import type { Database } from '@opendj/db';
import { schema } from '@opendj/db';
import { and, asc, eq, lte } from 'drizzle-orm';
import type { GuestSlotRecord, GuestSlotRepository, GuestSlotStatus } from '../types.js';

function mapSlot(row: typeof schema.guestSlots.$inferSelect): GuestSlotRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    fingerprintHash: row.fingerprintHash,
    slotToken: row.slotToken,
    status: row.status as GuestSlotStatus,
    queuePosition: row.queuePosition,
    lastHeartbeat: row.lastHeartbeat,
    createdAt: row.createdAt,
  };
}

export class DrizzleGuestSlotRepository implements GuestSlotRepository {
  constructor(private readonly db: Database) {}

  async findBySessionAndFingerprint(
    sessionId: string,
    fingerprintHash: string,
  ): Promise<GuestSlotRecord | null> {
    const rows = await this.db
      .select()
      .from(schema.guestSlots)
      .where(
        and(
          eq(schema.guestSlots.sessionId, sessionId),
          eq(schema.guestSlots.fingerprintHash, fingerprintHash),
        ),
      )
      .limit(1);
    return rows[0] ? mapSlot(rows[0]) : null;
  }

  async findBySlotToken(slotToken: string): Promise<GuestSlotRecord | null> {
    const rows = await this.db
      .select()
      .from(schema.guestSlots)
      .where(eq(schema.guestSlots.slotToken, slotToken))
      .limit(1);
    return rows[0] ? mapSlot(rows[0]) : null;
  }

  async countByStatus(sessionId: string, status: GuestSlotStatus): Promise<number> {
    const rows = await this.db
      .select({ id: schema.guestSlots.id })
      .from(schema.guestSlots)
      .where(and(eq(schema.guestSlots.sessionId, sessionId), eq(schema.guestSlots.status, status)));
    return rows.length;
  }

  async create(input: {
    sessionId: string;
    fingerprintHash: string;
    slotToken: string;
    status: GuestSlotStatus;
    queuePosition?: number | null;
  }): Promise<GuestSlotRecord> {
    const rows = await this.db
      .insert(schema.guestSlots)
      .values({
        sessionId: input.sessionId,
        fingerprintHash: input.fingerprintHash,
        slotToken: input.slotToken,
        status: input.status,
        queuePosition: input.queuePosition ?? null,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Failed to insert guest slot.');
    return mapSlot(row);
  }

  async touchHeartbeat(id: string, nowEpochMs: number): Promise<void> {
    await this.db
      .update(schema.guestSlots)
      .set({ lastHeartbeat: new Date(nowEpochMs) })
      .where(eq(schema.guestSlots.id, id));
  }

  async setStatus(input: {
    id: string;
    status: GuestSlotStatus;
    queuePosition?: number | null;
  }): Promise<void> {
    const set: Record<string, unknown> = { status: input.status };
    if (input.queuePosition !== undefined) set['queuePosition'] = input.queuePosition;
    await this.db.update(schema.guestSlots).set(set).where(eq(schema.guestSlots.id, input.id));
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(schema.guestSlots).where(eq(schema.guestSlots.id, id));
  }

  async findActiveStaleSince(sessionId: string, cutoff: Date): Promise<GuestSlotRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.guestSlots)
      .where(
        and(
          eq(schema.guestSlots.sessionId, sessionId),
          eq(schema.guestSlots.status, 'active'),
          lte(schema.guestSlots.lastHeartbeat, cutoff),
        ),
      );
    return rows.map(mapSlot);
  }

  async findFirstQueued(sessionId: string): Promise<GuestSlotRecord | null> {
    const rows = await this.db
      .select()
      .from(schema.guestSlots)
      .where(
        and(eq(schema.guestSlots.sessionId, sessionId), eq(schema.guestSlots.status, 'queued')),
      )
      .orderBy(asc(schema.guestSlots.createdAt))
      .limit(1);
    return rows[0] ? mapSlot(rows[0]) : null;
  }
}
