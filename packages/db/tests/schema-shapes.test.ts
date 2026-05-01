import { describe, expectTypeOf, it } from 'vitest';
import type {
  AbuseSubjectInsert,
  AbuseSubjectRow,
  AccountInsert,
  AccountRow,
  ActionEventInsert,
  ActionEventRow,
  AuthIdentityInsert,
  AuthIdentityRow,
  AuthSessionInsert,
  AuthSessionRow,
  GuestInsert,
  GuestRow,
  GuestSlotInsert,
  GuestSlotRow,
  LyricsCacheInsert,
  LyricsCacheRow,
  LyricsFeedbackInsert,
  LyricsFeedbackRow,
  OAuthStateInsert,
  OAuthStateRow,
  OutboxEventInsert,
  OutboxEventRow,
  PasswordCredentialInsert,
  PasswordCredentialRow,
  ProviderConnectionInsert,
  ProviderConnectionRow,
  QueueItemInsert,
  QueueItemRow,
  SessionEventInsert,
  SessionEventRow,
  SessionInsert,
  SessionRow,
  UserInsert,
  UserRow,
} from '../src/schema/index.js';

/**
 * Compile-time tests: every table's $inferSelect / $inferInsert types are
 * importable and have the load-bearing primary key + a few key fields.
 *
 * If a future schema migration drops or renames one of these fields, this
 * file fails to compile — surfacing the breaking change before runtime.
 */

describe('users', () => {
  it('row + insert types include id and email fields', () => {
    expectTypeOf<UserRow>().toHaveProperty('id').toEqualTypeOf<string>();
    expectTypeOf<UserRow>().toHaveProperty('primaryEmail').toEqualTypeOf<string | null>();
    expectTypeOf<UserRow>().toHaveProperty('emailVerified').toEqualTypeOf<boolean>();
    expectTypeOf<UserRow>().toHaveProperty('publicUserId').toEqualTypeOf<number>();
    expectTypeOf<UserInsert>().toHaveProperty('displayName');
  });
});

describe('accounts + memberships', () => {
  it('account row has plan + slug', () => {
    expectTypeOf<AccountRow>().toHaveProperty('id').toEqualTypeOf<string>();
    expectTypeOf<AccountRow>().toHaveProperty('plan').toEqualTypeOf<string>();
    expectTypeOf<AccountRow>().toHaveProperty('slug').toEqualTypeOf<string>();
    expectTypeOf<AccountInsert>().toHaveProperty('displayName');
  });
});

describe('auth tables', () => {
  it('auth_identities, auth_sessions, password_credentials, oauth_states load', () => {
    expectTypeOf<AuthIdentityRow>().toHaveProperty('providerId').toEqualTypeOf<string>();
    expectTypeOf<AuthIdentityRow>().toHaveProperty('providerSubject').toEqualTypeOf<string>();
    expectTypeOf<AuthSessionRow>().toHaveProperty('sessionHash').toEqualTypeOf<string>();
    expectTypeOf<AuthSessionRow>().toHaveProperty('claimsSnapshot').toEqualTypeOf<string[]>();
    expectTypeOf<PasswordCredentialRow>().toHaveProperty('passwordHash').toEqualTypeOf<string>();
    expectTypeOf<OAuthStateRow>().toHaveProperty('state').toEqualTypeOf<string>();
    expectTypeOf<AuthIdentityInsert>().toHaveProperty('userId');
    expectTypeOf<AuthSessionInsert>().toHaveProperty('expiresAt');
    expectTypeOf<PasswordCredentialInsert>().toHaveProperty('hashAlgorithm');
    expectTypeOf<OAuthStateInsert>().toHaveProperty('flowKind');
  });
});

describe('provider_connections', () => {
  it('exposes accessToken, refreshToken, expiresAt', () => {
    expectTypeOf<ProviderConnectionRow>().toHaveProperty('providerId').toEqualTypeOf<string>();
    expectTypeOf<ProviderConnectionRow>()
      .toHaveProperty('accessToken')
      .toEqualTypeOf<string | null>();
    expectTypeOf<ProviderConnectionRow>()
      .toHaveProperty('refreshToken')
      .toEqualTypeOf<string | null>();
    expectTypeOf<ProviderConnectionInsert>().toHaveProperty('accountId');
  });
});

describe('sessions, guests, queue_items, session_events, outbox_events, guest_slots', () => {
  it('load with required fields', () => {
    expectTypeOf<SessionRow>().toHaveProperty('qrSlug').toEqualTypeOf<string>();
    expectTypeOf<SessionRow>().toHaveProperty('voteSkipMode').toEqualTypeOf<string>();
    expectTypeOf<SessionRow>().toHaveProperty('songsPerGuestCap').toEqualTypeOf<number>();
    expectTypeOf<GuestRow>().toHaveProperty('fingerprint').toEqualTypeOf<string>();
    expectTypeOf<QueueItemRow>().toHaveProperty('trackUri').toEqualTypeOf<string>();
    expectTypeOf<QueueItemRow>().toHaveProperty('skipVotes').toEqualTypeOf<number>();
    expectTypeOf<SessionEventRow>().toHaveProperty('eventType').toEqualTypeOf<string>();
    expectTypeOf<OutboxEventRow>().toHaveProperty('attempts').toEqualTypeOf<number>();
    expectTypeOf<GuestSlotRow>().toHaveProperty('slotToken').toEqualTypeOf<string>();
    expectTypeOf<SessionInsert>().toHaveProperty('accountId');
    expectTypeOf<GuestInsert>().toHaveProperty('sessionId');
    expectTypeOf<QueueItemInsert>().toHaveProperty('guestId');
    expectTypeOf<SessionEventInsert>().toHaveProperty('payload');
    expectTypeOf<OutboxEventInsert>().toHaveProperty('kind');
    expectTypeOf<GuestSlotInsert>().toHaveProperty('fingerprintHash');
  });
});

describe('lyrics_cache + lyrics_feedback', () => {
  it('load with required fields', () => {
    expectTypeOf<LyricsCacheRow>().toHaveProperty('source').toEqualTypeOf<string>();
    expectTypeOf<LyricsCacheRow>().toHaveProperty('isSynced').toEqualTypeOf<boolean>();
    expectTypeOf<LyricsCacheRow>().toHaveProperty('lookupKeyHash').toEqualTypeOf<string>();
    expectTypeOf<LyricsFeedbackRow>().toHaveProperty('kind').toEqualTypeOf<string>();
    expectTypeOf<LyricsCacheInsert>().toHaveProperty('trackName');
    expectTypeOf<LyricsFeedbackInsert>().toHaveProperty('kind');
  });
});

describe('action_events + abuse_subjects', () => {
  it('load with required fields', () => {
    expectTypeOf<ActionEventRow>().toHaveProperty('eventKind').toEqualTypeOf<string>();
    expectTypeOf<AbuseSubjectRow>().toHaveProperty('subjectHash').toEqualTypeOf<string>();
    expectTypeOf<AbuseSubjectRow>().toHaveProperty('status').toEqualTypeOf<string>();
    expectTypeOf<ActionEventInsert>().toHaveProperty('eventKind');
    expectTypeOf<AbuseSubjectInsert>().toHaveProperty('subjectHash');
  });
});
