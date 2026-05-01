---
'@opendj/backend': minor
---

Add ClaimsService + the repository pattern that all data-access services will follow.

**Repository interfaces** (`@opendj/backend/repositories`):

- `UserRepository`, `AccountRepository`, `MembershipRepository`, `AuthIdentityRepository`, `AuthSessionRepository`, `PasswordCredentialRepository`
- Plain record types (`UserRecord` / `AccountRecord` / etc.) decoupled from Drizzle's inferred types — services depend on repositories, not on the ORM
- `Repositories` aggregate type for the service-deps graph

**Drizzle implementations** (`@opendj/backend/repositories/drizzle`):

- One class per interface, each scoped to a single table
- `createDrizzleRepositories(db)` factory that wires the lot
- Direct `drizzle-orm` queries — no extra abstraction over the ORM

**In-memory implementations** (`@opendj/backend/repositories/in-memory`):

- One class per interface backed by `Map`, with `seed()` test helpers on the relational ones
- Injectable clock for deterministic timestamps
- `createInMemoryRepositories()` factory
- `findActiveByHash` correctly filters revoked + expired sessions

**ClaimsService** (`@opendj/backend/auth`):

- `refreshClaims(userId, accountId)` — returns the active membership's claim list (empty array for non-member / invited / disabled)
- `assertMembership(userId, accountId)` — throws `NotAccountMemberError` with both ids attached
- `assertClaimOnAccount(userId, accountId, claim)` — throws `MissingClaimError` when missing
- `getAccountsForUser(userId)` — joins memberships + accounts; filters inactive memberships and orphaned account references; returns claim copies (not live arrays)

**29 new tests** (44 total in backend) covering the full ClaimsService surface — happy paths, inactive-membership filtering, deleted-account handling, copy semantics — plus in-memory repository invariants (case-insensitive email lookup, monotonic publicUserId, expired/revoked session filtering, claim snapshot updates).
