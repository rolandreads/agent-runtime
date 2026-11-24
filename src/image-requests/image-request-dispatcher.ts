import { settings } from '../settings';
import type { StoragePrivacy } from '../privacy';
import type { ImageRecipe } from './image-recipe';
import type { EventLog } from '../utils/event-log';
import type { ImageGenerator } from './image-generator';
import type { ImageRequest } from './image-request-types';
import { embedImageRecipe } from './image-recipe-metadata';
import { buildComfyWorkflow } from '../comfy/comfy-workflow';
import type { CharacterId } from '../characters/character-catalog';
import type { NodeTiming, ComfyOutputImage } from '../comfy/comfy-client';
import { archiveJPG, readArchive, nextImageArchiveKey } from '../utils/image-archive';
import type { ImageRequestRepository } from '../repositories/image-request-repository';
import type { UserId, ConversationId, ImageRequestId, GeneratedImageId } from '../utils/brands';
import type { ArchivedImageArtifact, GeneratedImageRepository } from '../repositories/generated-image-repository';

type DeliverImage = (params: { conversationId: ConversationId; generatedImageId: GeneratedImageId; imageBytes: Uint8Array }) => Promise<void>;
export type ImageRequestRejectionReason = 'paused';
type ImageRequestDispatcherDeps = {
  eventLog: EventLog;
  privacy: StoragePrivacy;
  deliverImage: DeliverImage;
  imageGenerator: ImageGenerator;
  requestGpuCapacity: () => void;
  imageRequestRepo: ImageRequestRepository;
  generatedImageRepo: GeneratedImageRepository;
  notifyUser: (params: { conversationId: ConversationId; traceId: string; sourceImageId: GeneratedImageId | null; message: string }) => Promise<void>;
};

export class ImageRequestDispatcher {
  private paused = false;
  private drainPending = false;
  private draining: Promise<void> | undefined;
  private readonly activeRequests = new Set<Promise<void>>();

  constructor(private readonly deps: ImageRequestDispatcherDeps) {}

  checkAvailability(): ImageRequestRejectionReason | null {
    return settings.get().gate === 'open' ? null : 'paused';
  }

  enqueue(params: {
    userId: UserId;
    traceId: string;
    characterId: CharacterId;
    conversationId: ConversationId;
    requests: readonly { sourceImageId: GeneratedImageId | null; generationSpec: ImageRecipe }[];
  }): { kind: 'queued'; requestIds: ImageRequestId[] } | { kind: 'rejected'; reason: ImageRequestRejectionReason } {
    const { userId, characterId, conversationId, traceId, requests } = params;
    const rejected = this.checkAvailability();
    if (rejected !== null) {
      this.deps.eventLog.log({ traceId, type: 'image_request_rejected', userId, data: { reason: rejected, requestedCount: requests.length } });
      return { kind: 'rejected', reason: rejected };
    }
    const now = Date.now();
    const capacityPath = this.deps.imageGenerator.connectedWorkerCount() > 0 ? 'warm' as const : 'cold' as const;
    const imageRequests: Omit<ImageRequest, 'id'>[] = requests.map(({ sourceImageId, generationSpec }) => ({
      userId,
      traceId,
      characterId,
      capacityPath,
      failure: null,
      sourceImageId,
      conversationId,
      createdAt: now,
      generationSpec,
      updatedAt: now,
      status: 'queued',
    }));
    const ids = this.deps.imageRequestRepo.saveMany(imageRequests);
    this.deps.eventLog.log({ traceId, type: 'image_request_created', userId, data: { requestIds: ids } });
    this.deps.requestGpuCapacity();
    void this.kick();
    return { kind: 'queued', requestIds: ids };
  }

  recover(): Promise<void> {
    this.deps.imageRequestRepo.requeueProcessing();
    this.deps.requestGpuCapacity();
    return this.kick();
  }

  async failQueuedForCapacity(error: unknown): Promise<void> {
    const requests = this.deps.imageRequestRepo.listQueuedForGeneration();
    for (const request of requests) {
      this.deps.imageRequestRepo.markFailed({ requestId: request.id, failure: 'generation_failed' });
      this.deps.eventLog.error({ type: 'image_gpu_capacity_failed', userId: request.userId, traceId: request.traceId, data: { requestId: request.id } }, error);
    }
    this.deps.requestGpuCapacity();
    await Promise.all(requests.map((request) => this.notifyFailure(request, "I couldn't generate that image because no GPU was available. Please try again in a few minutes.")));
  }

  kick(): Promise<void> {
    if (this.paused) return Promise.resolve();
    void this.prefetchRequests(this.deps.imageRequestRepo.listQueuedForGeneration());
    this.drainPending = true;
    this.draining ??= this.drainWork();
    return this.draining;
  }

  async drain(): Promise<void> {
    this.paused = true;
    this.deps.eventLog.log({ type: 'image_request_drain_started', data: { activeRequestCount: this.activeRequests.size } });
    await this.draining;
    await Promise.all(this.activeRequests);
    this.deps.eventLog.log({ type: 'image_request_drain_completed' });
  }

  private async drainWork(): Promise<void> {
    try {
      while (this.drainPending) {
        this.drainPending = false;
        await this.submitLoop();
      }
    } finally {
      this.draining = undefined;
    }
  }

  private async submitLoop(): Promise<void> {
    for (; ;) {
      if (this.paused) return;
      const request = this.deps.imageRequestRepo.claimNext();
      if (request === null) return;

      const artifact = this.deps.generatedImageRepo.findArchivedForRequest({ requestId: request.id, userId: request.userId });
      if (artifact !== null) {
        await this.deliverArchivedImage({ request, artifact });
        continue;
      }

      const drainDecision = await this.submitImageRequestToGpu(request);
      if (drainDecision === 'pause_draining') return;
    }
  }

  private async prefetchRequests(requests: readonly Pick<ImageRequest, 'generationSpec'>[]): Promise<void> {
    if (requests.length === 0) return;
    try {
      const requiredAssets = requests.flatMap(({ generationSpec }) => buildComfyWorkflow(generationSpec).requiredAssets);
      await this.deps.imageGenerator.prefetch(requiredAssets);
    } catch (error) {
      this.deps.eventLog.error({ type: 'image_asset_prefetch_failed', data: { requestCount: requests.length } }, error);
    }
  }

  private async submitImageRequestToGpu(request: ImageRequest): Promise<'keep_draining' | 'pause_draining'> {
    const { generationSpec } = request;
    try {
      const workflow = buildComfyWorkflow(generationSpec);
      const { outputNodeIds, ...submission } = workflow;
      this.deps.eventLog.log({ type: 'gpu_generation_submit', userId: request.userId, traceId: request.traceId, data: { requestId: request.id } });
      const submitResult = await this.deps.imageGenerator.submit(submission);
      if (submitResult.kind === 'busy') {
        this.deps.imageRequestRepo.markQueued({ requestId: request.id });
        this.deps.requestGpuCapacity();
        return 'pause_draining';
      }
      this.deps.eventLog.log({ type: 'image_gpu_accepted', userId: request.userId, traceId: request.traceId, durationMs: Date.now() - request.createdAt, data: { requestId: request.id } });
      const processing = submitResult.attempt.completion
        .then(
          ({ images, nodeTimings }) => this.handleGpuExecutionSuccess({ request, outputNodeIds, images, nodeTimings }),
          (error) => this.handleGpuExecutionFailure(request, error),
        )
        .catch((error) => this.deps.eventLog.error({ type: 'image_gpu_settlement_failed', userId: request.userId, traceId: request.traceId, data: { requestId: request.id } }, error));
      this.activeRequests.add(processing);
      void processing.then(() => this.activeRequests.delete(processing));
    } catch (error) {
      await this.handleGpuFailure({ request, type: 'image_gpu_submission_failed', error });
      return 'keep_draining';
    }

    return 'keep_draining';
  }

  private async handleGpuExecutionFailure(request: ImageRequest, error: unknown): Promise<void> {
    await this.handleGpuFailure({ request, type: `image_gpu_execution_failed - reason:execution_error detail: ${String(error)}` });
  }

  private async handleGpuFailure(params: { request: ImageRequest; type: string; error?: unknown }): Promise<void> {
    this.deps.imageRequestRepo.markFailed({ requestId: params.request.id, failure: 'generation_failed' });
    this.deps.requestGpuCapacity();
    this.deps.eventLog.error({ type: params.type, userId: params.request.userId, traceId: params.request.traceId }, params.error);
    await this.notifyFailure(params.request, "I couldn't generate that image. Please try again.");
  }

  private async handleGpuExecutionSuccess(params: { request: ImageRequest; outputNodeIds: { final: string; preDetailPass?: string }; images: ComfyOutputImage[]; nodeTimings: NodeTiming[] }): Promise<void> {
    const { request, outputNodeIds, images, nodeTimings } = params;
    const outputImage = images.find((image) => image.nodeId === outputNodeIds.final);
    if (outputImage === undefined) {
      await this.handleGpuExecutionFailure(request, `Comfy returned no image from output node ${outputNodeIds.final}`);
      return;
    }
    this.deps.eventLog.log({ type: 'gpu_generation_completed', userId: request.userId, traceId: request.traceId, data: { requestId: request.id, imageCount: images.length } });
    const durationMs = nodeTimings.reduce((total, timing) => total + timing.durationMs, 0);

    this.deps.eventLog.log({
      durationMs,
      userId: request.userId,
      traceId: request.traceId,
      type: 'image_comfy_profile',
      data: { nodeTimings, requestId: request.id, width: request.generationSpec.width, height: request.generationSpec.height },
    });

    const preDetailPassImage = images.find((image) => image.nodeId === outputNodeIds.preDetailPass);
    const withRecipe = (image: ComfyOutputImage): Uint8Array => {
      try {
        return embedImageRecipe({ bytes: image.bytes, recipe: request.generationSpec, privacy: this.deps.privacy });
      } catch (error) {
        this.deps.eventLog.error({ type: 'image_recipe_metadata_failed', userId: request.userId, traceId: request.traceId, data: { requestId: request.id, nodeId: image.nodeId } }, error);
        return image.bytes;
      }
    };
    const outputImageBytes = withRecipe(outputImage);
    const additionalImageBytes = preDetailPassImage ? withRecipe(preDetailPassImage) : undefined;
    await this.deliverAndArchive({ request, outputImageBytes, additionalImageBytes });
  }

  private async deliverAndArchive(params: { request: ImageRequest; outputImageBytes: Uint8Array; additionalImageBytes: Uint8Array | undefined }): Promise<void> {
    const { request, outputImageBytes, additionalImageBytes } = params;
    const r2Key = nextImageArchiveKey();
    const generatedImageId = this.deps.generatedImageRepo.save({ imageRequestId: request.id, fileSizeBytes: outputImageBytes.byteLength, userId: request.userId, r2Key: null });
    const archivedFinal = archiveJPG(outputImageBytes, r2Key);
    const archivedAdditional = additionalImageBytes === undefined ? Promise.resolve() : archiveJPG(additionalImageBytes, nextImageArchiveKey('pre_detail_pass')).catch((error) => {
      this.deps.eventLog.error({ type: 'image_archive_failed', userId: request.userId, traceId: request.traceId, data: { requestId: request.id, generatedImageId, r2Key } }, error);
    });

    try {
      const archivedR2Key = await archivedFinal;
      this.deps.generatedImageRepo.markArchived({ generatedImageId, userId: request.userId, r2Key: archivedR2Key });
    } catch (error) {
      this.deps.eventLog.error({ type: 'image_archive_failed', userId: request.userId, traceId: request.traceId, data: { requestId: request.id, generatedImageId, r2Key } }, error);
    }

    try {
      await this.deps.deliverImage({ generatedImageId, imageBytes: outputImageBytes, conversationId: request.conversationId });
      this.deps.imageRequestRepo.markDelivered({ requestId: request.id });
      this.deps.eventLog.log({ type: 'image_delivery_success', userId: request.userId, traceId: request.traceId, durationMs: Date.now() - request.createdAt, data: { generatedImageId, requestId: request.id } });
    } catch (error) {
      this.deps.eventLog.error({ type: 'image_delivery_failed', userId: request.userId, traceId: request.traceId }, error);
      this.deps.imageRequestRepo.markFailed({ requestId: request.id, failure: 'delivery_failed' });
      await this.notifyFailure(request, "I generated that image, but couldn't send it through Discord. Please try again.");
    }
    this.deps.requestGpuCapacity();

    await archivedAdditional;
  }

  private async deliverArchivedImage(params: { request: ImageRequest; artifact: ArchivedImageArtifact }): Promise<void> {
    const { request, artifact } = params;
    try {
      const imageBytes = await readArchive(artifact.r2Key);
      await this.deps.deliverImage({ generatedImageId: artifact.generatedImageId, imageBytes, conversationId: request.conversationId });
      this.deps.imageRequestRepo.markDelivered({ requestId: request.id });
      this.deps.eventLog.log({ type: 'image_delivery_retry_success', userId: request.userId, traceId: request.traceId, data: { generatedImageId: artifact.generatedImageId, requestId: request.id } });
    } catch (error) {
      this.deps.eventLog.error({ type: 'image_delivery_retry_failed', userId: request.userId, traceId: request.traceId, data: { generatedImageId: artifact.generatedImageId, requestId: request.id } }, error);
      this.deps.imageRequestRepo.markFailed({ requestId: request.id, failure: 'delivery_failed' });
    }
  }

  private async notifyFailure(request: ImageRequest, message: string): Promise<void> {
    await this.deps.notifyUser({ conversationId: request.conversationId, traceId: request.traceId, sourceImageId: request.sourceImageId, message }).catch((error) => this.deps.eventLog.error({ type: 'image_failure_notification_failed', userId: request.userId, traceId: request.traceId, data: { requestId: request.id } }, error));
  }

}
