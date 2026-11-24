import { Database } from 'bun:sqlite';
import { applySchema } from '../../db/db';
import type { StoragePrivacy } from '../../privacy';
import { ImageRequestRepository } from '../image-request-repository';
import { AnimateRequestRepository } from '../animate-request-repository';
import { GeneratedImageRepository } from '../generated-image-repository';
import { test, expect, describe, afterEach, beforeEach } from 'bun:test';
import type { ImageRequest } from '../../image-requests/image-request-types';
import type { AnimateRequest } from '../../image-requests/animate-request-types';
import type { UserId, ConversationId, GeneratedImageId } from '../../utils/brands';

const privacy = {
  encryptForUser: (_userId: UserId, scope: string, data: string) => `${scope}\0${data}`,
  decryptForUser: (_userId: UserId, scope: string, data: string) => {
    const prefix = `${scope}\0`;
    if (!data.startsWith(prefix)) throw new Error(`Unexpected scope ${scope}`);
    return data.slice(prefix.length);
  },
} as unknown as StoragePrivacy;

const userId = 'user-1' as UserId;

describe('animate request repository', () => {
  let db: Database;
  let animateRepo: AnimateRequestRepository;
  let sourceImageId: GeneratedImageId;

  beforeEach(() => {
    db = new Database(':memory:', { strict: true });
    db.run('PRAGMA foreign_keys = ON');
    applySchema(db);
    db.query(`INSERT INTO users (id, created_at) VALUES ('user-1', 1)`).run();
    db.query(`INSERT INTO conversations (id, user_id, character_id, scope_key, created_at, updated_at) VALUES (1, 'user-1', 'agent_a', 'scope', 1, 1)`).run();
    const imageRequestRepo = new ImageRequestRepository(db, privacy);
    const generatedImageRepo = new GeneratedImageRepository(db, privacy);
    const requestId = imageRequestRepo.save(stillRequest());
    sourceImageId = generatedImageRepo.save({ imageRequestId: requestId, fileSizeBytes: 1, userId, r2Key: 'images/test.jpg' });
    animateRepo = new AnimateRequestRepository(db, privacy);
  });

  afterEach(() => db.close());

  test('keeps submitted and archived checkpoints while open', () => {
    const id = animateRepo.save({
      userId,
      createdAt: 1,
      updatedAt: 1,
      costUsd: null,
      failure: null,
      sourceImageId,
      traceId: 't1',
      status: 'queued',
      fileSizeBytes: null,
      grokRequestId: null,
      r2Key: 'videos/a.mp4',
      characterId: 'agent_a',
      conversationId: 1 as ConversationId,
      prompt: 'Lorem ipsum dolor sit amet.',
    });

    expect(animateRepo.listOpen().map((request) => request.id)).toEqual([id]);
    animateRepo.markSubmitted({ requestId: id, grokRequestId: 'req-1' });
    animateRepo.markArchived({ requestId: id, userId, r2Key: 'videos/a.mp4', fileSizeBytes: 12, costUsd: 0.41 });

    expect(animateRepo.listOpen()).toMatchObject([{ id, grokRequestId: 'req-1', r2Key: 'videos/a.mp4', costUsd: 0.41, prompt: 'Lorem ipsum dolor sit amet.' }]);
    expect(animateRepo.markDelivered({ requestId: id })).toBe(true);
    expect(animateRepo.markFailed({ requestId: id, failure: 'generation_failed' })).toBe(false);
    expect(animateRepo.listOpen()).toEqual([]);
  });

  test('retries archived delivery failures regardless of billing settlement idempotently', () => {
    const reserved = animateRepo.save(animateRequest(sourceImageId, { status: 'failed', failure: 'delivery_failed', fileSizeBytes: 12 }));
    const unbilled = animateRepo.save(animateRequest(sourceImageId, { traceId: 'unbilled', status: 'failed', failure: 'delivery_failed', fileSizeBytes: 12 }));
    const settled = animateRepo.save(animateRequest(sourceImageId, { traceId: 'released', status: 'failed', failure: 'delivery_failed', fileSizeBytes: 12 }));
    const missingArchive = animateRepo.save(animateRequest(sourceImageId, { traceId: 'missing', status: 'failed', failure: 'delivery_failed' }));
    const generationFailed = animateRepo.save(animateRequest(sourceImageId, { traceId: 'generation', status: 'failed', failure: 'generation_failed' }));

    const requestIds = [reserved, unbilled, settled, missingArchive, generationFailed];
    expect(animateRepo.retryFailed({ requestIds })).toBe(3);
    expect(animateRepo.retryFailed({ requestIds })).toBe(0);
    expect(db.query(`SELECT id, status, failure FROM animate_requests ORDER BY id`).all()).toEqual([
      { id: reserved, status: 'queued', failure: null },
      { id: unbilled, status: 'queued', failure: null },
      { id: settled, status: 'queued', failure: null },
      { id: missingArchive, status: 'failed', failure: 'delivery_failed' },
      { id: generationFailed, status: 'failed', failure: 'generation_failed' },
    ]);
  });

  test('lists animation failures without user or prompt data', () => {
    const older = animateRepo.save(animateRequest(sourceImageId, { traceId: 'older', status: 'failed', failure: 'generation_failed', createdAt: 10, updatedAt: 20 }));
    const newer = animateRepo.save(animateRequest(sourceImageId, { traceId: 'newer', status: 'failed', failure: 'delivery_failed', fileSizeBytes: 12, createdAt: 30, updatedAt: 40 }));

    expect(animateRepo.listFailed(25)).toEqual([
      { id: newer, characterId: 'agent_a', failure: 'delivery_failed', createdAt: 30, updatedAt: 40 },
      { id: older, characterId: 'agent_a', failure: 'generation_failed', createdAt: 10, updatedAt: 20 },
    ]);
  });
});

const animateRequest = (sourceImageId: GeneratedImageId, overrides: Partial<Omit<AnimateRequest, 'id'>> = {}): Omit<AnimateRequest, 'id'> => ({
  userId,
  ...overrides,
  createdAt: 1,
  updatedAt: 1,
  costUsd: null,
  failure: null,
  sourceImageId,
  prompt: 'Wave.',
  status: 'queued',
  traceId: 'animate',
  fileSizeBytes: null,
  characterId: 'agent_a',
  grokRequestId: 'grok-1',
  r2Key: 'videos/test.mp4',
  conversationId: 1 as ConversationId,
});

const stillRequest = (): Omit<ImageRequest, 'id'> => ({
  userId,
  createdAt: 1,
  updatedAt: 1,
  failure: null,
  traceId: 't0',
  status: 'queued',
  sourceImageId: null,
  capacityPath: 'warm',
  characterId: 'agent_a',
  conversationId: 1 as ConversationId,
  generationSpec: {
    loras: [],
    version: 1,
    width: 832,
    clipSkip: 2,
    height: 1216,
    appliedLoras: [],
    detailPassEnabled: false,
    requestedPrompt: 'Lorem',
    kind: 'standard-diffusion',
    negativePrompt: 'negative',
    positivePrompt: 'Lorem ipsum',
    sampling: { seed: 1, steps: 22, cfg: 7, denoise: 1, samplerName: 'euler_ancestral', scheduler: 'normal' },
    checkpoint: { group: 'checkpoints', filename: 'checkpoint.safetensors', sizeBytes: 1, source: { kind: 'r2', key: 'checkpoints/checkpoint.safetensors' } },
  },
});
