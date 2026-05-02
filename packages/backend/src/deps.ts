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
import { LrclibAdapter, type LyricsProvider } from '@opendj/lyrics';
import type { RealtimeRoom } from '@opendj/realtime';
import { AbuseModerationService } from './abuse/AbuseModerationService.js';
import { AuthService } from './auth/AuthService.js';
import { ClaimsService } from './auth/ClaimsService.js';
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
    rooms,
    roomManager,
  };
}
