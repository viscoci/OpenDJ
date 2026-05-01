import type { Database } from '@opendj/db';
import { schema } from '@opendj/db';
import { and, eq } from 'drizzle-orm';
import type { GuestRecord, GuestRepository } from '../types.js';

function mapGuest(row: typeof schema.guests.$inferSelect): GuestRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    userId: row.userId,
    fingerprint: row.fingerprint,
    name: row.name,
    createdAt: row.createdAt,
  };
}

export class DrizzleGuestRepository implements GuestRepository {
  constructor(private readonly db: Database) {}

  async findBySessionAndFingerprint(
    sessionId: string,
    fingerprint: string,
  ): Promise<GuestRecord | null> {
    const rows = await this.db
      .select()
      .from(schema.guests)
      .where(
        and(eq(schema.guests.sessionId, sessionId), eq(schema.guests.fingerprint, fingerprint)),
      )
      .limit(1);
    return rows[0] ? mapGuest(rows[0]) : null;
  }

  async create(input: {
    sessionId: string;
    userId?: string | null;
    fingerprint: string;
    name?: string | null;
  }): Promise<GuestRecord> {
    const rows = await this.db
      .insert(schema.guests)
      .values({
        sessionId: input.sessionId,
        userId: input.userId ?? null,
        fingerprint: input.fingerprint,
        name: input.name ?? null,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Failed to insert guest.');
    return mapGuest(row);
  }

  async linkUser(guestId: string, userId: string): Promise<void> {
    await this.db.update(schema.guests).set({ userId }).where(eq(schema.guests.id, guestId));
  }
}
