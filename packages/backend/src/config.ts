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
  maxSongsPerGuest: v.pipe(v.number(), v.integer(), v.minValue(1)),
  maxGuestsPerSession: v.union([v.pipe(v.number(), v.integer(), v.minValue(1)), v.null()]),
  moderationEnabledDefault: v.boolean(),
  valkeyUrl: v.optional(v.pipe(v.string(), v.url())),
});

export type Config = v.InferOutput<typeof ConfigSchema>;

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
  };
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
