/**
 * Explicit dependency graph for the OpenDJ backend.
 *
 * Brief §"Provider registry pattern" — no decorator DI. A small typed record
 * is easier for Workers, tests, and agents to reason about than InversifyJS.
 *
 * `createDeps(options)` is the canonical wiring used by `apps/oss-demo` and
 * `opendj-live/apps/api`. Tests construct individual services with in-memory
 * repositories; production passes a Drizzle `Database` and the OAuth client
 * credentials.
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
import {
  createDefaultLoginProviderRegistry,
  type LoginProviderRegistry,
} from './auth/loginProviders/index.js';
import type { Config } from './config.js';
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
import { RoomRegistryImpl, type RealtimeRoomManager } from './realtime/RoomRegistryImpl.js';
import { createDrizzleRepositories } from './repositories/drizzle/index.js';
import type { Repositories } from './repositories/types.js';
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
  streamingRouter: StreamingRouter;
  streamingProviderOAuthConfigs: StreamingProviderOAuthRegistry;
  lyricsLookupService: LyricsLookupService;
  abuseModerationService: AbuseModerationService;
  passwordHasher: PasswordHasher & { algorithm?: string };
  emailPasswordService: EmailPasswordService;
  loginAuthService: LoginAuthService;
  loginProviders: LoginProviderRegistry;
  rooms: RealtimeRoomRegistry;
  /**
   * Concrete room manager. Routes that materialize rooms (the WS upgrade
   * route) use this; QueueService and other publishers see the read-only
   * `rooms` view above.
   */
  roomManager: RealtimeRoomManager | null;
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
  const queueService = new QueueService({
    sessions: repositories.sessions,
    guests: repositories.guests,
    guestSlots: repositories.guestSlots,
    queueItems: repositories.queueItems,
    rooms,
  });

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const providerRegistry: ProviderRegistry =
    options.providerRegistry ??
    ({
      spotify: () => new SpotifyProvider({ fetchImpl }),
      soundtrack: () => new SoundtrackProvider(),
      'apple-music': () => new AppleMusicProvider(),
    } as ProviderRegistry);

  const streamingRouter = new StreamingRouter({
    providerConnections: repositories.providerConnections,
    registry: providerRegistry,
    context: { fetch: fetchImpl },
  });

  const lyricsProvider = options.lyricsProvider ?? new LrclibAdapter({ fetchImpl });
  const lyricsLookupService = new LyricsLookupService({
    provider: lyricsProvider,
    cache: repositories.lyricsCache,
    feedback: repositories.lyricsFeedback,
  });

  const abuseModerationService = new AbuseModerationService({
    abuseSubjects: repositories.abuseSubjects,
    actionEvents: repositories.actionEvents,
  });

  const passwordHasher = options.passwordHasher ?? new Argon2idPasswordHasher();
  const emailPasswordService = new EmailPasswordService({
    users: repositories.users,
    authIdentities: repositories.authIdentities,
    passwordCredentials: repositories.passwordCredentials,
    passwordHasher,
    authService,
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
    streamingRouter,
    streamingProviderOAuthConfigs:
      options.streamingProviderOAuthConfigs ?? defaultStreamingProviderOAuthConfigs,
    lyricsLookupService,
    abuseModerationService,
    passwordHasher,
    emailPasswordService,
    loginAuthService,
    loginProviders,
    rooms,
    roomManager,
  };
}
