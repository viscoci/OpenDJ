/**
 * Session token utilities.
 *
 * Browser clients see ONLY an opaque session token in a secure httpOnly cookie.
 * Server-side, we store the SHA-256 of the token in `auth_sessions.session_hash`
 * — so a database leak never compromises live sessions.
 *
 * Uses Web Crypto via `globalThis.crypto`, which is present in Node 22, all
 * modern browsers, and Cloudflare Workers.
 */

const TOKEN_BYTE_LENGTH = 32;

function getCrypto(): Crypto {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function' || c.subtle === undefined) {
    throw new Error('Web Crypto API is not available in this runtime.');
  }
  return c;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += (bytes[i]! >> 4).toString(16);
    out += (bytes[i]! & 0x0f).toString(16);
  }
  return out;
}

/**
 * Generate a cryptographically random opaque session token, encoded as
 * lowercase hex (64 chars from 32 bytes).
 */
export function generateSessionToken(): string {
  const c = getCrypto();
  const bytes = new Uint8Array(TOKEN_BYTE_LENGTH);
  c.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/**
 * Hash a session token for storage / lookup. SHA-256 hex.
 */
export async function hashSessionToken(token: string): Promise<string> {
  const c = getCrypto();
  const data = new TextEncoder().encode(token);
  const digest = await c.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(digest));
}
