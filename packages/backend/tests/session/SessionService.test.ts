import { describe, expect, it } from 'vitest';
import { SessionService, SessionServiceError } from '../../src/session/SessionService.js';
import { InMemorySessionRepository } from '../../src/repositories/in-memory/index.js';

const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';

function setup() {
  const sessions = new InMemorySessionRepository();
  let counter = 0;
  const generateQrSlug = () => `slug-${++counter}`;
  const service = new SessionService({ sessions, generateQrSlug });
  return { service, sessions };
}

describe('SessionService.create', () => {
  it('creates with defaults', async () => {
    const { service } = setup();
    const session = await service.create({ accountId: ACCOUNT_ID, name: 'My Event' });
    expect(session.name).toBe('My Event');
    expect(session.qrSlug).toBe('slug-1');
    expect(session.guestCapOverride).toBeNull();
    expect(session.songsPerGuestCap).toBe(3);
    expect(session.maxConsecutivePerGuest).toBeNull();
    expect(session.moderationEnabled).toBe(false);
    expect(session.voteSkipMode).toBe('fixed');
    expect(session.voteSkipThreshold).toBe(5);
    expect(session.karaokeMode).toBe('off');
    expect(session.karaokeMicCount).toBe(1);
    expect(session.karaokePauseMode).toBe('manual');
    expect(session.karaokePauseTimeoutSec).toBe(30);
  });

  it('respects an explicit qrSlug', async () => {
    const { service } = setup();
    const session = await service.create({
      accountId: ACCOUNT_ID,
      name: 'X',
      qrSlug: 'custom',
    });
    expect(session.qrSlug).toBe('custom');
  });

  it('throws qr_slug_taken when the slug is already in use', async () => {
    const { service } = setup();
    await service.create({ accountId: ACCOUNT_ID, name: 'A', qrSlug: 'shared' });
    await expect(
      service.create({ accountId: ACCOUNT_ID, name: 'B', qrSlug: 'shared' }),
    ).rejects.toMatchObject({ code: 'qr_slug_taken' });
  });

  it('allows reusing the slug of an ENDED session', async () => {
    const { service } = setup();
    const first = await service.create({ accountId: ACCOUNT_ID, name: 'A', qrSlug: 'party' });
    await service.end(first.id, ACCOUNT_ID);
    const second = await service.create({ accountId: ACCOUNT_ID, name: 'B', qrSlug: 'party' });
    expect(second.qrSlug).toBe('party');
    expect(second.id).not.toBe(first.id);
  });

  it('respects per-create overrides', async () => {
    const { service } = setup();
    const session = await service.create({
      accountId: ACCOUNT_ID,
      name: 'X',
      guestCapOverride: 50,
      songsPerGuestCap: 5,
      maxConsecutivePerGuest: 2,
      moderationEnabled: true,
      voteSkipMode: 'percentage',
      voteSkipThreshold: 60,
      karaokeMode: 'required',
      karaokeMicCount: 4,
      karaokePauseMode: 'auto',
      karaokePauseTimeoutSec: 90,
    });
    expect(session).toMatchObject({
      guestCapOverride: 50,
      songsPerGuestCap: 5,
      maxConsecutivePerGuest: 2,
      moderationEnabled: true,
      voteSkipMode: 'percentage',
      voteSkipThreshold: 60,
      karaokeMode: 'required',
      karaokeMicCount: 4,
      karaokePauseMode: 'auto',
      karaokePauseTimeoutSec: 90,
    });
  });
});

describe('SessionService.getById', () => {
  it('returns the session', async () => {
    const { service } = setup();
    const created = await service.create({ accountId: ACCOUNT_ID, name: 'X' });
    expect((await service.getById(created.id)).id).toBe(created.id);
  });

  it('throws session_not_found when missing', async () => {
    const { service } = setup();
    await expect(service.getById('missing')).rejects.toMatchObject({ code: 'session_not_found' });
  });

  it('throws account_mismatch when require check fails', async () => {
    const { service } = setup();
    const created = await service.create({ accountId: ACCOUNT_ID, name: 'X' });
    await expect(service.getById(created.id, 'other-account')).rejects.toMatchObject({
      code: 'account_mismatch',
    });
  });
});

describe('SessionService.update', () => {
  it('applies the partial update', async () => {
    const { service } = setup();
    const created = await service.create({ accountId: ACCOUNT_ID, name: 'X' });
    const updated = await service.update({
      id: created.id,
      accountId: ACCOUNT_ID,
      moderationEnabled: true,
      voteSkipThreshold: 9,
    });
    expect(updated.moderationEnabled).toBe(true);
    expect(updated.voteSkipThreshold).toBe(9);
    // Untouched fields remain
    expect(updated.songsPerGuestCap).toBe(3);
    expect(updated.maxConsecutivePerGuest).toBeNull();
    expect(updated.karaokeMode).toBe('off');
  });

  it('updates maxConsecutivePerGuest independently', async () => {
    const { service } = setup();
    const created = await service.create({ accountId: ACCOUNT_ID, name: 'X' });
    const updated = await service.update({
      id: created.id,
      accountId: ACCOUNT_ID,
      maxConsecutivePerGuest: 2,
    });
    expect(updated.maxConsecutivePerGuest).toBe(2);
    // Untouched fields remain
    expect(updated.songsPerGuestCap).toBe(3);
  });

  it('updates the four karaoke settings independently', async () => {
    const { service } = setup();
    const created = await service.create({ accountId: ACCOUNT_ID, name: 'X' });
    const updated = await service.update({
      id: created.id,
      accountId: ACCOUNT_ID,
      karaokeMode: 'optional',
      karaokeMicCount: 3,
      karaokePauseMode: 'off',
      karaokePauseTimeoutSec: 120,
    });
    expect(updated.karaokeMode).toBe('optional');
    expect(updated.karaokeMicCount).toBe(3);
    expect(updated.karaokePauseMode).toBe('off');
    expect(updated.karaokePauseTimeoutSec).toBe(120);
    // Untouched fields remain
    expect(updated.songsPerGuestCap).toBe(3);
    expect(updated.voteSkipMode).toBe('fixed');
  });

  it('refuses cross-account updates', async () => {
    const { service } = setup();
    const created = await service.create({ accountId: ACCOUNT_ID, name: 'X' });
    await expect(
      service.update({ id: created.id, accountId: 'other', moderationEnabled: true }),
    ).rejects.toMatchObject({ code: 'account_mismatch' });
  });

  it('refuses updates on ended sessions', async () => {
    const { service, sessions } = setup();
    const created = await service.create({ accountId: ACCOUNT_ID, name: 'X' });
    await sessions.end(created.id, new Date());
    await expect(
      service.update({ id: created.id, accountId: ACCOUNT_ID, moderationEnabled: true }),
    ).rejects.toMatchObject({ code: 'session_ended' });
  });
});

describe('SessionService.end', () => {
  it('marks the session ended', async () => {
    const { service } = setup();
    const created = await service.create({ accountId: ACCOUNT_ID, name: 'X' });
    const ended = await service.end(created.id, ACCOUNT_ID, 1_700_000_000_000);
    expect(ended.endedAt?.getTime()).toBe(1_700_000_000_000);
  });

  it('is idempotent — second end keeps the original endedAt', async () => {
    const { service } = setup();
    const created = await service.create({ accountId: ACCOUNT_ID, name: 'X' });
    const first = await service.end(created.id, ACCOUNT_ID, 1_700_000_000_000);
    const second = await service.end(created.id, ACCOUNT_ID, 1_800_000_000_000);
    expect(second.endedAt?.getTime()).toBe(first.endedAt?.getTime());
  });

  it('refuses cross-account end', async () => {
    const { service } = setup();
    const created = await service.create({ accountId: ACCOUNT_ID, name: 'X' });
    await expect(service.end(created.id, 'other')).rejects.toMatchObject({
      code: 'account_mismatch',
    });
  });
});

describe('SessionService.reopen', () => {
  it('clears endedAt on an ended session', async () => {
    const { service } = setup();
    const created = await service.create({ accountId: ACCOUNT_ID, name: 'X' });
    await service.end(created.id, ACCOUNT_ID);
    const reopened = await service.reopen(created.id, ACCOUNT_ID);
    expect(reopened.endedAt).toBeNull();
  });

  it('is idempotent on an already-active session', async () => {
    const { service } = setup();
    const created = await service.create({ accountId: ACCOUNT_ID, name: 'X' });
    const reopened = await service.reopen(created.id, ACCOUNT_ID);
    expect(reopened.id).toBe(created.id);
    expect(reopened.endedAt).toBeNull();
  });

  it('throws qr_slug_taken when a different active session holds the slug', async () => {
    const { service } = setup();
    const first = await service.create({ accountId: ACCOUNT_ID, name: 'A', qrSlug: 'party' });
    await service.end(first.id, ACCOUNT_ID);
    await service.create({ accountId: ACCOUNT_ID, name: 'B', qrSlug: 'party' });
    await expect(service.reopen(first.id, ACCOUNT_ID)).rejects.toMatchObject({
      code: 'qr_slug_taken',
    });
  });

  it('refuses cross-account reopen', async () => {
    const { service } = setup();
    const created = await service.create({ accountId: ACCOUNT_ID, name: 'X' });
    await service.end(created.id, ACCOUNT_ID);
    await expect(service.reopen(created.id, 'other')).rejects.toMatchObject({
      code: 'account_mismatch',
    });
  });
});

describe('SessionService slug resolution after reuse', () => {
  it('getBySlug resolves the ACTIVE session when an ended one shares the slug', async () => {
    const { service } = setup();
    const first = await service.create({ accountId: ACCOUNT_ID, name: 'Old', qrSlug: 'party' });
    await service.end(first.id, ACCOUNT_ID);
    const second = await service.create({ accountId: ACCOUNT_ID, name: 'New', qrSlug: 'party' });
    const resolved = await service.getBySlug('party');
    expect(resolved.id).toBe(second.id);
  });

  it('getBySlug still resolves an ended session when no active one exists', async () => {
    const { service } = setup();
    const first = await service.create({ accountId: ACCOUNT_ID, name: 'Old', qrSlug: 'party' });
    await service.end(first.id, ACCOUNT_ID);
    const resolved = await service.getBySlug('party');
    expect(resolved.id).toBe(first.id);
  });
});

describe('SessionService.listForAccount', () => {
  it('returns all sessions for the account', async () => {
    const { service } = setup();
    await service.create({ accountId: ACCOUNT_ID, name: 'A' });
    await service.create({ accountId: ACCOUNT_ID, name: 'B' });
    await service.create({ accountId: 'other-account', name: 'C' });
    const list = await service.listForAccount(ACCOUNT_ID);
    expect(list.map((s) => s.name).sort()).toEqual(['A', 'B']);
  });
});

describe('SessionServiceError surface', () => {
  it('exposes name + code', () => {
    const e = new SessionServiceError('qr_slug_taken', 'oops');
    expect(e.name).toBe('SessionServiceError');
    expect(e.code).toBe('qr_slug_taken');
  });
});
