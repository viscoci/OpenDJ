/**
 * StreamingRouter — bridge between an OpenDJ account/session and the
 * appropriate `IStreamingProvider` instance.
 *
 * `getProvider(accountId, providerId)` looks up the provider connection in
 * `provider_connections`, instantiates the provider via the registry factory,
 * and connects it with the stored credentials. The returned instance is a
 * fully-connected `IStreamingProvider` — callers use the type guards from
 * `@opendj/core` to access feature methods safely.
 *
 * Cross-cutting feature methods (search, queueTrack, getNowPlaying, ...)
 * deliberately live on the provider itself, not on the router. The router
 * stays a thin lookup; routes call the provider directly via type guards.
 *
 * See docs/agent-brief.md §"Provider Architecture" + §"`StreamingRouter` contract".
 */

import {
  InvalidProviderCredentialsError,
  NotImplementedError,
  type IStreamingProvider,
  type ProviderCredentials,
} from '@opendj/core';
import type { ProviderConnectionRepository } from '../../repositories/types.js';
import type { ProviderContext, ProviderRegistry } from './providerRegistry.js';

export class ProviderConnectionNotFoundError extends Error {
  readonly accountId: string;
  readonly providerId: string;
  constructor(accountId: string, providerId: string) {
    super(`No "${providerId}" connection for account "${accountId}".`);
    this.name = 'ProviderConnectionNotFoundError';
    this.accountId = accountId;
    this.providerId = providerId;
  }
}

export class UnknownProviderError extends Error {
  readonly providerId: string;
  constructor(providerId: string) {
    super(`Unknown provider "${providerId}". Registered: see providerRegistry.`);
    this.name = 'UnknownProviderError';
    this.providerId = providerId;
  }
}

export interface StreamingRouterDeps {
  providerConnections: ProviderConnectionRepository;
  registry: ProviderRegistry;
  context: ProviderContext;
}

export class StreamingRouter {
  constructor(private readonly deps: StreamingRouterDeps) {}

  /**
   * Resolve and connect the provider for `(accountId, providerId)`.
   *
   * Throws:
   * - `UnknownProviderError` when the providerId isn't registered
   * - `ProviderConnectionNotFoundError` when no row exists in `provider_connections`
   * - `InvalidProviderCredentialsError` when the row exists but has no access token
   * - Whatever the provider's `connect` throws on bad credentials
   */
  async getProvider(accountId: string, providerId: string): Promise<IStreamingProvider> {
    const factory = this.deps.registry[providerId];
    if (!factory) throw new UnknownProviderError(providerId);

    const connection = await this.deps.providerConnections.findByAccountAndProvider(
      accountId,
      providerId,
    );
    if (!connection) throw new ProviderConnectionNotFoundError(accountId, providerId);
    if (!connection.accessToken) {
      throw new InvalidProviderCredentialsError(providerId, 'No access token stored.');
    }

    const provider = factory(this.deps.context);
    const credentials: ProviderCredentials = { accessToken: connection.accessToken };
    if (connection.refreshToken) credentials['refreshToken'] = connection.refreshToken;
    if (connection.providerAccountId) credentials['accountId'] = connection.providerAccountId;
    if (connection.tokenType) credentials['tokenType'] = connection.tokenType;
    if (connection.scopes) credentials['scopes'] = connection.scopes.join(' ');

    // Wire token-refresh persistence: when the provider's underlying
    // client trades the refresh token for a fresh access token, write the
    // new tokens back to provider_connections so they survive a restart.
    // Provider must opt in via `setOnTokenRefreshed` — providers without
    // it (Soundtrack stub, etc.) just skip the wiring.
    const providerWithRefresh = provider as IStreamingProvider & {
      setOnTokenRefreshed?: (
        cb: (tokens: {
          accessToken: string;
          refreshToken?: string;
          expiresAt?: Date;
          tokenType?: string;
        }) => void | Promise<void>,
      ) => void;
    };
    if (typeof providerWithRefresh.setOnTokenRefreshed === 'function') {
      providerWithRefresh.setOnTokenRefreshed(async (tokens) => {
        await this.deps.providerConnections.updateTokens({
          id: connection.id,
          accessToken: tokens.accessToken,
          ...(tokens.refreshToken !== undefined && { refreshToken: tokens.refreshToken }),
          ...(tokens.expiresAt !== undefined && { expiresAt: tokens.expiresAt }),
          ...(tokens.tokenType !== undefined && { tokenType: tokens.tokenType }),
        });
      });
    }

    await provider.connect(credentials);
    return provider;
  }

  /**
   * Replace stored credentials and (re)connect the provider in one step.
   * Used by the OAuth callback route after a fresh token exchange.
   */
  async switchProvider(
    accountId: string,
    providerId: string,
    credentials: ProviderCredentials,
    options: { connectedByUserId?: string | null; providerAccountId?: string | null } = {},
  ): Promise<IStreamingProvider> {
    if (!this.deps.registry[providerId]) throw new UnknownProviderError(providerId);
    const accessToken = credentials['accessToken'];
    if (!accessToken) {
      throw new InvalidProviderCredentialsError(
        providerId,
        'switchProvider requires an accessToken in credentials.',
      );
    }
    await this.deps.providerConnections.upsert({
      accountId,
      providerId,
      accessToken,
      refreshToken: credentials['refreshToken'] ?? null,
      tokenType: credentials['tokenType'] ?? null,
      ...(options.connectedByUserId !== undefined && {
        connectedByUserId: options.connectedByUserId,
      }),
      ...(options.providerAccountId !== undefined && {
        providerAccountId: options.providerAccountId,
      }),
    });
    return this.getProvider(accountId, providerId);
  }
}

/**
 * Defensive helper for routes that mistakenly call a feature method on a
 * stub provider — converts a `NotImplementedError` into the canonical 501
 * `not_supported_by_provider` shape. Routes that gate on type guards never
 * hit this; it exists as a backstop.
 */
export function isProviderUnimplemented(err: unknown): err is NotImplementedError {
  return err instanceof NotImplementedError;
}
