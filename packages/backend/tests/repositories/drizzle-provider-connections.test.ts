import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { schema, type Database } from '@opendj/db';
import { DrizzleProviderConnectionRepository } from '../../src/repositories/drizzle/provider-connections.js';

/**
 * No Postgres in unit tests: a pg-proxy driver captures the SQL drizzle
 * emits and answers with canned rows, so the KTD6 write rules are checked
 * at the SQL level.
 */
interface Captured {
  sql: string;
  params: unknown[];
  method: string;
}

function proxyDb(answer: (q: Captured) => unknown[][]) {
  const queries: Captured[] = [];
  const db = drizzle(
    async (sql, params, method) => {
      const q = { sql, params, method };
      queries.push(q);
      return { rows: answer(q) };
    },
    { schema },
  );
  return { db: db as unknown as Database, queries };
}

const columnNames = Object.keys(getTableColumns(schema.providerConnections));

/** One `provider_connections` row in select-column order, as the driver returns it. */
function rowArray(overrides: Record<string, unknown> = {}): unknown[] {
  const base: Record<string, unknown> = {
    id: '00000000-0000-0000-0000-000000000001',
    accountId: '00000000-0000-0000-0000-0000000000a1',
    connectedByUserId: null,
    providerId: 'spotify',
    providerAccountId: null,
    displayName: null,
    accessToken: 'tok',
    refreshToken: null,
    expiresAt: null,
    scopes: null,
    tokenType: null,
    rawProfile: null,
    rawTokenResponse: null,
    rateLimitedUntil: null,
    searchRateLimitedUntil: null,
    rateLimitedClientId: null,
    createdAt: '2026-10-23 12:00:00+00',
    updatedAt: '2026-10-23 12:00:00+00',
    ...overrides,
  };
  return columnNames.map((name) => base[name]);
}

describe('DrizzleProviderConnectionRepository.extendRateLimitedUntil', () => {
  it('is an update-only GREATEST write that leaves updated_at alone', async () => {
    const { db, queries } = proxyDb(() => [['00000000-0000-0000-0000-000000000001']]);
    const repo = new DrizzleProviderConnectionRepository(db);
    const until = new Date(Date.UTC(2026, 9, 23, 14, 0, 0, 457));

    const updated = await repo.extendRateLimitedUntil({
      accountId: 'acct-1',
      providerId: 'spotify',
      group: 'player',
      until,
      clientId: 'client-a',
    });

    expect(updated).toBe(true);
    expect(queries).toHaveLength(1);
    const { sql, params } = queries[0]!;
    expect(sql).toMatch(/^update "provider_connections"/i);
    expect(sql).not.toMatch(/insert/i);
    expect(sql).toMatch(
      /greatest\((?:"provider_connections"\.)?"rate_limited_until", \$\d+(?:::timestamptz)?\)/i,
    );
    expect(sql).not.toContain('updated_at');
    expect(sql).toContain('"account_id"');
    expect(sql).toContain('"provider_id"');
    // Millisecond precision reaches the driver.
    expect(params).toContain('2026-10-23T14:00:00.457Z');
    expect(params).toContain('acct-1');
    expect(params).toContain('spotify');
    expect(params).toContain('client-a');
    expect(sql).toMatch(/"rate_limited_client_id" = \$\d+/);
    // The other group's column is only touched to drop another client's deadline.
    expect(sql).not.toMatch(/greatest\((?:"provider_connections"\.)?"search_rate_limited_until"/i);
  });

  it('writes a search cooldown to search_rate_limited_until with GREATEST', async () => {
    const { db, queries } = proxyDb(() => [['00000000-0000-0000-0000-000000000001']]);
    const repo = new DrizzleProviderConnectionRepository(db);

    await repo.extendRateLimitedUntil({
      accountId: 'acct-1',
      providerId: 'spotify',
      group: 'search',
      until: new Date(Date.UTC(2026, 9, 23, 14, 0, 0, 0)),
      clientId: 'client-a',
    });

    const { sql } = queries[0]!;
    expect(sql).toMatch(
      /greatest\((?:"provider_connections"\.)?"search_rate_limited_until", \$\d+(?:::timestamptz)?\)/i,
    );
    expect(sql).not.toMatch(/greatest\((?:"provider_connections"\.)?"rate_limited_until"/i);
    expect(sql).not.toContain('updated_at');
  });

  it('reports false (and does not throw) when no connection row matched', async () => {
    const { db } = proxyDb(() => []);
    const repo = new DrizzleProviderConnectionRepository(db);

    await expect(
      repo.extendRateLimitedUntil({
        accountId: 'missing',
        providerId: 'spotify',
        group: 'player',
        until: new Date(Date.now() + 1_000),
        clientId: null,
      }),
    ).resolves.toBe(false);
  });
});

describe('DrizzleProviderConnectionRepository row mapping', () => {
  it('exposes rateLimitedUntil at millisecond precision', async () => {
    const { db } = proxyDb(() => [rowArray({ rateLimitedUntil: '2026-10-23 14:00:00.457+00' })]);
    const repo = new DrizzleProviderConnectionRepository(db);

    const row = await repo.findByAccountAndProvider('acct-1', 'spotify');

    expect(row?.rateLimitedUntil?.getTime()).toBe(Date.UTC(2026, 9, 23, 14, 0, 0, 457));
  });

  it('exposes the search deadline and the client id it was recorded under', async () => {
    const { db } = proxyDb(() => [
      rowArray({
        searchRateLimitedUntil: '2026-10-23 14:00:00.457+00',
        rateLimitedClientId: 'client-a',
      }),
    ]);
    const repo = new DrizzleProviderConnectionRepository(db);

    const row = await repo.findByAccountAndProvider('acct-1', 'spotify');

    expect(row?.searchRateLimitedUntil?.getTime()).toBe(Date.UTC(2026, 9, 23, 14, 0, 0, 457));
    expect(row?.rateLimitedClientId).toBe('client-a');
    expect(row?.rateLimitedUntil).toBeNull();
  });

  it('maps a NULL rate_limited_until to null', async () => {
    const { db } = proxyDb(() => [rowArray()]);
    const repo = new DrizzleProviderConnectionRepository(db);

    const row = await repo.findByAccountAndProvider('acct-1', 'spotify');

    expect(row?.rateLimitedUntil).toBeNull();
  });
});

describe('DrizzleProviderConnectionRepository.upsert', () => {
  it('never lists rate_limited_until in the conflict update, so a reconnect keeps it', async () => {
    const { db, queries } = proxyDb(() => [
      rowArray({ rateLimitedUntil: '2026-10-23 14:00:00+00' }),
    ]);
    const repo = new DrizzleProviderConnectionRepository(db);

    const row = await repo.upsert({ accountId: 'acct-1', providerId: 'spotify', accessToken: 'x' });

    const sql = queries[0]!.sql;
    const lower = sql.toLowerCase();
    // Just the `do update set ...` list, without the trailing `returning`.
    const conflictSet = sql.slice(lower.indexOf('on conflict'), lower.indexOf(' returning '));
    expect(conflictSet).toMatch(/do update set/i);
    expect(conflictSet).not.toContain('rate_limited_until');
    expect(conflictSet).not.toContain('rate_limited_client_id');
    expect(row.rateLimitedUntil?.getTime()).toBe(Date.UTC(2026, 9, 23, 14, 0, 0, 0));
  });
});
