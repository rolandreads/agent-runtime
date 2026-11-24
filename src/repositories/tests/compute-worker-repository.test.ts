import { Database } from 'bun:sqlite';
import { applySchema } from '../../db/db';
import { ComputeWorkerRepository } from '../compute-worker-repository';
import { test, expect, describe, afterEach, beforeEach } from 'bun:test';

describe('ComputeWorkerRepository', () => {
  let db: Database;
  let workers: ComputeWorkerRepository;

  beforeEach(() => {
    db = new Database(':memory:', { strict: true });
    db.run('PRAGMA foreign_keys = ON');
    applySchema(db);
    workers = new ComputeWorkerRepository(db);
  });

  afterEach(() => db.close());

  test('persists workers and their successfully synced assets', () => {
    const assetFingerprint = 'loras/example.safetensors:123:r2:loras/example.safetensors';
    const computeWorkerId = workers.saveWorker({ provider: 'vast', providerWorkerId: '101', providerMachineId: '202', imageReference: 'worker@sha256:image', createdAt: 1_000 });
    workers.saveWorker({ provider: 'local', providerWorkerId: 'local', providerMachineId: null, imageReference: 'local', createdAt: 1_000 });
    workers.markAssetSynced({ computeWorkerId, assetFingerprint, syncedAt: 2_000 });
    workers.markAssetSynced({ computeWorkerId, assetFingerprint, syncedAt: 3_000 });

    expect(workers.listActiveWorkers('vast')).toEqual([{ id: computeWorkerId, provider: 'vast', provider_worker_id: '101', provider_machine_id: '202', image_reference: 'worker@sha256:image', created_at: 1_000, destroyed_at: null }]);
    expect(workers.findActiveWorkerId('vast', '101')).toBe(computeWorkerId);
    expect(workers.listAssetFingerprints(computeWorkerId)).toEqual([assetFingerprint]);
    expect(db.query('SELECT synced_at FROM compute_worker_assets').get()).toEqual({ synced_at: 3_000 });

    workers.markWorkerDestroyed(computeWorkerId, 4_000);
    expect(workers.listActiveWorkers('vast')).toEqual([]);
    expect(workers.findActiveWorkerId('vast', '101')).toBeNull();
    expect(workers.listAssetFingerprints(computeWorkerId)).toEqual([assetFingerprint]);
    expect(db.query('SELECT destroyed_at FROM compute_workers WHERE id = ?').get(computeWorkerId)).toEqual({ destroyed_at: 4_000 });
  });
});
