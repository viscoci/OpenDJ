/**
 * GuestIdentityService — turns a client-supplied browser fingerprint hash
 * into an event-scoped slot.
 *
 * Server-side salting:
 *   storedHash = SHA-256(eventSlug + isoDate(UTC) + clientHash)
 *
 * The date scopes slots to a single calendar day (UTC) — the same browser
 * rejoining tomorrow gets a fresh slot. The eventSlug + clientHash combo
 * means the same browser at two different events gets two different stored
 * hashes.
 *
 * Cap policy:
 *   - If a slot already exists for `(sessionId, storedHash)`, return it +
 *     refresh heartbeat
 *   - If a `fingerprint_priority` row exists (recently released slot), return
 *     a `priority_queued` slot — promotion logic preferentially picks these
 *   - Else if active count < `effectiveCap`, create an `active` slot
 *   - Else create a `queued` slot with the next position
 */

import { effectiveGuestCap } from '@opendj/core';
import { generateSessionToken } from '@opendj/auth';
import type {
  AccountRepository,
  FingerprintPriorityRepository,
  GuestRepository,
  GuestSlotRecord,
  GuestSlotRepository,
  SessionRepository,
} from '../repositories/types.js';

export class SessionNotFoundError extends Error {
  readonly qrSlug: string;
  constructor(qrSlug: string) {
    super(`No active session for qrSlug "${qrSlug}".`);
    this.name = 'SessionNotFoundError';
    this.qrSlug = qrSlug;
  }
}

export class SessionEndedError extends Error {
  readonly qrSlug: string;
  constructor(qrSlug: string) {
    super(`Session "${qrSlug}" has ended.`);
    this.name = 'SessionEndedError';
    this.qrSlug = qrSlug;
  }
}

export interface GuestIdentityServiceDeps {
  sessions: SessionRepository;
  accounts: AccountRepository;
  guests: GuestRepository;
  guestSlots: GuestSlotRepository;
  fingerprintPriority: FingerprintPriorityRepository;
}

export interface IssueIdentityInput {
  fingerprintHash: string;
  eventSlug: string;
}

export interface IssueIdentityResult {
  slotToken: string;
  status: GuestSlotRecord['status'];
  queuePosition?: number;
  guestId: string;
  sessionId: string;
}

const TEXT_ENCODER = new TextEncoder();

function isoDateUTC(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += (bytes[i]! >> 4).toString(16);
    out += (bytes[i]! & 0x0f).toString(16);
  }
  return out;
}

async function sha256Hex(input: string): Promise<string> {
  const data = TEXT_ENCODER.encode(input);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(digest));
}

export class GuestIdentityService {
  constructor(private readonly deps: GuestIdentityServiceDeps) {}

  /**
   * Compute the per-event-per-day server-side hash for a browser fingerprint.
   * Exposed so tests + other services can validate slot tokens against the
   * same keying.
   */
  async computeStoredHash(eventSlug: string, fingerprintHash: string, now: Date): Promise<string> {
    return sha256Hex(`${eventSlug}|${isoDateUTC(now)}|${fingerprintHash}`);
  }

  async issueIdentity(
    input: IssueIdentityInput,
    nowEpochMs?: number,
  ): Promise<IssueIdentityResult> {
    const now = nowEpochMs ?? Date.now();
    const session = await this.deps.sessions.findByQrSlug(input.eventSlug);
    if (!session) throw new SessionNotFoundError(input.eventSlug);
    if (session.endedAt && session.endedAt.getTime() <= now) {
      throw new SessionEndedError(input.eventSlug);
    }

    const account = await this.deps.accounts.findById(session.accountId);
    if (!account) throw new SessionNotFoundError(input.eventSlug);

    const storedHash = await this.computeStoredHash(
      input.eventSlug,
      input.fingerprintHash,
      new Date(now),
    );

    // 1. Existing slot — refresh + return
    const existing = await this.deps.guestSlots.findBySessionAndFingerprint(session.id, storedHash);
    if (existing) {
      await this.deps.guestSlots.touchHeartbeat(existing.id, now);
      return resultFor(existing, await this.findOrCreateGuest(session.id, storedHash));
    }

    // 2. Priority re-entry
    const priority = await this.deps.fingerprintPriority.find(session.id, storedHash, now);
    const wantsPriority = priority !== null;

    // 3. Cap check
    const cap = effectiveGuestCap(
      {
        id: account.id,
        displayName: account.displayName,
        slug: account.slug,
        plan: account.plan,
        createdAt: account.createdAt,
      },
      {
        id: session.id,
        accountId: session.accountId,
        name: session.name,
        qrSlug: session.qrSlug,
        guestCapOverride: session.guestCapOverride,
        songsPerGuestCap: session.songsPerGuestCap,
        maxConsecutivePerGuest: session.maxConsecutivePerGuest,
        allowDuplicates: session.allowDuplicates,
        moderationEnabled: session.moderationEnabled,
        voteSkipMode: session.voteSkipMode,
        voteSkipThreshold: session.voteSkipThreshold,
        karaokeMode: session.karaokeMode,
        karaokeMicCount: session.karaokeMicCount,
        karaokePauseMode: session.karaokePauseMode,
        karaokePauseTimeoutSec: session.karaokePauseTimeoutSec,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
      },
    );

    const activeCount = await this.deps.guestSlots.countByStatus(session.id, 'active');
    const slotToken = generateSessionToken();

    if (activeCount < cap) {
      const created = await this.deps.guestSlots.create({
        sessionId: session.id,
        fingerprintHash: storedHash,
        slotToken,
        status: wantsPriority ? 'priority_queued' : 'active',
      });
      // Priority slots get immediately promoted because there's room.
      if (wantsPriority) {
        await this.deps.guestSlots.setStatus({ id: created.id, status: 'active' });
        await this.deps.fingerprintPriority.delete(session.id, storedHash);
        created.status = 'active';
      }
      return resultFor(created, await this.findOrCreateGuest(session.id, storedHash));
    }

    // Queued (or priority_queued) — assign next position
    const queuedCount = await this.deps.guestSlots.countByStatus(session.id, 'queued');
    const priorityCount = await this.deps.guestSlots.countByStatus(session.id, 'priority_queued');
    const position = queuedCount + priorityCount + 1;
    const created = await this.deps.guestSlots.create({
      sessionId: session.id,
      fingerprintHash: storedHash,
      slotToken,
      status: wantsPriority ? 'priority_queued' : 'queued',
      queuePosition: position,
    });
    return resultFor(created, await this.findOrCreateGuest(session.id, storedHash));
  }

  async heartbeat(slotToken: string, nowEpochMs?: number): Promise<GuestSlotRecord> {
    const now = nowEpochMs ?? Date.now();
    const slot = await this.deps.guestSlots.findBySlotToken(slotToken);
    if (!slot) throw new Error('Unknown slot token.');
    await this.deps.guestSlots.touchHeartbeat(slot.id, now);
    return { ...slot, lastHeartbeat: new Date(now) };
  }

  async getSlot(slotToken: string): Promise<GuestSlotRecord | null> {
    return this.deps.guestSlots.findBySlotToken(slotToken);
  }

  /**
   * Lazily create the `guests` row corresponding to an issued slot.
   * The slot table holds the salted fingerprint hash; the guests table holds
   * the same hash as `fingerprint`. Keeping them aligned lets queue items
   * point at a guest row while still preserving the slot's lifecycle.
   */
  private async findOrCreateGuest(sessionId: string, fingerprint: string) {
    const existing = await this.deps.guests.findBySessionAndFingerprint(sessionId, fingerprint);
    if (existing) return existing;
    return this.deps.guests.create({ sessionId, fingerprint });
  }
}

function resultFor(slot: GuestSlotRecord, guest: { id: string }): IssueIdentityResult {
  const result: IssueIdentityResult = {
    slotToken: slot.slotToken,
    status: slot.status,
    guestId: guest.id,
    sessionId: slot.sessionId,
  };
  if (slot.queuePosition !== null) result.queuePosition = slot.queuePosition;
  return result;
}
