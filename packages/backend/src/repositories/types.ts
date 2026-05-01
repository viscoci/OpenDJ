/**
 * Repository interfaces between services and the database.
 *
 * Services depend on these interfaces — never on Drizzle directly. Production
 * wires the Drizzle-backed implementations in `./drizzle/`; tests use the
 * in-memory implementations in `./in-memory/`. This pattern keeps services
 * unit-testable without spinning up Postgres.
 */

import type { Claim } from '@opendj/auth';

export interface UserRecord {
  id: string;
  publicUserId: number;
  displayName: string | null;
  primaryEmail: string | null;
  emailVerified: boolean;
  avatarUrl: string | null;
  status: 'active' | 'disabled' | 'deleted';
  createdAt: Date;
  updatedAt: Date;
}

export interface AccountRecord {
  id: string;
  displayName: string;
  slug: string;
  plan: 'free' | 'paid_monthly' | 'paid_event' | 'oss';
  createdAt: Date;
}

export interface MembershipRecord {
  accountId: string;
  userId: string;
  status: 'active' | 'invited' | 'disabled';
  role: 'owner' | 'admin' | 'host' | 'member';
  claims: Claim[];
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthIdentityRecord {
  id: string;
  userId: string;
  providerId: string;
  providerSubject: string;
  email: string | null;
  emailVerified: boolean;
  rawProfile: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthSessionRecord {
  id: string;
  userId: string;
  currentAccountId: string | null;
  sessionHash: string;
  claimsSnapshot: Claim[];
  ipHash: string | null;
  userAgentHash: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface PasswordCredentialRecord {
  userId: string;
  passwordHash: string;
  hashAlgorithm: string;
  passwordUpdatedAt: Date;
  failedAttempts: number;
  lockedUntil: Date | null;
}

// ─── Repository interfaces ────────────────────────────────────────────────

export interface UserRepository {
  findById(id: string): Promise<UserRecord | null>;
  findByPrimaryEmail(email: string): Promise<UserRecord | null>;
  create(input: {
    primaryEmail?: string | null;
    displayName?: string | null;
    avatarUrl?: string | null;
    emailVerified?: boolean;
  }): Promise<UserRecord>;
}

export interface AccountRepository {
  findById(id: string): Promise<AccountRecord | null>;
  findBySlug(slug: string): Promise<AccountRecord | null>;
}

export interface MembershipRepository {
  find(accountId: string, userId: string): Promise<MembershipRecord | null>;
  findAllForUser(userId: string): Promise<MembershipRecord[]>;
}

export interface AuthIdentityRepository {
  findByProvider(providerId: string, providerSubject: string): Promise<AuthIdentityRecord | null>;
  create(input: {
    userId: string;
    providerId: string;
    providerSubject: string;
    email?: string | null;
    emailVerified?: boolean;
    rawProfile?: unknown;
  }): Promise<AuthIdentityRecord>;
}

export interface AuthSessionRepository {
  /** Insert a new session row. Caller hashes the opaque token before calling. */
  create(input: {
    userId: string;
    currentAccountId: string | null;
    sessionHash: string;
    claimsSnapshot: Claim[];
    ipHash?: string | null;
    userAgentHash?: string | null;
    expiresAt: Date;
  }): Promise<AuthSessionRecord>;
  findActiveByHash(sessionHash: string, nowEpochMs: number): Promise<AuthSessionRecord | null>;
  /** Bump `lastSeenAt` to the given timestamp. Used on every authenticated request. */
  touch(id: string, nowEpochMs: number): Promise<void>;
  revoke(id: string, nowEpochMs: number): Promise<void>;
  /** Refresh the persisted claims snapshot (e.g. after membership change). */
  updateClaimsSnapshot(id: string, claims: Claim[]): Promise<void>;
  /** Switch the active account on a session row. Used by /api/v1/auth/switch-account. */
  updateCurrentAccount(id: string, accountId: string | null): Promise<void>;
}

export interface PasswordCredentialRepository {
  findByUser(userId: string): Promise<PasswordCredentialRecord | null>;
  upsert(input: {
    userId: string;
    passwordHash: string;
    hashAlgorithm: string;
  }): Promise<PasswordCredentialRecord>;
  recordFailedAttempt(userId: string, lockUntil: Date | null): Promise<void>;
  resetFailedAttempts(userId: string): Promise<void>;
}

export interface ProviderConnectionRecord {
  id: string;
  accountId: string;
  connectedByUserId: string | null;
  providerId: string;
  providerAccountId: string | null;
  displayName: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[] | null;
  tokenType: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProviderConnectionRepository {
  findByAccountAndProvider(
    accountId: string,
    providerId: string,
  ): Promise<ProviderConnectionRecord | null>;
  findAllForAccount(accountId: string): Promise<ProviderConnectionRecord[]>;
  upsert(input: {
    accountId: string;
    connectedByUserId?: string | null;
    providerId: string;
    providerAccountId?: string | null;
    displayName?: string | null;
    accessToken: string | null;
    refreshToken?: string | null;
    expiresAt?: Date | null;
    scopes?: string[] | null;
    tokenType?: string | null;
  }): Promise<ProviderConnectionRecord>;
  /** Update tokens after refresh. Does not change account / provider association. */
  updateTokens(input: {
    id: string;
    accessToken: string;
    refreshToken?: string | null;
    expiresAt?: Date | null;
    tokenType?: string | null;
  }): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface Repositories {
  users: UserRepository;
  accounts: AccountRepository;
  memberships: MembershipRepository;
  authIdentities: AuthIdentityRepository;
  authSessions: AuthSessionRepository;
  passwordCredentials: PasswordCredentialRepository;
  providerConnections: ProviderConnectionRepository;
}
