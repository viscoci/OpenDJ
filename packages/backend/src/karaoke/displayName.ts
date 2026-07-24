/**
 * Karaoke display-name sanitization.
 *
 * Guests type these on their phones and the result lands on the TV — so the
 * server normalizes aggressively: strip control characters (C0 + DEL + C1),
 * collapse nothing else (inner spacing is the singer's choice), trim edges.
 * The sanitized result must be 1–40 characters; anything else is rejected
 * upstream with `invalid_display_name`.
 */

export const KARAOKE_DISPLAY_NAME_MAX = 40;

// C0 controls (U+0000–U+001F), DEL (U+007F), and C1 controls (U+0080–U+009F).
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

/**
 * Returns the sanitized display name, or `null` when the result is empty or
 * longer than {@link KARAOKE_DISPLAY_NAME_MAX} — callers map `null` to the
 * `invalid_display_name` error code.
 */
export function sanitizeKaraokeDisplayName(raw: string): string | null {
  const cleaned = raw.replace(CONTROL_CHARS, '').trim();
  if (cleaned.length < 1 || cleaned.length > KARAOKE_DISPLAY_NAME_MAX) return null;
  return cleaned;
}
