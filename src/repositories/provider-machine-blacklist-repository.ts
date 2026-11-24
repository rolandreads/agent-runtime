import type { Database } from 'bun:sqlite';
import type { ProviderMachineBlacklistRow } from '../db/schema-types';

export class ProviderMachineBlacklistRepository {
  private readonly listActiveQuery = `SELECT * FROM provider_machine_blacklist WHERE provider = $provider AND expires_at > $now ORDER BY expires_at, provider_machine_id`;
  private readonly setQuery = `INSERT INTO provider_machine_blacklist (provider, provider_machine_id, offer_id, reason, created_at, expires_at) VALUES ($provider, $providerMachineId, $offerId, $reason, $now, $expiresAt) ON CONFLICT(provider, provider_machine_id) DO UPDATE SET offer_id = COALESCE(excluded.offer_id, provider_machine_blacklist.offer_id), reason = excluded.reason, created_at = excluded.created_at, expires_at = excluded.expires_at`;
  private readonly expireQuery = `UPDATE provider_machine_blacklist SET expires_at = $now WHERE provider = $provider AND provider_machine_id = $providerMachineId`;
  private readonly expireProviderQuery = `UPDATE provider_machine_blacklist SET expires_at = $now WHERE provider = $provider AND expires_at > $now`;

  constructor(private readonly db: Database) {}

  listActive(provider: string, now: number): ProviderMachineBlacklistRow[] {
    return this.db.query<ProviderMachineBlacklistRow, { provider: string; now: number }>(this.listActiveQuery).all({ provider, now });
  }

  listMachineIds(provider: string, now: number): Set<string> {
    return new Set(this.listActive(provider, now).map((row) => row.provider_machine_id));
  }

  set(params: { provider: string; providerMachineId: string; offerId: string | null; reason: string; now: number; expiresAt: number }): void {
    this.db.query(this.setQuery).run(params);
  }

  expire(provider: string, providerMachineId: string, now: number): void {
    this.db.query(this.expireQuery).run({ provider, providerMachineId, now });
  }

  expireProvider(provider: string, now: number): void {
    this.db.query(this.expireProviderQuery).run({ provider, now });
  }
}
