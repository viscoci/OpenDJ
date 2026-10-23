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
import { TrackCatalog } from './catalog/TrackCatalog.js';
import {
  createDefaultLoginProviderRegistry,
  type LoginProviderRegistry,
} from './auth/loginProviders/index.js';
import {
  DEFAULT_DEEZER_CONFIDENT_RANK,
  DEFAULT_DEEZER_RATE_LIMIT,
  DEFAULT_PROVIDER_COOLDOWN_MAX_SEC,
  resolveSearchPacing,
  resolveSearchSources,
  type Config,
  type SearchPacingConfig,
  type SearchSourceId,
} from './config.js';
import {
  ConsoleEmailAdapter,
  EmailVerificationService,
  PasswordResetService,
  type EmailAdapter,
} from './email/index.js';
import { GuestIdentityService } from './guest/GuestIdentityService.js';
import { KaraokeService } from './karaoke/KaraokeService.js';
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
import {
  QueueService,
  roomProviderQueueView,
  type RealtimeRoomRegistry,
} from './queue/QueueService.js';
import { NowPlayingPoller } from './realtime/NowPlayingPoller.js';
import { ProviderCooldowns } from './providers/streaming/ProviderCooldowns.js';
import {
  createSearchRateLimiter,
  type SlidingWindowRateLimiter,
} from './rate-limit/SlidingWindowRateLimiter.js';
import { RoomRegistryImpl, type RealtimeRoomManager } from './realtime/RoomRegistryImpl.js';
import { createDrizzleRepositories } from './repositories/drizzle/index.js';
import type { Repositories } from './repositories/types.js';
import type { ExternalSearchSourceId } from './routes/search.js';
import { DeezerSearchSource } from './search-sources/DeezerSearchSource.js';
import type { SearchSource } from './search-sources/SearchSource.js';
import { SessionAuditService } from './session/SessionAuditService.js';
import { SonovaultSearchSource } from './search-sources/SonovaultSearchSource.js';
import {
  createSonovaultLimiter,
  SonovaultTrackResolver,
} from './track-resolution/SonovaultTrackResolver.js';
import { SpotifyOEmbedVerifier } from './track-resolution/SpotifyOEmbedVerifier.js';
import {
  CatalogTrackResolver,
  ProviderIsrcTrackResolver,
  TrackResolverChain,
  type TrackResolver,
} from './track-resolution/TrackResolver.js';
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
  karaokeService: KaraokeService;
  sessionAuditService: SessionAuditService;
  streamingRouter: StreamingRouter;
  /** Shared per-account provider rate-limit cooldowns (see ProviderCooldowns). */
  providerCooldowns: ProviderCooldowns;
  /** Guest search pacing settings, with defaults applied. */
  searchPacing: SearchPacingConfig;
  /**
   * The process's one guest-search limiter: scope `'search'` (keys
   * `guest:<slotId>` / `anon`), scope `'search_budget'` (key `<providerId>`),
   * and scope `'search_daily'` (key `<providerId>`, 24h window).
   */
  searchRateLimiter: SlidingWindowRateLimiter;
  /**
   * Local catalog of tracks seen in provider searches or requested by
   * guests; search falls back to it when the provider can't be asked.
   */
  trackCatalog: TrackCatalog;
  /** Guest search sources in the order they are asked (`SEARCH_SOURCES`). */
  searchSources: SearchSourceId[];
  /** External search sources listed in `searchSources` (Deezer; Sonovault with a key). */
  externalSearchSources: Partial<Record<ExternalSearchSourceId, SearchSource>>;
  /**
   * Add-time resolution of non-native track uris: catalog, then Sonovault
   * (with `SONOVAULT_API_KEY`), then the provider's own ISRC search.
   */
  trackResolver: TrackResolverChain;
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
  /**
   * Override the guest-search limiter (e.g. one built with
   * `createSearchRateLimiter(pacing, fakeClock)` in tests). Defaults to one
   * built from the config's search pacing.
   */
  searchRateLimiter?: SlidingWindowRateLimiter;
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
      // `ctx.fetch` (not the outer fetchImpl): the StreamingRouter hands each
      // provider a cooldown-guarded fetch scoped to its account.
      spotify: (ctx) =>
        new SpotifyProvider({
          fetchImpl: ctx.fetch,
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

  const providerCooldowns = new ProviderCooldowns();
  // Persist every opened/extended cooldown so a restart mid-ban doesn't
  // resume calling the provider. Fire-and-forget: the provider call
  // path never waits on, or fails because of, this write. The in-memory
  // cooldown keeps the provider's full window; only the stored copy is
  // clamped, so a bogus Retry-After can't pause the provider for days.
  const cooldownMaxMs =
    (options.config.providerCooldownMaxSec ?? DEFAULT_PROVIDER_COOLDOWN_MAX_SEC) * 1000;
  const providerConnectionsRepo = repositories.providerConnections;
  // Quotas belong to the provider app, so each stored cooldown is tagged
  // with the client id it was earned under; a deployment switched to a
  // different client id ignores it (see StreamingRouter.getProvider).
  const providerClientIds: Partial<Record<string, string>> = {};
  if (options.config.spotify?.clientId !== undefined) {
    providerClientIds['spotify'] = options.config.spotify.clientId;
  }
  providerCooldowns.onRateLimited((event) => {
    const until = new Date(Math.min(event.untilEpochMs, Date.now() + cooldownMaxMs));
    void providerConnectionsRepo
      .extendRateLimitedUntil({
        accountId: event.accountId,
        providerId: event.providerId,
        group: event.group,
        until,
        clientId: providerClientIds[event.providerId] ?? null,
      })
      .then((updated) => {
        if (!updated) {
          console.warn(
            '[provider-cooldown] no connection row to persist the cooldown on;',
            `provider=${event.providerId} account=${event.accountId}`,
          );
        }
      })
      .catch((err: unknown) => {
        console.error(
          '[provider-cooldown] failed to persist the cooldown;',
          `provider=${event.providerId} account=${event.accountId}`,
          err,
        );
      });
  });
  const streamingRouter = new StreamingRouter({
    providerConnections: repositories.providerConnections,
    registry: providerRegistry,
    context: { fetch: fetchImpl },
    cooldowns: providerCooldowns,
    providerClientIds,
  });

  const searchPacing = resolveSearchPacing(options.config);
  const searchRateLimiter = options.searchRateLimiter ?? createSearchRateLimiter(searchPacing);

  const trackCatalog = new TrackCatalog({
    repository: repositories.trackCatalog,
    queueItems: repositories.queueItems,
    sessions: repositories.sessions,
    providerConnections: repositories.providerConnections,
  });
  // Load the index (and backfill an empty table from queue items) in the
  // background so boot never waits on it.
  trackCatalog.warm();

  const searchSources = resolveSearchSources(options.config);
  const externalSearchSources: Partial<Record<ExternalSearchSourceId, SearchSource>> = {};
  if (searchSources.includes('deezer')) {
    externalSearchSources.deezer = new DeezerSearchSource({
      fetchImpl,
      rateLimit: options.config.deezerRateLimit ?? DEFAULT_DEEZER_RATE_LIMIT,
      confidentRank: options.config.deezerConfidentRank ?? DEFAULT_DEEZER_CONFIDENT_RANK,
      requestedCounts: (providerId, isrcs) => trackCatalog.requestedCountsByIsrc(providerId, isrcs),
    });
  }
  const sonovaultApiKey = options.config.sonovaultApiKey;
  // One Sonovault budget for search and add-time resolution; search leaves a
  // reserve for resolution (see SonovaultSearchSource).
  const sonovaultLimiter = createSonovaultLimiter();
  if (searchSources.includes('sonovault')) {
    if (sonovaultApiKey !== undefined) {
      externalSearchSources.sonovault = new SonovaultSearchSource({
        apiKey: sonovaultApiKey,
        fetchImpl,
        limiter: sonovaultLimiter,
      });
    } else {
      console.warn(
        '[search] SEARCH_SOURCES lists sonovault but SONOVAULT_API_KEY is not set; sonovault search is disabled',
      );
    }
  }
  const resolvers: TrackResolver[] = [new CatalogTrackResolver(trackCatalog)];
  if (sonovaultApiKey !== undefined) {
    resolvers.push(
      new SonovaultTrackResolver({ apiKey: sonovaultApiKey, fetchImpl, limiter: sonovaultLimiter }),
    );
  }
  resolvers.push(new ProviderIsrcTrackResolver({ streamingRouter, searchRateLimiter }));
  // Non-catalog answers for Spotify are checked against Spotify's own title
  // (oEmbed) unless TRACK_VERIFY=off.
  const trackResolver = new TrackResolverChain(resolvers, console, {
    verifiers:
      options.config.trackVerify === false ? [] : [new SpotifyOEmbedVerifier({ fetchImpl })],
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
    karaokeClaims: repositories.karaokeClaims,
    rooms,
    streamingRouter,
    providerConnections: repositories.providerConnections,
    audit: sessionAuditService,
    trackCatalog,
    trackResolver,
    // Duplicate check also covers what Spotify already has queued/playing,
    // read from the poller-maintained room snapshot (no extra API call).
    providerQueueView: roomProviderQueueView(rooms),
  });

  const karaokeService = new KaraokeService({
    sessions: repositories.sessions,
    guests: repositories.guests,
    guestSlots: repositories.guestSlots,
    queueItems: repositories.queueItems,
    karaokeClaims: repositories.karaokeClaims,
    rooms,
    audit: sessionAuditService,
    // Spotlight/pause transitions drive the host's provider playback
    // (pause on spotlight in auto mode, resume on ready/deadline).
    streamingRouter,
    providerConnections: repositories.providerConnections,
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
      karaoke: karaokeService,
    });
    // Tell connected clients the moment any caller trips a provider rate
    // limit, not just on the poller's next tick. Only the player group:
    // a search-only quota leaves playback and queueing working, so it must
    // not tell every guest the provider is limiting the party (search
    // surfaces its own `provider_rate_limited` refusal).
    const poller = nowPlayingPoller;
    providerCooldowns.onRateLimited((event) => {
      if (event.group !== 'player') return;
      void poller.notifyRateLimited(event);
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
    karaokeService,
    sessionAuditService,
    streamingRouter,
    providerCooldowns,
    searchPacing,
    searchRateLimiter,
    trackCatalog,
    searchSources,
    externalSearchSources,
    trackResolver,
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
