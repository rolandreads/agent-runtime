import type { Database } from 'bun:sqlite';
import type { SessionInfo } from '@discordjs/ws';
import type { CharacterId } from '../characters/character-catalog';
import type { DiscordGatewaySessionsRow } from '../db/schema-types';

export class DiscordGatewayRepository {
  constructor(private readonly db: Database) { }

  get(characterId: CharacterId, shardId: number): SessionInfo | null {
    const row = this.db.query<DiscordGatewaySessionsRow, [CharacterId, number]>('SELECT * FROM discord_gateway_sessions WHERE character_id = ? AND shard_id = ?').get(characterId, shardId);
    if (!row) return null;
    return { shardId: row.shard_id, shardCount: row.shard_count, sessionId: row.session_id, resumeURL: row.resume_url, sequence: row.sequence };
  }

  save(characterId: CharacterId, shardId: number, session: SessionInfo | null): void {
    if (!session) {
      this.db.query('DELETE FROM discord_gateway_sessions WHERE character_id = ? AND shard_id = ?').run(characterId, shardId);
      return;
    }

    this.db
      .query<never, DiscordGatewaySessionsRow>(`INSERT INTO discord_gateway_sessions (character_id, shard_id, session_id, resume_url, sequence, shard_count)
      VALUES ($character_id, $shard_id, $session_id, $resume_url, $sequence, $shard_count)
      ON CONFLICT(character_id, shard_id) DO UPDATE SET session_id = excluded.session_id, resume_url = excluded.resume_url, sequence = excluded.sequence, shard_count = excluded.shard_count`)
      .run({
        shard_id: shardId,
        character_id: characterId,
        sequence: session.sequence,
        resume_url: session.resumeURL,
        session_id: session.sessionId,
        shard_count: session.shardCount,
      });
  }
}
