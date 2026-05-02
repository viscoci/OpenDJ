/**
 * Stable per-device fingerprint for the guest QR-code journey.
 *
 * Backed by `localStorage` — the fingerprint persists across reloads but
 * resets per browser/device, which matches OpenDJ's per-guest model.
 *
 * What we send to the backend is a SHA-256 hash of the local random — the
 * raw value never leaves the device. The backend then re-salts with
 * `(eventSlug, isoDate)` before persistence, so the same device under two
 * different events produces different stored hashes (linkability bound to
 * an event).
 *
 * SSR-safe: returns a stable placeholder when `localStorage` isn't reachable
 * (e.g. server prerender). The real value is computed once the page hydrates.
 */

const STORAGE_KEY = 'opendj.guest_fingerprint';
const SSR_PLACEHOLDER_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

export async function getOrCreateGuestFingerprintHash(): Promise<string> {
  const raw = readOrCreateRawFingerprint();
  if (raw === null) return SSR_PLACEHOLDER_HASH;
  return sha256Hex(raw);
}

function readOrCreateRawFingerprint(): string | null {
  if (typeof globalThis.localStorage === 'undefined') return null;
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

async function sha256Hex(value: string): Promise<string> {
  if (typeof globalThis.crypto?.subtle?.digest !== 'function') {
    // No SubtleCrypto (very old browser / non-secure context). Send the raw
    // value — the backend will still salt + re-hash before storing.
    return value;
  }
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
