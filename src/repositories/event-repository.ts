import type { Database } from 'bun:sqlite';
import type { UserId } from '../utils/brands';
import type { StoragePrivacy } from '../privacy';
import type { EventsRow } from '../db/schema-types';

export type Event = {
  type: string;
  userId?: UserId;
  traceId?: string;
  durationMs?: number;
  data?: Record<string, unknown>;
};

export class EventRepository {
  private readonly saveQuery = `INSERT INTO events (trace_id, event_type, created_at, duration_ms, user_id, data) VALUES ($trace_id, $event_type, $created_at, $duration_ms, $user_id, $data)`;

  constructor(
    private readonly db: Database,
    private readonly privacy: StoragePrivacy,
  ) {}

  save(event: Event): void {
    const row = this.serialize(event);
    this.db.query<never, Omit<EventsRow, 'id'>>(this.saveQuery).run(row);
  }

  private serialize(event: Event): Omit<EventsRow, 'id'> {
    const userId = event.userId ?? null;
    const jsonData = JSON.stringify(event.data ?? {});
    const data = userId === null ? jsonData : this.privacy.encryptForUser(userId, `events.data`, jsonData);

    return { data, user_id: userId, event_type: event.type, trace_id: event.traceId ?? null, created_at: Date.now(), duration_ms: event.durationMs ?? null };
  }
}
