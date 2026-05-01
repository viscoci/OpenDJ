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

export interface SessionRecord {
  id: string;
  accountId: string;
  name: string;
  qrSlug: string;
  guestCapOverride: number | null;
  songsPerGuestCap: number;
  moderationEnabled: boolean;
  voteSkipMode: 'fixed' | 'percentage' | 'host_approval';
  voteSkipThreshold: number;
  startedAt: Date;
  endedAt: Date | null;
}

export interface SessionRepository {
  findById(id: string): Promise<SessionRecord | null>;
  findByQrSlug(qrSlug: string): Promise<SessionRecord | null>;
}

export interface GuestRecord {
  id: string;
  sessionId: string;
  userId: string | null;
  /** Stored fingerprint hash (already salted by GuestIdentityService). */
  fingerprint: string;
  name: string | null;
  createdAt: Date;
}

export interface GuestRepository {
  findBySessionAndFingerprint(sessionId: string, fingerprint: string): Promise<GuestRecord | null>;
  create(input: {
    sessionId: string;
    userId?: string | null;
    fingerprint: string;
    name?: string | null;
  }): Promise<GuestRecord>;
  /** Link a logged-in user to an existing guest row (used by /api/v1/guest/link-account). */
  linkUser(guestId: string, userId: string): Promise<void>;
}

export type GuestSlotStatus = 'active' | 'queued' | 'priority_queued';

export interface GuestSlotRecord {
  id: string;
  sessionId: string;
  fingerprintHash: string;
  slotToken: string;
  status: GuestSlotStatus;
  queuePosition: number | null;
  lastHeartbeat: Date;
  createdAt: Date;
}

export interface GuestSlotRepository {
  findBySessionAndFingerprint(
    sessionId: string,
    fingerprintHash: string,
  ): Promise<GuestSlotRecord | null>;
  findBySlotToken(slotToken: string): Promise<GuestSlotRecord | null>;
  countByStatus(sessionId: string, status: GuestSlotStatus): Promise<number>;
  create(input: {
    sessionId: string;
    fingerprintHash: string;
    slotToken: string;
    status: GuestSlotStatus;
    queuePosition?: number | null;
  }): Promise<GuestSlotRecord>;
  touchHeartbeat(id: string, nowEpochMs: number): Promise<void>;
  setStatus(input: {
    id: string;
    status: GuestSlotStatus;
    queuePosition?: number | null;
  }): Promise<void>;
  delete(id: string): Promise<void>;
  /**
   * Find slots whose `last_heartbeat` is older than the cutoff and which are
   * currently `active`. Used by the expiry sweep.
   */
  findActiveStaleSince(sessionId: string, cutoff: Date): Promise<GuestSlotRecord[]>;
  /** Oldest queued slot for the session — used by promotion-on-free. */
  findFirstQueued(sessionId: string): Promise<GuestSlotRecord | null>;
}

export type QueueItemStatus = 'pending' | 'approved' | 'queued' | 'playing' | 'rejected';

export interface QueueItemRecord {
  id: string;
  sessionId: string;
  guestId: string;
  trackUri: string;
  trackName: string;
  artistName: string;
  albumArtUrl: string | null;
  durationMs: number | null;
  status: QueueItemStatus;
  skipVotes: number;
  createdAt: Date;
  decidedAt: Date | null;
}

export interface QueueItemRepository {
  findById(id: string): Promise<QueueItemRecord | null>;
  findAllForSession(sessionId: string): Promise<QueueItemRecord[]>;
  create(input: {
    sessionId: string;
    guestId: string;
    trackUri: string;
    trackName: string;
    artistName: string;
    albumArtUrl?: string | null;
    durationMs?: number | null;
    status?: QueueItemStatus;
  }): Promise<QueueItemRecord>;
  setStatus(input: {
    id: string;
    status: QueueItemStatus;
    decidedAt?: Date | null;
  }): Promise<QueueItemRecord | null>;
  delete(id: string): Promise<void>;
  /** Atomically increment skip-vote count and return the new value. */
  incrementSkipVotes(id: string): Promise<number>;
}

export interface FingerprintPriorityRecord {
  fingerprintHash: string;
  sessionId: string;
  releasedAt: Date;
  expiresAt: Date;
}

export interface FingerprintPriorityRepository {
  find(
    sessionId: string,
    fingerprintHash: string,
    nowEpochMs: number,
  ): Promise<FingerprintPriorityRecord | null>;
  upsert(input: {
    sessionId: string;
    fingerprintHash: string;
    expiresAt: Date;
  }): Promise<FingerprintPriorityRecord>;
  delete(sessionId: string, fingerprintHash: string): Promise<void>;
}

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

export interface OAuthStateRecord {
  state: string;
  /** 'login' for /api/v1/auth/:provider OAuth, 'connect-provider' for music-provider OAuth. */
  flowKind: 'login' | 'connect-provider';
  providerId: string;
  accountId: string | null;
  userId: string | null;
  redirectTo: string | null;
  codeVerifier: string | null;
  nonce: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface OAuthStateRepository {
  create(input: {
    state: string;
    flowKind: 'login' | 'connect-provider';
    providerId: string;
    accountId?: string | null;
    userId?: string | null;
    redirectTo?: string | null;
    codeVerifier?: string | null;
    nonce?: string | null;
    expiresAt: Date;
  }): Promise<OAuthStateRecord>;
  /** Find a state row that hasn't expired. */
  findActive(state: string, nowEpochMs: number): Promise<OAuthStateRecord | null>;
  /** Delete the row. Always called after consumption — single-use semantics. */
  delete(state: string): Promise<void>;
  /** Drop expired rows (sweep job). Returns the count deleted. */
  pruneExpired(nowEpochMs: number): Promise<number>;
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
  oauthStates: OAuthStateRepository;
  providerConnections: ProviderConnectionRepository;
  sessions: SessionRepository;
  guests: GuestRepository;
  guestSlots: GuestSlotRepository;
  fingerprintPriority: FingerprintPriorityRepository;
  queueItems: QueueItemRepository;
}
