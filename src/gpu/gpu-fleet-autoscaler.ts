import type { EventLog } from '../utils/event-log';
import type { SettingSnapshot } from '../settings';
import type { ComfyAsset } from '../comfy/comfy-assets';
import { buildComfyWorkflow } from '../comfy/comfy-workflow';
import type { GpuRuntime, GpuAcquisition } from './gpu-runtime';
import type { ImageRequest } from '../image-requests/image-request-types';

type GpuFleetPolicy = Pick<SettingSnapshot['gpu'], 'minWorkers' | 'maxWorkers' | 'activeUsersPerWorker' | 'coldStartCandidates' | 'readyPollIntervalMs'>;
type GpuFleetDemand = { countActiveGenerationUsers(): number; findOldestActiveGeneration(): Pick<ImageRequest, 'generationSpec'> | null };
type GpuFleetRuntime = Pick<GpuRuntime, 'connectedWorkerCount' | 'idleWorkerIds' | 'acquire' | 'destroyAcquisition' | 'destroyIdleWorker'>;
type FleetAcquisition = { handle: GpuAcquisition | null; cancelled: boolean; bootOrder: number };

export class GpuFleetAutoscaler {
  private stopped = false;
  private pendingTrigger: string | undefined;
  private reconciling: Promise<void> | undefined;
  private readonly acquisitions = new Set<FleetAcquisition>();
  private bootOrder = 0;

  constructor(private readonly deps: { events: EventLog; demand: GpuFleetDemand; runtime: GpuFleetRuntime; policy: () => GpuFleetPolicy; onCapacityUnavailable: (error: unknown) => void }) {}

  requestReconcile(trigger: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.pendingTrigger = trigger;
    // Schedule after assignment so the loop cannot clear reconciling before its promise is stored.
    this.reconciling ??= Promise.resolve().then(() => this.reconcileLoop());
    return this.reconciling;
  }

  stop(): void {
    this.stopped = true;
    this.pendingTrigger = undefined;
  }

  acquiringWorkerCount(): number {
    return [...this.acquisitions].filter((acquisition) => !acquisition.cancelled && !acquisition.handle?.appReady).length;
  }

  private desiredGpuWorkerCount(activeUsers: number, policy: GpuFleetPolicy): number {
    return Math.min(policy.maxWorkers, Math.max(policy.minWorkers, Math.ceil(activeUsers / policy.activeUsersPerWorker)));
  }

  private async reconcileLoop(): Promise<void> {
    try {
      while (this.pendingTrigger && !this.stopped) {
        const trigger = this.pendingTrigger;
        this.pendingTrigger = undefined;
        try {
          await this.reconcile(trigger);
        } catch (error) {
          this.deps.events.error({ type: 'gpu_fleet_autoscaler_reconcile_failed', data: { trigger } }, error);
        }
      }
    } finally {
      this.reconciling = undefined;
    }
  }

  private async reconcile(trigger: string): Promise<void> {
    const policy = this.deps.policy();
    const activeUsers = this.deps.demand.countActiveGenerationUsers();
    const desiredWorkers = this.desiredGpuWorkerCount(activeUsers, policy);
    const connectedWorkers = this.deps.runtime.connectedWorkerCount();
    const acquiringWorkers = [...this.acquisitions].filter((acquisition) => !acquisition.handle?.appReady);
    const activeAcquisitions = acquiringWorkers.filter((acquisition) => !acquisition.cancelled);
    for (const acquisition of acquiringWorkers.filter((item) => item.cancelled)) this.destroyAcquisition(acquisition);
    const coldStart = activeUsers > 0 && connectedWorkers === 0 && !activeAcquisitions.some((acquisition) => acquisition.bootOrder > 0);
    const targetWorkers = coldStart ? Math.min(policy.maxWorkers, Math.max(desiredWorkers, activeAcquisitions.length || policy.coldStartCandidates)) : desiredWorkers;
    const excessAcquisitions = Math.min(activeAcquisitions.length, Math.max(0, connectedWorkers + activeAcquisitions.length - targetWorkers));
    if (excessAcquisitions > 0) {
      const cancellations = activeAcquisitions.toSorted((left, right) => (left.bootOrder || Infinity) - (right.bootOrder || Infinity)).slice(-excessAcquisitions);
      for (const acquisition of cancellations) acquisition.cancelled = true;
      this.deps.events.log({ type: 'gpu_fleet_autoscaler_decision', data: { trigger, decision: 'destroy', reason: 'excess_acquiring_capacity', activeUsers, desiredWorkers, connectedWorkers, acquisitionCount: excessAcquisitions, acquiringWorkers: acquiringWorkers.length } });
      for (const acquisition of cancellations) this.destroyAcquisition(acquisition);
      return;
    }
    const idleSurplusWorkers = this.deps.runtime.idleWorkerIds().slice(0, Math.max(0, connectedWorkers - desiredWorkers));
    if (idleSurplusWorkers.length > 0) {
      this.deps.events.log({ type: 'gpu_fleet_autoscaler_decision', data: { trigger, decision: 'destroy', reason: 'idle_surplus', activeUsers, desiredWorkers, connectedWorkers, destructionCount: idleSurplusWorkers.length, acquiringWorkers: acquiringWorkers.length } });
      for (const computeWorkerId of idleSurplusWorkers) {
        void this.deps.runtime.destroyIdleWorker(computeWorkerId).then(
          () => { void this.requestReconcile('idle_worker_destroyed'); },
          (error) => this.deps.events.error({ type: 'gpu_fleet_worker_destruction_failed', data: { computeWorkerId } }, error),
        );
      }
      return;
    }
    const ceilingRoom = Math.max(0, policy.maxWorkers - connectedWorkers - acquiringWorkers.length);
    const missingWorkers = Math.min(ceilingRoom, Math.max(0, targetWorkers - connectedWorkers - activeAcquisitions.length));
    if (missingWorkers === 0) {
      this.deps.events.log({ type: 'gpu_fleet_autoscaler_decision', data: { trigger, decision: 'none', reason: 'at_desired_capacity', activeUsers, desiredWorkers, connectedWorkers, acquiringWorkers: acquiringWorkers.length } });
      return;
    }

    const activeRequest = this.deps.demand.findOldestActiveGeneration();
    if (!activeRequest) {
      this.deps.events.log({ type: 'gpu_fleet_autoscaler_decision', data: { trigger, decision: 'none', reason: 'no_active_request', activeUsers, desiredWorkers, connectedWorkers, acquiringWorkers: acquiringWorkers.length } });
      return;
    }

    const requiredAssets = buildComfyWorkflow(activeRequest.generationSpec).requiredAssets;
    const acquisitions: FleetAcquisition[] = [];
    for (let index = 0; index < missingWorkers; index += 1) {
      const acquisition: FleetAcquisition = { handle: null, cancelled: false, bootOrder: 0 };
      acquisitions.push(acquisition);
      this.acquisitions.add(acquisition);
    }
    this.deps.events.log({ type: 'gpu_fleet_autoscaler_decision', data: { trigger, decision: 'acquire', reason: 'missing_capacity', activeUsers, desiredWorkers, connectedWorkers, acquisitionCount: missingWorkers, acquiringWorkers: acquiringWorkers.length + missingWorkers } });
    if (coldStart) void this.startColdRace({ acquisitions, requiredAssets, activeUsers, desiredWorkers, retryDelayMs: policy.readyPollIntervalMs });
    else for (const acquisition of acquisitions) void this.startAcquisition({ acquisition, requiredAssets, activeUsers, desiredWorkers, retryDelayMs: policy.readyPollIntervalMs }, new Set());
  }

  private async startColdRace(params: { acquisitions: FleetAcquisition[]; requiredAssets: readonly ComfyAsset[]; activeUsers: number; desiredWorkers: number; retryDelayMs: number | null }): Promise<void> {
    const countriesAlreadyTried = new Set<string>();
    for (const acquisition of params.acquisitions) {
      if (acquisition.cancelled) continue;
      const handle = await this.startAcquisition({ ...params, acquisition }, countriesAlreadyTried);
      if (handle) countriesAlreadyTried.add(handle.countryCode);
    }
  }

  private async startAcquisition(params: { acquisition: FleetAcquisition; requiredAssets: readonly ComfyAsset[]; activeUsers: number; desiredWorkers: number; retryDelayMs: number | null }, countriesAlreadyTried: ReadonlySet<string>): Promise<GpuAcquisition | undefined> {
    return this.deps.runtime.acquire(params.requiredAssets, countriesAlreadyTried).then((handle) => {
      params.acquisition.handle = handle;
      void handle.booted.then(() => {
        if (params.acquisition.cancelled) return;
        params.acquisition.bootOrder = ++this.bootOrder;
        void this.requestReconcile('worker_booted');
      });
      void handle.ready.then(
        () => {
          if (params.acquisition.cancelled) return;
          this.acquisitions.delete(params.acquisition);
          void this.requestReconcile('acquisition_completed');
        },
        (error) => this.failAcquisition(params, error),
      );
      if (params.acquisition.cancelled) this.destroyAcquisition(params.acquisition);
      return handle;
    }, (error) => {
      this.failAcquisition(params, error);
      return undefined;
    });
  }

  private async failAcquisition(params: { acquisition: FleetAcquisition; requiredAssets: readonly ComfyAsset[]; activeUsers: number; desiredWorkers: number; retryDelayMs: number | null }, error: unknown): Promise<void> {
    if (params.acquisition.cancelled) return;
    if (params.acquisition.handle) {
      params.acquisition.cancelled = true;
      try {
        await this.deps.runtime.destroyAcquisition(params.acquisition.handle);
      } catch (cleanupError) {
        this.deps.events.error({ type: 'gpu_fleet_worker_destruction_failed', data: { workerId: params.acquisition.handle.contractId } }, cleanupError);
        return;
      }
    }
    this.acquisitions.delete(params.acquisition);
    this.deps.events.error({ type: 'gpu_fleet_worker_acquisition_failed', data: { activeUsers: params.activeUsers, desiredWorkers: params.desiredWorkers } }, error);
    if (params.retryDelayMs !== null && !this.stopped) {
      const retry: FleetAcquisition = { handle: null, cancelled: false, bootOrder: 0 };
      this.acquisitions.add(retry);
      void this.retryAcquisition(retry, params.requiredAssets, params.retryDelayMs);
      return;
    }
    this.reportCapacityUnavailable(error);
  }

  private destroyAcquisition(acquisition: FleetAcquisition): void {
    if (!acquisition.handle) {
      this.acquisitions.delete(acquisition);
      return;
    }
    void this.deps.runtime.destroyAcquisition(acquisition.handle).then(() => {
      this.acquisitions.delete(acquisition);
      void this.requestReconcile('acquisition_destroyed');
    }, (error) => {
      this.deps.events.error({ type: 'gpu_fleet_worker_destruction_failed', data: { workerId: acquisition.handle?.contractId } }, error);
    });
  }

  private async retryAcquisition(acquisition: FleetAcquisition, requiredAssets: readonly ComfyAsset[], delayMs: number): Promise<void> {
    if (delayMs > 0) await Bun.sleep(delayMs);
    if (this.stopped || acquisition.cancelled) {
      this.acquisitions.delete(acquisition);
      return;
    }
    const policy = this.deps.policy();
    const activeUsers = this.deps.demand.countActiveGenerationUsers();
    const desiredWorkers = this.desiredGpuWorkerCount(activeUsers, policy);
    const connectedWorkers = this.deps.runtime.connectedWorkerCount();
    const otherAcquisitions = [...this.acquisitions].filter((item) => item !== acquisition && !item.handle?.appReady).length;
    if (desiredWorkers <= connectedWorkers + otherAcquisitions) {
      this.acquisitions.delete(acquisition);
      return;
    }
    this.deps.events.log({ type: 'gpu_fleet_autoscaler_decision', data: { trigger: 'acquisition_retry', decision: 'acquire', reason: 'failed_acquisition', activeUsers, desiredWorkers, connectedWorkers, acquisitionCount: 1, acquiringWorkers: otherAcquisitions + 1 } });
    void this.startAcquisition({ acquisition, requiredAssets, activeUsers, desiredWorkers, retryDelayMs: null }, new Set());
  }

  private reportCapacityUnavailable(error: unknown): void {
    if (this.stopped || this.deps.runtime.connectedWorkerCount() > 0 || this.acquisitions.size > 0) return;
    this.deps.onCapacityUnavailable(error);
  }
}
