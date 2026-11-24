import type { Database } from 'bun:sqlite';
import type { StoragePrivacy } from '../privacy';
import type { AnimateRequestsRow } from '../db/schema-types';
import type { CharacterId } from '../characters/character-catalog';
import type { UserId, ConversationId, AnimateRequestId, GeneratedImageId } from '../utils/brands';
import type { AnimateRequest, AnimateRequestFailure } from '../image-requests/animate-request-types';

export type FailedAnimateRequestSummary = Pick<AnimateRequest, 'id' | 'characterId' | 'createdAt' | 'updatedAt'> & { failure: AnimateRequestFailure };

export class AnimateRequestRepository {
  private readonly markProcessingQuery = `UPDATE animate_requests SET status = 'processing', failure = NULL, updated_at = $now WHERE id = $id`;
  private readonly markFailedQuery = `UPDATE animate_requests SET status = 'failed', failure = $failure, updated_at = $now WHERE id = $id AND status IN ('queued', 'processing')`;
  private readonly markDeliveredQuery = `UPDATE animate_requests SET status = 'delivered', failure = NULL, updated_at = $now WHERE id = $id AND status IN ('queued', 'processing')`;
  private readonly markSubmittedQuery = `UPDATE animate_requests SET grok_request_id = $grok_request_id, updated_at = $now WHERE id = $id`;
  private readonly markArchivedQuery = `UPDATE animate_requests SET r2_key = $r2_key, file_size_bytes = $file_size_bytes, cost_usd = $cost_usd, updated_at = $now WHERE id = $id`;
  private readonly retryFailedQuery = `UPDATE animate_requests SET status = 'queued', failure = NULL, updated_at = $now WHERE id = $id AND status = 'failed' AND failure = 'delivery_failed' AND file_size_bytes IS NOT NULL`;
  private readonly listFailedQuery = `SELECT id, character_id, failure, created_at, updated_at FROM animate_requests WHERE status = 'failed' ORDER BY updated_at DESC, id DESC LIMIT $limit`;
  private readonly listOpenQuery = `SELECT * FROM animate_requests WHERE status IN ('queued', 'processing') ORDER BY created_at ASC, id ASC`;
  private readonly saveQuery =
    `INSERT INTO animate_requests (source_image_id, trace_id, conversation_id, character_id, user_id, prompt, grok_request_id, r2_key, file_size_bytes, cost_usd, status, failure, created_at, updated_at) VALUES ($source_image_id, $trace_id, $conversation_id, $character_id, $user_id, $prompt, $grok_request_id, $r2_key, $file_size_bytes, $cost_usd, $status, $failure, $created_at, $updated_at)`;

  constructor(
    private readonly db: Database,
    private readonly privacy: StoragePrivacy,
  ) { }

  save(request: Omit<AnimateRequest, 'id'>): AnimateRequestId {
    const result = this.db.query<never, Omit<AnimateRequestsRow, 'id'>>(this.saveQuery).run(this.serialize(request));
    return Number(result.lastInsertRowid) as AnimateRequestId;
  }

  listOpen(): AnimateRequest[] {
    return this.db.query<AnimateRequestsRow, []>(this.listOpenQuery).all().map((row) => this.deserialize(row));
  }

  markProcessing(params: { requestId: AnimateRequestId }): void {
    this.db.query<never, { now: number; id: number }>(this.markProcessingQuery).run({ now: Date.now(), id: params.requestId });
  }

  markSubmitted(params: { requestId: AnimateRequestId; grokRequestId: string }): void {
    this.db.query<never, { grok_request_id: string; now: number; id: number }>(this.markSubmittedQuery).run({ grok_request_id: params.grokRequestId, now: Date.now(), id: params.requestId });
  }

  markArchived(params: { requestId: AnimateRequestId; userId: UserId; r2Key: string; fileSizeBytes: number; costUsd: number | null }): void {
    this.db.query<never, { r2_key: string; file_size_bytes: number; cost_usd: number | null; now: number; id: number }>(this.markArchivedQuery).run({
      now: Date.now(),
      id: params.requestId,
      cost_usd: params.costUsd,
      file_size_bytes: params.fileSizeBytes,
      r2_key: this.privacy.encryptForUser(params.userId, 'animate_requests.r2_key', params.r2Key),
    });
  }

  markDelivered(params: { requestId: AnimateRequestId }): boolean {
    return this.db.query<never, { now: number; id: number }>(this.markDeliveredQuery).run({ now: Date.now(), id: params.requestId }).changes === 1;
  }

  markFailed(params: { requestId: AnimateRequestId; failure: AnimateRequestFailure }): boolean {
    return this.db.query<never, { failure: AnimateRequestFailure; now: number; id: number }>(this.markFailedQuery).run({ failure: params.failure, now: Date.now(), id: params.requestId }).changes === 1;
  }

  retryFailed(params: { requestIds: readonly AnimateRequestId[] }): number {
    const now = Date.now();
    const retry = this.db.query<never, { now: number; id: number }>(this.retryFailedQuery);
    return this.db.transaction((requestIds: readonly AnimateRequestId[]) => requestIds.reduce((count, id) => count + retry.run({ id, now }).changes, 0))(params.requestIds);
  }

  listFailed(limit: number): FailedAnimateRequestSummary[] {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('failed animate request limit must be a positive integer');
    const rows = this.db.query<Pick<AnimateRequestsRow, 'id' | 'character_id' | 'failure' | 'created_at' | 'updated_at'>, { limit: number }>(this.listFailedQuery).all({ limit });
    return rows.map((row) => ({ id: row.id as AnimateRequestId, characterId: row.character_id as CharacterId, failure: row.failure as AnimateRequestFailure, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  private serialize(request: Omit<AnimateRequest, 'id'>): Omit<AnimateRequestsRow, 'id'> {
    return {
      status: request.status,
      user_id: request.userId,
      failure: request.failure,
      cost_usd: request.costUsd,
      trace_id: request.traceId,
      created_at: request.createdAt,
      updated_at: request.updatedAt,
      character_id: request.characterId,
      file_size_bytes: request.fileSizeBytes,
      grok_request_id: request.grokRequestId,
      source_image_id: request.sourceImageId,
      conversation_id: request.conversationId,
      r2_key: this.privacy.encryptForUser(request.userId, 'animate_requests.r2_key', request.r2Key),
      prompt: this.privacy.encryptForUser(request.userId, 'animate_requests.prompt', request.prompt),
    };
  }

  private deserialize(row: AnimateRequestsRow): AnimateRequest {
    const userId = row.user_id as UserId;
    return {
      userId,
      costUsd: row.cost_usd,
      traceId: row.trace_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      id: row.id as AnimateRequestId,
      fileSizeBytes: row.file_size_bytes,
      grokRequestId: row.grok_request_id,
      characterId: row.character_id as CharacterId,
      status: row.status as AnimateRequest['status'],
      failure: row.failure as AnimateRequestFailure | null,
      conversationId: row.conversation_id as ConversationId,
      sourceImageId: row.source_image_id as GeneratedImageId,
      r2Key: this.privacy.decryptForUser(userId, 'animate_requests.r2_key', row.r2_key),
      prompt: this.privacy.decryptForUser(userId, 'animate_requests.prompt', row.prompt),
    };
  }
}
