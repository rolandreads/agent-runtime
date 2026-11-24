import { Database } from 'bun:sqlite';
import { applySchema } from '../../db/db';
import type { StoragePrivacy } from '../../privacy';
import { MessageRepository } from '../message-repository';
import type { UserId, ConversationId } from '../../utils/brands';
import { ImageRequestRepository } from '../image-request-repository';
import type { ImageRequest } from '../../image-requests/image-request-types';
import { test, spyOn, expect, describe, afterEach, beforeEach } from 'bun:test';
import { type GeneratedImage, GeneratedImageRepository } from '../generated-image-repository';

const privacy = {
  encryptForUser: (_userId: UserId, scope: string, data: string) => `${scope}\0${data}`,
  decryptForUser: (_userId: UserId, scope: string, data: string) => {
    const prefix = `${scope}\0`;
    if (!data.startsWith(prefix)) throw new Error(`Unexpected scope ${scope}`);
    return data.slice(prefix.length);
  },
} as unknown as StoragePrivacy;

const userId = 'user-1' as UserId;
const otherUserId = 'user-2' as UserId;

describe('image request links', () => {
  let db: Database;
  let imageRequestRepo: ImageRequestRepository;
  let messageRepo: MessageRepository;
  let generatedImageRepo: GeneratedImageRepository;

  beforeEach(() => {
    db = new Database(':memory:', { strict: true });
    db.run('PRAGMA foreign_keys = ON');
    applySchema(db);
    db.query(`INSERT INTO users (id, created_at) VALUES ('user-1', 1)`).run();
    db.query(`INSERT INTO users (id, created_at) VALUES ('user-2', 1)`).run();
    db.query(`INSERT INTO conversations (id, user_id, character_id, scope_key, created_at, updated_at) VALUES (1, 'user-1', 'agent_a', 'scope', 1, 1)`).run();
    db.query(`INSERT INTO conversations (id, user_id, character_id, scope_key, created_at, updated_at) VALUES (2, 'user-2', 'agent_a', 'other-scope', 1, 1)`).run();
    imageRequestRepo = new ImageRequestRepository(db, privacy);
    messageRepo = new MessageRepository(db, privacy);
    generatedImageRepo = new GeneratedImageRepository(db, privacy);
  });

  afterEach(() => db.close());

  test('generated images resolve their request prompt directly and through delivered Discord messages', () => {
    const parentId = imageRequestRepo.save(parentRequest);
    expect(imageRequestRepo.markDelivered({ requestId: parentId })).toBe(true);
    // Production change: reply and remix context uses the requested prompt without resolved checkpoint suffixes.
    const parentBase = imageRequest({}, 'Parent prompt', 'Parent generation prompt');
    expect(imageRequestRepo.markFailed({ requestId: parentId, failure: 'generation_failed' })).toBe(false);
    const childId = imageRequestRepo.save(imageRequest({ sourceImageId: generatedImageId }, 'Child prompt'));
    expect(db.query(`SELECT status FROM image_requests WHERE id = ?`).get(parentId)).toEqual({ status: 'delivered' });
    messageRepo.createTurn({ conversationId: action.conversationId, frontendMessageIds: [action.id], traceId: action.traceId });
    const generatedImageId = generatedImageRepo.save({ imageRequestId: parentId, fileSizeBytes: 1, userId, r2Key: 'images/test.jpg' });
    expect(messageRepo.findFailureReplyTarget({ traceId: action.traceId, sourceImageId: generatedImageId })).toBe('discord-message-1');
    expect(db.query(`SELECT source_image_id FROM image_requests WHERE id = ?`).get(childId)).toEqual({ source_image_id: generatedImageId });
    expect(generatedImageRepo.loadByFrontendMessageId({ frontendMessageId: 'discord-message-1', userId, characterId: 'agent_c' })).toBeNull();
    expect(generatedImageRepo.loadByFrontendMessageId({ frontendMessageId: 'discord-message-1', userId, characterId: 'agent_a' })).toEqual(expectedGeneratedImage);
    expect(messageRepo.getFrontendImageDeliveryTarget(1 as ConversationId)).toEqual({ frontend: 'discord', frontendChannelId: 'channel-1', characterId: 'agent_a' });
    expect(imageRequestRepo.claimNext()).toMatchObject({ id: childId, generationSpec: { requestedPrompt: 'Child prompt' }, sourceImageId: generatedImageId, status: 'processing' });
    const parentRequest = { ...parentBase, generationSpec: { ...parentBase.generationSpec, appliedLoras: [{ id: 'style_b' as const, strength: 1.2 }, { id: 'style_a' as const, strength: 0.8 }] } };
    const frontendMessageId = messageRepo.saveOutboundFrontendImage({ conversationId: 1, generatedImageId, frontend: 'discord', frontendMessageId: 'discord-message-1', frontendChannelId: 'channel-1' });
    expect(db.query(`SELECT frontend_message_id, generated_image_id FROM frontend_messages WHERE id = ?`).get(frontendMessageId)).toEqual({ frontend_message_id: 'discord-message-1', generated_image_id: generatedImageId });

    const expectedGeneratedImage: GeneratedImage = { imageId: generatedImageId, generationSpec: parentRequest.generationSpec, imageRequestId: parentId, frontendMessage: { id: frontendMessageId, conversationId: 1 as ConversationId } };
    const action = messageRepo.saveInboundFrontendMessage({ userId, traceId: 'discord:interaction-1', timestamp: 2, frontend: 'discord', characterId: 'agent_a', frontendMessageId: 'interaction-1', frontendChannelId: 'channel-1', content: [{ type: 'image_action', action: 'animate', sourceImage: { imageId: generatedImageId, prompt: 'Parent prompt', loras: [] } }] });
  });

  test('claims the oldest queued generation spec atomically', () => {
    const laterId = imageRequestRepo.save(imageRequest({ createdAt: 20, updatedAt: 20 }, 'later'));
    const earlierId = imageRequestRepo.save(imageRequest({ createdAt: 10, updatedAt: 10 }, 'earlier'));

    const clock = spyOn(Date, 'now').mockReturnValue(30);
    try {
      expect(imageRequestRepo.claimNext()).toMatchObject({ id: earlierId, generationSpec: { requestedPrompt: 'earlier' }, status: 'processing', updatedAt: 30 });
      clock.mockReturnValue(31);
      expect(imageRequestRepo.claimNext()).toMatchObject({ id: laterId, generationSpec: { requestedPrompt: 'later' }, status: 'processing', updatedAt: 31 });
      expect(imageRequestRepo.claimNext()).toBeNull();
    } finally { clock.mockRestore(); }
  });

  test('claims fairly by processing count, then request age', () => {
    const a1 = imageRequestRepo.save(imageRequest({ createdAt: 10, updatedAt: 10 }, 'A1'));
    const a2 = imageRequestRepo.save(imageRequest({ createdAt: 10, updatedAt: 10 }, 'A2'));

    expect(Array.from({ length: 4 }, () => imageRequestRepo.claimNext()?.id)).toEqual([b1, a1, b2, a2]);
    imageRequestRepo.save(imageRequest({ status: 'processing', createdAt: 1, updatedAt: 1 }, 'A active'));
    const b1 = imageRequestRepo.save(imageRequest({ userId: otherUserId, conversationId: 2 as ConversationId, createdAt: 20, updatedAt: 20 }, 'B1'));
    const b2 = imageRequestRepo.save(imageRequest({ userId: otherUserId, conversationId: 2 as ConversationId, createdAt: 21, updatedAt: 21 }, 'B2'));
  });

  test('requeues processing requests for fair retry after restart', () => {
    const recoveredA = imageRequestRepo.save(imageRequest({ status: 'processing', createdAt: 10, updatedAt: 10 }, 'A recovered'));
    const laterA = imageRequestRepo.save(imageRequest({ createdAt: 20, updatedAt: 20 }, 'A later'));
    const queuedB = imageRequestRepo.save(imageRequest({ userId: otherUserId, conversationId: 2 as ConversationId, createdAt: 30, updatedAt: 30 }, 'B queued'));

    imageRequestRepo.requeueProcessing();

    expect(imageRequestRepo.listQueuedForGeneration().map(({ id }) => id)).toEqual([recoveredA, laterA, queuedB]);
    expect(imageRequestRepo.claimNext()).toMatchObject({ id: recoveredA, createdAt: 10, status: 'processing' });
    expect(imageRequestRepo.claimNext()?.id).toBe(queuedB);
    expect(imageRequestRepo.claimNext()?.id).toBe(laterA);
  });

  test('does not requeue a request after a terminal failure wins the capacity race', () => {
    imageRequestRepo.markQueued({ requestId: id });
    expect(imageRequestRepo.claimNext()?.id).toBe(id);
    const id = imageRequestRepo.save(imageRequest({}, 'request'));
    expect(imageRequestRepo.markDelivered({ requestId: id })).toBe(false);

    imageRequestRepo.markFailed({ requestId: id, failure: 'generation_failed' });

    expect(db.query('SELECT status, failure FROM image_requests WHERE id = ?').get(id)).toEqual({ status: 'failed', failure: 'generation_failed' });
  });

  test('finds active generation users and oldest request', () => {
    imageRequestRepo.markDelivered({ requestId: delivered });

    expect(imageRequestRepo.countActiveGenerationUsers()).toBe(2);
    expect(imageRequestRepo.findOldestActiveGeneration()?.id).toBe(oldestActive);
    imageRequestRepo.save(imageRequest({ createdAt: 11, updatedAt: 11 }, 'same user queued'));
    const oldestActive = imageRequestRepo.save(imageRequest({ createdAt: 10, updatedAt: 10 }, 'queued'));
    const delivered = imageRequestRepo.save(imageRequest({ createdAt: 20, updatedAt: 20 }, 'delivered'));
    imageRequestRepo.save(imageRequest({ userId: otherUserId, conversationId: 2 as ConversationId, status: 'processing', createdAt: 12, updatedAt: 12 }, 'other user processing'));
  });

  test('excludes archived delivery work from generation demand', () => {
    const archived = imageRequestRepo.save(imageRequest({ createdAt: 5, updatedAt: 5 }, 'archived delivery'));
    generatedImageRepo.save({ imageRequestId: archived, fileSizeBytes: 1, userId, r2Key: 'images/archived.jpg' });
    const generation = imageRequestRepo.save(imageRequest({ userId: otherUserId, conversationId: 2 as ConversationId, createdAt: 10, updatedAt: 10 }, 'generation'));

    expect(imageRequestRepo.listQueuedForGeneration().map(({ id }) => id)).toEqual([generation]);
    expect(imageRequestRepo.countActiveGenerationUsers()).toBe(1);
    expect(imageRequestRepo.findOldestActiveGeneration()?.id).toBe(generation);
  });

  test('retries generation failures and archived delivery failures regardless of billing settlement idempotently', () => {
    try {
      imageRequestRepo.markDelivered({ requestId: delivered });

      const requestIds = [generationFailed, deliveryFailed, reservedDeliveryFailed, unbilledDeliveryFailed, settledDeliveryFailed, delivered];
      clock.mockReturnValue(3);
      expect(imageRequestRepo.retryFailed({ requestIds })).toBe(4);
      clock.mockReturnValue(4);
      expect(imageRequestRepo.retryFailed({ requestIds })).toBe(0);
      expect(db.query(`SELECT id, status, failure, updated_at FROM image_requests ORDER BY id`).all()).toEqual([
        { id: generationFailed, status: 'queued', failure: null, updated_at: 3 },
        { id: deliveryFailed, status: 'failed', failure: 'delivery_failed', updated_at: 1 },
        { id: reservedDeliveryFailed, status: 'queued', failure: null, updated_at: 3 },
        { id: unbilledDeliveryFailed, status: 'queued', failure: null, updated_at: 3 },
        { id: settledDeliveryFailed, status: 'queued', failure: null, updated_at: 3 },
        { id: delivered, status: 'delivered', failure: null, updated_at: 2 },
      ]);
    } finally { clock.mockRestore(); }
    const clock = spyOn(Date, 'now').mockReturnValue(2);
    const delivered = imageRequestRepo.save(imageRequest({}, 'delivered'));
    generatedImageRepo.save({ imageRequestId: settledDeliveryFailed, fileSizeBytes: 1, userId, r2Key: 'images/released.jpg' });
    generatedImageRepo.save({ imageRequestId: reservedDeliveryFailed, fileSizeBytes: 1, userId, r2Key: 'images/reserved.jpg' });
    generatedImageRepo.save({ imageRequestId: unbilledDeliveryFailed, fileSizeBytes: 1, userId, r2Key: 'images/unbilled.jpg' });
    const deliveryFailed = imageRequestRepo.save(imageRequest({ status: 'failed', failure: 'delivery_failed' }, 'delivery failed'));
    const generationFailed = imageRequestRepo.save(imageRequest({ status: 'failed', failure: 'generation_failed' }, 'generation failed'));
    const settledDeliveryFailed = imageRequestRepo.save(imageRequest({ status: 'failed', failure: 'delivery_failed' }, 'released delivery failed'));
    const reservedDeliveryFailed = imageRequestRepo.save(imageRequest({ status: 'failed', failure: 'delivery_failed' }, 'reserved delivery failed'));
    const unbilledDeliveryFailed = imageRequestRepo.save(imageRequest({ status: 'failed', failure: 'delivery_failed' }, 'unbilled delivery failed'));
  });

  test('returns the durable archived artifact for a claimed request', () => {
    const requestId = imageRequestRepo.save(imageRequest({}, 'delivery'));
    const generatedImageId = generatedImageRepo.save({ imageRequestId: requestId, fileSizeBytes: 1, userId, r2Key: 'images/retry.jpg' });
    expect(imageRequestRepo.claimNext()).toMatchObject({ id: requestId, status: 'processing' });
    expect(generatedImageRepo.findArchivedForRequest({ requestId, userId })).toEqual({
      generatedImageId,
      r2Key: 'images/retry.jpg',
    });
  });

  test('lists recent failures without user or prompt data', () => {
    ]);

    expect(imageRequestRepo.listFailed(25)).toEqual([
      { id: newer, characterId: 'agent_a', failure: 'delivery_failed', createdAt: 30, updatedAt: 40 },
      { id: older, characterId: 'agent_a', failure: 'generation_failed', createdAt: 10, updatedAt: 20 },
    imageRequestRepo.save(imageRequest({ createdAt: 50, updatedAt: 50 }, 'lorem ipsum'));
    const newer = imageRequestRepo.save(imageRequest({ status: 'failed', failure: 'delivery_failed', createdAt: 30, updatedAt: 40 }, 'lorem ipsum'));
    const older = imageRequestRepo.save(imageRequest({ status: 'failed', failure: 'generation_failed', createdAt: 10, updatedAt: 20 }, 'lorem ipsum'));
  });
});

const imageRequest = (overrides: Partial<Omit<ImageRequest, 'id'>>, requestedPrompt = 'Lorem', generationPrompt = 'Lorem ipsum'): Omit<ImageRequest, 'id'> => ({
  userId,
  ...overrides,
  createdAt: 1,
  updatedAt: 1,
  failure: null,
  status: 'queued',
  sourceImageId: null,
  capacityPath: 'warm',
  characterId: 'agent_a',
  conversationId: 1 as ConversationId,
  traceId: `trace-${requestedPrompt}`,
  generationSpec: {
    loras: [],
    version: 1,
    width: 832,
    clipSkip: 2,
    height: 1216,
    requestedPrompt,
    appliedLoras: [],
    detailPassEnabled: false,
    kind: 'standard-diffusion',
    negativePrompt: 'negative',
    positivePrompt: generationPrompt,
    sampling: { seed: 1, steps: 22, cfg: 7, denoise: 1, samplerName: 'euler_ancestral', scheduler: 'normal' },
    checkpoint: { group: 'checkpoints', filename: 'checkpoint.safetensors', sizeBytes: 1, source: { kind: 'r2', key: 'checkpoints/checkpoint.safetensors' } },
  },
});
