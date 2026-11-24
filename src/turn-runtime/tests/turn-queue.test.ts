import { test, expect } from 'bun:test';
import { TurnQueue } from '../turn-queue';
import type { TurnEngine } from '../turn-engine';
import type { EventLog } from '../../utils/event-log';
import type { FrontendMessage } from '../../frontends/frontend-message';
import type { ImageActionKind } from '../../image-requests/image-action';
import type { MessageRepository } from '../../repositories/message-repository';
import type { UserId, ConversationId, GeneratedImageId } from '../../utils/brands';

const userId = 'user-1' as UserId;
const messageRepo = { findTurnStatusByFrontendMessageId: () => null } as unknown as MessageRepository;
const eventLog = { log: () => undefined } as unknown as EventLog;
const makeQueue = (turnEngine: TurnEngine, messages = messageRepo, events = eventLog): TurnQueue =>
  new TurnQueue({
    turnEngine,
    eventLog: events,
    messageRepo: messages,
  });

test('TurnQueue builds executable turns from messages and image actions', async () => {
  const turns: [FrontendMessage, ...FrontendMessage[]][] = [];
  const processed = Promise.withResolvers<void>();
  let releaseFirstTurn = (): void => {};
  const firstTurnGate = new Promise<void>((resolve) => {
    releaseFirstTurn = resolve;
  });
  const turnEngine = {
    process: async (messages: [FrontendMessage, ...FrontendMessage[]]) => {
      turns.push(messages);
      if (turns.length === 1) await firstTurnGate;
      if (turns.length === 4) processed.resolve();
    },
  } as unknown as TurnEngine;
  const queue = makeQueue(turnEngine);

  queue.submit(message(1, 'warmup'));
  queue.submit(message(2, 'followup'));
  queue.submit(message(3, 'clarification'));
  queue.submit(imageAction('random_style'));
  queue.submit(message(4, 'make it brighter'));
  queue.submit(imageAction('random_composition'));
  queue.submit(message(5, 'from the side'));
  releaseFirstTurn();
  await processed.promise;

  expect(turns).toEqual([[message(1, 'warmup')], [message(2, 'followup'), message(3, 'clarification')], [imageAction('random_style'), message(4, 'make it brighter')], [imageAction('random_composition'), message(5, 'from the side')]]);
});

test('TurnQueue starts independent conversations concurrently without limiting submissions', async () => {
  const controlled = controlledTurnEngine();
  const queue = makeQueue(controlled.turnEngine);
  for (let id = 1; id <= 12; id += 1) {
    queue.submit({ ...message(id, 'x'.repeat(12_000)), conversationId: id as ConversationId });
  }
  expect(controlled.turns).toHaveLength(12);
  for (let id = 1; id <= 12; id += 1) await controlled.releaseNext();
  expect(controlled.turns.map((turn) => Number(turn[0].conversationId))).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
});

test('TurnQueue continues after processing failures', async () => {
  const firstAttempted = Promise.withResolvers<void>();
  const releaseFailure = Promise.withResolvers<void>();
  const secondProcessed = Promise.withResolvers<void>();
  const logs: Array<{ type: string }> = [];
  const turnEngine = {
    process: async (messages: [FrontendMessage, ...FrontendMessage[]]) => {
      if (messages[0].id === 1) {
        firstAttempted.resolve();
        await releaseFailure.promise;
        throw new Error('processing failed');
      }
      secondProcessed.resolve();
    },
  } as unknown as TurnEngine;
  const queue = makeQueue(turnEngine, messageRepo, { log: () => undefined, error: (event: Parameters<EventLog['log']>[0]) => logs.push(event) } as unknown as EventLog);

  queue.submit(message(1, 'first'));
  await firstAttempted.promise;
  queue.submit(message(2, 'second'));
  releaseFailure.resolve();
  await secondProcessed.promise;
  expect(logs.map((event) => event.type)).toContain('turn_queue_process_failed');
});

test('TurnQueue ignores a repeated receipt while its message is queued or running', async () => {
  const release = Promise.withResolvers<void>();
  const turns: FrontendMessage[][] = [];
  const turnEngine = {
    process: async (messages: [FrontendMessage, ...FrontendMessage[]]) => {
      turns.push(messages);
      await release.promise;
    },
  } as unknown as TurnEngine;
  const queue = makeQueue(turnEngine);
  const frontendMessage = message(1, 'once');

  queue.submit(frontendMessage);
  queue.submit(frontendMessage);
  expect(turns).toEqual([[frontendMessage]]);
  release.resolve();
});

test('TurnQueue recovers persisted messages', async () => {
  const processed = Promise.withResolvers<[FrontendMessage, ...FrontendMessage[]]>();
  const turnEngine = { process: async (messages: [FrontendMessage, ...FrontendMessage[]]) => processed.resolve(messages) } as unknown as TurnEngine;
  const queue = makeQueue(turnEngine);
  const frontendMessage = message(1, 'recover');

  queue.recover([frontendMessage]);

  expect(await processed.promise).toEqual([frontendMessage]);
});

test('TurnQueue logs each submission decision', () => {
  const events: Parameters<EventLog['log']>[0][] = [];
  const statuses = new Map([[3, 'completed']]);
  const loggedEventLog = { log: (event: Parameters<EventLog['log']>[0]) => events.push(event) } as unknown as EventLog;
  const persistedMessages = { findTurnStatusByFrontendMessageId: (id: number) => statuses.get(id) ?? null } as unknown as MessageRepository;
  const turnEngine = { process: async () => undefined } as unknown as TurnEngine;
  const queue = makeQueue(turnEngine, persistedMessages, loggedEventLog);
  const first = message(1, 'first');

  queue.submit(first);
  queue.submit(first);
  queue.submit(message(3, 'persisted'));
  expect(events.map((event) => event.data)).toEqual([
    expect.objectContaining({ outcome: 'queued', reason: 'new_turn' }),
    expect.objectContaining({ outcome: 'started' }),
    expect.objectContaining({ outcome: 'deduplicated', reason: 'already_queued' }),
    expect.objectContaining({ outcome: 'deduplicated', reason: 'already_assigned', turnStatus: 'completed' }),
  ]);
});

test('TurnQueue drain waits for running work and defers everything else', async () => {
  const release = Promise.withResolvers<void>();
  const events: Parameters<EventLog['log']>[0][] = [];
  const turns: [FrontendMessage, ...FrontendMessage[]][] = [];
  const loggedEventLog = { log: (event: Parameters<EventLog['log']>[0]) => events.push(event) } as unknown as EventLog;
  const turnEngine = {
    process: async (messages: [FrontendMessage, ...FrontendMessage[]]) => {
      turns.push(messages);
      await release.promise;
    },
  } as unknown as TurnEngine;
  const queue = makeQueue(turnEngine, messageRepo, loggedEventLog);
  const running = message(1, 'running');
  const pending = message(2, 'pending');
  const deferred = { ...message(3, 'during drain'), userId: 'user-2' as UserId, conversationId: 2 as ConversationId };

  queue.submit(running);
  queue.submit(pending);
  const drained = queue.drain();
  let drainCompleted = false;
  void drained.then(() => {
    drainCompleted = true;
  });

  queue.submit(deferred);
  await Promise.resolve();
  expect(drainCompleted).toBeFalse();
  release.resolve();
  await drained;

  expect(turns).toEqual([[running]]);
  expect(events).toContainEqual({ type: 'turn_queue_drain_started', data: { runningTurnCount: 1, pendingTurnCount: 1 } });
  expect(events).toContainEqual({ type: 'turn_queue_drain_completed' });
  expect(events.map((event) => event.data)).toContainEqual(expect.objectContaining({ outcome: 'deferred', reason: 'draining' }));
});

const controlledTurnEngine = (): {
  turnEngine: TurnEngine;
  releaseNext(): Promise<void>;
  turns: [FrontendMessage, ...FrontendMessage[]][];
} => {
  const turns: [FrontendMessage, ...FrontendMessage[]][] = [];
  const releases: Array<() => void> = [];
  const turnEngine = {
    process: async (messages: [FrontendMessage, ...FrontendMessage[]]) => {
      turns.push(messages);
      await new Promise<void>((resolve) => releases.push(resolve));
    },
  } as unknown as TurnEngine;

  return {
    turns,
    turnEngine,
    releaseNext: async () => {
      const release = releases.shift();
      if (!release) throw new Error('No running turn to release');
      release();
      await Promise.resolve();
    },
  };
};

const message = (id: number, text: string): FrontendMessage => ({
  id,
  userId,
  timestamp: 1,
  frontend: 'discord',
  characterId: 'agent_a',
  traceId: `trace-${text}`,
  frontendChannelId: 'channel-1',
  content: [{ type: 'text', text }],
  conversationId: 1 as ConversationId,
  frontendMessageId: `message-${text}`,
});

const imageAction = (kind: Extract<ImageActionKind, 'random_style' | 'random_composition'>): FrontendMessage => ({
  userId,
  timestamp: 1,
  frontend: 'discord',
  characterId: 'agent_a',
  traceId: `trace-${kind}`,
  frontendChannelId: 'channel-1',
  conversationId: 1 as ConversationId,
  id: kind === 'random_style' ? 41 : 42,
  frontendMessageId: `interaction-${kind}`,
  content: [{ type: 'image_action', action: kind, sourceImage: { imageId: 42 as GeneratedImageId, prompt: `${kind} source`, loras: [] } }],
});
