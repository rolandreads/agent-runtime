import { Database } from 'bun:sqlite';
import { applySchema } from '../../db/db';
import type { VastWorker } from '../vast-client';
import type { EventLog } from '../../utils/event-log';
import type { ComputeWorkerId } from '../../utils/brands';
import { CheckpointAssets } from '../../image-assets/image-checkpoints';
import { COMFY_WORKER_IMAGE_REFERENCE } from '../../comfy/comfy-worker-images';
import { ComputeWorkerRepository } from '../../repositories/compute-worker-repository';
import { mock, test, expect, afterAll, describe, afterEach, beforeEach } from 'bun:test';
import { SWINIR_4X_ASSET, type ComfyAsset, comfyAssetFingerprint } from '../../comfy/comfy-assets';

mock.module('../../environment', () => ({
  r2GenerativeAssetsConfig: { bucket: 'test', accessKeyId: 'test', secretAccessKey: 'test' },
  comfyWorkerConfig: { huggingFaceToken: 'test', caddyAuthToken: 'test', caKeyPath: '/tmp/test-ca.key', caCertPath: '/tmp/test-ca.crt' },
  vastConfig: {
    apiKey: 'test',
    runtimePort: 8443,
    apiBaseUrl: 'https://example.com',
    egressRefreshSignalPath: '/tmp/test-egress',
    imagePullCredentials: { registry: 'docker.io', username: 'test', token: 'test' },
    ssh: { privateKeyPath: '/tmp/test-key', knownHostsPath: '/tmp/test-known-hosts' },
  },
}));

const [{ GpuRuntime }, { ComfyProvision }] = await Promise.all([import('../gpu-runtime'), import('../../comfy/comfy-provision')]);
const originalWebSocket = globalThis.WebSocket;
const originalFetch = globalThis.fetch;
const originalBootstrap = ComfyProvision.prototype.bootstrap;
const originalSyncAssets = ComfyProvision.prototype.syncAssets;

class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static readonly sockets: FakeWebSocket[] = [];
  readyState = 0;
  readonly url: string;

  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.sockets.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event('open'));
    });
  }

  close(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }

  lose(): void {
    this.close();
  }

  sendMessage(message: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
  }

  static forHost(host: string): FakeWebSocket {
    const socket = FakeWebSocket.sockets.find(({ url }) => url.includes(`//${host}:`));
    if (!socket) throw new Error(`No websocket for ${host}`);
    return socket;
  }
}

class FailingWebSocket extends EventTarget {
  static readonly OPEN = 1;
  readyState = 0;

  constructor() {
    super();
    queueMicrotask(() => this.dispatchEvent(new Event('error')));
  }

  close(): void {
    this.readyState = 3;
  }
}

const makeWorker = (contractId: number): VastWorker => ({
  contractId,
  countryCode: 'US',
  status: 'running',
  machineId: contractId + 1_000,
  ssh: { host: '127.0.0.1', port: 10022 },
  imageReference: COMFY_WORKER_IMAGE_REFERENCE,
  https: { host: `worker-${String(contractId)}.test`, port: 18443 },
  providerState: { actualStatus: 'running', currentState: 'running', intendedState: 'running', statusMessage: 'running', portsReady: true },
  costs: { hourlyUsd: 0.8, gpuHourlyUsd: 0.7, uploadPerGbUsd: 0.004, storageHourlyUsd: 0.01, downloadPerGbUsd: 0.002, storagePerGbMonthUsd: 0.2 },
});

describe('GpuRuntime compute worker persistence', () => {
  let db: Database;
  let workers: ComputeWorkerRepository;
  let runtime: InstanceType<typeof GpuRuntime>;
  let bootstrap: ReturnType<typeof mock>;
  let syncAssets: ReturnType<typeof mock>;

  const installRuntime = (vast: unknown, events: EventLog = { log: mock(() => {}), error: mock(() => {}) } as unknown as EventLog): void => {
    runtime = new GpuRuntime(events, new Set(), workers);
    (runtime as unknown as { vast: unknown }).vast = vast;
    (runtime as unknown as { generateWorkerTlsBundle: () => Promise<{ caCert: string; keyB64: string; certB64: string; caCertB64: string }> }).generateWorkerTlsBundle = async () => ({
      caCert: 'test',
      keyB64: 'test',
      certB64: 'test',
      caCertB64: 'test',
    });
  };

  type RuntimeWorker = { computeWorkerId: ComputeWorkerId; worker: VastWorker; promptReservations: Set<unknown>; idleShutdownDue: boolean };
  const listRuntimeWorkers = (): RuntimeWorker[] => [...(runtime as unknown as { runtimes: Map<number, RuntimeWorker> }).runtimes.values()];
  const destroyIfIdle = async (worker: RuntimeWorker): Promise<void> => {
    worker.idleShutdownDue = true;
    await runtime.destroyIdleWorker(worker.computeWorkerId);
  };
  const acquireRuntime = async (requiredAssets: readonly ComfyAsset[]): Promise<void> => {
    const acquisition = await runtime.acquire(requiredAssets, new Set());
    await acquisition.ready;
  };
  const installPromptFetch = (): string[] => {
    const submittedHosts: string[] = [];
    let promptNumber = 0;
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      submittedHosts.push(url.hostname);
      promptNumber += 1;
      return Response.json({ prompt_id: `prompt-${String(promptNumber)}` });
    }) as unknown as typeof fetch;
    return submittedHosts;
  };

  beforeEach(() => {
    db = new Database(':memory:', { strict: true });
    db.run('PRAGMA foreign_keys = ON');
    applySchema(db);
    workers = new ComputeWorkerRepository(db);
    bootstrap = mock(async () => undefined);
    syncAssets = mock(async () => ({ objectCount: 1, skippedCount: 0, downloadedBytes: SWINIR_4X_ASSET.sizeBytes }));
    ComfyProvision.prototype.bootstrap = bootstrap;
    ComfyProvision.prototype.syncAssets = syncAssets;
    FakeWebSocket.sockets.length = 0;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    runtime?.disconnect();
    globalThis.fetch = originalFetch;
    db.close();
  });

  afterAll(() => {
    globalThis.WebSocket = originalWebSocket;
    ComfyProvision.prototype.bootstrap = originalBootstrap;
    ComfyProvision.prototype.syncAssets = originalSyncAssets;
  });

  test('reuses the active worker record and its persisted assets', async () => {
    const worker = makeWorker(101);
    const computeWorkerId = workers.saveWorker({ provider: 'vast', providerWorkerId: String(worker.contractId), providerMachineId: String(worker.machineId), imageReference: worker.imageReference, createdAt: 1_000 });
    workers.markAssetSynced({ computeWorkerId, assetFingerprint: comfyAssetFingerprint(CheckpointAssets.checkpoint_b.comfyAsset), syncedAt: 2_000 });
    workers.markAssetSynced({ computeWorkerId, assetFingerprint: comfyAssetFingerprint(SWINIR_4X_ASSET), syncedAt: 2_000 });
    const vast = {
      waitForSsh: mock(async () => 1),
      getWorker: mock(async () => worker),
      rentWorker: mock(async () => worker),
      listWorkers: mock(async () => [worker]),
      destroyWorker: mock(async () => undefined),
      startWorker: mock(async () => ({ kind: 'started' as const })),
    };
    runtime = new GpuRuntime({ log: mock(() => {}), error: mock(() => {}) } as unknown as EventLog, new Set(), workers);
    (runtime as unknown as { vast: typeof vast }).vast = vast;
    (runtime as unknown as { generateWorkerTlsBundle: () => Promise<{ caCert: string; keyB64: string; certB64: string; caCertB64: string }> }).generateWorkerTlsBundle = async () => ({
      caCert: 'test',
      keyB64: 'test',
      certB64: 'test',
      caCertB64: 'test',
    });

    await acquireRuntime([CheckpointAssets.checkpoint_b.comfyAsset, SWINIR_4X_ASSET]);

    expect(workers.listActiveWorkers('vast')).toHaveLength(1);
    expect(vast.rentWorker).not.toHaveBeenCalled();
    expect(syncAssets).not.toHaveBeenCalled();
  });

  test('reconnects a healthy worker at startup and restores its persisted assets', async () => {
    const worker = makeWorker(111);
    const computeWorkerId = workers.saveWorker({ provider: 'vast', providerWorkerId: String(worker.contractId), providerMachineId: String(worker.machineId), imageReference: worker.imageReference, createdAt: 1_000 });
    workers.markAssetSynced({ computeWorkerId, assetFingerprint: comfyAssetFingerprint(CheckpointAssets.checkpoint_b.comfyAsset), syncedAt: 2_000 });
    workers.markAssetSynced({ computeWorkerId, assetFingerprint: comfyAssetFingerprint(SWINIR_4X_ASSET), syncedAt: 2_000 });
    const vast = {
      waitForSsh: mock(async () => 1),
      getWorker: mock(async () => worker),
      rentWorker: mock(async () => worker),
      listWorkers: mock(async () => [worker]),
      destroyWorker: mock(async () => undefined),
      startWorker: mock(async () => ({ kind: 'started' as const })),
    };
    installRuntime(vast);

    await runtime.reconnect();
    await runtime.reconnect();
    await runtime.prepare([CheckpointAssets.checkpoint_b.comfyAsset, SWINIR_4X_ASSET]);

    expect(vast.listWorkers).toHaveBeenCalledTimes(1);
    expect(vast.rentWorker).not.toHaveBeenCalled();
    expect(vast.startWorker).not.toHaveBeenCalled();
    expect(vast.destroyWorker).not.toHaveBeenCalled();
    expect(vast.waitForSsh).not.toHaveBeenCalled();
    expect(bootstrap).not.toHaveBeenCalled();
    expect(syncAssets).not.toHaveBeenCalled();
  });

  test('does not acquire a worker during startup when none exist', async () => {
    const vast = {
      waitForSsh: mock(async () => 1),
      listWorkers: mock(async () => []),
      destroyWorker: mock(async () => undefined),
      getWorker: mock(async () => makeWorker(404)),
      rentWorker: mock(async () => makeWorker(404)),
      startWorker: mock(async () => ({ kind: 'started' as const })),
    };
    const events = { log: mock(() => {}), error: mock(() => {}) };
    installRuntime(vast, events as unknown as EventLog);

    await runtime.reconnect();

    expect(events.log).toHaveBeenCalledWith(expect.objectContaining({ type: 'gpu_runtime_reconnect_skipped' }));
    expect(events.error).not.toHaveBeenCalled();
    expect(vast.rentWorker).not.toHaveBeenCalled();
    expect(vast.startWorker).not.toHaveBeenCalled();
    expect(vast.destroyWorker).not.toHaveBeenCalled();
    expect(vast.waitForSsh).not.toHaveBeenCalled();
    expect(bootstrap).not.toHaveBeenCalled();
    expect(syncAssets).not.toHaveBeenCalled();
  });

  test('does not acquire a worker for prefetch when no runtime is connected', async () => {
    const vast = {
      waitForSsh: mock(async () => 1),
      listWorkers: mock(async () => []),
      destroyWorker: mock(async () => undefined),
      getWorker: mock(async () => makeWorker(405)),
      rentWorker: mock(async () => makeWorker(405)),
      startWorker: mock(async () => ({ kind: 'started' as const })),
    };
    installRuntime(vast);

    await runtime.prefetch([SWINIR_4X_ASSET]);

    expect(vast.listWorkers).not.toHaveBeenCalled();
    expect(vast.rentWorker).not.toHaveBeenCalled();
    expect(syncAssets).not.toHaveBeenCalled();
  });

  test('returns busy instead of implicitly renting when no runtime is connected', async () => {
    const vast = {
      waitForSsh: mock(async () => 1),
      listWorkers: mock(async () => []),
      destroyWorker: mock(async () => undefined),
      getWorker: mock(async () => makeWorker(406)),
      rentWorker: mock(async () => makeWorker(406)),
      startWorker: mock(async () => ({ kind: 'started' as const })),
    };
    installRuntime(vast);

    const result = await runtime.submit({ workflow: {}, requiredAssets: [CheckpointAssets.checkpoint_b.comfyAsset] });

    expect(result).toEqual({ kind: 'busy' });
    expect(vast.listWorkers).not.toHaveBeenCalled();
    expect(vast.rentWorker).not.toHaveBeenCalled();
  });

  test('does not start a stopped worker during startup', async () => {
    const worker: VastWorker = { ...makeWorker(222), status: 'stopped', providerState: { actualStatus: 'stopped', currentState: 'stopped', intendedState: 'stopped', statusMessage: 'stopped', portsReady: true } };
    const vast = {
      waitForSsh: mock(async () => 1),
      getWorker: mock(async () => worker),
      rentWorker: mock(async () => worker),
      listWorkers: mock(async () => [worker]),
      destroyWorker: mock(async () => undefined),
      startWorker: mock(async () => ({ kind: 'started' as const })),
    };
    const events = { log: mock(() => {}), error: mock(() => {}) };
    installRuntime(vast, events as unknown as EventLog);

    await runtime.reconnect();

    expect(events.log).toHaveBeenCalledWith(expect.objectContaining({ type: 'gpu_runtime_reconnect_skipped' }));
    expect(events.error).not.toHaveBeenCalled();
    expect(vast.rentWorker).not.toHaveBeenCalled();
    expect(vast.startWorker).not.toHaveBeenCalled();
    expect(vast.destroyWorker).not.toHaveBeenCalled();
    expect(vast.waitForSsh).not.toHaveBeenCalled();
    expect(bootstrap).not.toHaveBeenCalled();
  });

  test('leaves the runtime cold when startup reconnection fails', async () => {
    const worker = makeWorker(333);
    const vast = {
      waitForSsh: mock(async () => 1),
      getWorker: mock(async () => worker),
      rentWorker: mock(async () => worker),
      listWorkers: mock(async () => [worker]),
      destroyWorker: mock(async () => undefined),
      startWorker: mock(async () => ({ kind: 'started' as const })),
    };
    const reconnectFailed = mock(() => {});
    installRuntime(vast, { log: mock(() => {}), error: reconnectFailed } as unknown as EventLog);
    globalThis.WebSocket = FailingWebSocket as unknown as typeof WebSocket;

    await runtime.reconnect();

    expect(reconnectFailed).toHaveBeenCalledWith(expect.objectContaining({ type: 'gpu_runtime_reconnect_failed' }), expect.any(Error));
    expect(vast.rentWorker).not.toHaveBeenCalled();
    expect(vast.startWorker).not.toHaveBeenCalled();
    expect(vast.destroyWorker).not.toHaveBeenCalled();
    expect(bootstrap).not.toHaveBeenCalled();

    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    await acquireRuntime([CheckpointAssets.checkpoint_b.comfyAsset]);

    expect(vast.listWorkers).toHaveBeenCalledTimes(2);
    expect(vast.waitForSsh).toHaveBeenCalledTimes(1);
    expect(vast.rentWorker).not.toHaveBeenCalled();
    expect(bootstrap).not.toHaveBeenCalled();
  });

  test('persists a rental, successful asset sync, and provider-confirmed destruction', async () => {
    const worker = makeWorker(202);
    const vast = {
      waitForSsh: mock(async () => 1),
      listWorkers: mock(async () => []),
      getWorker: mock(async () => worker),
      rentWorker: mock(async () => worker),
      destroyWorker: mock(async () => undefined),
      startWorker: mock(async () => ({ kind: 'started' as const })),
    };
    runtime = new GpuRuntime({ log: mock(() => {}), error: mock(() => {}) } as unknown as EventLog, new Set(), workers);
    (runtime as unknown as { vast: typeof vast }).vast = vast;
    (runtime as unknown as { generateWorkerTlsBundle: () => Promise<{ caCert: string; keyB64: string; certB64: string; caCertB64: string }> }).generateWorkerTlsBundle = async () => ({
      caCert: 'test',
      keyB64: 'test',
      certB64: 'test',
      caCertB64: 'test',
    });

    await acquireRuntime([CheckpointAssets.checkpoint_b.comfyAsset, SWINIR_4X_ASSET]);

    const [savedWorker] = workers.listActiveWorkers('vast');
    expect(savedWorker?.provider_worker_id).toBe(String(worker.contractId));
    const computeWorkerId = workers.findActiveWorkerId('vast', String(worker.contractId));
    if (!computeWorkerId) throw new Error('Compute worker was not persisted');
    expect(workers.listAssetFingerprints(computeWorkerId)).toEqual([comfyAssetFingerprint(CheckpointAssets.checkpoint_b.comfyAsset), comfyAssetFingerprint(SWINIR_4X_ASSET)]);

    const [runtimeWorker] = listRuntimeWorkers();
    if (!runtimeWorker) throw new Error('Worker runtime was not created');
    await destroyIfIdle(runtimeWorker);

    expect(vast.destroyWorker).toHaveBeenCalledWith(worker.contractId);
    expect(workers.listActiveWorkers('vast')).toEqual([]);
  });

  test.each(['cancelled', 'failed'] as const)('preserves the rental and cached assets when recovery is %s after transport loss', async (outcome) => {
    const worker = makeWorker(204);
    const sshReady = Promise.withResolvers<number>();
    const vast = {
      rentWorker: mock(async () => worker),
      listWorkers: mock(async () => [worker]),
      waitForSsh: mock(() => sshReady.promise),
      destroyWorker: mock(async () => undefined),
    };
    installRuntime(vast);
    await runtime.reconnect();
    const computeWorkerId = listRuntimeWorkers()[0]!.computeWorkerId;
    const asset = CheckpointAssets.checkpoint_b.comfyAsset;
    workers.markAssetSynced({ computeWorkerId, assetFingerprint: comfyAssetFingerprint(asset), syncedAt: 2_000 });
    FakeWebSocket.forHost(worker.https.host).lose();
    const recovery = await runtime.acquire([asset], new Set());
    await recovery.booted;
    if (outcome === 'cancelled') {
      await runtime.destroyAcquisition(recovery);
      sshReady.resolve(1);
      await recovery.ready;
    } else {
      sshReady.reject(new Error('SSH temporarily unavailable'));
      await expect(recovery.ready).rejects.toThrow('SSH temporarily unavailable');
    }
    expect(vast.destroyWorker).not.toHaveBeenCalled();
    expect(vast.rentWorker).not.toHaveBeenCalled();
    expect(workers.findActiveWorkerId('vast', String(worker.contractId))).toBe(computeWorkerId);
    expect(workers.listAssetFingerprints(computeWorkerId)).toContain(comfyAssetFingerprint(asset));
    vast.waitForSsh.mockImplementation(async () => 1);
    await acquireRuntime([asset]);
    expect(runtime.connectedWorkerCount()).toBe(1);
    expect(syncAssets).not.toHaveBeenCalled();
  });

  test('destroys a newly rented acquisition before it becomes app-ready', async () => {
    const worker = makeWorker(203);
    const sshReady = Promise.withResolvers<number>();
    const vast = {
      listWorkers: mock(async () => []),
      getWorker: mock(async () => worker),
      rentWorker: mock(async () => worker),
      waitForSsh: mock(() => sshReady.promise),
      destroyWorker: mock(async () => undefined),
      startWorker: mock(async () => ({ kind: 'started' as const })),
    };
    installRuntime(vast);

    const acquisition = await runtime.acquire([CheckpointAssets.checkpoint_b.comfyAsset], new Set());
    await acquisition.booted;
    expect(bootstrap).not.toHaveBeenCalled();
    expect(syncAssets).not.toHaveBeenCalled();
    await runtime.destroyAcquisition(acquisition);
    sshReady.resolve(1);
    await acquisition.ready;

    expect(vast.destroyWorker).toHaveBeenCalledWith(worker.contractId);
    expect(workers.listActiveWorkers('vast')).toEqual([]);
    expect(runtime.connectedWorkerCount()).toBe(0);
  });

  test('overlaps TLS with SSH readiness and websocket connection with asset sync', async () => {
    const worker = makeWorker(206);
    const sshReady = Promise.withResolvers<number>();
    const tlsStarted = Promise.withResolvers<void>();
    const assetsReady = Promise.withResolvers<void>();
    const socketOpened = Promise.withResolvers<void>();
    const vast = {
      listWorkers: mock(async () => []),
      rentWorker: mock(async () => worker),
      waitForSsh: mock(() => sshReady.promise),
      destroyWorker: mock(async () => undefined),
    };
    installRuntime(vast);
    const tlsRuntime = runtime as unknown as { generateWorkerTlsBundle: () => Promise<{ caCert: string; keyB64: string; certB64: string; caCertB64: string }> };
    const generateTls = tlsRuntime.generateWorkerTlsBundle;
    tlsRuntime.generateWorkerTlsBundle = () => { tlsStarted.resolve(); return generateTls(); };
    globalThis.WebSocket = class extends FakeWebSocket {
      constructor(url: string) {
        super(url);
        this.addEventListener('open', () => socketOpened.resolve());
      }
    } as unknown as typeof WebSocket;
    syncAssets.mockImplementation(async () => {
      await assetsReady.promise;
      return { objectCount: 1, skippedCount: 0, downloadedBytes: SWINIR_4X_ASSET.sizeBytes };
    });

    const acquisition = await runtime.acquire([SWINIR_4X_ASSET], new Set());
    await tlsStarted.promise;
    expect(vast.waitForSsh).toHaveBeenCalled();
    expect(bootstrap).not.toHaveBeenCalled();
    sshReady.resolve(1);
    await socketOpened.promise;
    expect(syncAssets).toHaveBeenCalled();
    expect(acquisition.appReady).toBeFalse();
    expect(runtime.connectedWorkerCount()).toBe(0);
    assetsReady.resolve();
    await acquisition.ready;
    expect(acquisition.appReady).toBeTrue();
    expect(runtime.connectedWorkerCount()).toBe(1);
  });

  test.each(['before', 'after'] as const)('closes the websocket when asset sync fails %s connection', async (timing) => {
    const worker = makeWorker(207);
    const bootstrapReady = Promise.withResolvers<void>();
    const socketOpened = Promise.withResolvers<void>();
    const vast = {
      waitForSsh: mock(async () => 1),
      listWorkers: mock(async () => []),
      rentWorker: mock(async () => worker),
      destroyWorker: mock(async () => undefined),
    };
    installRuntime(vast);
    bootstrap.mockImplementation(() => bootstrapReady.promise);
    globalThis.WebSocket = class extends FakeWebSocket {
      constructor(url: string) {
        super(url);
        this.addEventListener('open', () => socketOpened.resolve());
      }
    } as unknown as typeof WebSocket;
    syncAssets.mockImplementation(async () => {
      bootstrapReady.resolve();
      if (timing === 'after') await socketOpened.promise;
      throw new Error('asset sync failed');
    });

    const acquisition = await runtime.acquire([SWINIR_4X_ASSET], new Set());
    await expect(acquisition.ready).rejects.toThrow('asset sync failed');
    expect(FakeWebSocket.forHost(worker.https.host).readyState).toBe(3);
    expect(vast.destroyWorker).toHaveBeenCalledWith(worker.contractId);
    expect(workers.listActiveWorkers('vast')).toEqual([]);
    expect(runtime.connectedWorkerCount()).toBe(0);
  });

  test.each(['boot', 'ssh', 'tls', 'bootstrap', 'connect', 'assets'] as const)('destroys a failed %s acquisition before releasing its rental record', async (stage) => {
    const worker = makeWorker(204);
    if (stage === 'boot') worker.status = 'unknown';
    const vast = {
      listWorkers: mock(async () => []),
      rentWorker: mock(async () => worker),
      destroyWorker: mock(async () => undefined),
      waitForSsh: mock(async () => { if (stage === 'ssh') throw new Error('SSH failed'); return 1; }),
    };
    if (stage === 'assets') syncAssets.mockImplementation(async () => { throw new Error('asset sync failed'); });
    installRuntime(vast);
    if (stage === 'tls') (runtime as unknown as { generateWorkerTlsBundle: () => Promise<never> }).generateWorkerTlsBundle = async () => { throw new Error('TLS failed'); };
    if (stage === 'bootstrap') bootstrap.mockImplementation(async () => { throw new Error('bootstrap failed'); });
    if (stage === 'connect') globalThis.WebSocket = FailingWebSocket as unknown as typeof WebSocket;

    const acquisition = await runtime.acquire([CheckpointAssets.checkpoint_b.comfyAsset], new Set());
    await expect(acquisition.ready).rejects.toThrow();

    expect(vast.destroyWorker).toHaveBeenCalledWith(worker.contractId);
    expect(workers.listActiveWorkers('vast')).toEqual([]);
    expect(runtime.connectedWorkerCount()).toBe(0);
  });

  test('keeps a failed acquisition owned when deletion fails and permits cleanup to retry', async () => {
    const worker = makeWorker(205);
    const vast = {
      listWorkers: mock(async () => []),
      rentWorker: mock(async () => worker),
      waitForSsh: mock(async () => { throw new Error('SSH failed'); }),
      destroyWorker: mock(async () => undefined).mockRejectedValueOnce(new Error('provider unavailable')),
    };
    installRuntime(vast);

    const acquisition = await runtime.acquire([], new Set());
    await expect(acquisition.ready).rejects.toThrow('SSH failed');
    expect(workers.listActiveWorkers('vast')).toHaveLength(1);
    await runtime.destroyAcquisition(acquisition);

    expect(vast.destroyWorker).toHaveBeenCalledTimes(2);
    expect(workers.listActiveWorkers('vast')).toEqual([]);
  });

  test('reconciles provider workers before selection', async () => {
    const staleWorkerId = workers.saveWorker({ provider: 'vast', providerWorkerId: 'stale', providerMachineId: 'stale', imageReference: 'stale', createdAt: 1_000 });
    const worker = makeWorker(303);
    const vast = {
      waitForSsh: mock(async () => 1),
      getWorker: mock(async () => worker),
      rentWorker: mock(async () => worker),
      listWorkers: mock(async () => [worker]),
      destroyWorker: mock(async () => undefined),
      startWorker: mock(async () => ({ kind: 'started' as const })),
    };
    runtime = new GpuRuntime({ log: mock(() => {}), error: mock(() => {}) } as unknown as EventLog, new Set(), workers);
    (runtime as unknown as { vast: typeof vast }).vast = vast;
    (runtime as unknown as { generateWorkerTlsBundle: () => Promise<{ caCert: string; keyB64: string; certB64: string; caCertB64: string }> }).generateWorkerTlsBundle = async () => ({
      caCert: 'test',
      keyB64: 'test',
      certB64: 'test',
      caCertB64: 'test',
    });

    await acquireRuntime([CheckpointAssets.checkpoint_b.comfyAsset]);

    expect(workers.listActiveWorkers('vast').map((row) => row.provider_worker_id)).toEqual([String(worker.contractId)]);
    const staleWorker = db.query<{ destroyed_at: number | null }, [number]>('SELECT destroyed_at FROM compute_workers WHERE id = ?').get(staleWorkerId);
    if (!staleWorker) throw new Error('Stale compute worker was not retained');
    expect(staleWorker.destroyed_at).not.toBeNull();
    expect(vast.rentWorker).not.toHaveBeenCalled();
  });

  test('adopts a discovered worker that was not reconnectable at startup', async () => {
    const readyWorker = makeWorker(3031);
    const discoveredWorker = { ...readyWorker, providerState: { ...readyWorker.providerState, portsReady: false } };
    const vast = {
      waitForSsh: mock(async () => 1),
      getWorker: mock(async () => readyWorker),
      destroyWorker: mock(async () => undefined),
      rentWorker: mock(async () => makeWorker(3032)),
      listWorkers: mock(async () => [discoveredWorker]),
      startWorker: mock(async () => ({ kind: 'started' as const })),
    };
    installRuntime(vast);

    await runtime.reconnect();
    await acquireRuntime([CheckpointAssets.checkpoint_b.comfyAsset]);

    expect(vast.listWorkers).toHaveBeenCalledTimes(2);
    expect(vast.rentWorker).not.toHaveBeenCalled();
    expect(runtime.connectedWorkerCount()).toBe(1);
  });

  test('reserves distinct discovered workers during concurrent acquisitions', async () => {
    const firstWorker = makeWorker(304);
    const secondWorker = makeWorker(305);
    const vast = {
      waitForSsh: mock(async () => 1),
      destroyWorker: mock(async () => undefined),
      rentWorker: mock(async () => makeWorker(306)),
      listWorkers: mock(async () => [firstWorker, secondWorker]),
      startWorker: mock(async () => ({ kind: 'started' as const })),
      getWorker: mock(async (workerId: number) => (workerId === firstWorker.contractId ? firstWorker : secondWorker)),
    };
    installRuntime(vast);

    await Promise.all([acquireRuntime([CheckpointAssets.checkpoint_b.comfyAsset]), acquireRuntime([CheckpointAssets.checkpoint_b.comfyAsset])]);

    expect(
      listRuntimeWorkers()
        .map(({ worker }) => worker.contractId)
        .toSorted(),
    ).toEqual([firstWorker.contractId, secondWorker.contractId]);
    expect(vast.rentWorker).not.toHaveBeenCalled();
  });

  test('reconnects all workers and fills their one-ahead queues by least load', async () => {
    const firstWorker = makeWorker(401);
    const secondWorker = makeWorker(402);
    const vast = {
      waitForSsh: mock(async () => 1),
      getWorker: mock(async () => firstWorker),
      rentWorker: mock(async () => firstWorker),
      destroyWorker: mock(async () => undefined),
      listWorkers: mock(async () => [firstWorker, secondWorker]),
      startWorker: mock(async () => ({ kind: 'started' as const })),
    };
    installRuntime(vast);
    await runtime.reconnect();
    const submittedHosts = installPromptFetch();
    const first = await runtime.submit({ workflow: {}, requiredAssets: [] });
    expect(first.kind).toBe('accepted');
    if (first.kind !== 'accepted') throw new Error('expected accepted');
    expect((await runtime.submit({ workflow: {}, requiredAssets: [] })).kind).toBe('accepted');
    expect((await runtime.submit({ workflow: {}, requiredAssets: [] })).kind).toBe('accepted');
    expect((await runtime.submit({ workflow: {}, requiredAssets: [] })).kind).toBe('accepted');
    expect(await runtime.submit({ workflow: {}, requiredAssets: [] })).toEqual({ kind: 'busy' });
    expect(submittedHosts).toEqual([firstWorker.https.host, secondWorker.https.host, firstWorker.https.host, secondWorker.https.host]);

    FakeWebSocket.forHost(firstWorker.https.host).sendMessage({ type: 'execution_success', data: { prompt_id: 'prompt-1' } });
    await first.attempt.completion;
    expect((await runtime.submit({ workflow: {}, requiredAssets: [] })).kind).toBe('accepted');
    expect(submittedHosts.at(-1)).toBe(firstWorker.https.host);
    expect(vast.rentWorker).not.toHaveBeenCalled();
  });

  test('prioritizes a worker with completed assets until its prompt queue is full', async () => {
    const firstWorker = makeWorker(403);
    const secondWorker = makeWorker(404);
    workers.saveWorker({ provider: 'vast', providerWorkerId: String(firstWorker.contractId), providerMachineId: String(firstWorker.machineId), imageReference: firstWorker.imageReference, createdAt: 1_000 });
    const secondWorkerId = workers.saveWorker({ provider: 'vast', providerWorkerId: String(secondWorker.contractId), providerMachineId: String(secondWorker.machineId), imageReference: secondWorker.imageReference, createdAt: 1_000 });
    workers.markAssetSynced({ computeWorkerId: secondWorkerId, assetFingerprint: comfyAssetFingerprint(SWINIR_4X_ASSET), syncedAt: 2_000 });
    const vast = {
      waitForSsh: mock(async () => 1),
      getWorker: mock(async () => firstWorker),
      rentWorker: mock(async () => firstWorker),
      destroyWorker: mock(async () => undefined),
      listWorkers: mock(async () => [firstWorker, secondWorker]),
      startWorker: mock(async () => ({ kind: 'started' as const })),
    };
    installRuntime(vast);
    await runtime.reconnect();
    const submittedHosts = installPromptFetch();
    const submission = () => ({ workflow: {}, requiredAssets: [SWINIR_4X_ASSET] });

    expect((await runtime.submit(submission())).kind).toBe('accepted');
    expect((await runtime.submit(submission())).kind).toBe('accepted');
    expect((await runtime.submit(submission())).kind).toBe('accepted');

    expect(submittedHosts).toEqual([secondWorker.https.host, secondWorker.https.host, firstWorker.https.host]);
    expect(syncAssets).toHaveBeenCalledTimes(1);
  });

  test('broadcasts prefetch to every worker and skips assets already synced', async () => {
    const firstWorker = makeWorker(451);
    const secondWorker = makeWorker(452);
    const vast = {
      waitForSsh: mock(async () => 1),
      getWorker: mock(async () => firstWorker),
      rentWorker: mock(async () => firstWorker),
      destroyWorker: mock(async () => undefined),
      listWorkers: mock(async () => [firstWorker, secondWorker]),
      startWorker: mock(async () => ({ kind: 'started' as const })),
    };
    installRuntime(vast);
    await runtime.reconnect();

    await runtime.prefetch([SWINIR_4X_ASSET]);
    await runtime.prefetch([SWINIR_4X_ASSET]);

    expect(syncAssets).toHaveBeenCalledTimes(2);
    expect(syncAssets.mock.calls.every(([assets]) => (assets as unknown[]).length === 1)).toBeTrue();
    expect(vast.rentWorker).not.toHaveBeenCalled();
  });

  test('allows idle destruction during idempotent duplicate prefetch', async () => {
    const worker = makeWorker(453);
    const vast = {
      waitForSsh: mock(async () => 1),
      getWorker: mock(async () => worker),
      rentWorker: mock(async () => worker),
      listWorkers: mock(async () => [worker]),
      destroyWorker: mock(async () => undefined),
      startWorker: mock(async () => ({ kind: 'started' as const })),
    };
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    syncAssets = mock(async () => {
      started.resolve();
      await release.promise;
      return { objectCount: 1, skippedCount: 0, downloadedBytes: SWINIR_4X_ASSET.sizeBytes };
    });
    ComfyProvision.prototype.syncAssets = syncAssets;
    installRuntime(vast);
    await runtime.reconnect();
    const [runtimeWorker] = listRuntimeWorkers();
    if (!runtimeWorker) throw new Error('Worker runtime was not created');

    const firstPrefetch = runtime.prefetch([SWINIR_4X_ASSET]);
    await started.promise;
    const duplicatePrefetch = runtime.prefetch([SWINIR_4X_ASSET]);
    await Promise.resolve();
    await destroyIfIdle(runtimeWorker);

    expect(syncAssets).toHaveBeenCalledTimes(2);
    expect(vast.destroyWorker).toHaveBeenCalledWith(worker.contractId);

    release.resolve();
    await Promise.all([firstPrefetch, duplicatePrefetch]);
    expect(syncAssets).toHaveBeenCalledTimes(2);
  });

  test('keeps serving on one worker when another worker disconnects', async () => {
    const firstWorker = makeWorker(501);
    const secondWorker = makeWorker(502);
    const vast = {
      waitForSsh: mock(async () => 1),
      getWorker: mock(async () => firstWorker),
      rentWorker: mock(async () => firstWorker),
      destroyWorker: mock(async () => undefined),
      listWorkers: mock(async () => [firstWorker, secondWorker]),
      startWorker: mock(async () => ({ kind: 'started' as const })),
    };
    const events = { log: mock(() => {}), error: mock(() => {}) };
    installRuntime(vast, events as unknown as EventLog);
    await runtime.reconnect();
    const submittedHosts = installPromptFetch();

    FakeWebSocket.forHost(firstWorker.https.host).lose();
    expect(listRuntimeWorkers().map(({ worker }) => worker.contractId)).toEqual([secondWorker.contractId]);
    expect((await runtime.submit({ workflow: {}, requiredAssets: [] })).kind).toBe('accepted');
    expect(submittedHosts).toEqual([secondWorker.https.host]);
    expect(events.error).toHaveBeenCalledWith(expect.objectContaining({ type: 'gpu_runtime_lost', data: { workerId: firstWorker.contractId } }), expect.any(Error));
    expect(vast.rentWorker).not.toHaveBeenCalled();
  });

  test('destroys an idle worker independently while another worker remains active', async () => {
    const activeWorker = makeWorker(601);
    const idleWorker = makeWorker(602);
    const vast = {
      waitForSsh: mock(async () => 1),
      getWorker: mock(async () => activeWorker),
      destroyWorker: mock(async () => undefined),
      rentWorker: mock(async () => activeWorker),
      listWorkers: mock(async () => [activeWorker, idleWorker]),
      startWorker: mock(async () => ({ kind: 'started' as const })),
    };
    installRuntime(vast);
    await runtime.reconnect();
    const submittedHosts = installPromptFetch();

    expect((await runtime.submit({ workflow: {}, requiredAssets: [] })).kind).toBe('accepted');
    const idleRuntime = listRuntimeWorkers().find(({ worker }) => worker.contractId === idleWorker.contractId);
    if (!idleRuntime) throw new Error('Idle worker runtime was not created');
    await destroyIfIdle(idleRuntime);

    expect(vast.destroyWorker).toHaveBeenCalledWith(idleWorker.contractId);
    expect(listRuntimeWorkers().map(({ worker }) => worker.contractId)).toEqual([activeWorker.contractId]);
    expect((await runtime.submit({ workflow: {}, requiredAssets: [] })).kind).toBe('accepted');
    expect(submittedHosts).toEqual([activeWorker.https.host, activeWorker.https.host]);
    expect(vast.rentWorker).not.toHaveBeenCalled();
  });

  test('rechecks idleness before destroying an expired worker', async () => {
    const worker = makeWorker(603);
    const vast = {
      waitForSsh: mock(async () => 1),
      getWorker: mock(async () => worker),
      rentWorker: mock(async () => worker),
      listWorkers: mock(async () => [worker]),
      destroyWorker: mock(async () => undefined),
      startWorker: mock(async () => ({ kind: 'started' as const })),
    };
    installRuntime(vast);
    await runtime.reconnect();
    installPromptFetch();
    const [runtimeWorker] = listRuntimeWorkers();
    if (!runtimeWorker) throw new Error('Worker runtime was not created');
    runtimeWorker.idleShutdownDue = true;

    expect((await runtime.submit({ workflow: {}, requiredAssets: [] })).kind).toBe('accepted');
    await runtime.destroyIdleWorker(runtimeWorker.computeWorkerId);

    expect(vast.destroyWorker).not.toHaveBeenCalled();
    expect(runtime.connectedWorkerCount()).toBe(1);
  });

  test('retains the runtime and worker record when idle destruction fails', async () => {
    const worker = makeWorker(604);
    const vast = {
      waitForSsh: mock(async () => 1),
      getWorker: mock(async () => worker),
      rentWorker: mock(async () => worker),
      listWorkers: mock(async () => [worker]),
      startWorker: mock(async () => ({ kind: 'started' as const })),
      destroyWorker: mock(async () => {
        throw new Error('provider unavailable');
      }),
    };
    installRuntime(vast);
    await runtime.reconnect();
    const [runtimeWorker] = listRuntimeWorkers();
    if (!runtimeWorker) throw new Error('Worker runtime was not created');
    runtimeWorker.idleShutdownDue = true;

    await expect(runtime.destroyIdleWorker(runtimeWorker.computeWorkerId)).rejects.toThrow('provider unavailable');

    expect(runtime.connectedWorkerCount()).toBe(1);
    expect(workers.listActiveWorkers('vast')).toHaveLength(1);
  });
});
