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
  AbuseSubjectRecord,
  AbuseSubjectRepository,
  AbuseSubjectStatus,
  AccountRecord,
  AccountRepository,
  ActionEventRecord,
  ActionEventRepository,
  AuthIdentityRecord,
  AuthIdentityRepository,
  AuthSessionRecord,
  AuthSessionRepository,
  EmailVerificationTokenRecord,
  EmailVerificationTokenRepository,
  FingerprintPriorityRecord,
  FingerprintPriorityRepository,
  GuestRecord,
  GuestRepository,
  GuestSlotRecord,
  GuestSlotRepository,
  GuestSlotStatus,
  LyricsCacheRecord,
  LyricsCacheRepository,
  LyricsFeedbackRecord,
  LyricsFeedbackRepository,
  MembershipRecord,
  MembershipRepository,
  OAuthStateRecord,
  OAuthStateRepository,
  PasswordCredentialRecord,
  PasswordCredentialRepository,
  PasswordResetTokenRecord,
  PasswordResetTokenRepository,
  ProviderConnectionRecord,
  ProviderConnectionRepository,
  QueueItemRecord,
  QueueItemRepository,
  QueueItemStatus,
  QueueSkipVoteRepository,
  Repositories,
  SessionAuditEventRecord,
  SessionAuditEventRepository,
  SessionRecord,
  SessionRepository,
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

  async setEmailVerified(userId: string): Promise<void> {
    const row = this.rows.get(userId);
    if (!row) return;
    if (row.emailVerified) return;
    this.rows.set(userId, { ...row, emailVerified: true, updatedAt: this.clock.now() });
  }
}

export class InMemoryAccountRepository implements AccountRepository {
  readonly rows = new Map<string, AccountRecord>();
  constructor(private readonly clock: InMemoryClock = systemClock) {}

  async findById(id: string): Promise<AccountRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async findBySlug(slug: string): Promise<AccountRecord | null> {
    for (const row of this.rows.values()) {
      if (row.slug === slug) return row;
    }
    return null;
  }

  async create(input: {
    displayName: string;
    slug: string;
    plan?: AccountRecord['plan'];
  }): Promise<AccountRecord> {
    if (await this.findBySlug(input.slug)) {
      throw new Error(`Account slug "${input.slug}" already exists.`);
    }
    const id = crypto.randomUUID();
    const row: AccountRecord = {
      id,
      displayName: input.displayName,
      slug: input.slug,
      plan: input.plan ?? 'oss',
      createdAt: this.clock.now(),
    };
    this.rows.set(id, row);
    return row;
  }

  /** Test helper: seed a row directly. */
  seed(record: AccountRecord): void {
    this.rows.set(record.id, record);
  }
}

export class InMemoryMembershipRepository implements MembershipRepository {
  /** Composite key: `${accountId}:${userId}`. */
  readonly rows = new Map<string, MembershipRecord>();
  constructor(private readonly clock: InMemoryClock = systemClock) {}

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

  async upsert(input: {
    accountId: string;
    userId: string;
    role: MembershipRecord['role'];
    claims: Claim[];
    status?: MembershipRecord['status'];
  }): Promise<MembershipRecord> {
    const key = `${input.accountId}:${input.userId}`;
    const existing = this.rows.get(key);
    const now = this.clock.now();
    const row: MembershipRecord = {
      accountId: input.accountId,
      userId: input.userId,
      status: input.status ?? 'active',
      role: input.role,
      claims: [...input.claims],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.rows.set(key, row);
    return row;
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

export class InMemoryEmailVerificationTokenRepository implements EmailVerificationTokenRepository {
  readonly rows = new Map<string, EmailVerificationTokenRecord>();
  constructor(private readonly clock: InMemoryClock = systemClock) {}

  async create(input: {
    tokenHash: string;
    userId: string;
    email: string;
    expiresAt: Date;
  }): Promise<EmailVerificationTokenRecord> {
    const row: EmailVerificationTokenRecord = {
      tokenHash: input.tokenHash,
      userId: input.userId,
      email: input.email,
      createdAt: this.clock.now(),
      expiresAt: input.expiresAt,
      consumedAt: null,
    };
    this.rows.set(input.tokenHash, row);
    return row;
  }

  async findActiveByHash(
    tokenHash: string,
    nowEpochMs: number,
  ): Promise<EmailVerificationTokenRecord | null> {
    const row = this.rows.get(tokenHash);
    if (!row) return null;
    if (row.consumedAt) return null;
    if (row.expiresAt.getTime() <= nowEpochMs) return null;
    return row;
  }

  async consume(tokenHash: string, nowEpochMs: number): Promise<void> {
    const row = this.rows.get(tokenHash);
    if (row) row.consumedAt = new Date(nowEpochMs);
  }

  async pruneExpired(nowEpochMs: number): Promise<number> {
    let count = 0;
    for (const [hash, row] of this.rows.entries()) {
      if (row.expiresAt.getTime() <= nowEpochMs || row.consumedAt) {
        this.rows.delete(hash);
        count += 1;
      }
    }
    return count;
  }
}

export class InMemoryPasswordResetTokenRepository implements PasswordResetTokenRepository {
  readonly rows = new Map<string, PasswordResetTokenRecord>();
  constructor(private readonly clock: InMemoryClock = systemClock) {}

  async create(input: {
    tokenHash: string;
    userId: string;
    expiresAt: Date;
    requestedFromIpHash?: string | null;
  }): Promise<PasswordResetTokenRecord> {
    const row: PasswordResetTokenRecord = {
      tokenHash: input.tokenHash,
      userId: input.userId,
      createdAt: this.clock.now(),
      expiresAt: input.expiresAt,
      consumedAt: null,
      requestedFromIpHash: input.requestedFromIpHash ?? null,
    };
    this.rows.set(input.tokenHash, row);
    return row;
  }

  async findActiveByHash(
    tokenHash: string,
    nowEpochMs: number,
  ): Promise<PasswordResetTokenRecord | null> {
    const row = this.rows.get(tokenHash);
    if (!row) return null;
    if (row.consumedAt) return null;
    if (row.expiresAt.getTime() <= nowEpochMs) return null;
    return row;
  }

  async consume(tokenHash: string, nowEpochMs: number): Promise<void> {
    const row = this.rows.get(tokenHash);
    if (row) row.consumedAt = new Date(nowEpochMs);
  }

  async pruneExpired(nowEpochMs: number): Promise<number> {
    let count = 0;
    for (const [hash, row] of this.rows.entries()) {
      if (row.expiresAt.getTime() <= nowEpochMs || row.consumedAt) {
        this.rows.delete(hash);
        count += 1;
      }
    }
    return count;
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

export class InMemorySessionRepository implements SessionRepository {
  readonly rows = new Map<string, SessionRecord>();
  constructor(private readonly clock: InMemoryClock = systemClock) {}

  async findById(id: string): Promise<SessionRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async findByQrSlug(qrSlug: string): Promise<SessionRecord | null> {
    for (const row of this.rows.values()) {
      if (row.qrSlug === qrSlug) return row;
    }
    return null;
  }

  async findByAccount(accountId: string): Promise<SessionRecord[]> {
    const out: SessionRecord[] = [];
    for (const row of this.rows.values()) {
      if (row.accountId === accountId) out.push(row);
    }
    return out;
  }

  async create(input: {
    accountId: string;
    name: string;
    qrSlug: string;
    guestCapOverride?: number | null;
    songsPerGuestCap?: number;
    maxConsecutivePerGuest?: number | null;
    allowDuplicates?: boolean;
    moderationEnabled?: boolean;
    voteSkipMode?: 'fixed' | 'percentage' | 'host_approval';
    voteSkipThreshold?: number;
    karaokeMode?: 'off' | 'optional' | 'required';
    karaokeMicCount?: number;
    karaokePauseMode?: 'off' | 'manual' | 'auto';
    karaokePauseTimeoutSec?: number;
  }): Promise<SessionRecord> {
    const id = crypto.randomUUID();
    const row: SessionRecord = {
      id,
      accountId: input.accountId,
      name: input.name,
      qrSlug: input.qrSlug,
      guestCapOverride: input.guestCapOverride ?? null,
      songsPerGuestCap: input.songsPerGuestCap ?? 3,
      maxConsecutivePerGuest: input.maxConsecutivePerGuest ?? null,
      allowDuplicates: input.allowDuplicates ?? false,
      moderationEnabled: input.moderationEnabled ?? false,
      voteSkipMode: input.voteSkipMode ?? 'fixed',
      voteSkipThreshold: input.voteSkipThreshold ?? 5,
      karaokeMode: input.karaokeMode ?? 'off',
      karaokeMicCount: input.karaokeMicCount ?? 1,
      karaokePauseMode: input.karaokePauseMode ?? 'manual',
      karaokePauseTimeoutSec: input.karaokePauseTimeoutSec ?? 30,
      startedAt: this.clock.now(),
      endedAt: null,
    };
    this.rows.set(id, row);
    return row;
  }

  async update(input: {
    id: string;
    guestCapOverride?: number | null;
    songsPerGuestCap?: number;
    maxConsecutivePerGuest?: number | null;
    allowDuplicates?: boolean;
    moderationEnabled?: boolean;
    voteSkipMode?: 'fixed' | 'percentage' | 'host_approval';
    voteSkipThreshold?: number;
    karaokeMode?: 'off' | 'optional' | 'required';
    karaokeMicCount?: number;
    karaokePauseMode?: 'off' | 'manual' | 'auto';
    karaokePauseTimeoutSec?: number;
    name?: string;
  }): Promise<SessionRecord | null> {
    const row = this.rows.get(input.id);
    if (!row) return null;
    if (input.guestCapOverride !== undefined) row.guestCapOverride = input.guestCapOverride;
    if (input.songsPerGuestCap !== undefined) row.songsPerGuestCap = input.songsPerGuestCap;
    if (input.maxConsecutivePerGuest !== undefined)
      row.maxConsecutivePerGuest = input.maxConsecutivePerGuest;
    if (input.allowDuplicates !== undefined) row.allowDuplicates = input.allowDuplicates;
    if (input.moderationEnabled !== undefined) row.moderationEnabled = input.moderationEnabled;
    if (input.voteSkipMode !== undefined) row.voteSkipMode = input.voteSkipMode;
    if (input.voteSkipThreshold !== undefined) row.voteSkipThreshold = input.voteSkipThreshold;
    if (input.karaokeMode !== undefined) row.karaokeMode = input.karaokeMode;
    if (input.karaokeMicCount !== undefined) row.karaokeMicCount = input.karaokeMicCount;
    if (input.karaokePauseMode !== undefined) row.karaokePauseMode = input.karaokePauseMode;
    if (input.karaokePauseTimeoutSec !== undefined)
      row.karaokePauseTimeoutSec = input.karaokePauseTimeoutSec;
    if (input.name !== undefined) row.name = input.name;
    return row;
  }

  async end(id: string, endedAt: Date): Promise<SessionRecord | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    if (row.endedAt === null) row.endedAt = endedAt;
    return row;
  }

  /** Test helper. */
  seed(record: SessionRecord): void {
    this.rows.set(record.id, record);
  }
}

export class InMemoryGuestRepository implements GuestRepository {
  readonly rows = new Map<string, GuestRecord>();
  constructor(private readonly clock: InMemoryClock = systemClock) {}

  async findBySessionAndFingerprint(
    sessionId: string,
    fingerprint: string,
  ): Promise<GuestRecord | null> {
    for (const row of this.rows.values()) {
      if (row.sessionId === sessionId && row.fingerprint === fingerprint) return row;
    }
    return null;
  }

  async create(input: {
    sessionId: string;
    userId?: string | null;
    fingerprint: string;
    name?: string | null;
  }): Promise<GuestRecord> {
    const id = crypto.randomUUID();
    const row: GuestRecord = {
      id,
      sessionId: input.sessionId,
      userId: input.userId ?? null,
      fingerprint: input.fingerprint,
      name: input.name ?? null,
      createdAt: this.clock.now(),
    };
    this.rows.set(id, row);
    return row;
  }

  async linkUser(guestId: string, userId: string): Promise<void> {
    const row = this.rows.get(guestId);
    if (row) row.userId = userId;
  }
}

export class InMemoryGuestSlotRepository implements GuestSlotRepository {
  readonly rows = new Map<string, GuestSlotRecord>();
  constructor(private readonly clock: InMemoryClock = systemClock) {}

  async findBySessionAndFingerprint(
    sessionId: string,
    fingerprintHash: string,
  ): Promise<GuestSlotRecord | null> {
    for (const row of this.rows.values()) {
      if (row.sessionId === sessionId && row.fingerprintHash === fingerprintHash) return row;
    }
    return null;
  }

  async findBySlotToken(slotToken: string): Promise<GuestSlotRecord | null> {
    for (const row of this.rows.values()) {
      if (row.slotToken === slotToken) return row;
    }
    return null;
  }

  async countByStatus(sessionId: string, status: GuestSlotStatus): Promise<number> {
    let count = 0;
    for (const row of this.rows.values()) {
      if (row.sessionId === sessionId && row.status === status) count += 1;
    }
    return count;
  }

  async create(input: {
    sessionId: string;
    fingerprintHash: string;
    slotToken: string;
    status: GuestSlotStatus;
    queuePosition?: number | null;
  }): Promise<GuestSlotRecord> {
    const id = crypto.randomUUID();
    const now = this.clock.now();
    const row: GuestSlotRecord = {
      id,
      sessionId: input.sessionId,
      fingerprintHash: input.fingerprintHash,
      slotToken: input.slotToken,
      status: input.status,
      queuePosition: input.queuePosition ?? null,
      lastHeartbeat: now,
      createdAt: now,
    };
    this.rows.set(id, row);
    return row;
  }

  async touchHeartbeat(id: string, nowEpochMs: number): Promise<void> {
    const row = this.rows.get(id);
    if (row) row.lastHeartbeat = new Date(nowEpochMs);
  }

  async setStatus(input: {
    id: string;
    status: GuestSlotStatus;
    queuePosition?: number | null;
  }): Promise<void> {
    const row = this.rows.get(input.id);
    if (!row) return;
    row.status = input.status;
    if (input.queuePosition !== undefined) row.queuePosition = input.queuePosition;
  }

  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }

  async findActiveStaleSince(sessionId: string, cutoff: Date): Promise<GuestSlotRecord[]> {
    const cutoffMs = cutoff.getTime();
    const out: GuestSlotRecord[] = [];
    for (const row of this.rows.values()) {
      if (row.sessionId !== sessionId) continue;
      if (row.status !== 'active') continue;
      if (row.lastHeartbeat.getTime() <= cutoffMs) out.push(row);
    }
    return out;
  }

  async findFirstQueued(sessionId: string): Promise<GuestSlotRecord | null> {
    let best: GuestSlotRecord | null = null;
    for (const row of this.rows.values()) {
      if (row.sessionId !== sessionId) continue;
      if (row.status !== 'queued') continue;
      if (!best || row.createdAt.getTime() < best.createdAt.getTime()) best = row;
    }
    return best;
  }
}

export class InMemoryFingerprintPriorityRepository implements FingerprintPriorityRepository {
  /** Composite key: `${sessionId}:${fingerprintHash}`. */
  readonly rows = new Map<string, FingerprintPriorityRecord>();
  constructor(private readonly clock: InMemoryClock = systemClock) {}

  async find(
    sessionId: string,
    fingerprintHash: string,
    nowEpochMs: number,
  ): Promise<FingerprintPriorityRecord | null> {
    const row = this.rows.get(`${sessionId}:${fingerprintHash}`);
    if (!row) return null;
    if (row.expiresAt.getTime() <= nowEpochMs) return null;
    return row;
  }

  async upsert(input: {
    sessionId: string;
    fingerprintHash: string;
    expiresAt: Date;
  }): Promise<FingerprintPriorityRecord> {
    const row: FingerprintPriorityRecord = {
      fingerprintHash: input.fingerprintHash,
      sessionId: input.sessionId,
      releasedAt: this.clock.now(),
      expiresAt: input.expiresAt,
    };
    this.rows.set(`${input.sessionId}:${input.fingerprintHash}`, row);
    return row;
  }

  async delete(sessionId: string, fingerprintHash: string): Promise<void> {
    this.rows.delete(`${sessionId}:${fingerprintHash}`);
  }
}

export class InMemoryQueueItemRepository implements QueueItemRepository {
  readonly rows = new Map<string, QueueItemRecord>();
  constructor(private readonly clock: InMemoryClock = systemClock) {}

  async findById(id: string): Promise<QueueItemRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async findAllForSession(sessionId: string): Promise<QueueItemRecord[]> {
    const out: QueueItemRecord[] = [];
    for (const row of this.rows.values()) {
      if (row.sessionId === sessionId) out.push(row);
    }
    out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return out;
  }

  async create(input: {
    sessionId: string;
    guestId: string;
    trackUri: string;
    trackName: string;
    artistName: string;
    albumArtUrl?: string | null;
    durationMs?: number | null;
    status?: QueueItemStatus;
  }): Promise<QueueItemRecord> {
    const id = crypto.randomUUID();
    const row: QueueItemRecord = {
      id,
      sessionId: input.sessionId,
      guestId: input.guestId,
      trackUri: input.trackUri,
      trackName: input.trackName,
      artistName: input.artistName,
      albumArtUrl: input.albumArtUrl ?? null,
      durationMs: input.durationMs ?? null,
      status: input.status ?? 'pending',
      skipVotes: 0,
      createdAt: this.clock.now(),
      decidedAt: null,
    };
    this.rows.set(id, row);
    return row;
  }

  async setStatus(input: {
    id: string;
    status: QueueItemStatus;
    decidedAt?: Date | null;
  }): Promise<QueueItemRecord | null> {
    const row = this.rows.get(input.id);
    if (!row) return null;
    row.status = input.status;
    if (input.decidedAt !== undefined) row.decidedAt = input.decidedAt;
    return row;
  }

  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }

  async incrementSkipVotes(id: string): Promise<number> {
    const row = this.rows.get(id);
    if (!row) return 0;
    row.skipVotes += 1;
    return row.skipVotes;
  }
}

export class InMemoryQueueSkipVoteRepository implements QueueSkipVoteRepository {
  /** Composite key: `${queueItemId}:${guestId}`. */
  readonly rows = new Map<string, { queueItemId: string; guestId: string; createdAt: Date }>();
  constructor(
    private readonly queueItems: InMemoryQueueItemRepository,
    private readonly clock: InMemoryClock = systemClock,
  ) {}

  async recordVote(input: {
    queueItemId: string;
    guestId: string;
  }): Promise<{ inserted: boolean; voteCount: number }> {
    const key = `${input.queueItemId}:${input.guestId}`;
    const item = await this.queueItems.findById(input.queueItemId);
    const currentCount = item?.skipVotes ?? 0;
    if (this.rows.has(key)) {
      return { inserted: false, voteCount: currentCount };
    }
    this.rows.set(key, { ...input, createdAt: this.clock.now() });
    const next = await this.queueItems.incrementSkipVotes(input.queueItemId);
    return { inserted: true, voteCount: next };
  }

  async hasVoted(input: { queueItemId: string; guestId: string }): Promise<boolean> {
    return this.rows.has(`${input.queueItemId}:${input.guestId}`);
  }
}

export class InMemorySessionAuditEventRepository implements SessionAuditEventRepository {
  readonly rows: SessionAuditEventRecord[] = [];
  constructor(private readonly clock: InMemoryClock = systemClock) {}

  async record(input: {
    sessionId: string;
    actorKind: 'host' | 'guest' | 'system';
    actorId?: string | null;
    actorLabel?: string | null;
    action: string;
    details?: Record<string, unknown>;
  }): Promise<SessionAuditEventRecord> {
    const row: SessionAuditEventRecord = {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      actorKind: input.actorKind,
      actorId: input.actorId ?? null,
      actorLabel: input.actorLabel ?? null,
      action: input.action,
      details: input.details ?? {},
      createdAt: this.clock.now(),
    };
    this.rows.push(row);
    return row;
  }

  async listForSession(
    sessionId: string,
    options?: { limit?: number; before?: Date },
  ): Promise<SessionAuditEventRecord[]> {
    const limit = options?.limit ?? 200;
    return this.rows
      .filter((r) => r.sessionId === sessionId)
      .filter((r) => !options?.before || r.createdAt < options.before)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }
}

export class InMemoryLyricsCacheRepository implements LyricsCacheRepository {
  /** Composite key: `${source}:${lookupKeyHash}`. */
  readonly rows = new Map<string, LyricsCacheRecord>();
  constructor(private readonly clock: InMemoryClock = systemClock) {}

  async findBySourceAndKey(
    source: string,
    lookupKeyHash: string,
  ): Promise<LyricsCacheRecord | null> {
    return this.rows.get(`${source}:${lookupKeyHash}`) ?? null;
  }

  async upsert(input: {
    source: string;
    sourceLyricsId?: string | null;
    providerTrackUri?: string | null;
    trackName: string;
    artistName: string;
    albumName?: string | null;
    durationMs?: number | null;
    isrc?: string | null;
    isSynced: boolean;
    isInstrumental?: boolean;
    matchConfidence: 'low' | 'medium' | 'high';
    syncedLrc?: string | null;
    plainLyrics?: string | null;
    attribution?: string | null;
    lookupKeyHash: string;
  }): Promise<LyricsCacheRecord> {
    const key = `${input.source}:${input.lookupKeyHash}`;
    const now = this.clock.now();
    const existing = this.rows.get(key);
    const row: LyricsCacheRecord = {
      id: existing?.id ?? crypto.randomUUID(),
      source: input.source,
      sourceLyricsId: input.sourceLyricsId ?? existing?.sourceLyricsId ?? null,
      providerTrackUri: input.providerTrackUri ?? existing?.providerTrackUri ?? null,
      trackName: input.trackName,
      artistName: input.artistName,
      albumName: input.albumName ?? existing?.albumName ?? null,
      durationMs: input.durationMs ?? existing?.durationMs ?? null,
      isrc: input.isrc ?? existing?.isrc ?? null,
      isSynced: input.isSynced,
      isInstrumental: input.isInstrumental ?? existing?.isInstrumental ?? false,
      matchConfidence: input.matchConfidence,
      syncedLrc: input.syncedLrc ?? existing?.syncedLrc ?? null,
      plainLyrics: input.plainLyrics ?? existing?.plainLyrics ?? null,
      attribution: input.attribution ?? existing?.attribution ?? null,
      lookupKeyHash: input.lookupKeyHash,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastUsedAt: existing?.lastUsedAt ?? null,
      suppressedAt: existing?.suppressedAt ?? null,
      suppressedReason: existing?.suppressedReason ?? null,
    };
    this.rows.set(key, row);
    return row;
  }

  async recordHit(id: string, nowEpochMs: number): Promise<void> {
    for (const row of this.rows.values()) {
      if (row.id === id) {
        row.lastUsedAt = new Date(nowEpochMs);
        return;
      }
    }
  }

  async suppress(id: string, reason: string, nowEpochMs: number): Promise<void> {
    for (const row of this.rows.values()) {
      if (row.id === id) {
        row.suppressedAt = new Date(nowEpochMs);
        row.suppressedReason = reason;
        return;
      }
    }
  }
}

export class InMemoryLyricsFeedbackRepository implements LyricsFeedbackRepository {
  readonly rows: LyricsFeedbackRecord[] = [];
  private nextId = 1;
  constructor(private readonly clock: InMemoryClock = systemClock) {}

  async create(input: {
    accountId?: string | null;
    sessionId?: string | null;
    userId?: string | null;
    guestId?: string | null;
    lyricsCacheId?: string | null;
    providerTrackUri?: string | null;
    kind: string;
    lineId?: string | null;
    comment?: string | null;
  }): Promise<LyricsFeedbackRecord> {
    const row: LyricsFeedbackRecord = {
      id: this.nextId++,
      accountId: input.accountId ?? null,
      sessionId: input.sessionId ?? null,
      userId: input.userId ?? null,
      guestId: input.guestId ?? null,
      lyricsCacheId: input.lyricsCacheId ?? null,
      providerTrackUri: input.providerTrackUri ?? null,
      kind: input.kind,
      lineId: input.lineId ?? null,
      comment: input.comment ?? null,
      createdAt: this.clock.now(),
    };
    this.rows.push(row);
    return row;
  }

  async countForCacheEntry(lyricsCacheId: string, kind?: string): Promise<number> {
    let count = 0;
    for (const row of this.rows) {
      if (row.lyricsCacheId !== lyricsCacheId) continue;
      if (kind !== undefined && row.kind !== kind) continue;
      count += 1;
    }
    return count;
  }
}

export class InMemoryAbuseSubjectRepository implements AbuseSubjectRepository {
  readonly rows = new Map<string, AbuseSubjectRecord>();
  constructor(private readonly clock: InMemoryClock = systemClock) {}

  async findByHash(subjectHash: string): Promise<AbuseSubjectRecord | null> {
    return this.rows.get(subjectHash) ?? null;
  }

  async findActiveForSession(
    sessionId: string,
    statuses?: ReadonlyArray<AbuseSubjectStatus>,
  ): Promise<AbuseSubjectRecord[]> {
    const now = this.clock.now().getTime();
    const out: AbuseSubjectRecord[] = [];
    for (const row of this.rows.values()) {
      if (row.sessionId !== sessionId) continue;
      if (statuses && !statuses.includes(row.status)) continue;
      if (row.expiresAt !== null && row.expiresAt.getTime() <= now) continue;
      out.push(row);
    }
    return out;
  }

  async upsert(input: {
    subjectHash: string;
    accountId?: string | null;
    sessionId?: string | null;
    riskScore?: number;
    status: AbuseSubjectStatus;
    reason?: string | null;
    expiresAt?: Date | null;
  }): Promise<AbuseSubjectRecord> {
    const existing = this.rows.get(input.subjectHash);
    const now = this.clock.now();
    const row: AbuseSubjectRecord = {
      subjectHash: input.subjectHash,
      accountId: input.accountId ?? existing?.accountId ?? null,
      sessionId: input.sessionId ?? existing?.sessionId ?? null,
      riskScore:
        input.riskScore !== undefined
          ? input.riskScore.toFixed(2)
          : (existing?.riskScore ?? '0.00'),
      status: input.status,
      reason: input.reason ?? existing?.reason ?? null,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      expiresAt: input.expiresAt ?? existing?.expiresAt ?? null,
    };
    this.rows.set(input.subjectHash, row);
    return row;
  }

  async delete(subjectHash: string): Promise<void> {
    this.rows.delete(subjectHash);
  }
}

export class InMemoryActionEventRepository implements ActionEventRepository {
  readonly rows: ActionEventRecord[] = [];
  private nextId = 1;
  constructor(private readonly clock: InMemoryClock = systemClock) {}

  async create(input: {
    accountId?: string | null;
    sessionId?: string | null;
    userId?: string | null;
    guestId?: string | null;
    eventKind: string;
    subjectHash?: string | null;
    riskScore?: number | null;
    meta?: unknown;
  }): Promise<ActionEventRecord> {
    const row: ActionEventRecord = {
      id: this.nextId++,
      accountId: input.accountId ?? null,
      sessionId: input.sessionId ?? null,
      userId: input.userId ?? null,
      guestId: input.guestId ?? null,
      eventKind: input.eventKind,
      subjectHash: input.subjectHash ?? null,
      riskScore:
        input.riskScore !== undefined && input.riskScore !== null
          ? input.riskScore.toFixed(2)
          : null,
      meta: input.meta ?? null,
      createdAt: this.clock.now(),
    };
    this.rows.push(row);
    return row;
  }

  async countByKindSince(
    sessionId: string,
    since: Date,
  ): Promise<Array<{ eventKind: string; count: number }>> {
    const sinceMs = since.getTime();
    const counts = new Map<string, number>();
    for (const row of this.rows) {
      if (row.sessionId !== sessionId) continue;
      if (row.createdAt.getTime() < sinceMs) continue;
      counts.set(row.eventKind, (counts.get(row.eventKind) ?? 0) + 1);
    }
    return [...counts.entries()].map(([eventKind, count]) => ({ eventKind, count }));
  }
}

export function createInMemoryRepositories(clock: InMemoryClock = systemClock): Repositories {
  // queueItems is shared with queueSkipVotes — declare first so we can hand
  // the same instance to the votes repo for atomic counter increments.
  const queueItems = new InMemoryQueueItemRepository(clock);
  return {
    users: new InMemoryUserRepository(clock),
    accounts: new InMemoryAccountRepository(clock),
    memberships: new InMemoryMembershipRepository(clock),
    authIdentities: new InMemoryAuthIdentityRepository(clock),
    authSessions: new InMemoryAuthSessionRepository(clock),
    passwordCredentials: new InMemoryPasswordCredentialRepository(clock),
    emailVerificationTokens: new InMemoryEmailVerificationTokenRepository(clock),
    passwordResetTokens: new InMemoryPasswordResetTokenRepository(clock),
    oauthStates: new InMemoryOAuthStateRepository(clock),
    providerConnections: new InMemoryProviderConnectionRepository(clock),
    sessions: new InMemorySessionRepository(clock),
    guests: new InMemoryGuestRepository(clock),
    guestSlots: new InMemoryGuestSlotRepository(clock),
    fingerprintPriority: new InMemoryFingerprintPriorityRepository(clock),
    queueItems,
    queueSkipVotes: new InMemoryQueueSkipVoteRepository(queueItems, clock),
    sessionAuditEvents: new InMemorySessionAuditEventRepository(clock),
    lyricsCache: new InMemoryLyricsCacheRepository(clock),
    lyricsFeedback: new InMemoryLyricsFeedbackRepository(clock),
    abuseSubjects: new InMemoryAbuseSubjectRepository(clock),
    actionEvents: new InMemoryActionEventRepository(clock),
  };
}
