/**
 * LoginAuthService — coordinates the OIDC/OAuth login flow.
 *
 * Flow per provider:
 * 1. `start(providerId)` — generate state nonce, persist to `oauth_states`
 *    with `flowKind: 'login'`, return the provider's authorize URL
 * 2. `complete(providerId, code, state)` — verify state, exchange code,
 *    fetch profile via the handler, upsert `auth_identities` + `users`,
 *    issue a session
 *
 * Auth-identity matching:
 * - Find by `(providerId, providerSubject)` first (the natural identity key)
 * - If found → reuse the linked user
 * - If not found → optionally link to an existing user-by-primary-email
 *   when the provider says `emailVerified: true` (Google does); otherwise
 *   create a new user
 */

import {
  buildAuthorizeUrl,
  exchangeCode,
  generateSessionToken,
  type OAuthTokens,
} from '@opendj/auth';
import { AuthService, type IssuedSession } from './AuthService.js';
import type { LoginProviderHandler } from './loginProviders/types.js';
import type {
  AuthIdentityRecord,
  AuthIdentityRepository,
  OAuthStateRepository,
  UserRecord,
  UserRepository,
} from '../repositories/types.js';

export class LoginAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'LoginAuthError';
    this.code = code;
  }
}

const STATE_TTL_MS = 10 * 60 * 1000;

export interface LoginCredentials {
  clientId: string;
  clientSecret: string | undefined;
  redirectUri: string;
}

export interface LoginAuthServiceDeps {
  users: UserRepository;
  authIdentities: AuthIdentityRepository;
  oauthStates: OAuthStateRepository;
  authService: AuthService;
  /** Provider id → credentials (filled from Config; missing providers throw `provider_not_configured`). */
  credentials: Readonly<Record<string, LoginCredentials | undefined>>;
  fetchImpl?: typeof fetch;
}

export interface StartResult {
  authorizeUrl: string;
  state: string;
}

export interface CompleteResult {
  session: IssuedSession;
  user: UserRecord;
  identity: AuthIdentityRecord;
}

export class LoginAuthService {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: LoginAuthServiceDeps) {
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  }

  async start(handler: LoginProviderHandler, redirectTo?: string | null): Promise<StartResult> {
    const credentials = this.deps.credentials[handler.providerId];
    if (!credentials) {
      throw new LoginAuthError(
        'provider_not_configured',
        `No client credentials for "${handler.providerId}".`,
      );
    }
    const state = generateSessionToken();
    await this.deps.oauthStates.create({
      state,
      flowKind: 'login',
      providerId: handler.providerId,
      ...(redirectTo !== undefined && redirectTo !== null && { redirectTo }),
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    });
    const authorizeUrl = buildAuthorizeUrl(
      handler.oauthConfig,
      credentials.clientId,
      credentials.redirectUri,
      state,
    );
    return { authorizeUrl, state };
  }

  async complete(
    handler: LoginProviderHandler,
    code: string,
    state: string,
  ): Promise<CompleteResult> {
    const credentials = this.deps.credentials[handler.providerId];
    if (!credentials) {
      throw new LoginAuthError(
        'provider_not_configured',
        `No client credentials for "${handler.providerId}".`,
      );
    }
    const stateRow = await this.deps.oauthStates.findActive(state, Date.now());
    if (!stateRow)
      throw new LoginAuthError('invalid_or_expired_state', 'State not found or expired.');
    if (stateRow.providerId !== handler.providerId) {
      throw new LoginAuthError('state_provider_mismatch', 'State provider does not match.');
    }
    if (stateRow.flowKind !== 'login') {
      throw new LoginAuthError('wrong_flow_kind', 'State was issued for a different flow.');
    }
    // Single-use: drop before exchange so a replay can't reuse the same state.
    await this.deps.oauthStates.delete(state);

    let tokens: OAuthTokens;
    try {
      tokens = await exchangeCode({
        config: handler.oauthConfig,
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        code,
        redirectUri: credentials.redirectUri,
        fetchImpl: this.fetchImpl,
      });
    } catch (err) {
      throw new LoginAuthError('token_exchange_failed', (err as Error).message);
    }

    const profile = await handler.fetchProfile(tokens, this.fetchImpl);

    // Identity match — exact provider+subject first.
    let identity = await this.deps.authIdentities.findByProvider(
      handler.providerId,
      profile.providerSubject,
    );

    let user: UserRecord | null = identity ? await this.deps.users.findById(identity.userId) : null;

    if (!user) {
      // Try to link to an existing user-by-email when the provider verified the email.
      if (profile.email && profile.emailVerified) {
        user = await this.deps.users.findByPrimaryEmail(profile.email);
      }
      if (!user) {
        user = await this.deps.users.create({
          primaryEmail: profile.email,
          displayName: profile.displayName,
          avatarUrl: profile.avatarUrl,
          emailVerified: profile.emailVerified,
        });
      }
    }

    if (!identity) {
      identity = await this.deps.authIdentities.create({
        userId: user.id,
        providerId: handler.providerId,
        providerSubject: profile.providerSubject,
        email: profile.email,
        emailVerified: profile.emailVerified,
        rawProfile: profile.raw,
      });
    }

    const session = await this.deps.authService.issueSession({ userId: user.id });
    return { session, user, identity };
  }
}
