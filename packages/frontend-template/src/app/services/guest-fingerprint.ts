/**
 * Stable per-device fingerprint for the guest QR-code journey.
 *
 * Backed by `localStorage` — the fingerprint persists across reloads but
 * resets per browser/device, which matches OpenDJ's per-guest model.
 *
 * The fingerprint is opaque to the backend (just gets salted + hashed
 * server-side). 32 hex chars = 128 bits of entropy, plenty for slot dedup.
 *
 * SSR-safe: returns a stable placeholder when `localStorage` isn't reachable
 * (e.g. server prerender). The real value is computed once the page hydrates.
 */

const STORAGE_KEY = 'opendj.guest_fingerprint';

export function getOrCreateGuestFingerprint(): string {
  if (typeof globalThis.localStorage === 'undefined') {
    return 'ssr-placeholder';
  }
  try {
    const existing = globalThis.localStorage.getItem(STORAGE_KEY);
    if (existing && /^[0-9a-f]{32}$/.test(existing)) return existing;
    const fresh = generateHex(16);
    globalThis.localStorage.setItem(STORAGE_KEY, fresh);
    return fresh;
  } catch {
    // Storage may be blocked (private mode, embedded webview); fall through to ephemeral.
    return generateHex(16);
  }
}

function generateHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < byteLength; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
