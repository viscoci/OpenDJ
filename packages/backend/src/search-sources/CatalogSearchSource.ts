/**
 * The local track catalog as a search source. Free and local, so it never
 * spends any limit. Any failure answers `'unavailable'`.
 */

import { OPENDJ_TRACK_URI_SCHEME } from '@opendj/core';
import type { TrackCatalog } from '../catalog/TrackCatalog.js';
import type { TrackCatalogRecord } from '../repositories/types.js';
import type { SearchSource, SourceTrack } from './SearchSource.js';

export function catalogRecordToSourceTrack(record: TrackCatalogRecord): SourceTrack {
  return {
    trackUri: record.trackUri,
    trackName: record.trackName,
    artistName: record.artistName,
    albumArtUrl: record.albumArtUrl,
    durationMs: record.durationMs,
    ...(record.isrc !== undefined && { isrc: record.isrc }),
  };
}

/**
 * Drop an `opendj:` row when another match carries the same ISRC: once a
 * recording has been resolved to the provider, guests see the native row.
 */
function preferResolved(records: TrackCatalogRecord[]): TrackCatalogRecord[] {
  const resolvedIsrcs = new Set<string>();
  for (const r of records) {
    if (r.isrc !== undefined && !r.trackUri.startsWith(OPENDJ_TRACK_URI_SCHEME)) {
      resolvedIsrcs.add(r.isrc);
    }
  }
  if (resolvedIsrcs.size === 0) return records;
  return records.filter(
    (r) =>
      !(
        r.trackUri.startsWith(OPENDJ_TRACK_URI_SCHEME) &&
        r.isrc !== undefined &&
        resolvedIsrcs.has(r.isrc)
      ),
  );
}

export function createCatalogSearchSource(
  catalog: Pick<TrackCatalog, 'search'>,
  logger: Pick<Console, 'error'> = console,
): SearchSource {
  return {
    id: 'catalog',
    async search(query, limit, ctx) {
      try {
        const records = await catalog.search(ctx.providerId, query, limit);
        return preferResolved(records).map(catalogRecordToSourceTrack);
      } catch (err) {
        logger.error('[search] local catalog search failed', err);
        return 'unavailable';
      }
    },
  };
}
