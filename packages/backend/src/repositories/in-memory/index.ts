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
  OAuthStateRecord,
  OAuthStateRepository,
  PasswordCredentialRecord,
  PasswordCredentialRepository,
  ProviderConnectionRecord,
  ProviderConnectionRepository,
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

export class InMemoryOAuthStateRepository implements OAuthStateRepository {
  readonly rows = new Map<string, OAuthStateRecord>();
  constructor(private readonly clock: InMemoryClock = systemClock) {}

  async create(input: {
    state: string;
    flowKind: 'login' | 'connect-provider';
    providerId: string;
    accountId?: string | null;
    userId?: string | null;
    redirectTo?: string | null;
    codeVerifier?: string | null;
    nonce?: string | null;
    expiresAt: Date;
  }): Promise<OAuthStateRecord> {
    const row: OAuthStateRecord = {
      state: input.state,
      flowKind: input.flowKind,
      providerId: input.providerId,
      accountId: input.accountId ?? null,
      userId: input.userId ?? null,
      redirectTo: input.redirectTo ?? null,
      codeVerifier: input.codeVerifier ?? null,
      nonce: input.nonce ?? null,
      createdAt: this.clock.now(),
      expiresAt: input.expiresAt,
    };
    this.rows.set(input.state, row);
    return row;
  }

  async findActive(state: string, nowEpochMs: number): Promise<OAuthStateRecord | null> {
    const row = this.rows.get(state);
    if (!row) return null;
    if (row.expiresAt.getTime() <= nowEpochMs) return null;
    return row;
  }

  async delete(state: string): Promise<void> {
    this.rows.delete(state);
  }

  async pruneExpired(nowEpochMs: number): Promise<number> {
    let count = 0;
    for (const [state, row] of this.rows.entries()) {
      if (row.expiresAt.getTime() <= nowEpochMs) {
        this.rows.delete(state);
        count += 1;
      }
    }
    return count;
  }
}

export class InMemoryProviderConnectionRepository implements ProviderConnectionRepository {
  /** Composite key: `${accountId}:${providerId}` (matches the unique index). */
  readonly rows = new Map<string, ProviderConnectionRecord>();
  constructor(private readonly clock: InMemoryClock = systemClock) {}

  async findByAccountAndProvider(
    accountId: string,
    providerId: string,
  ): Promise<ProviderConnectionRecord | null> {
    return this.rows.get(`${accountId}:${providerId}`) ?? null;
  }

  async findAllForAccount(accountId: string): Promise<ProviderConnectionRecord[]> {
    const out: ProviderConnectionRecord[] = [];
    for (const row of this.rows.values()) {
      if (row.accountId === accountId) out.push(row);
    }
    return out;
  }

  async upsert(input: {
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
  }): Promise<ProviderConnectionRecord> {
    const key = `${input.accountId}:${input.providerId}`;
    const now = this.clock.now();
    const existing = this.rows.get(key);
    const row: ProviderConnectionRecord = {
      id: existing?.id ?? crypto.randomUUID(),
      accountId: input.accountId,
      connectedByUserId: input.connectedByUserId ?? existing?.connectedByUserId ?? null,
      providerId: input.providerId,
      providerAccountId: input.providerAccountId ?? existing?.providerAccountId ?? null,
      displayName: input.displayName ?? existing?.displayName ?? null,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken ?? existing?.refreshToken ?? null,
      expiresAt: input.expiresAt ?? existing?.expiresAt ?? null,
      scopes: input.scopes ?? existing?.scopes ?? null,
      tokenType: input.tokenType ?? existing?.tokenType ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.rows.set(key, row);
    return row;
  }

  async updateTokens(input: {
    id: string;
    accessToken: string;
    refreshToken?: string | null;
    expiresAt?: Date | null;
    tokenType?: string | null;
  }): Promise<void> {
    for (const row of this.rows.values()) {
      if (row.id !== input.id) continue;
      row.accessToken = input.accessToken;
      if (input.refreshToken !== undefined) row.refreshToken = input.refreshToken;
      if (input.expiresAt !== undefined) row.expiresAt = input.expiresAt;
      if (input.tokenType !== undefined) row.tokenType = input.tokenType;
      row.updatedAt = this.clock.now();
      return;
    }
  }

  async delete(id: string): Promise<void> {
    for (const [key, row] of this.rows.entries()) {
      if (row.id === id) {
        this.rows.delete(key);
        return;
      }
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
    oauthStates: new InMemoryOAuthStateRepository(clock),
    providerConnections: new InMemoryProviderConnectionRepository(clock),
  };
}
