/**
 * Runtime configuration for the OpenDJ backend.
 *
 * Loaded from environment via `loadConfig(env)`. Both Node (`process.env`) and
 * Cloudflare Workers (`Env` binding) supply env as a `Record<string, string>`
 * — `loadConfig` is environment-agnostic.
 *
 * Validation uses Valibot (small bundle, Workers-friendly).
 */

import * as v from 'valibot';

const LoginProviderCredsSchema = v.object({
  clientId: v.pipe(v.string(), v.nonEmpty()),
  clientSecret: v.optional(v.pipe(v.string(), v.nonEmpty())),
  redirectUri: v.pipe(v.string(), v.url()),
});

const PositiveInt = v.pipe(v.number(), v.integer(), v.minValue(1));

/** Where guest search can get answers (see `SEARCH_SOURCES`). */
export const SEARCH_SOURCE_IDS = ['provider', 'deezer', 'catalog', 'sonovault'] as const;
export type SearchSourceId = (typeof SEARCH_SOURCE_IDS)[number];

const SearchSourcesSchema = v.pipe(
  v.array(v.picklist(SEARCH_SOURCE_IDS, 'must be one of provider, deezer, catalog, sonovault')),
  v.minLength(1, 'must name at least one source'),
  v.check((ids) => new Set(ids).size === ids.length, 'must not repeat a source'),
);

const ConfigSchema = v.object({
  databaseUrl: v.pipe(v.string(), v.url(), v.nonEmpty()),
  baseUrl: v.pipe(v.string(), v.url()),
  spotify: v.optional(
    v.object({
      clientId: v.pipe(v.string(), v.nonEmpty()),
      clientSecret: v.pipe(v.string(), v.nonEmpty()),
      redirectUri: v.pipe(v.string(), v.url()),
    }),
  ),
  loginProviders: v.object({
    google: v.optional(LoginProviderCredsSchema),
    apple: v.optional(LoginProviderCredsSchema),
    facebook: v.optional(LoginProviderCredsSchema),
  }),
  postLoginPath: v.pipe(v.string(), v.startsWith('/')),
  postProviderCallbackPath: v.pipe(v.string(), v.startsWith('/')),
  maxSongsPerGuest: v.pipe(v.number(), v.integer(), v.minValue(1)),
  maxGuestsPerSession: v.union([v.pipe(v.number(), v.integer(), v.minValue(1)), v.null()]),
  moderationEnabledDefault: v.boolean(),
  valkeyUrl: v.optional(v.pipe(v.string(), v.url())),
  /*
   * Guest search pacing. `loadConfig` always fills these; they are optional
   * in the type so hand-built configs (tests, downstream apps) keep compiling.
   * Read them through `resolveSearchPacing(config)`, which applies defaults.
   */
  /** Spotify searches allowed per API key (provider) per budget window. */
  searchBudgetLimit: v.optional(PositiveInt),
  searchBudgetWindowMs: v.optional(PositiveInt),
  /** Searches allowed per guest identity per search window. */
  searchGuestLimit: v.optional(PositiveInt),
  /** Searches allowed per search window, shared by every tokenless caller. */
  searchAnonLimit: v.optional(PositiveInt),
  searchWindowMs: v.optional(PositiveInt),
  /** Send the slow-down hint when budget `remaining` is at or below this % of the limit. 0 disables. */
  searchSlowDownThresholdPct: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100)),
  ),
  searchSlowDownDebounceMs: v.optional(PositiveInt),
  searchSlowDownTtlSec: v.optional(PositiveInt),
  /** Spotify searches allowed per provider per rolling 24h (the provider's daily quota). */
  searchDailyLimit: v.optional(PositiveInt),
  /**
   * Cap on a provider rate-limit cooldown persisted to `provider_connections`
   * (seconds), so a bogus `Retry-After` can't pause the provider for days.
   * Optional for hand-built configs; defaults to `DEFAULT_PROVIDER_COOLDOWN_MAX_SEC`.
   */
  providerCooldownMaxSec: v.optional(PositiveInt),
  /**
   * Guest search sources, in the order they are asked (`SEARCH_SOURCES`).
   * Optional for hand-built configs; read through `resolveSearchSources`.
   */
  searchSources: v.optional(SearchSourcesSchema),
  /** Deezer searches allowed per 5s across the deployment (`DEEZER_RATE_LIMIT`). */
  deezerRateLimit: v.optional(PositiveInt),
  /**
   * Enables Sonovault ISRC → provider link lookups at add time, and the
   * `sonovault` search source when `SEARCH_SOURCES` lists it (`SONOVAULT_API_KEY`).
   */
  sonovaultApiKey: v.optional(v.pipe(v.string(), v.nonEmpty())),
  /**
   * Verify non-catalog add-time resolutions against the provider's own title
   * (Spotify oEmbed). On unless `TRACK_VERIFY=off`; absent means on.
   */
  trackVerify: v.optional(v.boolean()),
});

export type Config = v.InferOutput<typeof ConfigSchema>;

/** Resolved guest search pacing settings (see `resolveSearchPacing`). */
export interface SearchPacingConfig {
  searchBudgetLimit: number;
  searchBudgetWindowMs: number;
  searchGuestLimit: number;
  searchAnonLimit: number;
  searchWindowMs: number;
  searchSlowDownThresholdPct: number;
  searchSlowDownDebounceMs: number;
  searchSlowDownTtlSec: number;
  searchDailyLimit: number;
}

/**
 * Defaults sized for Spotify development mode: the now-playing poller makes
 * ~6 calls per 30s, so 3 searches per 30s keeps the app near 10 calls per 30s.
 * Development mode also caps `/v1/search` at roughly 500 calls per 24h per
 * developer account; 400 a day leaves headroom for other callers.
 */
export const DEFAULT_SEARCH_PACING: Readonly<SearchPacingConfig> = Object.freeze({
  searchBudgetLimit: 3,
  searchBudgetWindowMs: 30_000,
  searchGuestLimit: 5,
  searchAnonLimit: 5,
  searchWindowMs: 30_000,
  searchSlowDownThresholdPct: 30,
  searchSlowDownDebounceMs: 1_200,
  searchSlowDownTtlSec: 30,
  searchDailyLimit: 400,
});

/** Default search source order: the provider, then the local catalog as its fallback. */
export const DEFAULT_SEARCH_SOURCES: ReadonlyArray<SearchSourceId> = Object.freeze([
  'provider',
  'catalog',
]);

/** Default Deezer searches per 5s, under Deezer's documented 50 per 5s. */
export const DEFAULT_DEEZER_RATE_LIMIT = 45;

/** Search source order from `config`, defaulting to `DEFAULT_SEARCH_SOURCES`. */
export function resolveSearchSources(config: {
  searchSources?: ReadonlyArray<SearchSourceId> | undefined;
}): SearchSourceId[] {
  return [...(config.searchSources ?? DEFAULT_SEARCH_SOURCES)];
}

/** Default cap on a persisted provider cooldown: 24h. */
export const DEFAULT_PROVIDER_COOLDOWN_MAX_SEC = 86_400;

/** Search pacing from `config`, with defaults for any field it omits. */
export function resolveSearchPacing(config: Partial<SearchPacingConfig>): SearchPacingConfig {
  const resolved = { ...DEFAULT_SEARCH_PACING };
  for (const key of Object.keys(DEFAULT_SEARCH_PACING) as Array<keyof SearchPacingConfig>) {
    const value = config[key];
    if (value !== undefined) resolved[key] = value;
  }
  return resolved;
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function parseOptionalInteger(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1';
}

export class ConfigError extends Error {
  readonly issues: ReadonlyArray<string>;

  constructor(issues: ReadonlyArray<string>) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/**
 * Build a `Config` from a flat key/value map (Node env or Workers env binding).
 *
 * Throws `ConfigError` with all schema violations aggregated, so the caller
 * sees every problem at once instead of fixing them one at a time.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const candidate: Record<string, unknown> = {
    databaseUrl: env['DATABASE_URL'] ?? '',
    baseUrl: env['BASE_URL'] ?? 'http://localhost:8888',
    maxSongsPerGuest: parseInteger(env['MAX_SONGS_PER_GUEST'], 3),
    maxGuestsPerSession: parseOptionalInteger(env['MAX_GUESTS_PER_SESSION']),
    moderationEnabledDefault: parseBoolean(env['MODERATION_ENABLED_DEFAULT'], false),
    searchBudgetLimit: parseInteger(
      env['SEARCH_BUDGET_LIMIT'],
      DEFAULT_SEARCH_PACING.searchBudgetLimit,
    ),
    searchBudgetWindowMs: parseInteger(
      env['SEARCH_BUDGET_WINDOW_MS'],
      DEFAULT_SEARCH_PACING.searchBudgetWindowMs,
    ),
    searchGuestLimit: parseInteger(
      env['SEARCH_GUEST_LIMIT'],
      DEFAULT_SEARCH_PACING.searchGuestLimit,
    ),
    searchAnonLimit: parseInteger(env['SEARCH_ANON_LIMIT'], DEFAULT_SEARCH_PACING.searchAnonLimit),
    searchWindowMs: parseInteger(env['SEARCH_WINDOW_MS'], DEFAULT_SEARCH_PACING.searchWindowMs),
    searchSlowDownThresholdPct: parseInteger(
      env['SEARCH_SLOWDOWN_THRESHOLD_PCT'],
      DEFAULT_SEARCH_PACING.searchSlowDownThresholdPct,
    ),
    searchSlowDownDebounceMs: parseInteger(
      env['SEARCH_SLOWDOWN_DEBOUNCE_MS'],
      DEFAULT_SEARCH_PACING.searchSlowDownDebounceMs,
    ),
    searchSlowDownTtlSec: parseInteger(
      env['SEARCH_SLOWDOWN_TTL_SEC'],
      DEFAULT_SEARCH_PACING.searchSlowDownTtlSec,
    ),
    searchDailyLimit: parseInteger(
      env['SEARCH_DAILY_LIMIT'],
      DEFAULT_SEARCH_PACING.searchDailyLimit,
    ),
    providerCooldownMaxSec: parseInteger(
      env['PROVIDER_COOLDOWN_MAX_SEC'],
      DEFAULT_PROVIDER_COOLDOWN_MAX_SEC,
    ),
  };
  const searchSources = env['SEARCH_SOURCES'];
  candidate['searchSources'] =
    searchSources === undefined || searchSources.trim() === ''
      ? [...DEFAULT_SEARCH_SOURCES]
      : searchSources.split(',').map((id) => id.trim().toLowerCase());
  candidate['deezerRateLimit'] = parseInteger(env['DEEZER_RATE_LIMIT'], DEFAULT_DEEZER_RATE_LIMIT);
  const sonovaultApiKey = env['SONOVAULT_API_KEY'];
  if (sonovaultApiKey !== undefined && sonovaultApiKey !== '') {
    candidate['sonovaultApiKey'] = sonovaultApiKey;
  }
  candidate['trackVerify'] = env['TRACK_VERIFY']?.trim().toLowerCase() !== 'off';
  const valkey = env['VALKEY_URL'];
  if (valkey !== undefined && valkey !== '') candidate['valkeyUrl'] = valkey;

  const spotifyClientId = env['SPOTIFY_CLIENT_ID'];
  const spotifyClientSecret = env['SPOTIFY_CLIENT_SECRET'];
  const spotifyRedirectUri =
    env['SPOTIFY_REDIRECT_URI'] ??
    `${candidate['baseUrl'] as string}/api/v1/provider/connections/spotify/callback`;
  if (spotifyClientId && spotifyClientSecret) {
    candidate['spotify'] = {
      clientId: spotifyClientId,
      clientSecret: spotifyClientSecret,
      redirectUri: spotifyRedirectUri,
    };
  }

  const baseUrl = candidate['baseUrl'] as string;
  const loginProviders: Record<string, unknown> = {};
  for (const provider of ['google', 'apple', 'facebook'] as const) {
    const upper = provider.toUpperCase();
    const clientId = env[`${upper}_CLIENT_ID`];
    if (!clientId) continue;
    const clientSecret = env[`${upper}_CLIENT_SECRET`];
    const redirectUri =
      env[`${upper}_REDIRECT_URI`] ?? `${baseUrl}/api/v1/auth/oauth/${provider}/callback`;
    loginProviders[provider] = {
      clientId,
      ...(clientSecret !== undefined && clientSecret !== '' && { clientSecret }),
      redirectUri,
    };
  }
  candidate['loginProviders'] = loginProviders;
  candidate['postLoginPath'] = env['POST_LOGIN_PATH'] ?? '/';
  candidate['postProviderCallbackPath'] = env['POST_PROVIDER_CALLBACK_PATH'] ?? '/host/dashboard';

  const result = v.safeParse(ConfigSchema, candidate);
  if (!result.success) {
    const issues = result.issues.map((issue) => {
      const path = issue.path?.map((p) => p.key).join('.') ?? '<root>';
      return `${path}: ${issue.message}`;
    });
    throw new ConfigError(issues);
  }
  return result.output;
}
