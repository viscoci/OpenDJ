/**
 * In-memory repository implementations for unit tests.
 *
 * Each store is a plain Map keyed by primary key. Lookups by other indexes
 * walk the Map — this is fine for the test data sizes we care about (<<100
 * rows per table) and keeps the impl trivial to reason about.
 *
 * `clock()` lets tests inject a deterministic Date for createdAt / updatedAt /
 * lastSeenAt.
 */

import type { Claim } from '@opendj/auth';
import type {
  AccountRecord,
  AccountRepository,
  AuthIdentityRecord,
  AuthIdentityRepository,
  AuthSessionRecord,
  AuthSessionRepository,
  MembershipRecord,
  MembershipRepository,
  PasswordCredentialRecord,
  PasswordCredentialRepository,
  Repositories,
  UserRecord,
  UserRepository,
} from '../types.js';

export interface InMemoryClock {
  now(): Date;
}

export const systemClock: InMemoryClock = {
  now: () => new Date(),
};

let nextPublicUserId = 1;

export class InMemoryUserRepository implements UserRepository {
  readonly rows = new Map<string, UserRecord>();
  constructor(private readonly clock: InMemoryClock = systemClock) {}

  async findById(id: string): Promise<UserRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async findByPrimaryEmail(email: string): Promise<UserRecord | null> {
    const lower = email.toLowerCase();
    for (const row of this.rows.values()) {
      if (row.primaryEmail?.toLowerCase() === lower) return row;
    }
    return null;
  }

  async create(input: {
    primaryEmail?: string | null;
    displayName?: string | null;
    avatarUrl?: string | null;
    emailVerified?: boolean;
  }): Promise<UserRecord> {
    const id = crypto.randomUUID();
    const now = this.clock.now();
    const row: UserRecord = {
      id,
      publicUserId: nextPublicUserId++,
      displayName: input.displayName ?? null,
      primaryEmail: input.primaryEmail ?? null,
      emailVerified: input.emailVerified ?? false,
      avatarUrl: input.avatarUrl ?? null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(id, row);
    return row;
  }
}

export class InMemoryAccountRepository implements AccountRepository {
  readonly rows = new Map<string, AccountRecord>();

  async findById(id: string): Promise<AccountRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async findBySlug(slug: string): Promise<AccountRecord | null> {
    for (const row of this.rows.values()) {
      if (row.slug === slug) return row;
    }
    return null;
  }

  /** Test helper: seed a row directly. */
  seed(record: AccountRecord): void {
    this.rows.set(record.id, record);
  }
}

export class InMemoryMembershipRepository implements MembershipRepository {
  /** Composite key: `${accountId}:${userId}`. */
  readonly rows = new Map<string, MembershipRecord>();

  async find(accountId: string, userId: string): Promise<MembershipRecord | null> {
    return this.rows.get(`${accountId}:${userId}`) ?? null;
  }

  async findAllForUser(userId: string): Promise<MembershipRecord[]> {
    const result: MembershipRecord[] = [];
    for (const row of this.rows.values()) {
      if (row.userId === userId) result.push(row);
    }
    return result;
  }

  /** Test helper: insert/update a membership. */
  seed(record: MembershipRecord): void {
    this.rows.set(`${record.accountId}:${record.userId}`, record);
  }
}

export class InMemoryAuthIdentityRepository implements AuthIdentityRepository {
  readonly rows = new Map<string, AuthIdentityRecord>();
  constructor(private readonly clock: InMemoryClock = systemClock) {}

  async findByProvider(
    providerId: string,
    providerSubject: string,
  ): Promise<AuthIdentityRecord | null> {
    for (const row of this.rows.values()) {
      if (row.providerId === providerId && row.providerSubject === providerSubject) {
        return row;
      }
    }
    return null;
  }

  async create(input: {
    userId: string;
    providerId: string;
    providerSubject: string;
    email?: string | null;
    emailVerified?: boolean;
    rawProfile?: unknown;
  }): Promise<AuthIdentityRecord> {
    const id = crypto.randomUUID();
    const now = this.clock.now();
    const row: AuthIdentityRecord = {
      id,
      userId: input.userId,
      providerId: input.providerId,
      providerSubject: input.providerSubject,
      email: input.email ?? null,
      emailVerified: input.emailVerified ?? false,
      rawProfile: input.rawProfile ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(id, row);
    return row;
  }
}

export class InMemoryAuthSessionRepository implements AuthSessionRepository {
  readonly rows = new Map<string, AuthSessionRecord>();
  constructor(private readonly clock: InMemoryClock = systemClock) {}

  async create(input: {
    userId: string;
    currentAccountId: string | null;
    sessionHash: string;
    claimsSnapshot: Claim[];
    ipHash?: string | null;
    userAgentHash?: string | null;
    expiresAt: Date;
  }): Promise<AuthSessionRecord> {
    const id = crypto.randomUUID();
    const now = this.clock.now();
    const row: AuthSessionRecord = {
      id,
      userId: input.userId,
      currentAccountId: input.currentAccountId,
      sessionHash: input.sessionHash,
      claimsSnapshot: [...input.claimsSnapshot],
      ipHash: input.ipHash ?? null,
      userAgentHash: input.userAgentHash ?? null,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: input.expiresAt,
      revokedAt: null,
    };
    this.rows.set(id, row);
    return row;
  }

  async findActiveByHash(
    sessionHash: string,
    nowEpochMs: number,
  ): Promise<AuthSessionRecord | null> {
    for (const row of this.rows.values()) {
      if (row.sessionHash !== sessionHash) continue;
      if (row.revokedAt !== null) continue;
      if (row.expiresAt.getTime() <= nowEpochMs) continue;
      return row;
    }
    return null;
  }

  async touch(id: string, nowEpochMs: number): Promise<void> {
    const row = this.rows.get(id);
    if (row) row.lastSeenAt = new Date(nowEpochMs);
  }

  async revoke(id: string, nowEpochMs: number): Promise<void> {
    const row = this.rows.get(id);
    if (row) row.revokedAt = new Date(nowEpochMs);
  }

  async updateClaimsSnapshot(id: string, claims: Claim[]): Promise<void> {
    const row = this.rows.get(id);
    if (row) row.claimsSnapshot = [...claims];
  }

  async updateCurrentAccount(id: string, accountId: string | null): Promise<void> {
    const row = this.rows.get(id);
    if (row) row.currentAccountId = accountId;
  }
}

export class InMemoryPasswordCredentialRepository implements PasswordCredentialRepository {
  readonly rows = new Map<string, PasswordCredentialRecord>();
  constructor(private readonly clock: InMemoryClock = systemClock) {}

  async findByUser(userId: string): Promise<PasswordCredentialRecord | null> {
    return this.rows.get(userId) ?? null;
  }

  async upsert(input: {
    userId: string;
    passwordHash: string;
    hashAlgorithm: string;
  }): Promise<PasswordCredentialRecord> {
    const now = this.clock.now();
    const row: PasswordCredentialRecord = {
      userId: input.userId,
      passwordHash: input.passwordHash,
      hashAlgorithm: input.hashAlgorithm,
      passwordUpdatedAt: now,
      failedAttempts: 0,
      lockedUntil: null,
    };
    this.rows.set(input.userId, row);
    return row;
  }

  async recordFailedAttempt(userId: string, lockUntil: Date | null): Promise<void> {
    const row = this.rows.get(userId);
    if (row) {
      row.failedAttempts += 1;
      row.lockedUntil = lockUntil;
    }
  }

  async resetFailedAttempts(userId: string): Promise<void> {
    const row = this.rows.get(userId);
    if (row) {
      row.failedAttempts = 0;
      row.lockedUntil = null;
    }
  }
}

export function createInMemoryRepositories(clock: InMemoryClock = systemClock): Repositories {
  return {
    users: new InMemoryUserRepository(clock),
    accounts: new InMemoryAccountRepository(),
    memberships: new InMemoryMembershipRepository(),
    authIdentities: new InMemoryAuthIdentityRepository(clock),
    authSessions: new InMemoryAuthSessionRepository(clock),
    passwordCredentials: new InMemoryPasswordCredentialRepository(clock),
  };
}
