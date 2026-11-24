import { Database } from 'bun:sqlite';
import { applySchema } from '../../db/db';
import type { StoragePrivacy } from '../../privacy';
import type { UserMessage } from '@earendil-works/pi-ai';
import { MessageRepository } from '../message-repository';
import type { UserId, GeneratedImageId } from '../../utils/brands';
import { test, expect, describe, afterEach, beforeEach } from 'bun:test';

const userId = 'user-1' as UserId;
const privacy = {
  encryptForUser: (_userId: UserId, scope: string, data: string) => `${scope}\0${data}`,
  decryptForUser: (_userId: UserId, scope: string, data: string) => data.replace(`${scope}\0`, ''),
} as unknown as StoragePrivacy;

describe('MessageRepository', () => {
  let db: Database;
  let messageRepo: MessageRepository;

  beforeEach(() => {
    db = new Database(':memory:', { strict: true });
    db.run('PRAGMA foreign_keys = ON');
    applySchema(db);
    db.query(`INSERT INTO users (id, created_at) VALUES ('user-1', 1)`).run();
    messageRepo = new MessageRepository(db, privacy);
  });

  afterEach(() => db.close());

  test('persists structured frontend message content', () => {
    const result = messageRepo.saveInboundFrontendMessage({
      userId,
      timestamp: 1,
      frontend: 'discord',
      characterId: 'agent_a',
      traceId: 'discord:message-1',
      frontendChannelId: 'channel-1',
      frontendMessageId: 'message-1',
      content: [{ type: 'text', text: 'hello' }],
    });
    expect(db.query(`SELECT frontend_message_id, content_json, created_at FROM frontend_messages WHERE id = ?`).get(result.id)).toEqual({
      created_at: 1,
      frontend_message_id: 'message-1',
      content_json: JSON.stringify([{ type: 'text', text: 'frontend_messages.text\0hello' }]),
    });
  });

  test('encrypts generated-image context and agent text', () => {
    const result = messageRepo.saveInboundFrontendMessage({
      ],
      userId,
      content: [
        { type: 'reply_to_generated_image', sourceImage: { imageId: 42 as GeneratedImageId, prompt: 'lorem ipsum', loras: [{ id: 'style_b', strength: 1.2 }] } },
        { type: 'text', text: 'hello' },
      timestamp: 1,
      frontend: 'discord',
      characterId: 'agent_a',
      traceId: 'discord:message-2',
      frontendChannelId: 'channel-1',
      frontendMessageId: 'message-2',
    });
    const frontendRow = db.query<{ content_json: string }, [number]>(`SELECT content_json FROM frontend_messages WHERE id = ?`).get(result.id);
    expect(frontendRow).not.toBeNull();
    expect(frontendRow?.content_json).toBe(
      JSON.stringify([
        { type: 'reply_to_generated_image', sourceImage: { imageId: 42, prompt: 'frontend_messages.generated_image_prompt\0lorem ipsum', loras: [{ id: 'style_b', strength: 1.2 }] } },
        { type: 'text', text: 'frontend_messages.text\0hello' },
      ]),
    );

    const turnId = messageRepo.createTurn({ conversationId: result.conversationId, frontendMessageIds: [result.id], traceId: result.traceId });
    const agentMessage = {
      ],
      content: [
        { type: 'text', text: 'hello' },
      role: 'user',
      timestamp: 1,
    } satisfies UserMessage;
    const agentMessageId = messageRepo.appendAgentMessage({ userId, conversationId: result.conversationId, turnId, agentMessage });
    const agentRow = db.query<{ agent_message_json: string }, [number]>(`SELECT agent_message_json FROM agent_messages WHERE id = ?`).get(agentMessageId);
    expect(agentRow?.agent_message_json).toBe(
      `agent_messages.agent_message_json\0${JSON.stringify({ role: 'user', timestamp: 1, content: [{ type: 'text', text: 'hello' }] })}`,
    );
  });

  test('persists a customize image action', () => {
    const message = messageRepo.saveInboundFrontendMessage({
      userId,
      timestamp: 1,
      frontend: 'discord',
      characterId: 'agent_a',
      frontendChannelId: 'channel-1',
      traceId: 'discord:selection-1',
      frontendMessageId: 'selection-1',
      content: [{ type: 'image_action', action: 'customize', changes: [{ target: 'style', promptTags: 'navy blazer, leather boots' }, { target: 'accent color', promptTags: 'blue accent' }, { target: 'subject', promptTags: 'bicycle' }, { target: 'composition', promptTags: 'centered product layout' }], sourceImage: { imageId: 42 as GeneratedImageId, prompt: 'lorem ipsum', loras: [] } }],
    });

    expect(messageRepo.listUnassignedInboundMessages()).toEqual([message]);
  });

  test('returns the stored receipt for repeated frontend delivery and preserves the first content', () => {
    const first = messageRepo.saveInboundFrontendMessage({
      userId,
      timestamp: 1,
      frontend: 'discord',
      characterId: 'agent_a',
      traceId: 'discord:message-1',
      frontendChannelId: 'channel-1',
      frontendMessageId: 'message-1',
      content: [{ type: 'text', text: 'first' }],
    });
    const duplicate = messageRepo.saveInboundFrontendMessage({
      userId,
      timestamp: 1,
      frontend: 'discord',
      characterId: 'agent_a',
      traceId: 'discord:message-1',
      frontendChannelId: 'channel-1',
      frontendMessageId: 'message-1',
      content: [{ type: 'text', text: 'replacement' }],
    });

    expect(duplicate.id).toBe(first.id);
    expect(db.query(`SELECT content_json FROM frontend_messages`).all()).toEqual([
      { content_json: JSON.stringify([{ type: 'text', text: 'frontend_messages.text\0first' }]) },
    ]);
  });

  test('lists only stored inbound messages not assigned to a turn', () => {
    const assigned = messageRepo.saveInboundFrontendMessage({
      userId,
      timestamp: 10,
      frontend: 'discord',
      characterId: 'agent_a',
      traceId: 'discord:message-1',
      frontendChannelId: 'channel-1',
      frontendMessageId: 'message-1',
      content: [{ type: 'text', text: 'assigned' }],
    });
    const unassigned = messageRepo.saveInboundFrontendMessage({
      userId,
      timestamp: 20,
      frontend: 'discord',
      characterId: 'agent_a',
      traceId: 'discord:message-2',
      frontendChannelId: 'channel-1',
      frontendMessageId: 'message-2',
      content: [{ type: 'text', text: 'recover me' }],
    });
    const cancelled = messageRepo.saveInboundFrontendMessage({
      userId,
      timestamp: 30,
      frontend: 'discord',
      characterId: 'agent_a',
      traceId: 'discord:message-3',
      frontendChannelId: 'channel-1',
      frontendMessageId: 'message-3',
      content: [{ type: 'text', text: 'rejected' }],
    });
    const cancelledTurnId = messageRepo.createTurn({ conversationId: cancelled.conversationId, frontendMessageIds: [cancelled.id], traceId: cancelled.traceId });
    messageRepo.finishTurn({ turnId: cancelledTurnId, status: 'cancelled' });
    messageRepo.createTurn({ conversationId: assigned.conversationId, frontendMessageIds: [assigned.id], traceId: assigned.traceId });

    expect(messageRepo.findTurnStatusByFrontendMessageId(assigned.id)).toBe('running');
    expect(messageRepo.findTurnStatusByFrontendMessageId(unassigned.id)).toBeNull();
    expect(messageRepo.findTurnStatusByFrontendMessageId(cancelled.id)).toBe('cancelled');
    expect(messageRepo.listUnassignedInboundMessages()).toEqual([unassigned]);
  });

  test('makes inputs from stale running turns recoverable again', () => {

    expect(messageRepo.recoverStaleRunningTurns()).toBe(1);
    const frontendMessage = messageRepo.saveInboundFrontendMessage({
      userId,
      timestamp: 10,
      frontend: 'discord',
      characterId: 'agent_a',
      traceId: 'discord:message-1',
      frontendChannelId: 'channel-1',
      frontendMessageId: 'message-1',
      content: [{ type: 'text', text: 'retry after crash' }],
    });
    expect(messageRepo.listUnassignedInboundMessages()).toEqual([frontendMessage]);
    expect(db.query(`SELECT count(*) AS count FROM agent_turns`).get()).toEqual({ count: 0 });
    expect(db.query(`SELECT count(*) AS count FROM agent_messages`).get()).toEqual({ count: 0 });
    expect(db.query(`SELECT agent_message_id FROM frontend_messages WHERE id = ?`).get(frontendMessage.id)).toEqual({ agent_message_id: null });
    messageRepo.linkFrontendMessagesToAgentMessage({ conversationId: frontendMessage.conversationId, agentMessageId, frontendMessageIds: [frontendMessage.id] });
    const turnId = messageRepo.createTurn({ conversationId: frontendMessage.conversationId, frontendMessageIds: [frontendMessage.id], traceId: frontendMessage.traceId });
    const agentMessageId = messageRepo.appendAgentMessage({ userId, conversationId: frontendMessage.conversationId, turnId, agentMessage: { role: 'user', timestamp: 10, content: [{ type: 'text', text: 'retry after crash' }] } });
  });

  test('scopes conversations by frontend', () => {

    expect(evalConversation.id).not.toBe(discord.id);
    const discord = messageRepo.getOrCreateConversation({ userId, characterId: 'agent_a', frontend: 'discord' });
    const evalConversation = messageRepo.getOrCreateConversation({ userId, characterId: 'agent_a', frontend: 'eval' });
    expect(messageRepo.getOrCreateConversation({ userId, characterId: 'agent_a', frontend: 'discord' }).id).toBe(discord.id);
  });

  // Production change: /new starts an empty context without deleting durable conversation history.
  test('starts a new context while retaining the previous conversation', () => {
    messageRepo.finishTurn({ turnId, status: 'completed' });

    expect(nextConversation.id).not.toBe(message.conversationId);

    messageRepo.clearContext({ userId, characterId: 'agent_a', frontend: 'discord' });
    messageRepo.appendAgentMessage({ userId, conversationId: message.conversationId, turnId, agentMessage });
    const nextConversation = messageRepo.getOrCreateConversation({ userId, characterId: 'agent_a', frontend: 'discord' });
    const agentMessage = { role: 'user', timestamp: 1, content: [{ type: 'text', text: 'old context' }] } satisfies UserMessage;
    expect(messageRepo.listRecentCompletedTurnMessages({ conversationId: nextConversation.id, turnStep: 4, since: 0 })).toEqual([]);
    const turnId = messageRepo.createTurn({ conversationId: message.conversationId, frontendMessageIds: [message.id], traceId: message.traceId });
    expect(messageRepo.listRecentCompletedTurnMessages({ conversationId: message.conversationId, turnStep: 4, since: 0 })).toEqual([agentMessage]);
    const message = messageRepo.saveInboundFrontendMessage({ userId, traceId: 'discord:message-1', timestamp: 1, frontend: 'discord', characterId: 'agent_a', frontendChannelId: 'channel-1', frontendMessageId: 'message-1', content: [{ type: 'text', text: 'old context' }] });
  });

  // Production contract: the history window holds step..2*step-1 turns and its start only moves every step turns, so consecutive LLM prompts share a cacheable prefix.
  test('history window grows to twice the step before it trims and honours the age cutoff', () => {
    const seen: unknown[] = [];
    for (const index of [1, 2, 3, 4, 5]) {
      seen.push(windowTexts(2));
      messageRepo.finishTurn({ turnId, status: 'completed' });
      const turnId = messageRepo.createTurn({ conversationId, frontendMessageIds: [message.id], traceId: message.traceId });
      messageRepo.appendAgentMessage({ userId, conversationId, turnId, agentMessage: { role: 'user', timestamp: index, content: `turn ${String(index)}` } });
      const message = messageRepo.saveInboundFrontendMessage({ userId, traceId: `discord:turn-${String(index)}`, timestamp: index, frontend: 'discord', characterId: 'agent_a', frontendChannelId: 'channel-1', frontendMessageId: `message-${String(index)}`, content: [{ type: 'text', text: `turn ${String(index)}` }] });
    }
    expect(windowTexts(2, Date.now() + 1)).toEqual([]);
    const conversationId = messageRepo.getOrCreateConversation({ userId, characterId: 'agent_a', frontend: 'discord' }).id;
    expect(seen).toEqual([['turn 1'], ['turn 1', 'turn 2'], ['turn 1', 'turn 2', 'turn 3'], ['turn 3', 'turn 4'], ['turn 3', 'turn 4', 'turn 5']]);
    const windowTexts = (turnStep: number, since = 0) => messageRepo.listRecentCompletedTurnMessages({ conversationId, turnStep, since }).flatMap((message) => (message.role === 'user' ? [message.content] : []));
  });

  test('turns retain their ordered frontend inputs', () => {
    const conversation = messageRepo.getOrCreateConversation({ userId, characterId: 'agent_a', frontend: 'discord' });
    const firstMessageId = Number(db.query(`INSERT INTO frontend_messages (conversation_id, frontend, frontend_message_id, frontend_channel_id, direction, chunk_index, created_at) VALUES (?, 'discord', 'message-1', 'channel-1', 'inbound', 0, 1)`).run(conversation.id).lastInsertRowid);
    const secondMessageId = Number(db.query(`INSERT INTO frontend_messages (conversation_id, frontend, frontend_message_id, frontend_channel_id, direction, chunk_index, created_at) VALUES (?, 'discord', 'message-2', 'channel-1', 'inbound', 0, 2)`).run(conversation.id).lastInsertRowid);
    const turnId = messageRepo.createTurn({ conversationId: conversation.id, frontendMessageIds: [firstMessageId, secondMessageId], traceId: 'discord:message-1' });

    expect(db.query(`SELECT frontend_message_id, position FROM agent_turn_inputs WHERE turn_id = ? ORDER BY position`).all(turnId)).toEqual([
      { frontend_message_id: firstMessageId, position: 0 },
      { frontend_message_id: secondMessageId, position: 1 },
    ]);
  });
});
