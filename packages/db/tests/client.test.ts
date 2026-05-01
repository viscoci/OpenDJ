import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Database } from '../src/client.js';
import { createDb, schema } from '../src/index.js';

describe('createDb', () => {
  it('returns a Drizzle client typed against the OpenDJ schema', () => {
    expectTypeOf(createDb).parameters.toMatchTypeOf<[string, ...unknown[]]>();
    expectTypeOf<ReturnType<typeof createDb>>().toMatchTypeOf<Database>();
  });

  it('schema export contains the canonical OSS tables', () => {
    expect(schema).toHaveProperty('users');
    expect(schema).toHaveProperty('accounts');
    expect(schema).toHaveProperty('accountMemberships');
    expect(schema).toHaveProperty('authIdentities');
    expect(schema).toHaveProperty('authSessions');
    expect(schema).toHaveProperty('passwordCredentials');
    expect(schema).toHaveProperty('oauthStates');
    expect(schema).toHaveProperty('providerConnections');
    expect(schema).toHaveProperty('sessions');
    expect(schema).toHaveProperty('guests');
    expect(schema).toHaveProperty('queueItems');
    expect(schema).toHaveProperty('sessionEvents');
    expect(schema).toHaveProperty('outboxEvents');
    expect(schema).toHaveProperty('guestSlots');
    expect(schema).toHaveProperty('fingerprintPriority');
    expect(schema).toHaveProperty('lyricsCache');
    expect(schema).toHaveProperty('lyricsFeedback');
    expect(schema).toHaveProperty('actionEvents');
    expect(schema).toHaveProperty('abuseSubjects');
  });
});
