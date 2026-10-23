/**
 * Provider-agnostic guest search sources.
 *
 * `SEARCH_SOURCES` lists the sources the search route asks, in order; the
 * first one that returns at least one result answers. A source answers
 * `'unavailable'` when it can't be asked right now (rate limited, failed,
 * disabled), and the route moves on to the next one.
 *
 * - `provider` — the session's connected streaming provider, behind the
 *   search budget, daily cap, and cooldowns. Handled by the search route
 *   itself because its admission is tied to the route's cache and limits.
 * - `deezer` — Deezer's public search (`DeezerSearchSource`); answers
 *   `opendj:isrc:<ISRC>` URIs that are resolved to the provider at add time.
 * - `catalog` — the local track catalog (`createCatalogSearchSource`).
 * - `sonovault` — Sonovault's artist + title search (`SonovaultSearchSource`),
 *   only for queries like `Artist - Title` / `Title by Artist`; needs
 *   `SONOVAULT_API_KEY` (listed without one, it is disabled with a startup
 *   warning). Answers `opendj:isrc:<ISRC>` URIs like `deezer`.
 */

export type { SearchSourceId } from '../config.js';
import type { SearchSourceId } from '../config.js';

/** One search hit, in the search response's shape. */
export interface SourceTrack {
  trackUri: string;
  trackName: string;
  artistName: string;
  albumArtUrl: string | null;
  durationMs: number | null;
  isrc?: string;
}

export interface SearchSourceContext {
  accountId: string;
  /** The session's active provider (catalog rows and resolution are keyed by it). */
  providerId: string;
}

export interface SearchSource {
  readonly id: SearchSourceId;
  search(
    query: string,
    limit: number,
    ctx: SearchSourceContext,
  ): Promise<SourceTrack[] | 'unavailable'>;
}
