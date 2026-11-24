import { mock, test, expect } from 'bun:test';
import type { GpuAcquisition } from '../gpu-runtime';
import type { EventLog } from '../../utils/event-log';
import type { ComputeWorkerId } from '../../utils/brands';
import { GpuFleetAutoscaler } from '../gpu-fleet-autoscaler';
import type { ImageRecipe } from '../../image-requests/image-recipe';
import { CheckpointAssets } from '../../image-assets/image-checkpoints';

test('calculates bounded desired GPU workers from distinct active users', async () => {
  const desiredFor = async (activeUsers: number, minWorkers = 0) => {
    const harness = createHarness({ minWorkers });
    harness.activeUsers.value = activeUsers;
    harness.connectedWorkers.value = 3;
    await harness.autoscaler.requestReconcile('check');
    harness.autoscaler.stop();
    const calls = (harness.events.log as ReturnType<typeof mock>).mock.calls as [{ data: { desiredWorkers: number } }][];
    return calls.at(-1)?.[0].data.desiredWorkers;
  };
  expect(await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map((activeUsers) => desiredFor(activeUsers)))).toEqual([0, 1, 1, 2, 2, 3, 3, 3]);
  expect(await desiredFor(0, 1)).toBe(1);
});

test('reserves every ordinary scale-up worker before concurrent events can rent duplicates', async () => {
  const harness = createHarness();
  harness.activeUsers.value = 5;
  harness.connectedWorkers.value = 1;

  await Promise.all([
    harness.autoscaler.requestReconcile('enqueue'),
    harness.autoscaler.requestReconcile('kick'),
    harness.autoscaler.requestReconcile('retry_wake'),
  ]);
  expect(harness.acquire).toHaveBeenCalledTimes(2);

  await harness.autoscaler.requestReconcile('duplicate');
  expect(harness.acquire).toHaveBeenCalledTimes(2);
  harness.autoscaler.stop();
});

test('counts connected workers toward the fleet ceiling', async () => {
  const harness = createHarness();
  harness.activeUsers.value = 7;
  harness.connectedWorkers.value = 2;

  await harness.autoscaler.requestReconcile('enqueue');

  expect(harness.acquire).toHaveBeenCalledTimes(1);
  harness.autoscaler.stop();
});

test('starts three equal acquisitions once when demand finds no connected worker', async () => {
  const harness = createHarness();

  await harness.autoscaler.requestReconcile('enqueue');
  await flushMicrotasks();
  await harness.autoscaler.requestReconcile('duplicate');

  expect(harness.acquire).toHaveBeenCalledTimes(3);
  expect(harness.countriesAlreadyTried).toEqual([[], ['US'], ['US', 'ES']]);
  harness.autoscaler.stop();
});

test('caps cold-start acquisitions at maxWorkers', async () => {
  const harness = createHarness({ maxWorkers: 2 });

  await harness.autoscaler.requestReconcile('enqueue');

  expect(harness.acquire).toHaveBeenCalledTimes(2);
  harness.autoscaler.stop();
});

test('cancels every other candidate when a later rental boots first, before app readiness', async () => {
  const harness = createHarness();
  await harness.autoscaler.requestReconcile('enqueue');
  await flushMicrotasks();
  expect(harness.autoscaler.acquiringWorkerCount()).toBe(3);

  harness.boot(1);
  await flushMicrotasks();

  expect(harness.destroyAcquisition).toHaveBeenCalledTimes(2);
  expect(harness.destroyAcquisition.mock.calls.map(([acquisition]) => acquisition.contractId).sort()).toEqual([1, 3]);
  expect(harness.autoscaler.acquiringWorkerCount()).toBe(1);
  expect(harness.connectedWorkers.value).toBe(0);
  await harness.autoscaler.requestReconcile('still_provisioning');
  expect(harness.acquire).toHaveBeenCalledTimes(3);
  harness.complete(1);
  await flushMicrotasks();
  expect(harness.autoscaler.acquiringWorkerCount()).toBe(0);
  harness.autoscaler.stop();
});

test('keeps enough cold-start acquisitions for current desired capacity', async () => {
  const harness = createHarness();
  harness.activeUsers.value = 3;
  await harness.autoscaler.requestReconcile('enqueue');
  await flushMicrotasks();
  harness.boot(0);
  await flushMicrotasks();

  expect(harness.destroyAcquisition).toHaveBeenCalledTimes(1);
  harness.complete(0);
  harness.complete(1);
  await flushMicrotasks();
  expect(harness.connectedWorkers.value).toBe(2);
  expect(harness.destroyAcquisition).toHaveBeenCalledTimes(1);
  harness.autoscaler.stop();
});

test('cancels boot losers while another rental request is still in flight', async () => {
  const rental = Promise.withResolvers<void>();
  const harness = createHarness({ delayedThirdRental: rental.promise });
  await harness.autoscaler.requestReconcile('enqueue');
  await flushMicrotasks();

  harness.boot(0);
  await flushMicrotasks();
  expect(harness.destroyAcquisition.mock.calls.map(([acquisition]) => acquisition.contractId)).toEqual([2]);
  expect(harness.connectedWorkers.value).toBe(0);

  rental.resolve();
  await flushMicrotasks();
  expect(harness.destroyAcquisition.mock.calls.map(([acquisition]) => acquisition.contractId)).toEqual([2, 3]);
  expect(harness.acquire).toHaveBeenCalledTimes(3);
  harness.autoscaler.stop();
});

test('does not replace one failed cold-start acquisition while other reservations remain', async () => {
  const harness = createHarness();
  await harness.autoscaler.requestReconcile('enqueue');
  await flushMicrotasks();
  harness.fail(0);
  await flushMicrotasks();

  expect(harness.acquire).toHaveBeenCalledTimes(3);
  expect(harness.destroyAcquisition).toHaveBeenCalledWith(expect.objectContaining({ contractId: 1 }));
  harness.autoscaler.stop();
});

test('clears a failed ordinary acquisition reservation and performs one bounded retry', async () => {
  const harness = createHarness({ failFirstStart: true });
  harness.activeUsers.value = 3;
  harness.connectedWorkers.value = 1;

  await harness.autoscaler.requestReconcile('enqueue');
  await flushMicrotasks();

  expect(harness.acquire).toHaveBeenCalledTimes(2);
  expect(harness.events.error).toHaveBeenCalledWith(expect.objectContaining({ type: 'gpu_fleet_worker_acquisition_failed' }), expect.any(Error));
  harness.autoscaler.stop();
});

test('reports capacity unavailable once after every cold-start attempt is exhausted', async () => {
  const harness = createHarness({ failAllStarts: true });

  await harness.autoscaler.requestReconcile('enqueue');
  await harness.capacityUnavailable.promise;

  expect(harness.acquire).toHaveBeenCalledTimes(4);
  expect(harness.onCapacityUnavailable).toHaveBeenCalledTimes(1);
  harness.autoscaler.stop();
});

test('retains idle workers that current demand still needs', async () => {
  const harness = createHarness();
  harness.connectedWorkers.value = 1;
  harness.idleWorkers.value = [1 as ComputeWorkerId];

  await harness.autoscaler.requestReconcile('idle_expired');

  expect(harness.destroyIdleWorker).not.toHaveBeenCalled();
  harness.autoscaler.stop();
});

test('destroys only idle workers above freshly desired capacity', async () => {
  const harness = createHarness();
  harness.connectedWorkers.value = 3;
  harness.idleWorkers.value = [1 as ComputeWorkerId, 2 as ComputeWorkerId, 3 as ComputeWorkerId];

  await harness.autoscaler.requestReconcile('idle_expired');
  await flushMicrotasks();

  expect(harness.destroyIdleWorker.mock.calls.map(([computeWorkerId]) => computeWorkerId)).toEqual([1 as ComputeWorkerId, 2 as ComputeWorkerId]);
  expect(harness.connectedWorkers.value).toBe(1);
  harness.autoscaler.stop();
});

test('renewed demand prevents expired idle workers from being destroyed', async () => {
  const harness = createHarness();
  harness.activeUsers.value = 5;
  harness.connectedWorkers.value = 3;
  harness.idleWorkers.value = [1 as ComputeWorkerId, 2 as ComputeWorkerId, 3 as ComputeWorkerId];

  await harness.autoscaler.requestReconcile('new_demand');

  expect(harness.destroyIdleWorker).not.toHaveBeenCalled();
  harness.autoscaler.stop();
});

const createHarness = (options: { minWorkers?: number; maxWorkers?: number; failFirstStart?: boolean; failAllStarts?: boolean; delayedThirdRental?: Promise<void> } = {}) => {
  return {
    events,
    acquire,
    autoscaler,
    activeUsers,
    idleWorkers,
    connectedWorkers,
    destroyIdleWorker,
    destroyAcquisition,
    capacityUnavailable,
    countriesAlreadyTried,
    onCapacityUnavailable,
    boot: (index: number) => pending[index]?.booted.resolve(),
    fail: (index: number) => pending[index]?.readiness.reject(new Error('provision failed')),
    complete: (index: number) => {
      if (pending[index]) pending[index].acquisition.appReady = true;
      pending[index]?.booted.resolve();
      connectedWorkers.value += 1;
      pending[index]?.readiness.resolve();
    },
  };
  let acquisitionCount = 0;
  const activeUsers = { value: 2 };
  const connectedWorkers = { value: 0 };
  const autoscaler = new GpuFleetAutoscaler({
    events,
    onCapacityUnavailable,
    demand: { countActiveGenerationUsers: () => activeUsers.value, findOldestActiveGeneration: () => ({ generationSpec: recipe }) },
    runtime: { connectedWorkerCount: () => connectedWorkers.value, idleWorkerIds: () => idleWorkers.value, acquire, destroyAcquisition, destroyIdleWorker },
    policy: () => ({ minWorkers: options.minWorkers ?? 0, maxWorkers: options.maxWorkers ?? 3, activeUsersPerWorker: 2, coldStartCandidates: 3, readyPollIntervalMs: 0 }),
  });
  const countriesAlreadyTried: string[][] = [];
  const idleWorkers = { value: [] as ComputeWorkerId[] };
  const capacityUnavailable = Promise.withResolvers<void>();
  const destroyIdleWorker = mock((computeWorkerId: ComputeWorkerId) => {
    idleWorkers.value = idleWorkers.value.filter((workerId) => workerId !== computeWorkerId);
    connectedWorkers.value -= 1;
    return Promise.resolve();
  });
  const destroyAcquisition = mock((_acquisition: GpuAcquisition) => Promise.resolve());
  const events = { log: mock(() => {}), error: mock(() => {}) } as unknown as EventLog;
  const onCapacityUnavailable = mock((_error: unknown) => { capacityUnavailable.resolve(); });
  const acquire = mock((_requiredAssets: readonly unknown[], triedCountries: ReadonlySet<string>) => {
    countriesAlreadyTried.push([...triedCountries]);
    acquisitionCount += 1;
    if (options.failAllStarts || (options.failFirstStart && acquisitionCount === 1)) return Promise.reject(new Error('no offer'));
    const readiness = Promise.withResolvers<void>();
    const booted = Promise.withResolvers<void>();
    const acquisition: GpuAcquisition = { computeWorkerId: acquisitionCount as ComputeWorkerId, contractId: acquisitionCount, countryCode: ['US', 'ES', 'JP'][acquisitionCount - 1] ?? 'US', appReady: false, booted: booted.promise, ready: readiness.promise };
    pending.push({ acquisition, booted, readiness });
    return acquisitionCount === 3 && options.delayedThirdRental ? options.delayedThirdRental.then(() => acquisition) : Promise.resolve(acquisition);
  });
  const pending: { acquisition: GpuAcquisition; booted: PromiseWithResolvers<void>; readiness: PromiseWithResolvers<void> }[] = [];
};

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const recipe = {
  loras: [],
  version: 1,
  width: 832,
  clipSkip: 2,
  height: 1216,
  appliedLoras: [],
  detailPassEnabled: false,
  kind: 'standard-diffusion',
  requestedPrompt: 'test prompt',
  negativePrompt: 'negative prompt',
  positivePrompt: 'generation prompt',
  checkpoint: CheckpointAssets.checkpoint_b.comfyAsset,
  sampling: { seed: 1, steps: 22, cfg: 7, denoise: 1, samplerName: 'euler_ancestral', scheduler: 'normal' },
} satisfies ImageRecipe;
