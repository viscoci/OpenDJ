import { describe, expect, it, vi } from 'vitest';
import { ApiError, NetworkError } from '../../src/api/errors.js';
import { HttpClient } from '../../src/api/http.js';

describe('HttpClient.request', () => {
  it('builds URLs from baseUrl + path', async () => {
    let seenUrl = '';
    const fetchImpl = vi.fn(async (url: string) => {
      seenUrl = url;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const http = new HttpClient({ baseUrl: 'https://api.test', fetchImpl: fetchImpl as never });
    await http.request<{ ok: boolean }>('/v1/health');
    expect(seenUrl).toBe('https://api.test/v1/health');
  });

  it('drops trailing slash on baseUrl and prepends "/" to path', async () => {
    let seenUrl = '';
    const fetchImpl = vi.fn(async (url: string) => {
      seenUrl = url;
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const http = new HttpClient({
      baseUrl: 'https://api.test/',
      fetchImpl: fetchImpl as never,
    });
    await http.request('v1/health');
    expect(seenUrl).toBe('https://api.test/v1/health');
  });

  it('appends query params (skipping null/undefined)', async () => {
    let seenUrl = '';
    const fetchImpl = vi.fn(async (url: string) => {
      seenUrl = url;
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const http = new HttpClient({ baseUrl: 'https://api.test', fetchImpl: fetchImpl as never });
    await http.request('/v1/lookup', {
      query: { trackUri: 'spotify:track:1', limit: 10, includeMissing: false, skip: null },
    });
    expect(seenUrl).toBe(
      'https://api.test/v1/lookup?trackUri=spotify%3Atrack%3A1&limit=10&includeMissing=false',
    );
  });

  it('JSON-encodes the body and sets content-type', async () => {
    let init: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => {
      init = _init;
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const http = new HttpClient({ baseUrl: 'https://api.test', fetchImpl: fetchImpl as never });
    await http.request('/v1/x', { method: 'POST', body: { a: 1 } });
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"a":1}');
    const headers = init?.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
  });

  it('forwards x-slot-token when slotToken is supplied', async () => {
    let init: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => {
      init = _init;
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const http = new HttpClient({ baseUrl: 'https://api.test', fetchImpl: fetchImpl as never });
    await http.request('/v1/x', { slotToken: 'slt_abc' });
    const headers = init?.headers as Record<string, string>;
    expect(headers['x-slot-token']).toBe('slt_abc');
  });

  it('returns undefined for 204 No Content', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const http = new HttpClient({ baseUrl: 'https://api.test', fetchImpl: fetchImpl as never });
    const result = await http.request<void>('/v1/heartbeat', { method: 'POST' });
    expect(result).toBeUndefined();
  });

  it('throws ApiError on non-2xx with the JSON code', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'invalid_credentials' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const http = new HttpClient({ baseUrl: 'https://api.test', fetchImpl: fetchImpl as never });
    await expect(http.request('/v1/login', { method: 'POST' })).rejects.toMatchObject({
      name: 'ApiError',
      code: 'invalid_credentials',
      status: 401,
    });
  });

  it('exposes ApiError.is(...) for code matching', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'email_taken' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const http = new HttpClient({ baseUrl: 'https://api.test', fetchImpl: fetchImpl as never });
    try {
      await http.request('/v1/register', { method: 'POST' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).is('email_taken')).toBe(true);
      expect((err as ApiError).is('invalid_credentials', 'email_taken')).toBe(true);
      expect((err as ApiError).is('invalid_credentials')).toBe(false);
    }
  });

  it('throws NetworkError when fetch itself rejects', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });
    const http = new HttpClient({ baseUrl: 'https://api.test', fetchImpl: fetchImpl as never });
    await expect(http.request('/v1/health')).rejects.toBeInstanceOf(NetworkError);
  });

  it('fires onUnauthorized once on first 401', async () => {
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'unauthenticated' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const http = new HttpClient({
      baseUrl: 'https://api.test',
      fetchImpl: fetchImpl as never,
      onUnauthorized,
    });
    await expect(http.request('/v1/me')).rejects.toBeInstanceOf(ApiError);
    await expect(http.request('/v1/me')).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});
