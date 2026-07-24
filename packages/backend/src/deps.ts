/**
 * Explicit dependency graph for the OpenDJ backend.
 *
 * Brief §"Provider registry pattern" — no decorator DI. A small typed record
 * is easier for Workers, tests, and agents to reason about than InversifyJS.
 *
 * `createDeps(options)` is the canonical wiring used by `apps/oss-demo`; a
 * Workers entry point can call it the same way. Tests construct individual
 * services with in-memory repositories; production passes a Drizzle
 * `Database` and the OAuth client credentials.
 */

import type { Database } from '@opendj/db';
import type { PasswordHasher } from '@opendj/auth';
import { LrclibAdapter, type LyricsProvider } from '@opendj/lyrics';
import type { RealtimeRoom } from '@opendj/realtime';
import { AbuseModerationService } from './abuse/AbuseModerationService.js';
import { Argon2idPasswordHasher } from './auth/Argon2idPasswordHasher.js';
import { AuthService } from './auth/AuthService.js';
import { ClaimsService } from './auth/ClaimsService.js';
import { EmailPasswordService } from './auth/EmailPasswordService.js';
import { LoginAuthService, type LoginCredentials } from './auth/LoginAuthService.js';
import { AccountService } from './account/AccountService.js';
import {
  createDefaultLoginProviderRegistry,
  type LoginProviderRegistry,
} from './auth/loginProviders/index.js';
import type { Config } from './config.js';
import {
  ConsoleEmailAdapter,
  EmailVerificationService,
  PasswordResetService,
  type EmailAdapter,
} from './email/index.js';
import { GuestIdentityService } from './guest/GuestIdentityService.js';
import { LyricsLookupService } from './lyrics/LyricsLookupService.js';
import { AppleMusicProvider } from './providers/streaming/AppleMusicProvider.js';
import {
  defaultStreamingProviderOAuthConfigs,
  type StreamingProviderOAuthRegistry,
} from './providers/streaming/oauthConfigs.js';
import type { ProviderRegistry } from './providers/streaming/providerRegistry.js';
import { SoundtrackProvider } from './providers/streaming/SoundtrackProvider.js';
import { SpotifyProvider } from './providers/streaming/spotify/SpotifyProvider.js';
import { StreamingRouter } from './providers/streaming/StreamingRouter.js';
import { QueueService, type RealtimeRoomRegistry } from './queue/QueueService.js';
import { NowPlayingPoller } from './realtime/NowPlayingPoller.js';
import { RoomRegistryImpl, type RealtimeRoomManager } from './realtime/RoomRegistryImpl.js';
import { createDrizzleRepositories } from './repositories/drizzle/index.js';
import type { Repositories } from './repositories/types.js';
import { SessionAuditService } from './session/SessionAuditService.js';
import { SessionService } from './session/SessionService.js';

export interface AppDeps {
  config: Config;
  db: Database | null;
  repositories: Repositories;
  authService: AuthService;
  claimsService: ClaimsService;
  guestIdentityService: GuestIdentityService;
  sessionService: SessionService;
  queueService: QueueService;
  sessionAuditService: SessionAuditService;
  streamingRouter: StreamingRouter;
  streamingProviderOAuthConfigs: StreamingProviderOAuthRegistry;
  lyricsLookupService: LyricsLookupService;
  abuseModerationService: AbuseModerationService;
  passwordHasher: PasswordHasher & { algorithm?: string };
  emailPasswordService: EmailPasswordService;
  loginAuthService: LoginAuthService;
  loginProviders: LoginProviderRegistry;
  accountService: AccountService;
  emailAdapter: EmailAdapter;
  emailVerificationService: EmailVerificationService;
  passwordResetService: PasswordResetService;
  rooms: RealtimeRoomRegistry;
  /**
   * Concrete room manager. Routes that materialize rooms (the WS upgrade
   * route) use this; QueueService and other publishers see the read-only
   * `rooms` view above.
   */
  roomManager: RealtimeRoomManager | null;
  /**
   * Per-session "what's playing on the host's Spotify" poller. Driven by
   * the realtime route's WS lifecycle: started on first subscriber,
   * stopped after the last leaves (with a small idle grace). Null when
   * `realtime: 'none'` because there's no room manager to publish to.
   */
  nowPlayingPoller: NowPlayingPoller | null;
}

export interface CreateDepsOptions {
  config: Config;
  /** Drizzle database. Required when `repositories` is omitted. */
  db?: Database;
  /** Pre-built repositories (e.g. in-memory). When omitted, `db` is required. */
  repositories?: Repositories;
  /** Override the default streaming provider registry. */
  providerRegistry?: ProviderRegistry;
  /** Override the OAuth-config registry (e.g. add new providers). */
  streamingProviderOAuthConfigs?: StreamingProviderOAuthRegistry;
  /**
   * Realtime room registry. When `realtime: 'in-process'` (default), an
   * in-process `RoomRegistryImpl` is created. Pass a registry directly to
   * override (e.g. tests, hosted Cloudflare Durable Object adapter).
   */
  rooms?: RealtimeRoomRegistry;
  /** Realtime backing strategy. */
  realtime?: 'in-process' | 'none';
  /** fetch impl for outbound calls (provider OAuth + Spotify). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Override the default lyrics provider (defaults to LRCLIB). */
  lyricsProvider?: LyricsProvider;
  /**
   * Override the password hasher. Defaults to `Argon2idPasswordHasher` which
   * needs the optional `argon2` native dep. Workers consumers must supply a
   * WASM-backed hasher here.
   */
  passwordHasher?: PasswordHasher & { algorithm?: string };
  /** Override the default login-provider registry (e.g. add custom providers). */
  loginProviders?: LoginProviderRegistry;
  /**
   * Outbound-email adapter. Defaults to `ConsoleEmailAdapter` (writes to
   * stdout) — fine for the OSS demo. Production should pass an SMTP/SES
   * adapter.
   */
  emailAdapter?: EmailAdapter;
}

const NULL_ROOM_REGISTRY: RealtimeRoomRegistry = {
  forSession: (): RealtimeRoom | null => null,
};

export function createDeps(options: CreateDepsOptions): AppDeps {
  const repositories =
    options.repositories ??
    (options.db
      ? createDrizzleRepositories(options.db)
      : (() => {
          throw new Error('createDeps requires either `repositories` or `db`.');
        })());

  const claimsService = new ClaimsService({
    memberships: repositories.memberships,
    accounts: repositories.accounts,
  });

  const authService = new AuthService({
    authSessions: repositories.authSessions,
    claims: claimsService,
  });

  const guestIdentityService = new GuestIdentityService({
    sessions: repositories.sessions,
    accounts: repositories.accounts,
    guests: repositories.guests,
    guestSlots: repositories.guestSlots,
    fingerprintPriority: repositories.fingerprintPriority,
  });

  const sessionService = new SessionService({ sessions: repositories.sessions });

  let roomManager: RealtimeRoomManager | null = null;
  let rooms: RealtimeRoomRegistry;
  if (options.rooms) {
    rooms = options.rooms;
  } else if (options.realtime === 'none') {
    rooms = NULL_ROOM_REGISTRY;
  } else {
    roomManager = new RoomRegistryImpl();
    rooms = roomManager;
  }

  // Defer constructing the poller until we have a roomManager + the
  // streaming router below. We hold a ref here so it can be returned in
  // AppDeps.
  let nowPlayingPoller: NowPlayingPoller | null = null;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const providerRegistry: ProviderRegistry =
    options.providerRegistry ??
    ({
      spotify: () =>
        new SpotifyProvider({
          fetchImpl,
          // Forward the app-level Spotify Developer credentials so the
          // client can refresh the user's access token on 401 instead of
          // throwing. Falls back to no-refresh when SPOTIFY_* aren't set.
          ...(options.config.spotify?.clientId !== undefined && {
            clientId: options.config.spotify.clientId,
          }),
          ...(options.config.spotify?.clientSecret !== undefined && {
            clientSecret: options.config.spotify.clientSecret,
          }),
        }),
      soundtrack: () => new SoundtrackProvider(),
      'apple-music': () => new AppleMusicProvider(),
    } as ProviderRegistry);

  const streamingRouter = new StreamingRouter({
    providerConnections: repositories.providerConnections,
    registry: providerRegistry,
    context: { fetch: fetchImpl },
  });

  const sessionAuditService = new SessionAuditService({
    repository: repositories.sessionAuditEvents,
  });

  // Now construct QueueService with the provider integration in scope so
  // approved guest requests get pushed into the host's actual playback
  // queue (Spotify queue, etc.).
  const queueService = new QueueService({
    sessions: repositories.sessions,
    guests: repositories.guests,
    guestSlots: repositories.guestSlots,
    queueItems: repositories.queueItems,
    queueSkipVotes: repositories.queueSkipVotes,
    rooms,
    streamingRouter,
    providerConnections: repositories.providerConnections,
    audit: sessionAuditService,
  });

  const lyricsProvider = options.lyricsProvider ?? new LrclibAdapter({ fetchImpl });
  const lyricsLookupService = new LyricsLookupService({
    provider: lyricsProvider,
    cache: repositories.lyricsCache,
    feedback: repositories.lyricsFeedback,
  });

  if (roomManager) {
    nowPlayingPoller = new NowPlayingPoller({
      sessions: repositories.sessions,
      providerConnections: repositories.providerConnections,
      streamingRouter,
      roomManager,
      queueItems: repositories.queueItems,
      providerQueueRejections: queueService,
      lyricsLookup: lyricsLookupService,
    });
  }

  const abuseModerationService = new AbuseModerationService({
    abuseSubjects: repositories.abuseSubjects,
    actionEvents: repositories.actionEvents,
  });

  const accountService = new AccountService({
    accounts: repositories.accounts,
    memberships: repositories.memberships,
  });

  const passwordHasher = options.passwordHasher ?? new Argon2idPasswordHasher();
  const emailPasswordService = new EmailPasswordService({
    users: repositories.users,
    authIdentities: repositories.authIdentities,
    passwordCredentials: repositories.passwordCredentials,
    memberships: repositories.memberships,
    passwordHasher,
    authService,
    accountService,
  });

  const loginProviders = options.loginProviders ?? createDefaultLoginProviderRegistry();
  const loginCredentials: Record<string, LoginCredentials | undefined> = {};
  for (const providerId of Object.keys(loginProviders)) {
    const creds = (options.config.loginProviders as Record<string, LoginCredentials | undefined>)[
      providerId
    ];
    if (creds) loginCredentials[providerId] = creds;
  }
  const loginAuthService = new LoginAuthService({
    users: repositories.users,
    authIdentities: repositories.authIdentities,
    oauthStates: repositories.oauthStates,
    authService,
    credentials: loginCredentials,
    fetchImpl,
    accountService,
  });

  const emailAdapter = options.emailAdapter ?? new ConsoleEmailAdapter();
  const emailVerificationService = new EmailVerificationService({
    users: repositories.users,
    tokens: repositories.emailVerificationTokens,
    email: emailAdapter,
    baseUrl: options.config.baseUrl,
  });
  const passwordResetService = new PasswordResetService({
    users: repositories.users,
    tokens: repositories.passwordResetTokens,
    credentials: repositories.passwordCredentials,
    authSessions: repositories.authSessions,
    passwordHasher,
    email: emailAdapter,
    baseUrl: options.config.baseUrl,
  });

  return {
    config: options.config,
    db: options.db ?? null,
    repositories,
    authService,
    claimsService,
    guestIdentityService,
    sessionService,
    queueService,
    sessionAuditService,
    streamingRouter,
    streamingProviderOAuthConfigs:
      options.streamingProviderOAuthConfigs ?? defaultStreamingProviderOAuthConfigs,
    lyricsLookupService,
    abuseModerationService,
    passwordHasher,
    emailPasswordService,
    loginAuthService,
    loginProviders,
    accountService,
    emailAdapter,
    emailVerificationService,
    passwordResetService,
    rooms,
    roomManager,
    nowPlayingPoller,
  };
}
