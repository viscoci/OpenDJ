import type { Database } from '@opendj/db';
import { schema } from '@opendj/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { SessionRecord, SessionRepository } from '../types.js';

function mapSession(row: typeof schema.sessions.$inferSelect): SessionRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    name: row.name,
    qrSlug: row.qrSlug,
    guestCapOverride: row.guestCapOverride,
    songsPerGuestCap: row.songsPerGuestCap,
    allowDuplicates: row.allowDuplicates,
    moderationEnabled: row.moderationEnabled,
    voteSkipMode: row.voteSkipMode as SessionRecord['voteSkipMode'],
    voteSkipThreshold: row.voteSkipThreshold,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
  };
}

export class DrizzleSessionRepository implements SessionRepository {
  constructor(private readonly db: Database) {}

  async findById(id: string): Promise<SessionRecord | null> {
    const rows = await this.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, id))
      .limit(1);
    return rows[0] ? mapSession(rows[0]) : null;
  }

  async findByQrSlug(qrSlug: string): Promise<SessionRecord | null> {
    const rows = await this.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.qrSlug, qrSlug))
      .limit(1);
    return rows[0] ? mapSession(rows[0]) : null;
  }

  async findByAccount(accountId: string): Promise<SessionRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.accountId, accountId));
    return rows.map(mapSession);
  }

  async create(input: {
    accountId: string;
    name: string;
    qrSlug: string;
    guestCapOverride?: number | null;
    songsPerGuestCap?: number;
    allowDuplicates?: boolean;
    moderationEnabled?: boolean;
    voteSkipMode?: 'fixed' | 'percentage' | 'host_approval';
    voteSkipThreshold?: number;
  }): Promise<SessionRecord> {
    const rows = await this.db
      .insert(schema.sessions)
      .values({
        accountId: input.accountId,
        name: input.name,
        qrSlug: input.qrSlug,
        guestCapOverride: input.guestCapOverride ?? null,
        songsPerGuestCap: input.songsPerGuestCap ?? 3,
        allowDuplicates: input.allowDuplicates ?? false,
        moderationEnabled: input.moderationEnabled ?? false,
        voteSkipMode: input.voteSkipMode ?? 'fixed',
        voteSkipThreshold: input.voteSkipThreshold ?? 5,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Failed to insert session.');
    return mapSession(row);
  }

  async update(input: {
    id: string;
    guestCapOverride?: number | null;
    songsPerGuestCap?: number;
    allowDuplicates?: boolean;
    moderationEnabled?: boolean;
    voteSkipMode?: 'fixed' | 'percentage' | 'host_approval';
    voteSkipThreshold?: number;
    name?: string;
  }): Promise<SessionRecord | null> {
    const set: Record<string, unknown> = {};
    if (input.guestCapOverride !== undefined) set['guestCapOverride'] = input.guestCapOverride;
    if (input.songsPerGuestCap !== undefined) set['songsPerGuestCap'] = input.songsPerGuestCap;
    if (input.allowDuplicates !== undefined) set['allowDuplicates'] = input.allowDuplicates;
    if (input.moderationEnabled !== undefined) set['moderationEnabled'] = input.moderationEnabled;
    if (input.voteSkipMode !== undefined) set['voteSkipMode'] = input.voteSkipMode;
    if (input.voteSkipThreshold !== undefined) set['voteSkipThreshold'] = input.voteSkipThreshold;
    if (input.name !== undefined) set['name'] = input.name;
    if (Object.keys(set).length === 0) return this.findById(input.id);
    const rows = await this.db
      .update(schema.sessions)
      .set(set)
      .where(eq(schema.sessions.id, input.id))
      .returning();
    return rows[0] ? mapSession(rows[0]) : null;
  }

  async end(id: string, endedAt: Date): Promise<SessionRecord | null> {
    // Idempotent: only set endedAt when currently null.
    const rows = await this.db
      .update(schema.sessions)
      .set({ endedAt })
      .where(and(eq(schema.sessions.id, id), isNull(schema.sessions.endedAt)))
      .returning();
    if (rows[0]) return mapSession(rows[0]);
    return this.findById(id);
  }
}
