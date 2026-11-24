import pino from 'pino';
import { Database } from 'bun:sqlite';
import { applySchema } from '../../db/db';
import { settings } from '../../settings';
import { EventLog } from '../../utils/event-log';
import type { StoragePrivacy } from '../../privacy';
import { CostRepository } from '../../repositories/cost-repository';
import { UserRepository } from '../../repositories/user-repository';
import { EventRepository } from '../../repositories/event-repository';
import { buildSystemPrompt } from '../../prompts/system-prompt-builder';
import { test, expect, describe, afterEach, beforeEach } from 'bun:test';
import { MessageRepository } from '../../repositories/message-repository';
import { rejectionUserMessage } from '../../turn-runtime/rejection-messages';
import type { FrontendMessageContent } from '../../frontends/frontend-message';
import type { UserId, FrontendUserId, GeneratedImageId } from '../../utils/brands';
import type { ImageRequestDispatcher } from '../../image-requests/image-request-dispatcher';
import type { AnimateRequestDispatcher } from '../../image-requests/animate-request-dispatcher';
import { TurnEngine, type TurnEngineEvents, type TurnProcessingFinishedEvent } from '../turn-engine';
import { createModels, fauxProvider, fauxToolCall, type Context, fauxAssistantMessage, type SimpleStreamOptions } from '@earendil-works/pi-ai';

describe('TurnEngine', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:', { strict: true });
    db.run('PRAGMA foreign_keys = ON');
    applySchema(db);
    settings.bind(db);
  });

  afterEach(() => {
    settings.reset();
    db.close();
  });

  test('runs a real agent turn through persistence and delivery', async () => {
    const harness = createHarness(db);
    const response = 'faux response';
    let requestContext: Context | undefined;
    let requestOptions: SimpleStreamOptions | undefined;
    harness.faux.setResponses([(context, options) => {
      requestContext = context;
      requestOptions = options;
      return fauxAssistantMessage([fauxToolCall('submit_response', { reply: response, prompts: [] })], { stopReason: 'toolUse' });
    }]);
    const message = harness.saveMessage('hello');

    await harness.engine.process([message]);

    expect(harness.messageRepo.findTurnStatusByFrontendMessageId(message.id)).toBe('completed');
    expect(harness.messageRepo.listRecentCompletedTurnMessages({ conversationId: message.conversationId, turnStep: 1, since: 0 }).map(({ role }) => role)).toEqual(['user', 'assistant', 'toolResult']);
    expect(harness.deliveries).toEqual([response]);
    expect(harness.lifecycle).toEqual(['started', 'ready', 'finished:completed']);
    expect(requestContext?.tools?.map(({ name }) => name)).toEqual(['update_notes', 'submit_response', 'animate_image']);
    expect(requestOptions).toMatchObject({ sessionId: String(message.conversationId), headers: { 'x-session-id': String(message.conversationId) } });
    expect(db.query<{ count: number }, []>('SELECT count(*) AS count FROM costs').get()?.count).toBe(1);
  });

  test('validates OpenRouter usage without altering the provider stream or losing the last valid cost', async () => {
    const originalFetch = globalThis.fetch;
    const source = 'data: {"provider":"test-upstream"}\n\ndata: {"usage":{"cost":0.2,"cost_details":{"upstream_inference_cost":0.1}}}\n\ndata: {"provider":123,"usage":{"cost":0.9,"cost_details":{"upstream_inference_cost":"bad"}}}\n\ndata: [DONE]\n';
    globalThis.fetch = Object.assign(async () => new Response(source), { preconnect: originalFetch.preconnect });
    try {
      const harness = createHarness(db);
      harness.faux.setResponses([async (_context, options) => {
        if (!options?.fetch) throw new Error('Missing provider fetch');
        const response = await options.fetch('https://openrouter.ai/api/v1/chat/completions');
        expect(await response.text()).toBe(source);
        return fauxAssistantMessage([fauxToolCall('submit_response', { reply: 'response', prompts: [] })], { stopReason: 'toolUse' });
      }]);
      const message = harness.saveMessage('hello');
      await harness.engine.process([message]);

      expect(harness.messageRepo.findTurnStatusByFrontendMessageId(message.id)).toBe('completed');
      expect(db.query<{ amount_usd: number }, []>('SELECT amount_usd FROM costs').get()?.amount_usd).toBeCloseTo(0.2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('executes tools and dispatches the resulting image request', async () => {
    const harness = createHarness(db);
    const notes = 'Prefers blue packaging accents.';
    const imagePrompt = 'test image prompt';
    harness.faux.setResponses([fauxAssistantMessage([fauxToolCall('update_notes', { notes, visualChange: true }), fauxToolCall('submit_response', { reply: 'done', prompts: [imagePrompt] })], { stopReason: 'toolUse' })]);
    const message = harness.saveMessage('use both tools');

    await harness.engine.process([message]);

    expect(harness.faux.state.callCount).toBe(1);
    expect(harness.userRepo.getPersonalization({ userId: message.userId, characterId: message.characterId })?.notes).toBe(notes);
    expect(harness.deliveries).toEqual(['done']);
    expect(harness.imageRequests[0]).toMatchObject({ userId: message.userId, characterId: message.characterId, conversationId: message.conversationId, requests: [{ sourceImageId: null, generationSpec: { requestedPrompt: imagePrompt } }] });
    expect(harness.messageRepo.findTurnStatusByFrontendMessageId(message.id)).toBe('completed');
  });

  test('delivers a conversational submit_response without dispatching an image', async () => {
    const harness = createHarness(db);
    harness.faux.setResponses([fauxAssistantMessage([fauxToolCall('submit_response', { reply: 'good night', prompts: [] })], { stopReason: 'toolUse' })]);
    const message = harness.saveMessage('gn');

    await harness.engine.process([message]);

    expect(harness.deliveries).toEqual(['good night']);
    expect(harness.imageRequests).toEqual([]);
    expect(harness.messageRepo.findTurnStatusByFrontendMessageId(message.id)).toBe('completed');
  });

  test('replies to the triggering message when image admission is rejected', async () => {
    const harness = createHarness(db, undefined, { kind: 'rejected', reason: 'paused' });
    harness.faux.setResponses([fauxAssistantMessage([fauxToolCall('submit_response', { reply: '', prompts: ['new image'] })], { stopReason: 'toolUse' })]);
    const message = harness.saveMessage('make an image');

    await harness.engine.process([message]);

    expect(harness.deliveries).toEqual([rejectionUserMessage.paused]);
    expect(harness.deliveryTargets).toEqual([message.frontendMessageId]);
  });

  test('uses source-image LoRAs instead of global pinned LoRAs', async () => {
    const harness = createHarness(db);

    await harness.engine.process([message]);
    const sourceImageId = 42 as GeneratedImageId;
    const pinnedLoras = [{ id: 'style_b' as const, strength: 4 }];
    const sourceLoras = [{ id: 'style_a' as const, strength: 0.8 }];

    expect(harness.imageRequests[0]?.requests[0]).toMatchObject({ sourceImageId, generationSpec: { appliedLoras: sourceLoras } });
    harness.userRepo.updateLoraSettings({ userId: harness.userId, characterId: 'agent_a', loraSettings: { autoLoraSelectionEnabled: true, pinnedLoras } });
    harness.faux.setResponses([fauxAssistantMessage([fauxToolCall('submit_response', { reply: '', prompts: ['new image'] })], { stopReason: 'toolUse' })]);
    const message = harness.saveContent([{ type: 'reply_to_generated_image', sourceImage: { imageId: sourceImageId, prompt: 'old image', loras: sourceLoras } }, { type: 'text', text: 'change the composition' }]);
  });

  test('continues after update_notes until a user-facing action succeeds', async () => {
    const harness = createHarness(db);
    harness.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('update_notes', { notes: 'lorem ipsum', visualChange: false })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('submit_response', { reply: "I'll remember that.", prompts: [] })], { stopReason: 'toolUse' }),
    ]);
    const message = harness.saveMessage('remember that I like rain');

    await harness.engine.process([message]);

    expect(harness.faux.state.callCount).toBe(2);
    expect(harness.deliveries).toEqual(["I'll remember that."]);
    expect(harness.messageRepo.findTurnStatusByFrontendMessageId(message.id)).toBe('completed');
  });

  test('feeds a failed terminal tool back for a corrective model round', async () => {
    const harness = createHarness(db);
    harness.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('animate_image', { reply: '', prompt: 'Lorem ipsum dolor sit amet.' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('submit_response', { reply: 'Reply to the image you want me to animate.', prompts: [] })], { stopReason: 'toolUse' }),
    ]);
    const message = harness.saveMessage('animate that');

    await harness.engine.process([message]);

    expect(harness.faux.state.callCount).toBe(2);
    expect(harness.animateRequests).toEqual([]);
    expect(harness.deliveries).toEqual(['Reply to the image you want me to animate.']);
    expect(harness.messageRepo.findTurnStatusByFrontendMessageId(message.id)).toBe('completed');
    expect(db.query<{ count: number }, [string]>('SELECT count(*) AS count FROM costs WHERE user_id = ?').get(message.userId)?.count).toBe(2);
  });

  test('rejects multiple terminal tools before either side effect executes', async () => {
    const harness = createHarness(db);
    harness.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('submit_response', { reply: 'duplicate', prompts: [] }), fauxToolCall('animate_image', { reply: '', prompt: 'Lorem ipsum dolor sit amet.' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('submit_response', { reply: 'corrected', prompts: [] })], { stopReason: 'toolUse' }),
    ]);
    const message = harness.saveMessage('hello');

    await harness.engine.process([message]);

    expect(harness.faux.state.callCount).toBe(2);
    expect(harness.deliveries).toEqual(['corrected']);
    expect(harness.animateRequests).toEqual([]);
    expect(harness.messageRepo.findTurnStatusByFrontendMessageId(message.id)).toBe('completed');
  });

  test('does not repeat a successful terminal action while repairing an auxiliary failure', async () => {
    const harness = createHarness(db);
    harness.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('update_notes', {}), fauxToolCall('submit_response', { reply: "I'll remember that.", prompts: [] })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('update_notes', { notes: 'lorem ipsum', visualChange: false }), fauxToolCall('submit_response', { reply: "I'll remember that.", prompts: [] })], { stopReason: 'toolUse' }),
    ]);
    const message = harness.saveMessage('remember that I like rain');

    await harness.engine.process([message]);

    expect(harness.faux.state.callCount).toBe(2);
    expect(harness.deliveries).toEqual(["I'll remember that."]);
    expect(harness.userRepo.getOrCreatePersonalization({ userId: message.userId, characterId: message.characterId }).notes).toBe('lorem ipsum');
    expect(harness.messageRepo.findTurnStatusByFrontendMessageId(message.id)).toBe('completed');
  });

  test('feeds a silent submit_response back for correction', async () => {
    const harness = createHarness(db);
    harness.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('submit_response', { reply: '', prompts: [] })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('submit_response', { reply: 'corrected', prompts: [] })], { stopReason: 'toolUse' }),
    ]);
    const message = harness.saveMessage('hello');

    await harness.engine.process([message]);

    expect(harness.faux.state.callCount).toBe(2);
    expect(harness.deliveries).toEqual(['corrected']);
    expect(harness.messageRepo.findTurnStatusByFrontendMessageId(message.id)).toBe('completed');
  });

  test('fails at the configured model-round limit without a user-facing action', async () => {
    const harness = createHarness(db);
    harness.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('update_notes', { notes: 'lorem ipsum', visualChange: false })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('update_notes', { notes: 'lorem ipsum', visualChange: false })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('update_notes', { notes: 'lorem ipsum', visualChange: false })], { stopReason: 'toolUse' }),
    ]);
    const message = harness.saveMessage('remember that I like rain');

    await harness.engine.process([message]);

    expect(harness.faux.state.callCount).toBe(3);
    expect(harness.deliveries).toEqual([]);
    expect(harness.messageRepo.findTurnStatusByFrontendMessageId(message.id)).toBe('failed');
    expect(harness.finishedEvents[0]).toMatchObject({ status: 'failed', replyToFrontendMessageId: message.frontendMessageId });
  });

  test('retries a truncated tool call without executing its partial action', async () => {
    const harness = createHarness(db);
    harness.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('submit_response', { reply: 'partial', prompts: [] })], { stopReason: 'length' }),
      fauxAssistantMessage([fauxToolCall('submit_response', { reply: 'complete', prompts: [] })], { stopReason: 'toolUse' }),
    ]);
    const message = harness.saveMessage('hello');

    await harness.engine.process([message]);

    expect(harness.faux.state.callCount).toBe(2);
    expect(harness.deliveries).toEqual(['complete']);
    expect(harness.messageRepo.findTurnStatusByFrontendMessageId(message.id)).toBe('completed');
  });

  test('does not treat natural assistant text as a delivered response', async () => {
    const harness = createHarness(db);
    harness.faux.setResponses([fauxAssistantMessage('bypassed tool')]);
    const message = harness.saveMessage('hello');

    await harness.engine.process([message]);

    expect(harness.deliveries).toEqual([]);
    expect(harness.messageRepo.findTurnStatusByFrontendMessageId(message.id)).toBe('failed');
  });

  test('queues animation as the standalone terminal response', async () => {
    const harness = createHarness(db);
    harness.faux.setResponses([fauxAssistantMessage([fauxToolCall('animate_image', { reply: '', prompt: 'Lorem ipsum dolor sit amet.' })], { stopReason: 'toolUse' })]);
    const message = harness.saveContent([{ type: 'image_action', action: 'animate', sourceImage: { imageId: 42 as GeneratedImageId, prompt: 'lorem ipsum', loras: [] } }]);

    await harness.engine.process([message]);

    expect(harness.faux.state.callCount).toBe(1);
    expect(harness.animateRequests).toContainEqual(expect.objectContaining({ sourceImageId: 42, prompt: 'Lorem ipsum dolor sit amet.' }));
    expect(harness.deliveries).toEqual([]);
    expect(harness.messageRepo.findTurnStatusByFrontendMessageId(message.id)).toBe('completed');
  });

  test('sends persistent notes as change-only user-role snapshots', async () => {
    const harness = createHarness(db);
    const contexts: Context[] = [];
    harness.faux.setResponses([1, 2, 3].map((turn) => (context: Context) => {
      contexts.push(context);
      return fauxAssistantMessage([fauxToolCall('submit_response', { reply: `response ${String(turn)}`, prompts: [] })], { stopReason: 'toolUse' });
    }));
    const first = harness.saveMessage('first');
    harness.userRepo.updateNotes({ userId: first.userId, characterId: first.characterId, notes: 'timezone: Pacific\nprefers short replies' });

    await harness.engine.process([first]);
    await harness.engine.process([harness.saveMessage('second')]);
    harness.userRepo.updateNotes({ userId: first.userId, characterId: first.characterId, notes: '' });
    await harness.engine.process([harness.saveMessage('third')]);

    expect(contexts.map(({ systemPrompt }) => systemPrompt)).toEqual([contexts[0]?.systemPrompt, contexts[0]?.systemPrompt, contexts[0]?.systemPrompt]);
    expect(contexts[0]?.systemPrompt).not.toContain('timezone Pacific');
    const persistentNotesSnapshots = contexts.map(({ messages }) => messages.filter((message) => 'contextKind' in message).map(({ content }) => content));
    expect(persistentNotesSnapshots).toEqual([
      ['## Persistent user notes\n\nThis snapshot supersedes earlier persistent-note snapshots.\n\ntimezone: Pacific\nprefers short replies'],
      ['## Persistent user notes\n\nThis snapshot supersedes earlier persistent-note snapshots.\n\ntimezone: Pacific\nprefers short replies'],
      ['## Persistent user notes\n\nThis snapshot supersedes earlier persistent-note snapshots.\n\ntimezone: Pacific\nprefers short replies', '## Persistent user notes\n\nNone. Earlier persistent-note snapshots no longer apply.'],
    ]);
  });

  test('fails the turn when Discord delivery fails', async () => {
    const deliveryFailure = new Error('delivery unavailable');
    const harness = createHarness(db, deliveryFailure);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => new Response('data: {"usage":{"cost":0.004}}\n\n'), { preconnect: originalFetch.preconnect });
    harness.faux.setResponses([1, 2, 3].map(() => async (_context: Context, options?: SimpleStreamOptions) => {
      await (await options!.fetch!('https://openrouter.ai/api/v1/chat/completions')).text();
      return fauxAssistantMessage([fauxToolCall('submit_response', { reply: 'response', prompts: [] })], { stopReason: 'toolUse' });
    }));
    const message = harness.saveMessage('hello');

    try { await harness.engine.process([message]); } finally { globalThis.fetch = originalFetch; }

    expect(harness.messageRepo.findTurnStatusByFrontendMessageId(message.id)).toBe('failed');
    expect(harness.lifecycle.at(-1)).toBe('finished:failed');
    expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM frontend_messages WHERE direction = 'outbound'").get()?.count).toBe(0);
  });
});

const createHarness = (db: Database, deliveryFailure?: Error, imageResult: ReturnType<ImageRequestDispatcher['enqueue']> = { kind: 'queued', requestIds: [] }) => {
  const userRepo = new UserRepository(db, privacy);
  const costRepo = new CostRepository(db);
  const messageRepo = new MessageRepository(db, privacy);
  const eventLog = new EventLog(pino({ level: 'silent' }), new EventRepository(db, privacy));
  const llmSettings = settings.get().llm;
  const faux = fauxProvider({ provider: llmSettings.provider, models: [{ id: llmSettings.model, cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 } }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const imageRequests: Parameters<ImageRequestDispatcher['enqueue']>[0][] = [];
  const animateRequests: Parameters<AnimateRequestDispatcher['enqueue']>[0][] = [];
  const imageDispatcher: Pick<ImageRequestDispatcher, 'enqueue'> = { enqueue: (request) => {
    imageRequests.push(request);
    return imageResult;
  } };
  const lifecycle: string[] = [];
  const deliveries: string[] = [];
  const deliveryTargets: Array<string | null> = [];
  const finishedEvents: TurnProcessingFinishedEvent[] = [];
  const events: TurnEngineEvents = {
    turnProcessingStarted: async () => {
      lifecycle.push('started');
    },
    turnProcessingFinished: async (event) => {
      lifecycle.push(`finished:${event.status}`);
      finishedEvents.push(event);
    },
    assistantResponseReady: async ({ text, replyToFrontendMessageId }) => {
      lifecycle.push('ready');
      if (deliveryFailure) throw deliveryFailure;
      deliveries.push(text);
      deliveryTargets.push(replyToFrontendMessageId);
      return { type: 'assistant_response_delivered', messages: [{ messageId: `out-${String(deliveries.length)}`, text }] };
    },
  };
  const animateDispatcher: Pick<AnimateRequestDispatcher, 'enqueue'> = { enqueue: (request) => {
    animateRequests.push(request);
    return { kind: 'queued' };
  } };
  const engine = new TurnEngine({ models, buildSystemPrompt, eventLog, events, userRepo, costRepo, messageRepo, imageDispatcher, animateDispatcher });
  const userId = userRepo.getOrCreateUser('discord', 'frontend-user' as FrontendUserId);
  let messageCount = 0;
  const saveContent = (content: [FrontendMessageContent, ...FrontendMessageContent[]]) => {
    messageCount += 1;
    return messageRepo.saveInboundFrontendMessage({ userId, traceId: `trace-${String(messageCount)}`, timestamp: messageCount, frontend: 'discord', characterId: 'agent_a', frontendChannelId: 'channel', frontendMessageId: `message-${String(messageCount)}`, content });
  };
  const saveMessage = (text: string) => saveContent([{ type: 'text', text }]);

  return { engine, faux, userId, userRepo, messageRepo, imageRequests, animateRequests, deliveries, deliveryTargets, finishedEvents, lifecycle, saveContent, saveMessage };
};

const privacy = {
  hashFrontendUserId: (userId: FrontendUserId) => `hash:${userId}`,
  encryptForUser: (_userId: UserId, scope: string, data: string) => `${scope}\0${data}`,
  decryptForUser: (_userId: UserId, scope: string, data: string) => data.replace(`${scope}\0`, ''),
} as unknown as StoragePrivacy;
