import { parseLrc } from '../lrc-parser.js';
import type {
  LyricsDocument,
  LyricsLookupInput,
  LyricsMatchConfidence,
  LyricsProvider,
} from '../types.js';

/**
 * LRCLIB adapter. Uses the public LRCLIB HTTP API (https://lrclib.net/docs).
 *
 * Implementation rules from docs/agent-brief.md §"LRCLIB adapter":
 * - Built on `fetch`, no Node-only SDK; works in Node + Workers + browsers
 * - Normalizes track metadata before lookup
 * - Prefers synced lyrics; falls back to plain when synced not available
 * - Never throws on lookup failure — returns null/empty so playback never blocks
 * - Treats results as third-party content; populates `attribution`
 */

const DEFAULT_BASE_URL = 'https://lrclib.net/api';
const DEFAULT_USER_AGENT = 'OpenDJ Lyrics Adapter (+https://github.com/viscoci/opendj)';

export interface LrclibAdapterOptions {
  baseUrl?: string;
  userAgent?: string;
  /** Inject a fetch implementation. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

interface LrclibTrackResponse {
  id: number;
  trackName: string;
  artistName: string;
  albumName?: string | null;
  duration?: number | null;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

export class LrclibAdapter implements LyricsProvider {
  readonly providerId = 'lrclib';
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LrclibAdapterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    // Bind to globalThis to preserve `this` in environments where fetch is a method.
    this.fetchImpl = (options.fetchImpl ?? globalThis.fetch).bind(globalThis);
  }

  async getBestMatch(input: LyricsLookupInput): Promise<LyricsDocument | null> {
    const params = new URLSearchParams({
      track_name: input.trackName,
      artist_name: input.artistName,
    });
    if (input.albumName) params.set('album_name', input.albumName);
    if (input.durationMs != null && input.durationMs > 0) {
      params.set('duration', String(Math.round(input.durationMs / 1000)));
    }
    const url = `${this.baseUrl}/get?${params.toString()}`;
    const response = await this.safeFetch(url);
    if (!response || !response.ok) return null;
    const body = (await this.safeJson<LrclibTrackResponse>(response)) ?? null;
    if (!body) return null;
    return this.toDocument(body, 'high');
  }

  async search(input: LyricsLookupInput): Promise<LyricsDocument[]> {
    const params = new URLSearchParams({
      track_name: input.trackName,
      artist_name: input.artistName,
    });
    if (input.albumName) params.set('album_name', input.albumName);
    const url = `${this.baseUrl}/search?${params.toString()}`;
    const response = await this.safeFetch(url);
    if (!response || !response.ok) return [];
    const body = (await this.safeJson<LrclibTrackResponse[]>(response)) ?? [];
    return body.map((row) => this.toDocument(row, 'medium'));
  }

  private toDocument(row: LrclibTrackResponse, confidence: LyricsMatchConfidence): LyricsDocument {
    const synced = row.syncedLyrics?.trim();
    const plain = row.plainLyrics?.trim();
    const isSynced = synced !== undefined && synced.length > 0;

    const document: LyricsDocument = {
      id: `lrclib:${row.id}`,
      source: 'lrclib',
      providerLyricsId: row.id,
      trackName: row.trackName,
      artistName: row.artistName,
      albumName: row.albumName ?? null,
      durationMs: row.duration != null ? Math.round(row.duration * 1000) : null,
      isSynced,
      lines: isSynced ? parseLrc(synced!) : [],
      attribution: 'Lyrics from LRCLIB (https://lrclib.net) — CC0',
      matchConfidence: confidence,
    };
    if (row.instrumental !== undefined) {
      document.isInstrumental = row.instrumental;
    }
    if (synced && synced.length > 0) {
      document.rawLrc = synced;
    }
    if (plain && plain.length > 0) {
      document.plainText = plain;
    }
    return document;
  }

  private async safeFetch(url: string): Promise<Response | null> {
    try {
      return await this.fetchImpl(url, {
        headers: {
          accept: 'application/json',
          'user-agent': this.userAgent,
        },
      });
    } catch {
      return null;
    }
  }

  private async safeJson<T>(response: Response): Promise<T | null> {
    try {
      return (await response.json()) as T;
    } catch {
      return null;
    }
  }
}
