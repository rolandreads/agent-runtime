import { settings } from '../settings';
import type { EventLog } from '../utils/event-log';
import type { CharacterId } from '../characters/character-catalog';
import type { CostRepository } from '../repositories/cost-repository';
import { GrokVideoError, type GrokVideoClient } from '../grok/grok-video';
import type { AnimateRequest, AnimateRequestFailure } from './animate-request-types';
import { archiveMP4, readArchive, nextVideoArchiveKey } from '../utils/image-archive';
import type { AnimateRequestRepository } from '../repositories/animate-request-repository';
import type { GeneratedImageRepository } from '../repositories/generated-image-repository';
import type { UserId, ConversationId, AnimateRequestId, GeneratedImageId } from '../utils/brands';

export type AnimateRequestRejectionReason = 'paused';

type AnimateRequestDispatcherDeps = {
  eventLog: EventLog;
  costRepo: CostRepository;
  grokVideo: GrokVideoClient;
  animateRequestRepo: AnimateRequestRepository;
  generatedImageRepo: GeneratedImageRepository;
  deliverAnimation: (params: { conversationId: ConversationId; videoBytes: Uint8Array }) => Promise<void>;
  notifyUser: (params: { conversationId: ConversationId; traceId: string; sourceImageId: GeneratedImageId; message: string }) => Promise<void>;
};

export class AnimateRequestDispatcher {
  private paused = false;
  private readonly inflight = new Set<AnimateRequest['id']>();
  private readonly activeRequests = new Set<Promise<void>>();

  constructor(private readonly deps: AnimateRequestDispatcherDeps) {}

  checkAvailability(): AnimateRequestRejectionReason | null {
    return settings.get().gate === 'open' ? null : 'paused';
  }

  enqueue(params: {
    prompt: string;
    userId: UserId;
    traceId: string;
    characterId: CharacterId;
    conversationId: ConversationId;
    sourceImageId: GeneratedImageId;
  }): { kind: 'queued' } | { kind: 'rejected'; reason: AnimateRequestRejectionReason } {
    const rejected = this.checkAvailability();
    if (rejected !== null) {
      this.deps.eventLog.log({ traceId: params.traceId, type: 'animate_request_rejected', userId: params.userId, data: { reason: rejected } });
      return { kind: 'rejected', reason: rejected };
    }

    const now = Date.now();
    const request = { userId: params.userId, traceId: params.traceId, prompt: params.prompt, createdAt: now, updatedAt: now, characterId: params.characterId, status: 'queued' as const, conversationId: params.conversationId, sourceImageId: params.sourceImageId, failure: null, grokRequestId: null, r2Key: nextVideoArchiveKey(), fileSizeBytes: null, costUsd: null };
    const requestId = this.deps.animateRequestRepo.save(request);
    this.run({ ...request, id: requestId });
    this.deps.eventLog.log({ traceId: params.traceId, type: 'animate_request_created', userId: params.userId, data: { sourceImageId: params.sourceImageId } });
    return { kind: 'queued' };
  }

  recover(): void {
    if (this.paused) return;
    for (const request of this.deps.animateRequestRepo.listOpen()) this.run(request);
  }

  async drain(): Promise<void> {
    this.paused = true;
    this.deps.eventLog.log({ type: 'animate_request_drain_started', data: { activeRequestCount: this.activeRequests.size } });
    await Promise.all(this.activeRequests);
    this.deps.eventLog.log({ type: 'animate_request_drain_completed' });
  }

  private run(request: AnimateRequest): void {
    if (this.paused || this.inflight.has(request.id)) return;
    this.inflight.add(request.id);
    this.deps.animateRequestRepo.markProcessing({ requestId: request.id });
    const task = this.process(request).finally(() => {
      this.activeRequests.delete(task);
      this.inflight.delete(request.id);
      this.recover();
    });
    this.activeRequests.add(task);
  }

  private async process(request: AnimateRequest): Promise<void> {
    try {
      const videoBytes = await (request.fileSizeBytes === null ? this.generateAndArchive(request) : readArchive(request.r2Key));
      await this.deps.deliverAnimation({ conversationId: request.conversationId, videoBytes });
      this.markTerminal({ requestId: request.id, failure: null });
      this.deps.eventLog.log({ type: 'animate_delivery_success', userId: request.userId, traceId: request.traceId, data: { sourceImageId: request.sourceImageId, requestId: request.id } });
    } catch (error) {
      await this.fail(request, error);
    }
  }

  private async generateAndArchive(request: AnimateRequest): Promise<Uint8Array> {
    const { eventLog, grokVideo } = this.deps;
    request.grokRequestId ??= await this.submit(request);
    eventLog.log({ type: 'animate_poll', userId: request.userId, traceId: request.traceId, data: { sourceImageId: request.sourceImageId, grokRequestId: request.grokRequestId } });
    const done = await grokVideo.waitForVideo(request.grokRequestId);
    const videoBytes = await grokVideo.download(done.url);
    if (done.costUsd !== null) {
      this.deps.costRepo.save({ source: 'xai', amountUsd: done.costUsd, userId: request.userId, traceId: request.traceId, data: { requestId: request.id, grokRequestId: request.grokRequestId, durationSec: done.durationSec, resolution: settings.get().grok.resolution } });
    }
    await archiveMP4(videoBytes, request.r2Key);
    this.deps.animateRequestRepo.markArchived({ requestId: request.id, userId: request.userId, r2Key: request.r2Key, fileSizeBytes: videoBytes.byteLength, costUsd: done.costUsd });
    request.costUsd = done.costUsd;
    request.fileSizeBytes = videoBytes.byteLength;
    return videoBytes;
  }

  private async submit(request: AnimateRequest): Promise<string> {
    const r2Key = this.deps.generatedImageRepo.getArchivedImageKey(request.sourceImageId, request.userId);
    if (r2Key === null) throw new Error(`Source image ${String(request.sourceImageId)} has no archived bytes`);
    const imageBytes = await readArchive(r2Key, { retryUntilMs: settings.get().grok.sourceArchiveRetryMs });
    this.deps.eventLog.log({ type: 'animate_submit', userId: request.userId, traceId: request.traceId, data: { sourceImageId: request.sourceImageId, requestId: request.id } });
    const grok = settings.get().grok;
    const grokRequestId = await this.deps.grokVideo.submitImage({ imageBytes, prompt: request.prompt, durationSec: grok.durationSec, resolution: grok.resolution });
    this.deps.animateRequestRepo.markSubmitted({ requestId: request.id, grokRequestId });
    return grokRequestId;
  }

  private async fail(request: AnimateRequest, error: unknown): Promise<void> {
    this.markTerminal({ requestId: request.id, failure });
    const refused = error instanceof GrokVideoError && error.refused;
    const failure: AnimateRequestFailure = refused ? 'refused' : request.fileSizeBytes === null ? 'generation_failed' : 'delivery_failed';
    this.deps.eventLog.error({ type: 'animate_failed', userId: request.userId, traceId: request.traceId, data: { sourceImageId: request.sourceImageId, requestId: request.id, refused } }, error);
    await this.deps.notifyUser({ conversationId: request.conversationId, traceId: request.traceId, sourceImageId: request.sourceImageId, message: refused ? refusedUserMessage : failure === 'delivery_failed' ? deliveryFailedUserMessage : failedUserMessage }).catch((notificationError) => this.deps.eventLog.error({ type: 'animate_failure_notification_failed', userId: request.userId, traceId: request.traceId, data: { requestId: request.id } }, notificationError));
  }

  private markTerminal(params: { requestId: AnimateRequestId; failure: AnimateRequestFailure | null }): void {
    if (params.failure === null) this.deps.animateRequestRepo.markDelivered(params);
    else this.deps.animateRequestRepo.markFailed({ ...params, failure: params.failure });
  }
}
