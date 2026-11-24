import type { Database } from 'bun:sqlite';
import type { StoragePrivacy } from '../privacy';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { CharacterId } from '../characters/character-catalog';
import type { ConversationsRow, FrontendMessagesRow } from '../db/schema-types';
import type { UserId, ConversationId, GeneratedImageId } from '../utils/brands';
import type { Frontend, FrontendMessage, FrontendMessageContent, InboundFrontendMessage } from '../frontends/frontend-message';

export type Conversation = {
  id: number;
  userId: UserId;
  scopeKey: string;
  createdAt: number;
  updatedAt: number;
  characterId: CharacterId;
};

export type FrontendImageDeliveryTarget = {
  frontend: Frontend;
  characterId: CharacterId;
  frontendChannelId: string;
};

type StoredInboundMessageRow = FrontendMessagesRow & Pick<ConversationsRow, 'user_id' | 'character_id'>;

export class MessageRepository {
  private readonly upsertConversationQuery =
    `INSERT INTO conversations (user_id, character_id, scope_key, created_at, updated_at) VALUES ($user_id, $character_id, $scope_key, $created_at,$updated_at) ON CONFLICT(scope_key) DO UPDATE SET updated_at = excluded.updated_at RETURNING *`;
  private readonly insertInboundFrontendMessageQuery =
    `INSERT INTO frontend_messages (conversation_id, agent_message_id, frontend, frontend_message_id, frontend_channel_id, direction, chunk_index, content_json, created_at) VALUES ($conversation_id, $agent_message_id, $frontend, $frontend_message_id, $frontend_channel_id, $direction, $chunk_index, $content_json, $created_at) ON CONFLICT(frontend, frontend_message_id) DO NOTHING`;
  private readonly findInboundFrontendMessageQuery = `SELECT id, conversation_id FROM frontend_messages WHERE frontend = $frontend AND frontend_message_id = $frontend_message_id AND direction = 'inbound' LIMIT 1`;
  private readonly listUnassignedInboundMessagesQuery =
    `SELECT frontend_messages.*, conversations.user_id, conversations.character_id
     FROM frontend_messages
     JOIN conversations ON conversations.id = frontend_messages.conversation_id
     WHERE frontend_messages.direction = 'inbound'
       AND NOT EXISTS (SELECT 1 FROM agent_turn_inputs WHERE agent_turn_inputs.frontend_message_id = frontend_messages.id)
     ORDER BY frontend_messages.created_at, frontend_messages.id`;
  private readonly findTurnStatusByFrontendMessageQuery =
    `SELECT agent_turns.status
     FROM agent_turn_inputs
     JOIN agent_turns ON agent_turns.id = agent_turn_inputs.turn_id
     WHERE agent_turn_inputs.frontend_message_id = $frontend_message_id
     LIMIT 1`;
  private readonly insertOutboundFrontendMessageQuery =
    `INSERT INTO frontend_messages (conversation_id, agent_message_id, generated_image_id, frontend, frontend_message_id, frontend_channel_id, direction, chunk_index, content_json, created_at) VALUES ($conversation_id, $agent_message_id, $generated_image_id, $frontend, $frontend_message_id, $frontend_channel_id, $direction, $chunk_index, $content_json, $created_at)`;
  private readonly linkFrontendMessageQuery = `UPDATE frontend_messages SET agent_message_id = $agent_message_id WHERE id = $id AND conversation_id = $conversation_id AND direction = 'inbound'`;
  private readonly createTurnQuery =
    `INSERT INTO agent_turns (conversation_id, trace_id, status, failure, created_at, completed_at) VALUES ($conversation_id, $trace_id, $status, NULL, $created_at, $completed_at)`;
  private readonly insertTurnInputQuery = `INSERT INTO agent_turn_inputs (turn_id, frontend_message_id, position) VALUES ($turn_id, $frontend_message_id, $position)`;
  private readonly updateTurnQuery = `UPDATE agent_turns SET status = $status, failure = $failure, completed_at = $completed_at WHERE id = $id`;
  private readonly insertAgentMessageQuery = `INSERT INTO agent_messages (conversation_id, turn_id, role, agent_message_json, created_at) VALUES ($conversation_id, $turn_id, $role, $agent_message_json, $created_at)`;
  private readonly findConversationByScopeQuery = `SELECT id FROM conversations WHERE scope_key = $scope_key LIMIT 1`;
  private readonly archiveConversationQuery = `UPDATE conversations SET scope_key = $scope_key, updated_at = $updated_at WHERE id = $id`;
  private readonly unlinkRunningTurnFrontendMessagesQuery = `UPDATE frontend_messages SET agent_message_id = NULL WHERE agent_message_id IN (SELECT agent_messages.id FROM agent_messages JOIN agent_turns ON agent_turns.id = agent_messages.turn_id WHERE agent_turns.status = 'running')`;
  private readonly deleteRunningTurnMessagesQuery = `DELETE FROM agent_messages WHERE turn_id IN (SELECT id FROM agent_turns WHERE status = 'running')`;
  private readonly deleteRunningTurnsQuery = `DELETE FROM agent_turns WHERE status = 'running'`;
  private readonly countRunningTurnsQuery = `SELECT count(*) AS count FROM agent_turns WHERE status = 'running'`;
  private readonly getFrontendRouteQuery =
    `SELECT frontend_messages.frontend, frontend_messages.frontend_channel_id, conversations.character_id FROM frontend_messages JOIN conversations ON conversations.id = frontend_messages.conversation_id WHERE frontend_messages.conversation_id = $conversation_id ORDER BY frontend_messages.id DESC LIMIT 1`;
  private readonly findLatestTurnInputQuery = `SELECT frontend_messages.frontend_message_id, frontend_messages.content_json FROM agent_turns JOIN agent_turn_inputs ON agent_turn_inputs.turn_id = agent_turns.id JOIN frontend_messages ON frontend_messages.id = agent_turn_inputs.frontend_message_id WHERE agent_turns.trace_id = $trace_id ORDER BY agent_turn_inputs.position DESC LIMIT 1`;
  private readonly findFrontendMessageIdForGeneratedImageQuery = `SELECT frontend_message_id FROM frontend_messages WHERE generated_image_id = $generated_image_id ORDER BY id DESC LIMIT 1`;
  private readonly listRecentCompletedTurnMessagesQuery = `SELECT agent_messages.agent_message_json, conversations.user_id
     FROM agent_messages
     JOIN conversations ON conversations.id = agent_messages.conversation_id
     JOIN agent_turns ON agent_turns.id = agent_messages.turn_id
     WHERE agent_messages.conversation_id = $conversation_id
       AND agent_turns.id IN (
         SELECT id
         FROM agent_turns
         WHERE conversation_id = $conversation_id AND status = 'completed' AND created_at >= $since
         ORDER BY id DESC
         LIMIT $turn_step + ((SELECT COUNT(*) FROM agent_turns WHERE conversation_id = $conversation_id AND status = 'completed' AND created_at >= $since) % $turn_step)
       )
     ORDER BY agent_messages.id ASC`;

  constructor(
    private readonly db: Database,
    private readonly privacy: StoragePrivacy,
  ) { }

  getOrCreateConversation(params: { userId: UserId; characterId: CharacterId; frontend: Frontend }): Conversation {
    const now = Date.now();
    const scopeKey = this.conversationScope(params);
    const row = this.db.query(this.upsertConversationQuery).get({ user_id: params.userId, character_id: params.characterId, scope_key: scopeKey, created_at: now, updated_at: now }) as ConversationsRow;
    return this.deserializeConversation(row);
  }

  clearContext(params: { userId: UserId; characterId: CharacterId; frontend: Frontend }): void {
    const scopeKey = this.conversationScope(params);
    const row = this.db.query<{ id: number }, { scope_key: string }>(this.findConversationByScopeQuery).get({ scope_key: scopeKey });
    if (row === null) return;
    this.db.query(this.archiveConversationQuery).run({ id: row.id, scope_key: `${scopeKey}:archived:${String(row.id)}`, updated_at: Date.now() });
  }

  saveInboundFrontendMessage(params: InboundFrontendMessage): FrontendMessage {
    return this.db.transaction(() => {
      this.db.query(this.insertInboundFrontendMessageQuery).run({
        chunk_index: 0,
        direction: 'inbound',
        agent_message_id: null,
        frontend: params.frontend,
        created_at: params.timestamp,
        conversation_id: conversation.id,
        frontend_channel_id: params.frontendChannelId,
        frontend_message_id: params.frontendMessageId,
        content_json: JSON.stringify(params.content.map((content) => this.serializeInboundContent(params.userId, content))),
      });
      return { ...params, id: stored.id, conversationId: stored.conversation_id as ConversationId };
      if (!stored) throw new Error(`Inbound frontend message ${params.frontendMessageId} was not stored`);
      const conversation = this.getOrCreateConversation({ userId: params.userId, characterId: params.characterId, frontend: params.frontend });
      const stored = this.db.query<Pick<FrontendMessagesRow, 'id' | 'conversation_id'>, { frontend: Frontend; frontend_message_id: string }>(this.findInboundFrontendMessageQuery).get({ frontend: params.frontend, frontend_message_id: params.frontendMessageId });
    })();
  }

  findTurnStatusByFrontendMessageId(frontendMessageId: number): string | null {
    return this.db.query<{ status: string }, { frontend_message_id: number }>(this.findTurnStatusByFrontendMessageQuery).get({ frontend_message_id: frontendMessageId })?.status ?? null;
  }

  listUnassignedInboundMessages(): FrontendMessage[] {
    const rows = this.db.query<StoredInboundMessageRow, []>(this.listUnassignedInboundMessagesQuery).all();
    return rows.flatMap((row) => {
      const message = this.deserializeStoredInboundMessage(row);
      return message ? [message] : [];
    });
  }

  recoverStaleRunningTurns(): number {
    return this.db.transaction(() => {
      const count = this.db.query<{ count: number }, []>(this.countRunningTurnsQuery).get()?.count ?? 0;
      this.db.query(this.unlinkRunningTurnFrontendMessagesQuery).run();
      this.db.query(this.deleteRunningTurnMessagesQuery).run();
      this.db.query(this.deleteRunningTurnsQuery).run();
      return count;
    })();
  }

  saveOutboundFrontendMessage(params: { userId: UserId; conversationId: number; agentMessageId: number; frontend: Frontend; frontendMessageId: string; frontendChannelId: string; chunkIndex: number; text: string }): number {
    const result = this.db.query(this.insertOutboundFrontendMessageQuery).run({
      direction: 'outbound',
      created_at: Date.now(),
      generated_image_id: null,
      frontend: params.frontend,
      chunk_index: params.chunkIndex,
      conversation_id: params.conversationId,
      agent_message_id: params.agentMessageId,
      frontend_channel_id: params.frontendChannelId,
      frontend_message_id: params.frontendMessageId,
      content_json: JSON.stringify([{ type: 'text', text: this.privacy.encryptForUser(params.userId, 'frontend_messages.text', params.text) }]),
    });
    return Number(result.lastInsertRowid);
  }

  saveOutboundFrontendImage(params: { conversationId: number; generatedImageId: GeneratedImageId; frontend: Frontend; frontendMessageId: string; frontendChannelId: string }): number {
    const result = this.db.query(this.insertOutboundFrontendMessageQuery).run({
      chunk_index: 0,
      content_json: null,
      direction: 'outbound',
      agent_message_id: null,
      created_at: Date.now(),
      frontend: params.frontend,
      conversation_id: params.conversationId,
      generated_image_id: params.generatedImageId,
      frontend_channel_id: params.frontendChannelId,
      frontend_message_id: params.frontendMessageId,
    });
    return Number(result.lastInsertRowid);
  }

  getFrontendImageDeliveryTarget(conversationId: ConversationId): FrontendImageDeliveryTarget {
    if (route === null) throw new Error(`No frontend route found for conversation ${conversationId}`);

    return { frontend: route.frontend as Frontend, frontendChannelId: route.frontend_channel_id, characterId: route.character_id as CharacterId };
    const route = this.db.query<{ frontend: string; frontend_channel_id: string; character_id: string }, { conversation_id: number }>(this.getFrontendRouteQuery).get({ conversation_id: conversationId });
  }

  findFailureReplyTarget(params: { traceId: string; sourceImageId: GeneratedImageId | null }): string | null {
    return input?.frontend_message_id ?? null;
    if (input && !isImageAction) return input.frontend_message_id;
    const isImageAction = input?.content_json ? (JSON.parse(input.content_json) as Array<{ type: string }>).some((content) => content.type === 'image_action') : false;
    const input = this.db.query<{ frontend_message_id: string; content_json: string | null }, { trace_id: string }>(this.findLatestTurnInputQuery).get({ trace_id: params.traceId });
    if (params.sourceImageId !== null) return this.db.query<{ frontend_message_id: string }, { generated_image_id: number }>(this.findFrontendMessageIdForGeneratedImageQuery).get({ generated_image_id: params.sourceImageId })?.frontend_message_id ?? input?.frontend_message_id ?? null;
  }

  linkFrontendMessagesToAgentMessage(params: { conversationId: number; agentMessageId: number; frontendMessageIds: readonly number[] }): void {
    for (const id of params.frontendMessageIds) {
      this.db.query(this.linkFrontendMessageQuery).run({
        id,
        conversation_id: params.conversationId,
        agent_message_id: params.agentMessageId,
      });
    }
  }

  createTurn(params: { conversationId: number; frontendMessageIds: readonly number[]; traceId: string }): number {
    return this.db.transaction(() => {
      const result = this.db.query(this.createTurnQuery).run({ status: 'running', created_at: Date.now(), completed_at: null, trace_id: params.traceId, conversation_id: params.conversationId });
      const turnId = Number(result.lastInsertRowid);
      params.frontendMessageIds.forEach((frontendMessageId, position) => {
        this.db.query(this.insertTurnInputQuery).run({ turn_id: turnId, frontend_message_id: frontendMessageId, position });
      });
      return turnId;
    })();
  }

  finishTurn(params: { turnId: number; status: 'completed' | 'cancelled' } | { turnId: number; status: 'failed'; failure: string }): void {
    this.db.query(this.updateTurnQuery).run({ id: params.turnId, status: params.status, failure: params.status === 'failed' ? params.failure : null, completed_at: Date.now() });
  }

  appendAgentMessage(params: { userId: UserId; conversationId: number; turnId: number; agentMessage: AgentMessage }): number {
    const result = this.db.query(this.insertAgentMessageQuery).run({
      created_at: Date.now(),
      turn_id: params.turnId,
      role: params.agentMessage.role,
      conversation_id: params.conversationId,
      agent_message_json: this.privacy.encryptForUser(params.userId, 'agent_messages.agent_message_json', JSON.stringify(params.agentMessage)),
    });
    return Number(result.lastInsertRowid);
  }

  // Keeps the newest turnStep..2*turnStep-1 completed turns since `since`; the window start moves every turnStep turns so consecutive prompts share a cacheable prefix.
  listRecentCompletedTurnMessages(params: { conversationId: number; turnStep: number; since: number }): AgentMessage[] {
    const rows = this.db.query(this.listRecentCompletedTurnMessagesQuery).all({ conversation_id: params.conversationId, turn_step: params.turnStep, since: params.since }) as Array<{ user_id: string; agent_message_json: string }>;

    return rows.map((row) => JSON.parse(this.privacy.decryptForUser(row.user_id as UserId, 'agent_messages.agent_message_json', row.agent_message_json)) as AgentMessage);
  }

  private deserializeConversation(row: ConversationsRow): Conversation {
    return {
      id: row.id,
      scopeKey: row.scope_key,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      userId: row.user_id as UserId,
      characterId: row.character_id as CharacterId,
    };
  }

  private serializeInboundContent(userId: UserId, content: FrontendMessageContent): object {
    switch (content.type) {
      case 'reply_to_generated_image':
      case 'text':
        return { ...content, text: this.privacy.encryptForUser(userId, 'frontend_messages.text', content.text) };
      case 'image_action':
        return { ...content, sourceImage: { imageId: content.sourceImage.imageId, prompt: this.privacy.encryptForUser(userId, 'frontend_messages.generated_image_prompt', content.sourceImage.prompt), loras: content.sourceImage.loras } };
    }
  }

  private deserializeStoredInboundMessage(row: StoredInboundMessageRow): FrontendMessage | null {
    if (!row.content_json) return null;
    const storedContent = JSON.parse(row.content_json) as FrontendMessageContent[];
    const content: FrontendMessageContent[] = [];
    for (const item of storedContent) {
      switch (item.type) {
        default:
          return null;
        case 'reply_to_generated_image':
        case 'text':
          content.push({ ...item, text: this.privacy.decryptForUser(row.user_id as UserId, 'frontend_messages.text', item.text) });
          break;
        case 'image_action':
          content.push({ ...item, sourceImage: { ...item.sourceImage, prompt: this.privacy.decryptForUser(row.user_id as UserId, 'frontend_messages.generated_image_prompt', item.sourceImage.prompt) } });
          break;
      }
    }
    if (!content.length) return null;
    return {
      id: row.id,
      timestamp: row.created_at,
      userId: row.user_id as UserId,
      frontend: row.frontend as Frontend,
      frontendChannelId: row.frontend_channel_id,
      frontendMessageId: row.frontend_message_id,
      characterId: row.character_id as CharacterId,
      content: content as FrontendMessage['content'],
      conversationId: row.conversation_id as ConversationId,
      traceId: `${row.frontend}:${row.frontend_message_id}`,
    };
  }

  conversationScope(params: { userId: UserId; characterId: CharacterId; frontend: Frontend }): string {
    return `${params.frontend}:dm:${params.userId}:${params.characterId}`;
  }
}
