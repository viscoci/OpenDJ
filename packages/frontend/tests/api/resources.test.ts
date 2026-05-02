/**
 * Smoke tests for each resource — validates the URL/method/body shape sent
 * to the transport without exercising the full backend.
 */

import { describe, expect, it, vi } from 'vitest';
import { OpenDjClient } from '../../src/api/OpenDjClient.js';

interface Capture {
  url: string;
  init: RequestInit | undefined;
}

function makeClient(response: { status?: number; body?: unknown } = {}): {
  client: OpenDjClient;
  captures: Capture[];
} {
  const captures: Capture[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    captures.push({ url, init });
    return new Response(JSON.stringify(response.body ?? {}), {
      status: response.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const client = new OpenDjClient({
    baseUrl: 'https://api.test',
    fetchImpl: fetchImpl as never,
  });
  return { client, captures };
}

describe('AuthApi', () => {
  it('register POSTs /api/v1/auth/email/register', async () => {
    const { client, captures } = makeClient({
      body: { user: { id: 'u1' }, currentAccount: null, accounts: [], claims: [] },
    });
    await client.auth.register({ email: 'a@b.test', password: 'pw-long-enough' });
    expect(captures[0]?.url).toBe('https://api.test/api/v1/auth/email/register');
    expect(captures[0]?.init?.method).toBe('POST');
  });

  it('me GETs /api/v1/auth/me', async () => {
    const { client, captures } = makeClient({
      body: { user: { id: 'u1' }, currentAccount: null, accounts: [], claims: [] },
    });
    await client.auth.me();
    expect(captures[0]?.url).toBe('https://api.test/api/v1/auth/me');
    expect(captures[0]?.init?.method).toBe('GET');
  });

  it('oauthStartUrl returns the expected path', () => {
    const { client } = makeClient();
    expect(client.auth.oauthStartUrl('google')).toBe('/api/v1/auth/oauth/google/start');
  });
});

describe('SessionsApi', () => {
  it('getById unwraps the {session} envelope', async () => {
    const { client, captures } = makeClient({
      body: { session: { id: 'sess-1', name: 'Wedding' } },
    });
    const session = await client.sessions.getById('sess-1');
    expect(captures[0]?.url).toBe('https://api.test/api/v1/sessions/sess-1');
    expect(session).toEqual({ id: 'sess-1', name: 'Wedding' });
  });

  it('create POSTs /api/v1/sessions and unwraps the response', async () => {
    const { client, captures } = makeClient({
      body: { session: { id: 'sess-2', name: 'Birthday' } },
    });
    const session = await client.sessions.create({ name: 'Birthday' });
    expect(captures[0]?.url).toBe('https://api.test/api/v1/sessions');
    expect(captures[0]?.init?.method).toBe('POST');
    expect(captures[0]?.init?.body).toBe('{"name":"Birthday"}');
    expect(session.id).toBe('sess-2');
  });

  it('end DELETEs /api/v1/sessions/:id', async () => {
    const { client, captures } = makeClient({ body: { session: { id: 's' } } });
    await client.sessions.end('sess-3');
    expect(captures[0]?.url).toBe('https://api.test/api/v1/sessions/sess-3');
    expect(captures[0]?.init?.method).toBe('DELETE');
  });
});

describe('QueueApi', () => {
  it('list unwraps the {items} envelope', async () => {
    const { client, captures } = makeClient({
      body: { items: [{ id: 'q1' }, { id: 'q2' }] },
    });
    const items = await client.queue.list('sess-1');
    expect(captures[0]?.url).toBe('https://api.test/api/v1/sessions/sess-1/queue');
    expect(items.map((i) => i.id)).toEqual(['q1', 'q2']);
  });

  it('request sends body + Bearer slot token and unwraps {item}', async () => {
    const { client, captures } = makeClient({ body: { item: { id: 'q-new' } } });
    await client.queue.request('sess-1', 'slt_abc', {
      trackUri: 'spotify:track:1',
      trackName: 'X',
      artistName: 'Y',
    });
    const headers = captures[0]?.init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer slt_abc');
    expect(captures[0]?.init?.method).toBe('POST');
  });

  it('moderate PATCHes /queue/:itemId with the decision body', async () => {
    const { client, captures } = makeClient({ body: { item: { id: 'q1' } } });
    await client.queue.moderate('sess-1', 'q1', { decision: 'approved' });
    expect(captures[0]?.url).toBe('https://api.test/api/v1/sessions/sess-1/queue/q1');
    expect(captures[0]?.init?.method).toBe('PATCH');
    expect(captures[0]?.init?.body).toBe('{"decision":"approved"}');
  });

  it('voteSkip targets the skip-vote endpoint', async () => {
    const { client, captures } = makeClient({ body: { votes: 3, threshold: 5 } });
    const result = await client.queue.voteSkip('sess-1', 'item-1', 'slt_abc');
    expect(captures[0]?.url).toBe('https://api.test/api/v1/sessions/sess-1/queue/item-1/skip-vote');
    expect(result).toEqual({ votes: 3, threshold: 5 });
  });
});

describe('GuestApi', () => {
  it('identity POSTs /guest/identity with fingerprintHash + eventSlug', async () => {
    const { client, captures } = makeClient({
      body: {
        guestId: 'g1',
        sessionId: 'sess-1',
        slotToken: 'slt_xyz',
        status: 'active',
      },
    });
    const result = await client.guest.identity({
      fingerprintHash: 'fp-hash-1',
      eventSlug: 'wedding-2026',
    });
    expect(captures[0]?.url).toBe('https://api.test/api/v1/guest/identity');
    expect(captures[0]?.init?.method).toBe('POST');
    expect(captures[0]?.init?.body).toBe(
      '{"fingerprintHash":"fp-hash-1","eventSlug":"wedding-2026"}',
    );
    expect(result.slotToken).toBe('slt_xyz');
    expect(result.status).toBe('active');
  });

  it('heartbeat POSTs /guest/heartbeat with Bearer slot token', async () => {
    const { client, captures } = makeClient({ body: { status: 'active' } });
    await client.guest.heartbeat('slt_abc');
    expect(captures[0]?.url).toBe('https://api.test/api/v1/guest/heartbeat');
    const headers = captures[0]?.init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer slt_abc');
  });
});

describe('LyricsApi', () => {
  it('lookupByTrackUri encodes the trackUri query', async () => {
    const { client, captures } = makeClient({
      body: {
        trackUri: 'spotify:track:1',
        source: 'lrclib',
        isSynced: true,
        isInstrumental: false,
        matchConfidence: 'high',
        attribution: 'LRCLIB',
        lines: [],
        plain: null,
      },
    });
    const lyrics = await client.lyrics.lookupByTrackUri('spotify:track:1');
    expect(captures[0]?.url).toBe(
      'https://api.test/api/v1/lyrics/lookup?trackUri=spotify%3Atrack%3A1',
    );
    expect(lyrics?.source).toBe('lrclib');
  });

  it('lookupByTrackUri returns null when backend signals { lyrics: null }', async () => {
    const { client } = makeClient({ body: { lyrics: null } });
    const lyrics = await client.lyrics.lookupByTrackUri('spotify:track:missing');
    expect(lyrics).toBeNull();
  });
});
