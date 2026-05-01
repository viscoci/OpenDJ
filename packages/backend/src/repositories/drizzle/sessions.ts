import type { Database } from '@opendj/db';
import { schema } from '@opendj/db';
import { eq } from 'drizzle-orm';
import type { SessionRecord, SessionRepository } from '../types.js';

function mapSession(row: typeof schema.sessions.$inferSelect): SessionRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    name: row.name,
    qrSlug: row.qrSlug,
    guestCapOverride: row.guestCapOverride,
    songsPerGuestCap: row.songsPerGuestCap,
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
}
