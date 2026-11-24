import { Database } from 'bun:sqlite';
import { applySchema } from '../../db/db';
import { DiscordGatewayRepository } from '../discord-gateway-repository';
import { test, expect, describe, afterEach, beforeEach } from 'bun:test';

describe('DiscordGatewayRepository', () => {
  let db: Database;
  let gateway: DiscordGatewayRepository;

  beforeEach(() => {
    db = new Database(':memory:', { strict: true });
    applySchema(db);
    gateway = new DiscordGatewayRepository(db);
  });

  afterEach(() => db.close());

  test('saves, updates, and clears a resumable session', () => {
    gateway.save('agent_a', 0, { shardId: 0, shardCount: 1, sessionId: 'session-1', resumeURL: 'wss://resume.discord.gg', sequence: 10 });
    expect(gateway.get('agent_a', 0)).toEqual({ shardId: 0, shardCount: 1, sessionId: 'session-1', resumeURL: 'wss://resume.discord.gg', sequence: 10 });

    gateway.save('agent_a', 0, { shardId: 0, shardCount: 1, sessionId: 'session-1', resumeURL: 'wss://resume.discord.gg', sequence: 11 });
    expect(gateway.get('agent_a', 0)?.sequence).toBe(11);

    gateway.save('agent_a', 0, null);
    expect(gateway.get('agent_a', 0)).toBeNull();
  });
});
