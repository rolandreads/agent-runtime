import type { Logger } from 'pino';
import { Database } from 'bun:sqlite';
import type { UserId } from '../brands';
import { EventLog } from '../event-log';
import { test, expect } from 'bun:test';
import { applySchema } from '../../db/db';
import type { StoragePrivacy } from '../../privacy';
import { EventRepository } from '../../repositories/event-repository';

test('EventLog.error writes a turn failure to both the logger and the events table', () => {
  const db = new Database(':memory:', { strict: true });
  applySchema(db);
  const logs: Array<{ type: string }> = [];
  const eventLog = new EventLog(
    { info: () => undefined, error: (event: { type: string }) => logs.push(event) } as unknown as Logger,
    new EventRepository(db, { encryptForUser: (_userId: UserId, _scope: string, data: string) => data, decryptForUser: (_userId: UserId, _scope: string, data: string) => data } as unknown as StoragePrivacy),
  );

  eventLog.error({ type: 'turn_queue_process_failed', traceId: 'discord:1539121653316063352', data: { conversationId: 41 } }, new Error('NOT NULL constraint failed: agent_turns.frontend_message_id'));

  expect(logs).toMatchObject([{ type: 'turn_queue_process_failed' }]);
  const row = db.query<{ event_type: string; data: string }, []>(`SELECT event_type, data FROM events`).get();
  expect(row?.event_type).toBe('turn_queue_process_failed');
  expect(JSON.parse(row?.data ?? '{}')).toMatchObject({ conversationId: 41, error: { message: 'NOT NULL constraint failed: agent_turns.frontend_message_id' } });
  db.close();
});
