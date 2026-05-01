/**
 * Pluggable password hasher. The default OSS Node implementation uses Argon2id
 * — that concrete impl lives in @opendj/backend (it has a native dep) so this
 * package stays runtime-neutral.
 *
 * Workers / browsers that need password verification (rare; we prefer OAuth)
 * can plug in a WASM Argon2id implementation that satisfies this interface.
 */
export interface PasswordHasher {
  /** Hash a plaintext password. The returned string MUST encode the algorithm + parameters + salt. */
  hashPassword(password: string): Promise<string>;
  verifyPassword(password: string, hash: string): Promise<boolean>;
  /** True when the stored hash uses outdated parameters and should be re-hashed on next login. */
  needsRehash(hash: string): boolean;
}

/**
 * Inspect a hash string and report the algorithm it encodes (the prefix before
 * the first `$` after the leading `$`). Useful for migrating between
 * implementations and for the audit trail in `password_credentials.hash_algorithm`.
 *
 * Returns the algorithm in lowercase, or `null` for unrecognized formats.
 */
export function detectHashAlgorithm(hash: string): string | null {
  const match = /^\$([a-z0-9]+)(?:\$|$)/i.exec(hash);
  return match ? match[1]!.toLowerCase() : null;
}

/**
 * Constant-time string comparison. Useful when comparing tokens or non-Argon
 * digests where you still want timing-attack resistance.
 *
 * Returns false if lengths differ. The early-exit-on-length is the standard
 * trade-off — leaking length is acceptable when both sides are fixed-length
 * tokens of known size.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
