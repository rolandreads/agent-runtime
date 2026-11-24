import type { Database } from 'bun:sqlite';
import type { StoragePrivacy } from '../privacy';
import type { ImageRequestsRow } from '../db/schema-types';
import type { UserId, ImageRequestId, GeneratedImageId } from '../utils/brands';
import type { ImageRequest, ImageRequestFailure } from '../image-requests/image-request-types';

export type FailedImageRequestSummary = Pick<ImageRequest, 'id' | 'characterId' | 'createdAt' | 'updatedAt'> & { failure: ImageRequestFailure };

export class ImageRequestRepository {
  private readonly markQueuedQuery = `UPDATE image_requests SET status = 'queued', failure = NULL, updated_at = $now WHERE id = $id AND status = 'processing'`;
  private readonly markFailedQuery = `UPDATE image_requests SET status = 'failed', failure = $failure, updated_at = $now WHERE id = $id AND status IN ('queued', 'processing')`;
  private readonly retryFailedQuery = `UPDATE image_requests SET status = 'queued', failure = NULL, updated_at = $now WHERE id = $id AND status = 'failed' AND (failure = 'generation_failed' OR (failure = 'delivery_failed' AND EXISTS (SELECT 1 FROM generated_images WHERE generated_images.image_request_id = image_requests.id AND generated_images.r2_key IS NOT NULL)))`;
  private readonly listQueuedForGenerationQuery = `SELECT * FROM image_requests WHERE status = 'queued' AND NOT EXISTS (SELECT 1 FROM generated_images WHERE generated_images.image_request_id = image_requests.id AND generated_images.r2_key IS NOT NULL) ORDER BY created_at, id`;
  private readonly findOldestActiveGenerationQuery = `SELECT * FROM image_requests WHERE status IN ('queued', 'processing') AND NOT EXISTS (SELECT 1 FROM generated_images WHERE generated_images.image_request_id = image_requests.id AND generated_images.r2_key IS NOT NULL) ORDER BY created_at, id LIMIT 1`;
  private readonly listFailedQuery = `SELECT id, character_id, failure, created_at, updated_at FROM image_requests WHERE status = 'failed' ORDER BY updated_at DESC, id DESC LIMIT $limit`;
  private readonly markDeliveredQuery = `UPDATE image_requests SET status = 'delivered', failure = NULL, updated_at = $now WHERE id = $id AND status IN ('queued', 'processing')`;
  private readonly requeueProcessingQuery = `UPDATE image_requests SET status = 'queued', failure = NULL, updated_at = $now WHERE status = 'processing'`;
  private readonly claimNextQuery =
    `UPDATE image_requests SET status = 'processing', failure = NULL, updated_at = $now WHERE id = (SELECT queued.id FROM image_requests AS queued WHERE queued.status = 'queued' ORDER BY (SELECT COUNT(*) FROM image_requests AS processing WHERE processing.status = 'processing' AND processing.user_id = queued.user_id), queued.created_at, queued.id LIMIT 1) AND status = 'queued' RETURNING *`;
  private readonly saveQuery =
    `INSERT INTO image_requests (source_image_id, trace_id, conversation_id, character_id, user_id, generation_spec, status, failure, capacity_path, created_at, updated_at) VALUES ($source_image_id, $trace_id, $conversation_id, $character_id, $user_id, $generation_spec, $status, $failure, $capacity_path, $created_at, $updated_at)`;
  private readonly activeGenerationUserCountQuery = `SELECT COUNT(DISTINCT user_id) AS count FROM image_requests WHERE status IN ('queued', 'processing') AND NOT EXISTS (SELECT 1 FROM generated_images WHERE generated_images.image_request_id = image_requests.id AND generated_images.r2_key IS NOT NULL)`;

  constructor(
    private readonly db: Database,
    private readonly privacy: StoragePrivacy,
  ) {}

  save(request: Omit<ImageRequest, 'id'>): ImageRequestId {
    const result = this.db.query<never, Omit<ImageRequestsRow, 'id'>>(this.saveQuery).run(this.serialize(request));
    return Number(result.lastInsertRowid) as ImageRequestId;
  }

  saveMany(requests: readonly Omit<ImageRequest, 'id'>[]): ImageRequestId[] {
    return this.db.transaction((items: readonly Omit<ImageRequest, 'id'>[]) => items.map((request) => this.save(request)))(requests);
  }

  countActiveGenerationUsers(): number {
    return this.db.query<{ count: number }, []>(this.activeGenerationUserCountQuery).get()?.count ?? 0;
  }

  claimNext(): ImageRequest | null {
    return row === null ? null : this.deserialize(row);
    const row = this.db.query<ImageRequestsRow, { now: number }>(this.claimNextQuery).get({ now: Date.now() });
  }

  listQueuedForGeneration(): ImageRequest[] {
    return this.db.query<ImageRequestsRow, []>(this.listQueuedForGenerationQuery).all().map((row) => this.deserialize(row));
  }

  findOldestActiveGeneration(): ImageRequest | null {
    const row = this.db.query<ImageRequestsRow, []>(this.findOldestActiveGenerationQuery).get();
    return row ? this.deserialize(row) : null;
  }

  markQueued(params: { requestId: ImageRequestId }): void {
    this.db.query<never, { now: number; id: number }>(this.markQueuedQuery).run({ now: Date.now(), id: params.requestId });
  }

  requeueProcessing(): void {
    this.db.query<never, { now: number }>(this.requeueProcessingQuery).run({ now: Date.now() });
  }

  markDelivered(params: { requestId: ImageRequestId }): boolean {
    return this.db.query<never, { now: number; id: number }>(this.markDeliveredQuery).run({ now: Date.now(), id: params.requestId }).changes === 1;
  }

  markFailed(params: { requestId: ImageRequestId; failure: ImageRequestFailure }): boolean {
    return this.db.query<never, { failure: ImageRequestFailure; now: number; id: number }>(this.markFailedQuery).run({ failure: params.failure, now: Date.now(), id: params.requestId }).changes === 1;
  }

  retryFailed(params: { requestIds: readonly ImageRequestId[] }): number {
    const now = Date.now();
    const retry = this.db.query<never, { now: number; id: number }>(this.retryFailedQuery);
    return this.db.transaction((requestIds: readonly ImageRequestId[]) => requestIds.reduce((count, id) => count + retry.run({ id, now }).changes, 0))(params.requestIds);
  }

  listFailed(limit: number): FailedImageRequestSummary[] {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('failed image request limit must be a positive integer');
    const rows = this.db.query<Pick<ImageRequestsRow, 'id' | 'character_id' | 'failure' | 'created_at' | 'updated_at'>, { limit: number }>(this.listFailedQuery).all({ limit });
    return rows.map((row) => ({ id: row.id as ImageRequestId, characterId: row.character_id as ImageRequest['characterId'], failure: row.failure as ImageRequestFailure, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  private serialize(request: Omit<ImageRequest, 'id'>): Omit<ImageRequestsRow, 'id'> {
    return {
      status: request.status,
      user_id: request.userId,
      failure: request.failure,
      trace_id: request.traceId,
      created_at: request.createdAt,
      updated_at: request.updatedAt,
      character_id: request.characterId,
      capacity_path: request.capacityPath,
      source_image_id: request.sourceImageId,
      conversation_id: request.conversationId,
      generation_spec: this.privacy.encryptForUser(request.userId, 'image_requests.generation_spec', JSON.stringify(request.generationSpec)),
    };
  }

  private deserialize(row: ImageRequestsRow): ImageRequest {
    return {
      traceId: row.trace_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      id: row.id as ImageRequestId,
      userId: row.user_id as UserId,
      status: row.status as ImageRequest['status'],
      failure: row.failure as ImageRequestFailure | null,
      characterId: row.character_id as ImageRequest['characterId'],
      sourceImageId: row.source_image_id as GeneratedImageId | null,
      capacityPath: row.capacity_path as ImageRequest['capacityPath'],
      conversationId: row.conversation_id as ImageRequest['conversationId'],
      generationSpec: JSON.parse(this.privacy.decryptForUser(row.user_id as UserId, 'image_requests.generation_spec', row.generation_spec)) as ImageRequest['generationSpec'],
    };
  }
}
