import pino from 'pino';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { settings } from '../settings';
import type { Database } from 'bun:sqlite';
import { StoragePrivacy } from '../privacy';
import { EventLog } from '../utils/event-log';
import { rmSync, mkdtempSync } from 'node:fs';
import { TurnQueue } from '../turn-runtime/turn-queue';
import { TurnEngine } from '../turn-runtime/turn-engine';
import { openDatabase, migrateDatabase } from '../db/db';
import { Characters } from '../characters/character-catalog';
import { ImageRecipe } from '../image-requests/image-recipe';
import type { ComfyPromptResult } from '../comfy/comfy-client';
import { CostRepository } from '../repositories/cost-repository';
import { UserRepository } from '../repositories/user-repository';
import { EventRepository } from '../repositories/event-repository';
import { buildSystemPrompt } from '../prompts/system-prompt-builder';
import { mock, test, expect, afterEach, beforeEach } from 'bun:test';
import type { ConversationId, FrontendUserId } from '../utils/brands';
import { MessageRepository } from '../repositories/message-repository';
import type { InboundFrontendMessage } from '../frontends/frontend-message';
import { ImageRequestRepository } from '../repositories/image-request-repository';
import { GeneratedImageRepository } from '../repositories/generated-image-repository';
import type { ImageGenerator, ImageGenerationSubmitResult } from '../image-requests/image-generator';
import { createModels, fauxProvider, fauxToolCall, fauxAssistantMessage } from '@earendil-works/pi-ai';

mock.module('../utils/image-archive', () => ({
  readArchive: async () => new Uint8Array(),
  nextVideoArchiveKey: () => 'videos/test.mp4',
  archiveMP4: async (_bytes: Uint8Array, key = 'videos/test.mp4') => key,
  archiveJPG: async (_bytes: Uint8Array, key = 'images/final.jpg') => key,
  nextImageArchiveKey: (nameSuffix = 'final') => `images/${nameSuffix}.jpg`,
}));

const { ImageRequestDispatcher } = await import('../image-requests/image-request-dispatcher');

const privacy = new StoragePrivacy({ databaseKey: Buffer.alloc(32, 1), imageMetadataKey: Buffer.alloc(32, 2) });
const reply = fauxAssistantMessage([fauxToolCall('submit_response', { reply: 'ok', prompts: [] })], { stopReason: 'toolUse' });

let tmpDir: string;
let dbs: Database[];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'restart-recovery-'));
  dbs = [];
});

afterEach(() => {
  settings.reset();
  for (const db of dbs) db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

test('recovers an image that died mid-generation', async () => {
  const dbPath = join(tmpDir, 'app.db');
  const firstDb = openTestDatabase(dbPath);
  const first = createImageRuntime(firstDb);
  const userId = new UserRepository(firstDb, privacy).getOrCreateUser('discord', 'frontend-user' as FrontendUserId);
  const conversationId = new MessageRepository(firstDb, privacy).getOrCreateConversation({ userId, characterId: 'agent_a', frontend: 'discord' }).id as ConversationId;
  const recipe = ImageRecipe.create({ seed: 1, prompt: 'test prompt', image: Characters.agent_a.image, detailPassEnabled: false, loras: [] });
  expect(first.dispatcher.enqueue({ userId, traceId: 'trace', characterId: 'agent_a', conversationId, requests: [{ sourceImageId: null, generationSpec: recipe }] }).kind).toBe('queued');
  await first.imageGenerator.submitted.promise;

  const recovered = createImageRuntime(openTestDatabase(dbPath));
  const recovering = recovered.dispatcher.recover();
  await recovered.imageGenerator.submitted.promise;
  recovered.imageGenerator.complete([{ nodeId: 'save_final', metadata: { filename: 'final.jpg', type: 'output' }, bytes: new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9]) }]);
  await recovered.delivered.promise;
  await recovering;
  await recovered.dispatcher.drain();

  expect(count(recovered.db, `SELECT count(*) AS count FROM image_requests WHERE status = 'delivered'`)).toBe(1);
  expect(recovered.deliveries).toHaveLength(1);
});

test('repeated receipt after restart creates one turn', async () => {
  const dbPath = join(tmpDir, 'app.db');
  const firstDb = openTestDatabase(dbPath);
  const llmStarted = Promise.withResolvers<void>();
  const llmGate = Promise.withResolvers<void>();
  const first = createTurnRuntime(firstDb, [async () => {
    llmStarted.resolve();
    await llmGate.promise;
    return reply;
  }]);
  const userId = first.userRepo.getOrCreateUser('discord', 'frontend-user' as FrontendUserId);
  const inbound: InboundFrontendMessage = { userId, traceId: 'discord:message-1', timestamp: 1, frontend: 'discord', characterId: 'agent_a', frontendChannelId: 'channel-1', frontendMessageId: 'message-1', content: [{ type: 'text', text: 'hello' }] };
  const message = first.messageRepo.saveInboundFrontendMessage(inbound);
  first.turnQueue.submit(message);
  await llmStarted.promise;

  const recovered = createTurnRuntime(openTestDatabase(dbPath), [reply]);
  recovered.messageRepo.recoverStaleRunningTurns();
  recovered.turnQueue.recover(recovered.messageRepo.listUnassignedInboundMessages());
  await recovered.turnQueue.drain();

  recovered.turnQueue.submit(recovered.messageRepo.saveInboundFrontendMessage(inbound));
  await recovered.turnQueue.drain();

  expect(count(recovered.db, 'SELECT count(*) AS count FROM agent_turns')).toBe(1);
  expect(recovered.messageRepo.findTurnStatusByFrontendMessageId(message.id)).toBe('completed');
  expect(recovered.deliveries).toEqual(['ok']);
  expect(count(recovered.db, 'SELECT count(*) AS count FROM costs')).toBe(1);
});

const openTestDatabase = (dbPath: string): Database => {
  const db = openDatabase(dbPath);
  migrateDatabase(db);
  settings.bind(db);
  dbs.push(db);
  return db;
};

const count = (db: Database, sql: string): number => db.query<{ count: number }, []>(sql).get()?.count ?? 0;

const createTurnRuntime = (db: Database, responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0]) => {
  const userRepo = new UserRepository(db, privacy);
  const costRepo = new CostRepository(db);
  const messageRepo = new MessageRepository(db, privacy);
  const eventLog = new EventLog(pino({ level: 'silent' }), new EventRepository(db, privacy));
  const llmSettings = settings.get().llm;
  const faux = fauxProvider({ provider: llmSettings.provider, models: [{ id: llmSettings.model }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  const deliveries: string[] = [];
  const engine = new TurnEngine({     models,
    eventLog,
    userRepo,
    costRepo,
    messageRepo,
    buildSystemPrompt,
    imageDispatcher: { enqueue: () => ({ kind: 'queued', requestIds: [] }) },
    animateDispatcher: { enqueue: () => ({ kind: 'queued' }) },
    events: {
      turnProcessingStarted: async () => undefined,
      turnProcessingFinished: async () => undefined,
      assistantResponseReady: async ({ text }) => {
        deliveries.push(text);
        return { type: 'assistant_response_delivered', messages: [{ messageId: `out-${String(deliveries.length)}`, text }] };
      },
    },
  });
  return { db, userRepo, messageRepo, deliveries, turnQueue: new TurnQueue({ turnEngine: engine, messageRepo, eventLog }) };
};

const createImageRuntime = (db: Database) => {
  const imageRequestRepo = new ImageRequestRepository(db, privacy);
  const generatedImageRepo = new GeneratedImageRepository(db, privacy);
  const eventLog = new EventLog(pino({ level: 'silent' }), new EventRepository(db, privacy));
  const imageGenerator = new FakeImageGenerator();
  const deliveries: Uint8Array[] = [];
  const delivered = Promise.withResolvers<void>();
  const dispatcher = new ImageRequestDispatcher({
    privacy,
    eventLog,
    imageGenerator,
    imageRequestRepo,
    generatedImageRepo,
    notifyUser: async () => undefined,
    requestGpuCapacity: () => undefined,
    deliverImage: async ({ imageBytes }) => {
      deliveries.push(imageBytes);
      delivered.resolve();
    },
  });
  return { db, dispatcher, imageGenerator, deliveries, delivered };
};

class FakeImageGenerator implements ImageGenerator {
  readonly submitted = Promise.withResolvers<void>();
  private completion: ReturnType<typeof Promise.withResolvers<ComfyPromptResult>> | undefined;

  async prefetch(): Promise<void> {}

  connectedWorkerCount(): number {
    return 1;
  }

  async submit(): Promise<ImageGenerationSubmitResult> {
    this.submitted.resolve();
    this.completion = Promise.withResolvers();
    return { kind: 'accepted', attempt: { completion: this.completion.promise } };
  }

  complete(images: ComfyPromptResult['images']): void {
    if (!this.completion) throw new Error('No GPU submission to complete');
    this.completion.resolve({ images, nodeTimings: [] });
  }
};
