/**
 * Local track catalog: the tracks this deployment has already seen from
 * provider searches or guest requests, searchable without calling the
 * provider.
 *
 * The `track_catalog` table is the durable copy. Search runs on an
 * in-process index, loaded from the repository on first use and updated on
 * every write, which is fine for tens of thousands of rows. When the table
 * is empty at load, it is backfilled once from every session's queue items.
 *
 * Writes are fire-and-forget: `recordSeen` / `recordRequested` return at
 * once, never throw, and log failures. They run one at a time, after the
 * index has loaded, so a write is never counted twice by a concurrent load.
 *
 * State is per process (each Workers isolate builds its own index from the
 * shared table).
 */

import type { Track } from '@opendj/core';
import type {
  ProviderConnectionRepository,
  QueueItemRepository,
  SessionRepository,
  TrackCatalogRecord,
  TrackCatalogRepository,
  TrackCatalogUpsert,
} from '../repositories/types.js';
import {
  applyCatalogUpsert,
  catalogKey,
  indexCatalogRecord,
  matchIndexedEntries,
  mergeCatalogUpserts,
  withIsrc,
  type IndexedCatalogEntry,
} from './catalogSearch.js';

export interface TrackCatalogDeps {
  repository: TrackCatalogRepository;
  /** Backfill source. */
  queueItems: Pick<QueueItemRepository, 'findAll'>;
  /** Maps a backfilled item's session to its account. */
  sessions: Pick<SessionRepository, 'findById'>;
  /** An account's provider is its first connection, as in the search route. */
  providerConnections: Pick<ProviderConnectionRepository, 'findAllForAccount'>;
  /** Default `() => new Date()`. */
  now?: () => Date;
  /** Default `console`. */
  logger?: Pick<Console, 'error'>;
}

export class TrackCatalog {
  private readonly deps: TrackCatalogDeps;
  private readonly now: () => Date;
  private readonly logger: Pick<Console, 'error'>;
  /** providerId → catalogKey → entry. Null until loaded. */
  private index: Map<string, Map<string, IndexedCatalogEntry>> | null = null;
  private loading: Promise<boolean> | null = null;
  /** Tail of the serial write chain; never rejects. */
  private writes: Promise<void> = Promise.resolve();

  constructor(deps: TrackCatalogDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.logger = deps.logger ?? console;
  }

  /** Start loading (and, if the table is empty, backfilling) in the background. */
  warm(): void {
    void this.ensureLoaded();
  }

  /** Count each track of a successful provider search as seen once. */
  recordSeen(providerId: string, tracks: ReadonlyArray<Track>): void {
    if (tracks.length === 0) return;
    const seenAt = this.now();
    this.enqueue(async () =>
      tracks.map((track) => toUpsert(providerId, track, { seen: 1, requested: 0 }, seenAt)),
    );
  }

  /** Count an accepted queue request for `track` against the account's provider. */
  recordRequested(accountId: string, track: Track): void {
    const seenAt = this.now();
    this.enqueue(async () => {
      const providerId = (await this.deps.providerConnections.findAllForAccount(accountId))[0]
        ?.providerId;
      if (providerId === undefined) return [];
      return [toUpsert(providerId, track, { seen: 0, requested: 1 }, seenAt)];
    });
  }

  /** Ranked local matches for `query` among `providerId`'s tracks; [] if the catalog can't load. */
  async search(providerId: string, query: string, limit: number): Promise<TrackCatalogRecord[]> {
    if (!(await this.ensureLoaded())) return [];
    const entries = this.index?.get(providerId);
    if (!entries) return [];
    return matchIndexedEntries(entries.values(), query, limit);
  }

  /**
   * `providerId`'s rows for the recording `isrc` (any URI), for add-time
   * resolution. Reads the index when it loads, else the repository.
   */
  async findByIsrc(providerId: string, isrc: string): Promise<TrackCatalogRecord[]> {
    if (await this.ensureLoaded()) {
      const matches: TrackCatalogRecord[] = [];
      for (const entry of this.index?.get(providerId)?.values() ?? []) {
        if (entry.record.isrc === isrc) matches.push(entry.record);
      }
      return matches;
    }
    return this.deps.repository.findByIsrc({ providerId, isrc });
  }

  /** Resolves once the load and every write queued so far have settled. For tests and shutdown. */
  async whenIdle(): Promise<void> {
    for (;;) {
      const writes = this.writes;
      const loading = this.loading;
      await writes;
      if (loading) await loading;
      if (writes === this.writes && loading === this.loading) return;
    }
  }

  private enqueue(build: () => Promise<TrackCatalogUpsert[]>): void {
    this.writes = this.writes.then(async () => {
      try {
        const entries = mergeCatalogUpserts(await build());
        if (entries.length === 0) return;
        if (await this.ensureLoaded()) this.applyToIndex(entries);
        await this.deps.repository.upsertMany(entries);
      } catch (err) {
        this.logger.error('[track-catalog] failed to record tracks', err);
      }
    });
  }

  private ensureLoaded(): Promise<boolean> {
    if (this.index) return Promise.resolve(true);
    if (!this.loading) {
      const loading = this.load().then(
        () => true,
        (err: unknown) => {
          this.logger.error('[track-catalog] failed to load the catalog', err);
          if (this.loading === loading) this.loading = null;
          return false;
        },
      );
      this.loading = loading;
    }
    return this.loading;
  }

  private async load(): Promise<void> {
    let rows = await this.deps.repository.findAll();
    if (rows.length === 0) rows = await this.backfill();
    const index = new Map<string, Map<string, IndexedCatalogEntry>>();
    for (const row of rows) setEntry(index, row);
    this.index = index;
  }

  /** One-time fill of an empty table from every session's queue items. */
  private async backfill(): Promise<TrackCatalogRecord[]> {
    try {
      const items = await this.deps.queueItems.findAll();
      const providerBySession = new Map<string, string | null>();
      const providerByAccount = new Map<string, string | null>();
      const entries: TrackCatalogUpsert[] = [];
      for (const item of items) {
        let providerId = providerBySession.get(item.sessionId);
        if (providerId === undefined) {
          const session = await this.deps.sessions.findById(item.sessionId);
          providerId = null;
          if (session) {
            providerId = providerByAccount.get(session.accountId) ?? null;
            if (!providerByAccount.has(session.accountId)) {
              const conns = await this.deps.providerConnections.findAllForAccount(
                session.accountId,
              );
              providerId = conns[0]?.providerId ?? null;
              providerByAccount.set(session.accountId, providerId);
            }
          }
          providerBySession.set(item.sessionId, providerId);
        }
        if (providerId === null) continue;
        entries.push({
          providerId,
          trackUri: item.trackUri,
          trackName: item.trackName,
          artistName: item.artistName,
          albumArtUrl: item.albumArtUrl,
          durationMs: item.durationMs,
          seenIncrement: 0,
          requestedIncrement: 1,
          seenAt: item.createdAt,
        });
      }
      const merged = mergeCatalogUpserts(entries);
      if (merged.length === 0) return [];
      await this.deps.repository.upsertMany(merged);
      return merged.map((entry) => applyCatalogUpsert(undefined, entry));
    } catch (err) {
      this.logger.error('[track-catalog] backfill from queue items failed', err);
      return [];
    }
  }

  private applyToIndex(entries: ReadonlyArray<TrackCatalogUpsert>): void {
    const index = this.index;
    if (!index) return;
    for (const entry of entries) {
      const existing = index
        .get(entry.providerId)
        ?.get(catalogKey(entry.providerId, entry.trackUri));
      setEntry(index, applyCatalogUpsert(existing?.record, entry));
    }
  }
}

function setEntry(
  index: Map<string, Map<string, IndexedCatalogEntry>>,
  record: TrackCatalogRecord,
): void {
  let entries = index.get(record.providerId);
  if (!entries) {
    entries = new Map();
    index.set(record.providerId, entries);
  }
  entries.set(catalogKey(record.providerId, record.trackUri), indexCatalogRecord(record));
}

function toUpsert(
  providerId: string,
  track: Track,
  increments: { seen: number; requested: number },
  seenAt: Date,
): TrackCatalogUpsert {
  return {
    providerId,
    trackUri: track.uri,
    trackName: track.name,
    artistName: track.artist,
    albumArtUrl: track.albumArt,
    durationMs: track.durationMs,
    seenIncrement: increments.seen,
    requestedIncrement: increments.requested,
    seenAt,
    ...withIsrc(track.isrc),
  };
}
