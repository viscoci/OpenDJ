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
  ProviderConnectionRecord,
  ProviderConnectionRepository,
  QueueItemRecord,
  QueueItemRepository,
  QueueItemStatus,
  Repositories,
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
    moderationEnabled?: boolean;
    voteSkipMode?: 'fixed' | 'percentage' | 'host_approval';
    voteSkipThreshold?: number;
  }): Promise<SessionRecord> {
    const id = crypto.randomUUID();
    const row: SessionRecord = {
      id,
      accountId: input.accountId,
      name: input.name,
      qrSlug: input.qrSlug,
      guestCapOverride: input.guestCapOverride ?? null,
      songsPerGuestCap: input.songsPerGuestCap ?? 3,
      moderationEnabled: input.moderationEnabled ?? false,
      voteSkipMode: input.voteSkipMode ?? 'fixed',
      voteSkipThreshold: input.voteSkipThreshold ?? 5,
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
    moderationEnabled?: boolean;
    voteSkipMode?: 'fixed' | 'percentage' | 'host_approval';
    voteSkipThreshold?: number;
    name?: string;
  }): Promise<SessionRecord | null> {
    const row = this.rows.get(input.id);
    if (!row) return null;
    if (input.guestCapOverride !== undefined) row.guestCapOverride = input.guestCapOverride;
    if (input.songsPerGuestCap !== undefined) row.songsPerGuestCap = input.songsPerGuestCap;
    if (input.moderationEnabled !== undefined) row.moderationEnabled = input.moderationEnabled;
    if (input.voteSkipMode !== undefined) row.voteSkipMode = input.voteSkipMode;
    if (input.voteSkipThreshold !== undefined) row.voteSkipThreshold = input.voteSkipThreshold;
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
    sessions: new InMemorySessionRepository(clock),
    guests: new InMemoryGuestRepository(clock),
    guestSlots: new InMemoryGuestSlotRepository(clock),
    fingerprintPriority: new InMemoryFingerprintPriorityRepository(clock),
    queueItems: new InMemoryQueueItemRepository(clock),
    lyricsCache: new InMemoryLyricsCacheRepository(clock),
    lyricsFeedback: new InMemoryLyricsFeedbackRepository(clock),
  };
}
