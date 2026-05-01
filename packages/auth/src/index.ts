/**
 * @opendj/auth — runtime-neutral authentication primitives for OpenDJ.
 *
 * What lives here:
 * - Claim type + AuthContext + claim-assertion helpers
 * - OAuthProviderConfig + pure OAuth helpers (buildAuthorizeUrl, exchangeCode,
 *   refreshTokens, shouldRefresh) — fetch-based, no SDK, work in Node + Workers
 * - PasswordHasher INTERFACE plus algorithm-detection / constant-time helpers
 * - Session token generation + SHA-256 hashing (Web Crypto)
 *
 * What lives in @opendj/backend instead:
 * - Concrete Argon2id PasswordHasher (Node-native; not Workers-safe)
 * - Hono middleware (requireAuth, requireClaim, ...)
 * - AuthService / ClaimsService that touch the database
 *
 * See docs/agent-brief.md §"Authentication, accounts, and claims" + §"OAuth utilities".
 */

export * from './claims.js';
export * from './oauth/index.js';
export * from './password.js';
export * from './session-token.js';
