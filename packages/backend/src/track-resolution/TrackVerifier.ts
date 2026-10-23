/**
 * Add-time verification of a resolved track: does the recording a
 * non-catalog resolver answered look like the one the guest picked?
 *
 * Mapping services occasionally point an ISRC at the wrong recording (a
 * karaoke or tribute version of the song). A `TrackVerifier` checks one
 * provider's answer against the requested track name; `TrackResolverChain`
 * asks the verifier for the session's provider, if any, before accepting a
 * non-catalog answer. No verifier for a provider → every answer is accepted.
 *
 * Verdicts:
 *   - `match`: accept.
 *   - `mismatch`: reject; the chain treats it as a miss and asks the next resolver.
 *   - `unavailable`: the check itself failed (timeout, error, limiter); the
 *     chain accepts (fail-open) so a flaky check never blocks an add.
 */

export interface TrackVerifyRequest {
  /** The native URI a resolver answered. */
  uri: string;
  /** The guest's pick: its track name. */
  trackName: string;
  /** The guest's pick: its artist, when known. */
  artistName?: string;
}

export type TrackVerdict =
  | { verdict: 'match' }
  | { verdict: 'mismatch'; title: string; reason: string }
  | { verdict: 'unavailable'; reason: string };

export interface TrackVerifier {
  /** The provider whose URIs this verifier checks. */
  readonly providerId: string;
  verify(request: TrackVerifyRequest): Promise<TrackVerdict>;
}

/**
 * Words that mark a re-recording rather than the original. Matched as whole
 * token phrases on the loosely normalised title (so `K-Mix` is `k mix`).
 */
const COVER_MARKERS: ReadonlyArray<string> = [
  'karaoke',
  'k mix',
  'originally performed',
  'in the style of',
  'made famous by',
  'tribute',
  'cover',
  'instrumental',
];

/** Token overlap (shared / larger token count) at or above this matches. */
const MIN_TOKEN_OVERLAP = 0.6;

/** Lowercase, accents and apostrophes dropped, other punctuation → spaces. */
function loose(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * The core title: bracketed and parenthetical parts, ` - ` suffixes
 * (`Radio Edit`, `Remastered 2011`) and a trailing `feat. ...` removed.
 * Falls back to the loose title when nothing is left.
 */
function core(text: string): string {
  const stripped = text
    .replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, ' ')
    .replace(/\s[-–—]\s.*$/u, ' ')
    .replace(/\s(?:feat|ft|featuring)\.?\s.*$/iu, ' ');
  return loose(stripped) || loose(text);
}

function hasPhrase(normalised: string, phrase: string): boolean {
  return ` ${normalised} `.includes(` ${phrase} `);
}

/**
 * Whether `candidate` (the provider's title for the resolved URI) is the
 * recording `requested` (the guest's pick) names. A cover marker in the
 * candidate the requested name doesn't carry rejects; otherwise the core
 * titles match when one contains the other (whole tokens) or their tokens
 * overlap by at least 0.6.
 */
export function compareTitles(
  requested: string,
  candidate: string,
): { ok: true } | { ok: false; reason: string } {
  const requestedLoose = loose(requested);
  const candidateLoose = loose(candidate);
  for (const marker of COVER_MARKERS) {
    if (hasPhrase(candidateLoose, marker) && !hasPhrase(requestedLoose, marker)) {
      return { ok: false, reason: `cover marker "${marker}"` };
    }
  }

  const a = core(requested);
  const b = core(candidate);
  if (a === b || hasPhrase(a, b) || hasPhrase(b, a)) return { ok: true };

  const aTokens = new Set(a.split(' '));
  const bTokens = new Set(b.split(' '));
  let shared = 0;
  for (const token of aTokens) if (bTokens.has(token)) shared += 1;
  const overlap = shared / Math.max(aTokens.size, bTokens.size);
  return overlap >= MIN_TOKEN_OVERLAP
    ? { ok: true }
    : { ok: false, reason: `title mismatch (overlap ${overlap.toFixed(2)})` };
}

/** Splits an artist credit on commas, ` & `, ` and ` and `feat.` joins. */
const ARTIST_SEPARATOR = /\s*,\s*|\s+(?:&|and|feat\.?|ft\.?|featuring)\s+/iu;

/** One artist name, loose, with brackets and a leading `the` dropped. */
function looseArtist(name: string): string {
  return loose(name.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')).replace(/^the\s+/u, '');
}

/** The whole credit plus each split part, loosened, empties dropped. */
function artistNames(credit: string): string[] {
  const names = [credit, ...credit.split(ARTIST_SEPARATOR)].map(looseArtist);
  return [...new Set(names.filter((name) => name !== ''))];
}

/**
 * Whether the requested artist credit (the guest's pick) is among the
 * artists a provider credits the resolved recording to. Names are loosened
 * (case, accents, punctuation, a leading `the`); any requested name that
 * equals or contains / is contained in (whole tokens) any page artist matches.
 */
export function compareArtists(
  requested: string,
  candidates: ReadonlyArray<string>,
): { ok: true } | { ok: false; reason: string } {
  const wanted = artistNames(requested);
  const offered = candidates.flatMap(artistNames);
  if (wanted.length === 0) return { ok: true };
  for (const a of wanted) {
    for (const b of offered) {
      if (a === b || hasPhrase(a, b) || hasPhrase(b, a)) return { ok: true };
    }
  }
  return { ok: false, reason: `artist mismatch (credited to ${candidates.join(', ')})` };
}
