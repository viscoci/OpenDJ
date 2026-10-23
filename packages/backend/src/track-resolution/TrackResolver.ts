/**
 * Add-time track resolution: turn a recording's ISRC into a URI native to
 * the session's active provider, so a track found through a provider-agnostic
 * search source (`opendj:isrc:<ISRC>`) can be queued and played.
 *
 * `TrackResolverChain` asks each resolver in order and returns the first
 * native URI. The default chain (see `deps.ts`):
 *   1. `CatalogTrackResolver` — a catalog row for (provider, ISRC) with a
 *      native URI. Local, free.
 *   2. `SonovaultTrackResolver` — only when `SONOVAULT_API_KEY` is set.
 *   3. `ProviderIsrcTrackResolver` — the provider's own search for
 *      `isrc:<ISRC>`, only while its search cooldown is closed and the search
 *      budget and daily cap have room; it spends a unit of each like a guest
 *      search.
 *
 * Nothing here is provider-specific: native-ness comes from
 * `isNativeTrackUri` (the scheme map in `@opendj/core`).
 */

import { isNativeTrackUri, supportsSearch } from '@opendj/core';
import type { TrackCatalog } from '../catalog/TrackCatalog.js';
import type { StreamingRouter } from '../providers/streaming/StreamingRouter.js';
import {
  SEARCH_BUDGET_SCOPE,
  SEARCH_DAILY_SCOPE,
  type SlidingWindowRateLimiter,
} from '../rate-limit/SlidingWindowRateLimiter.js';

export interface TrackResolveRequest {
  accountId: string;
  /** The session's active provider: the answer must be native to it. */
  providerId: string;
  isrc: string;
}

export interface TrackResolver {
  readonly id: string;
  /** A URI native to `providerId` for the recording, or null when unknown. */
  resolve(request: TrackResolveRequest): Promise<string | null>;
}

export interface TrackResolution {
  uri: string;
  resolverId: string;
}

export class TrackResolverChain {
  constructor(
    private readonly resolvers: ReadonlyArray<TrackResolver>,
    private readonly logger: Pick<Console, 'error'> = console,
  ) {}

  /** Resolver ids, in the order they are asked. */
  get ids(): string[] {
    return this.resolvers.map((r) => r.id);
  }

  /** The first native answer, or null. A resolver that throws counts as a miss. */
  async resolve(request: TrackResolveRequest): Promise<TrackResolution | null> {
    for (const resolver of this.resolvers) {
      let uri: string | null;
      try {
        uri = await resolver.resolve(request);
      } catch (err) {
        this.logger.error(`[track-resolution] ${resolver.id} failed`, err);
        continue;
      }
      if (uri !== null && isNativeTrackUri(request.providerId, uri)) {
        return { uri, resolverId: resolver.id };
      }
    }
    return null;
  }
}

/** A catalog row for (provider, ISRC) that already has a native URI. */
export class CatalogTrackResolver implements TrackResolver {
  readonly id = 'catalog';

  constructor(private readonly catalog: Pick<TrackCatalog, 'findByIsrc'>) {}

  async resolve(request: TrackResolveRequest): Promise<string | null> {
    const rows = await this.catalog.findByIsrc(request.providerId, request.isrc);
    const native = rows
      .filter((row) => isNativeTrackUri(request.providerId, row.trackUri))
      .sort((a, b) => b.timesRequested - a.timesRequested || b.timesSeen - a.timesSeen);
    return native[0]?.trackUri ?? null;
  }
}

export interface ProviderIsrcTrackResolverDeps {
  streamingRouter: Pick<StreamingRouter, 'getProvider' | 'rateLimitedUntil'>;
  /** The guest search limiter: its budget and daily scopes are spent here too. */
  searchRateLimiter: SlidingWindowRateLimiter;
  logger?: Pick<Console, 'warn'>;
}

/**
 * The provider's own search for `isrc:<ISRC>`. Never called while the
 * provider's search cooldown is open or when the search budget or daily cap
 * has no room; otherwise spends one unit of each, like a guest search.
 */
export class ProviderIsrcTrackResolver implements TrackResolver {
  readonly id = 'provider';
  private readonly logger: Pick<Console, 'warn'>;

  constructor(private readonly deps: ProviderIsrcTrackResolverDeps) {
    this.logger = deps.logger ?? console;
  }

  async resolve(request: TrackResolveRequest): Promise<string | null> {
    const { accountId, providerId, isrc } = request;
    const provider = await this.deps.streamingRouter.getProvider(accountId, providerId);
    if (!supportsSearch(provider)) return null;

    // No awaits between the checks and the spend.
    if (this.deps.streamingRouter.rateLimitedUntil(accountId, providerId, 'search') !== null) {
      return null;
    }
    const limiter = this.deps.searchRateLimiter;
    if (!limiter.peekSync(SEARCH_DAILY_SCOPE, providerId).ok) return null;
    if (!limiter.peekSync(SEARCH_BUDGET_SCOPE, providerId).ok) return null;
    limiter.tryApply(SEARCH_DAILY_SCOPE, providerId);
    limiter.tryApply(SEARCH_BUDGET_SCOPE, providerId);

    try {
      const tracks = await provider.search(`isrc:${isrc}`, 5);
      return tracks.find((t) => isNativeTrackUri(providerId, t.uri))?.uri ?? null;
    } catch (err) {
      this.logger.warn(`[track-resolution] provider ISRC search failed: ${(err as Error).message}`);
      return null;
    }
  }
}
