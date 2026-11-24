import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { settings } from '../settings';
import { retryWithBackoff } from '../utils';
import type { EventLog } from '../utils/event-log';
import { ComfyClient } from '../comfy/comfy-client';
import type { ComputeWorkerId } from '../utils/brands';
import { rm, mkdtemp, readFile } from 'node:fs/promises';
import { VastClient, type VastWorker } from './vast-client';
import { vastConfig, comfyWorkerConfig } from '../environment';
import { isComfyWorkerImageReference } from '../comfy/comfy-worker-images';
import { type ComfyAsset, comfyAssetFingerprint } from '../comfy/comfy-assets';
import { ComfyProvision, comfyAssetManifestB64 } from '../comfy/comfy-provision';
import type { ComputeWorkerRepository } from '../repositories/compute-worker-repository';
import type { ImageGenerator, ImageGenerationSubmission, ImageGenerationSubmitResult } from '../image-requests/image-generator';

type WorkerRuntime = {
  worker: VastWorker;
  client: ComfyClient;
  idleShutdownDue: boolean;
  cachedAssets: Set<string>;
  provision: ComfyProvision;
  computeWorkerId: ComputeWorkerId;
  promptReservations: Set<ImageGenerationSubmission>;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
};

type AcquiredWorker = { computeWorkerId: ComputeWorkerId; worker: VastWorker; shouldTryReuse: boolean };
type ReconciledWorker = { computeWorkerId: ComputeWorkerId; worker: VastWorker };
type ReservedWorker = { selectedWorker: ReconciledWorker; shouldTryReuse: boolean };
export type GpuAcquisition = { computeWorkerId: ComputeWorkerId; contractId: number; countryCode: string; appReady: boolean; booted: Promise<void>; ready: Promise<void> };
type AcquisitionState = { cancelled: boolean; rented: boolean; destruction: Promise<void> | undefined };

type WorkerTlsBundle = {
  caCert: string;
  keyB64: string;
  certB64: string;
  caCertB64: string;
};

type ReadyListener = () => void;
type FleetListener = () => void;

export class GpuRuntime implements ImageGenerator {
  private readonly vast: VastClient;
  private acquisitionSelection = Promise.resolve();
  private readonly readyListeners: ReadyListener[] = [];
  private readonly fleetListeners: FleetListener[] = [];
  private readonly runtimes = new Map<ComputeWorkerId, WorkerRuntime>();
  private readonly acquiringComputeWorkerIds = new Set<ComputeWorkerId>();
  private readonly acquisitions = new Map<ComputeWorkerId, AcquisitionState>();

  constructor(
    private readonly events: EventLog,
    blockedMachineIds: ReadonlySet<string>,
    private readonly computeWorkerRepo: ComputeWorkerRepository,
  ) {
    this.vast = new VastClient(events, blockedMachineIds);
  }

  disconnect(): void {
    for (const runtime of this.runtimes.values()) {
      clearTimeout(runtime.idleTimer);
      runtime.client.disconnect();
    }
    this.runtimes.clear();
    this.acquisitions.clear();
  }

  onReady(listener: ReadyListener): void {
    this.readyListeners.push(listener);
  }

  onFleetChanged(listener: FleetListener): void {
    this.fleetListeners.push(listener);
  }

  connectedWorkerCount(): number {
    return this.runtimes.size;
  }

  idleWorkerIds(): ComputeWorkerId[] {
    return [...this.runtimes.values()].filter((runtime) => runtime.idleShutdownDue && runtime.promptReservations.size === 0).map((runtime) => runtime.computeWorkerId);
  }

  async reconnect(): Promise<void> {
    if (this.runtimes.size > 0) return;
    const startedAt = Date.now();
    const workers = await this.reconcileWorkers();
    const reconnectableWorkers = this.findReconnectableWorkers(workers);
    if (reconnectableWorkers.length === 0) {
      this.events.log({ type: 'gpu_runtime_reconnect_skipped', durationMs: Date.now() - startedAt, data: { workerCount: workers.length } });
      return;
    }
    for (const acquiredWorker of reconnectableWorkers) {
      let runtime: WorkerRuntime | undefined;
      try {
        this.events.log({ type: 'gpu_runtime_reconnect_started', data: { workerId: acquiredWorker.worker.contractId } });
        runtime = await this.createWorkerRuntime(acquiredWorker);
        await runtime.client.connect();
        this.addRuntime(runtime);
        this.events.log({ type: 'gpu_runtime_reconnected', durationMs: Date.now() - startedAt, data: { workerId: runtime.worker.contractId, cachedAssetCount: runtime.cachedAssets.size } });
      } catch (error) {
        runtime?.client.disconnect();
        this.events.error({ type: 'gpu_runtime_reconnect_failed', durationMs: Date.now() - startedAt, data: { workerId: acquiredWorker.worker.contractId } }, error);
      }
    }
    if (this.runtimes.size > 0) this.emitReady();
  }

  async prepare(requiredAssets: readonly ComfyAsset[]): Promise<void> {
    const runtime = this.selectRuntime(requiredAssets, Number.POSITIVE_INFINITY);
    if (runtime) {
      await this.syncAssets(runtime, requiredAssets);
      return;
    }
    const acquisition = await this.acquire(requiredAssets, new Set());
    await acquisition.ready;
  }

  async acquire(requiredAssets: readonly ComfyAsset[], countriesAlreadyTried: ReadonlySet<string>): Promise<GpuAcquisition> {
    const startedAt = Date.now();
    let reservedWorker: ReservedWorker;
    try {
      reservedWorker = await this.reserveWorker(requiredAssets, countriesAlreadyTried);
    } catch (error) {
      this.events.error({ type: 'gpu_runtime_start_failed', durationMs: Date.now() - startedAt, data: {} }, error);
      throw error;
    }
    const booted = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<void>();
    const acquisition: GpuAcquisition = {
      appReady: false,
      ready: ready.promise,
      booted: booted.promise,
      contractId: reservedWorker.selectedWorker.worker.contractId,
      countryCode: reservedWorker.selectedWorker.worker.countryCode,
      computeWorkerId: reservedWorker.selectedWorker.computeWorkerId,
    };
    const state: AcquisitionState = { cancelled: false, rented: !reservedWorker.shouldTryReuse, destruction: undefined };
    this.acquisitions.set(acquisition.computeWorkerId, state);
    void (async () => {
      try {
        const acquiredWorker = await this.acquireReadyWorker(reservedWorker);
        if (state.cancelled) {
          ready.resolve();
          return;
        }
        booted.resolve();
        const sshStartedAt = Date.now();
        const [runtime] = await Promise.all([
          this.createWorkerRuntime(acquiredWorker),
          this.vast.waitForSsh(acquiredWorker.worker).then((attemptCount) => {
            this.events.log({ type: 'gpu_worker_ssh_ready', durationMs: Date.now() - sshStartedAt, data: { workerId: acquisition.contractId, attemptCount } });
          }),
        ]);
        if (state.cancelled) {
          ready.resolve();
          return;
        }
        await this.initializeWorkerRuntime(runtime, requiredAssets, acquiredWorker.shouldTryReuse);
        if (state.cancelled) {
          runtime.client.disconnect();
          ready.resolve();
          return;
        }
        this.acquisitions.delete(acquisition.computeWorkerId);
        acquisition.appReady = true;
        ready.resolve();
        this.addRuntime(runtime);
        this.events.log({ type: 'gpu_runtime_ready', durationMs: Date.now() - startedAt, data: { workerId: runtime.worker.contractId, cachedAssetCount: runtime.cachedAssets.size } });
        this.emitReady();
      } catch (error) {
        if (state.cancelled) {
          ready.resolve();
          return;
        }
        this.events.error({ type: 'gpu_runtime_start_failed', durationMs: Date.now() - startedAt, data: { workerId: acquisition.contractId } }, error);
        try {
          await this.destroyAcquisition(acquisition);
        } catch (cleanupError) {
          this.events.error({ type: 'gpu_worker_destruction_failed', data: { workerId: acquisition.contractId } }, cleanupError);
        }
        ready.reject(error);
      }
    })();
    return acquisition;
  }

  async destroyAcquisition(acquisition: GpuAcquisition): Promise<void> {
    const state = this.acquisitions.get(acquisition.computeWorkerId);
    if (!state) return;
    state.cancelled = true;
    if (!state.rented) {
      this.acquisitions.delete(acquisition.computeWorkerId);
      this.events.log({ type: 'gpu_worker_acquisition_released', data: { workerId: acquisition.contractId } });
      return;
    }
    state.destruction ??= this.vast.destroyWorker(acquisition.contractId).then(() => {
      this.computeWorkerRepo.markWorkerDestroyed(acquisition.computeWorkerId, Date.now());
      this.acquisitions.delete(acquisition.computeWorkerId);
      this.events.log({ type: 'gpu_worker_acquisition_destroyed', data: { workerId: acquisition.contractId } });
    }).finally(() => { state.destruction = undefined; });
    await state.destruction;
  }

  async destroyIdleWorker(computeWorkerId: ComputeWorkerId): Promise<void> {
    const runtime = this.runtimes.get(computeWorkerId);
    if (!runtime?.idleShutdownDue || runtime.promptReservations.size > 0) return;
    this.runtimes.delete(computeWorkerId);
    clearTimeout(runtime.idleTimer);
    try {
      await this.vast.destroyWorker(runtime.worker.contractId);
    } catch (error) {
      this.runtimes.set(computeWorkerId, runtime);
      this.resetIdleTimer(runtime);
      this.emitFleetChanged();
      throw error;
    }
    runtime.client.disconnect();
    this.computeWorkerRepo.markWorkerDestroyed(computeWorkerId, Date.now());
    this.events.log({ type: 'gpu_worker_destroyed', data: { workerId: runtime.worker.contractId } });
    this.emitFleetChanged();
  }

  async prefetch(requiredAssets: readonly ComfyAsset[]): Promise<void> {
    if (requiredAssets.length === 0) return;
    await Promise.all(
      [...this.runtimes.values()].map(async (runtime) => {
        try {
          await this.syncAssets(runtime, requiredAssets);
        } catch (error) {
          this.events.error({ type: 'gpu_asset_prefetch_failed', data: { workerId: runtime.worker.contractId } }, error);
        }
      }),
    );
  }

  async submit(submission: ImageGenerationSubmission): Promise<ImageGenerationSubmitResult> {
    const runtime = this.selectRuntime(submission.requiredAssets, settings.get().gpu.queueDepth);
    if (!runtime) return { kind: 'busy' };

    runtime.promptReservations.add(submission);
    this.resetIdleTimer(runtime);
    try {
      await this.syncAssets(runtime, submission.requiredAssets);
      const attempt = await runtime.client.submit(submission.workflow);
      const release = (): void => {
        this.releasePrompt(runtime, submission);
        this.emitReady();
      };
      void attempt.completion.then(release, release);
      return { kind: 'accepted', attempt };
    } catch (error) {
      this.releasePrompt(runtime, submission);
      this.emitReady();
      throw error;
    }
  }

  private async initializeWorkerRuntime(runtime: WorkerRuntime, requiredAssets: readonly ComfyAsset[], shouldTryReuse: boolean): Promise<void> {
    const { worker, client, provision } = runtime;
    if (shouldTryReuse) {
      try {
        this.events.log({ type: 'gpu_runtime_reuse_started', data: { workerId: worker.contractId } });
        await client.connect();
        await this.syncAssets(runtime, requiredAssets);
        this.events.log({ type: 'gpu_runtime_reused', data: { workerId: worker.contractId } });
        return;
      } catch (error) {
        client.disconnect();
        this.events.error({ type: 'gpu_runtime_reuse_failed', data: { workerId: worker.contractId } }, error);
      }
    }
    const provisionStartedAt = Date.now();
    this.events.log({ type: 'gpu_provision_started', data: { workerId: worker.contractId } });
    const bootstrap = async (): Promise<void> => {
      const startedAt = Date.now();
      await provision.bootstrap();
      this.events.log({ type: 'gpu_bootstrap_completed', durationMs: Date.now() - startedAt, data: { workerId: worker.contractId } });
    };
    const connected = bootstrap().then(() => client.connect());
    try {
      await Promise.all([connected, this.syncAssets(runtime, requiredAssets)]);
    } catch (error) {
      // Connection may still be opening when asset sync fails; close it after it settles.
      await connected.catch(() => undefined);
      client.disconnect();
      throw error;
    }
    this.events.log({ type: 'gpu_provision_completed', durationMs: Date.now() - provisionStartedAt, data: { workerId: worker.contractId } });
  }

  private async createWorkerRuntime({ computeWorkerId, worker }: AcquiredWorker): Promise<WorkerRuntime> {
    const cachedAssets = new Set(this.computeWorkerRepo.listAssetFingerprints(computeWorkerId));
    const tls = await this.generateWorkerTlsBundle(worker.https.host);
    const provision = new ComfyProvision({
      tls: { caCertB64: tls.caCertB64, certB64: tls.certB64, keyB64: tls.keyB64 },
      caddy: { port: vastConfig.runtimePort, authToken: comfyWorkerConfig.caddyAuthToken },
      ssh: {
        host: worker.ssh.host,
        port: worker.ssh.port,
        knownHostsPath: vastConfig.ssh.knownHostsPath,
        privateKeyPath: vastConfig.ssh.privateKeyPath,
        hostKeyAlias: `vast-instance-${String(worker.contractId)}`,
      },
    });
    const client = new ComfyClient({
      caCert: tls.caCert,
      workerHost: worker.https.host,
      workerPort: worker.https.port,
      bearerToken: comfyWorkerConfig.caddyAuthToken,
      onTransportLost: (error) => this.invalidateRuntime(runtime, error),
    });
    const runtime: WorkerRuntime = { computeWorkerId, worker, provision, client, cachedAssets, promptReservations: new Set(), idleShutdownDue: false, idleTimer: undefined };
    return runtime;
  }

  private findReconnectableWorkers(workers: readonly ReconciledWorker[]): AcquiredWorker[] {
    return workers.flatMap(({ computeWorkerId, worker }) => {
      if (worker.status !== 'running' || !worker.providerState.portsReady) return [];
      return isComfyWorkerImageReference(worker.imageReference) ? [{ computeWorkerId, worker, shouldTryReuse: true }] : [];
    });
  }

  private async reserveWorker(requiredAssets: readonly ComfyAsset[], countriesAlreadyTried: ReadonlySet<string>): Promise<ReservedWorker> {
    const previousSelection = this.acquisitionSelection;
    const nextSelection = Promise.withResolvers<void>();
    this.acquisitionSelection = nextSelection.promise;
    await previousSelection;
    try {
      const workers = await this.reconcileWorkers();
      const availableWorkers = workers.filter(({ computeWorkerId }) => !this.runtimes.has(computeWorkerId) && !this.acquisitions.has(computeWorkerId) && !this.acquiringComputeWorkerIds.has(computeWorkerId));
      const existingWorker = availableWorkers.find(({ worker }) => isComfyWorkerImageReference(worker.imageReference));
      const selectedWorker = existingWorker ?? (await this.rentWorker(requiredAssets, countriesAlreadyTried));
      this.acquiringComputeWorkerIds.add(selectedWorker.computeWorkerId);
      return { selectedWorker, shouldTryReuse: existingWorker !== undefined };
    } finally {
      nextSelection.resolve();
    }
  }

  private async acquireReadyWorker({ selectedWorker, shouldTryReuse }: ReservedWorker): Promise<AcquiredWorker> {
    const startedAt = Date.now();
    try {
      let { worker } = selectedWorker;
      const readyWorker = await retryWithBackoff({
        attempts: settings.get().gpu.readyAttempts,
        sleepMs: settings.get().gpu.readyPollIntervalMs,
        fn: async (attempt) => {
          switch (worker.status) {
            case 'running':
              this.events.log({ type: 'gpu_worker_ready', durationMs: Date.now() - startedAt, data: { attempt, workerId: worker.contractId } });
              return worker;
            case 'exited':
            case 'created':
            case 'loading':
            case 'rebooting':
              this.events.log({ type: 'gpu_worker_retry_scheduled', data: { attempt, workerId: worker.contractId, workerStatus: worker.status } });
              return;
            case 'stopped': {
              this.events.log({ type: 'gpu_worker_start_requested', data: { attempt, workerId: worker.contractId } });
              const state = await this.vast.startWorker(worker.contractId);
              if (state.kind === 'scheduling') {
                this.events.log({ type: 'gpu_worker_scheduling_detected', data: { attempt, workerId: worker.contractId } });
                throw new Error(`Vast worker ${String(worker.contractId)} could not be started because resources are unavailable`);
              }
              return;
            }
            case 'frozen':
            case 'offline':
            case 'unknown':
              throw new Error(`Vast worker ${String(worker.contractId)} is in an unexpected state: ${worker.status}`);
          }
          if (attempt > 1) worker = await this.vast.getWorker(worker.contractId);
          if (!isComfyWorkerImageReference(worker.imageReference)) throw new Error(`Vast worker ${String(worker.contractId)} has unexpected image: ${worker.imageReference}`);
          this.events.log({ type: 'gpu_worker_ready_attempt', data: { attempt, workerId: worker.contractId, workerStatus: worker.status, providerState: worker.providerState } });
        },
      });

      if (readyWorker === undefined) {
        this.events.log({ type: 'gpu_worker_ready_timeout', data: { workerId: worker.contractId } });
        throw new Error(`Vast worker ${String(worker.contractId)} is in an unexpected state: ${worker.status}`);
      }

      return { computeWorkerId: selectedWorker.computeWorkerId, worker: readyWorker, shouldTryReuse };
    } finally {
      this.acquiringComputeWorkerIds.delete(selectedWorker.computeWorkerId);
    }
  }

  private async reconcileWorkers(): Promise<ReconciledWorker[]> {
    const workers = await this.vast.listWorkers();
    const activeContractIds = new Set(workers.map((worker) => String(worker.contractId)));
    const reconciledAt = Date.now();
    for (const worker of this.computeWorkerRepo.listActiveWorkers('vast')) {
      if (!activeContractIds.has(worker.provider_worker_id)) this.computeWorkerRepo.markWorkerDestroyed(worker.id as ComputeWorkerId, reconciledAt);
    }
    return workers.map((worker) => ({
      worker,
      computeWorkerId:
        this.computeWorkerRepo.findActiveWorkerId('vast', String(worker.contractId)) ??
        this.computeWorkerRepo.saveWorker({ provider: 'vast', providerWorkerId: String(worker.contractId), providerMachineId: String(worker.machineId), imageReference: worker.imageReference, createdAt: reconciledAt }),
    }));
  }

  private async rentWorker(requiredAssets: readonly ComfyAsset[], countriesAlreadyTried: ReadonlySet<string>): Promise<ReconciledWorker> {
    return { computeWorkerId, worker };
    const worker = await this.vast.rentWorker({ assetManifestB64: await comfyAssetManifestB64(requiredAssets), countriesAlreadyTried });
    const computeWorkerId = this.computeWorkerRepo.saveWorker({ provider: 'vast', providerWorkerId: String(worker.contractId), providerMachineId: String(worker.machineId), imageReference: worker.imageReference, createdAt: Date.now() });
  }

  private addRuntime(runtime: WorkerRuntime): void {
    this.runtimes.set(runtime.computeWorkerId, runtime);
    this.resetIdleTimer(runtime);
    this.emitFleetChanged();
  }

  private resetIdleTimer(runtime: WorkerRuntime): void {
    clearTimeout(runtime.idleTimer);
    runtime.idleShutdownDue = false;
    runtime.idleTimer = this.createIdleTimer(runtime);
  }

  private createIdleTimer(runtime: WorkerRuntime): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      if (this.runtimes.get(runtime.computeWorkerId) !== runtime) return;
      if (runtime.promptReservations.size > 0) {
        this.resetIdleTimer(runtime);
        return;
      }
      runtime.idleShutdownDue = true;
      this.emitFleetChanged();
    }, settings.get().gpu.hibernateIdleMs);
  }

  private invalidateRuntime(runtime: WorkerRuntime, error: unknown): void {
    if (this.runtimes.get(runtime.computeWorkerId) !== runtime) return;
    this.runtimes.delete(runtime.computeWorkerId);
    clearTimeout(runtime.idleTimer);
    runtime.client.disconnect();
    this.events.error({ type: 'gpu_runtime_lost', data: { workerId: runtime.worker.contractId } }, error);
    this.emitFleetChanged();
  }

  private selectRuntime(requiredAssets: readonly ComfyAsset[], promptLimit: number): WorkerRuntime | undefined {
    const requiredFingerprints = requiredAssets.map(comfyAssetFingerprint);
    let selected: WorkerRuntime | undefined;
    let selectedHasAssets = false;
    for (const runtime of this.runtimes.values()) {
      if (runtime.promptReservations.size >= promptLimit) continue;
      const hasAssets = requiredFingerprints.every((fingerprint) => runtime.cachedAssets.has(fingerprint));
      if (!selected || (hasAssets && !selectedHasAssets) || (hasAssets === selectedHasAssets && runtime.promptReservations.size < selected.promptReservations.size)) {
        selected = runtime;
        selectedHasAssets = hasAssets;
      }
    }
    return selected;
  }

  private releasePrompt(runtime: WorkerRuntime, submission: ImageGenerationSubmission): void {
    if (!runtime.promptReservations.delete(submission)) return;
    if (this.runtimes.get(runtime.computeWorkerId) === runtime) this.resetIdleTimer(runtime);
  }

  private async syncAssets(runtime: WorkerRuntime, requiredAssets: readonly ComfyAsset[]): Promise<void> {
    const missingAssets = this.missingAssets(requiredAssets, runtime.cachedAssets);
    if (missingAssets.length === 0) return;
    this.events.log({ type: 'gpu_asset_sync_started', data: { workerId: runtime.worker.contractId, assetCount: missingAssets.length } });
    const startedAt = Date.now();
    const result = await runtime.provision.syncAssets(missingAssets);
    const syncedAt = Date.now();
    for (const asset of missingAssets) {
      const assetFingerprint = comfyAssetFingerprint(asset);
      runtime.cachedAssets.add(assetFingerprint);
      this.computeWorkerRepo.markAssetSynced({ computeWorkerId: runtime.computeWorkerId, assetFingerprint, syncedAt });
    }
    this.events.log({ type: 'gpu_asset_sync_completed', durationMs: syncedAt - startedAt, data: { workerId: runtime.worker.contractId, assetCount: missingAssets.length, ...result } });
  }

  private missingAssets(requiredAssets: readonly ComfyAsset[], cachedAssets: ReadonlySet<string>): ComfyAsset[] {
    const uniqueAssets = new Map(requiredAssets.map((asset) => [comfyAssetFingerprint(asset), asset]));
    return [...uniqueAssets].filter(([fingerprint]) => !cachedAssets.has(fingerprint)).map(([, asset]) => asset);
  }

  private emitReady(): void {
    for (const listener of this.readyListeners) listener();
  }

  private emitFleetChanged(): void {
    for (const listener of this.fleetListeners) listener();
  }

  private async generateWorkerTlsBundle(runtimeHost: string): Promise<WorkerTlsBundle> {
    const tempDir = await mkdtemp(join(tmpdir(), 'agent-runtime-gpu-tls-'));
    const keyPath = join(tempDir, 'worker.key');
    const csrPath = join(tempDir, 'worker.csr');
    const certPath = join(tempDir, 'worker.crt');
    const serialPath = join(tempDir, 'worker.srl');
    const subjectAltName = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(runtimeHost) ? `IP:127.0.0.1,DNS:localhost,IP:${runtimeHost}` : `IP:127.0.0.1,DNS:localhost,DNS:${runtimeHost}`;

    try {
      await this.openssl(['ecparam', '-genkey', '-name', 'prime256v1', '-out', keyPath]);
      await this.openssl(['req', '-new', '-key', keyPath, '-out', csrPath, '-subj', '/CN=runtime-worker', '-addext', `subjectAltName=${subjectAltName}`]);
      await this.openssl([
        'x509',
        '-req',
        '-in',
        csrPath,
        '-CA',
        comfyWorkerConfig.caCertPath,
        '-CAkey',
        comfyWorkerConfig.caKeyPath,
        '-CAserial',
        serialPath,
        '-CAcreateserial',
        '-out',
        certPath,
        '-days',
        '365',
        '-copy_extensions',
        'copy',
      ]);

      const [caCert, cert, key] = await Promise.all([readFile(comfyWorkerConfig.caCertPath), readFile(certPath), readFile(keyPath)]);
      return {
        keyB64: key.toString('base64'),
        caCert: caCert.toString('utf8'),
        certB64: cert.toString('base64'),
        caCertB64: caCert.toString('base64'),
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private async openssl(args: string[]): Promise<void> {
    const proc = Bun.spawn(['openssl', ...args], { stdout: 'pipe', stderr: 'pipe' });
    if (exitCode !== 0) throw new Error(`openssl ${args[0]} failed: ${stderr.trim()}`);
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  }
}
