/**
 * ISRC helpers and OpenDJ's provider-agnostic track URIs
 * (`opendj:isrc:<ISRC>`), minted by external search sources and resolved to
 * a provider-native URI when a guest adds the track.
 */

import { OPENDJ_TRACK_URI_SCHEME } from '@opendj/core';

const ISRC_URI_PREFIX = `${OPENDJ_TRACK_URI_SCHEME}isrc:`;
/** CC-XXX-YY-NNNNN without separators. */
const ISRC_PATTERN = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

/** Uppercase, separators dropped; null unless it is a well-formed ISRC. */
export function normalizeIsrc(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const isrc = value.replace(/[\s-]/g, '').toUpperCase();
  return ISRC_PATTERN.test(isrc) ? isrc : null;
}

/** `opendj:isrc:<ISRC>` for a recording. Throws on a malformed ISRC. */
export function isrcTrackUri(isrc: string): string {
  const normalized = normalizeIsrc(isrc);
  if (normalized === null) throw new RangeError(`Not an ISRC: ${isrc}`);
  return `${ISRC_URI_PREFIX}${normalized}`;
}

/** The ISRC in an `opendj:isrc:` URI, or null for any other URI. */
export function isrcFromTrackUri(uri: string): string | null {
  if (!uri.startsWith(ISRC_URI_PREFIX)) return null;
  return normalizeIsrc(uri.slice(ISRC_URI_PREFIX.length));
}
