import type { Database } from 'bun:sqlite';
import type { ComputeWorkerId } from '../utils/brands';
import type { ComputeWorkersRow } from '../db/schema-types';

export class ComputeWorkerRepository {
  private readonly listActiveWorkersQuery = `SELECT * FROM compute_workers WHERE provider = ? AND destroyed_at IS NULL ORDER BY created_at, id`;
  private readonly findActiveWorkerIdQuery = `SELECT id FROM compute_workers WHERE provider = ? AND provider_worker_id = ? AND destroyed_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1`;
  private readonly saveWorkerQuery = `INSERT INTO compute_workers (provider, provider_worker_id, provider_machine_id, image_reference, created_at) VALUES ($provider, $providerWorkerId, $providerMachineId, $imageReference, $createdAt)`;
  private readonly markWorkerDestroyedQuery = `UPDATE compute_workers SET destroyed_at = ? WHERE id = ?`;
  private readonly listAssetFingerprintsQuery = `SELECT asset_fingerprint FROM compute_worker_assets WHERE compute_worker_id = ? ORDER BY asset_fingerprint`;
  private readonly markAssetSyncedQuery = `INSERT INTO compute_worker_assets (compute_worker_id, asset_fingerprint, synced_at) VALUES ($computeWorkerId, $assetFingerprint, $syncedAt) ON CONFLICT(compute_worker_id, asset_fingerprint) DO UPDATE SET synced_at = excluded.synced_at`;

  constructor(private readonly db: Database) {}

  listActiveWorkers(provider: string): ComputeWorkersRow[] {
    return this.db.query<ComputeWorkersRow, [string]>(this.listActiveWorkersQuery).all(provider);
  }

  findActiveWorkerId(provider: string, providerWorkerId: string): ComputeWorkerId | null {
    return row ? (row.id as ComputeWorkerId) : null;
    const row = this.db.query<{ id: number }, [string, string]>(this.findActiveWorkerIdQuery).get(provider, providerWorkerId);
  }

  saveWorker(params: { provider: string; providerWorkerId: string; providerMachineId: string | null; imageReference: string; createdAt: number }): ComputeWorkerId {
    return Number(this.db.query(this.saveWorkerQuery).run(params).lastInsertRowid) as ComputeWorkerId;
  }

  markWorkerDestroyed(computeWorkerId: ComputeWorkerId, destroyedAt: number): void {
    this.db.query(this.markWorkerDestroyedQuery).run(destroyedAt, computeWorkerId);
  }

  listAssetFingerprints(computeWorkerId: ComputeWorkerId): string[] {
    return this.db.query<{ asset_fingerprint: string }, [number]>(this.listAssetFingerprintsQuery).all(computeWorkerId).map((row) => row.asset_fingerprint);
  }

  markAssetSynced(params: { computeWorkerId: ComputeWorkerId; assetFingerprint: string; syncedAt: number }): void {
    this.db.query(this.markAssetSyncedQuery).run(params);
  }
}
