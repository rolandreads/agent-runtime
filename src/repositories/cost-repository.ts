import type { Database } from 'bun:sqlite';
import type { UserId } from '../utils/brands';
import type { CostsRow } from '../db/schema-types';

export type Cost = {
  userId?: UserId;
  traceId?: string;
  amountUsd: number;
  data?: Record<string, unknown>;
  source: string; // providers like anthropic, openrouter. Cloudflare R2, Vast.ai.
};

export class CostRepository {
  private readonly totalUsdForWindowQuery = `SELECT COALESCE(SUM(amount_usd), 0) AS total_usd FROM costs WHERE created_at >= $windowStartMs AND created_at < $windowEndMs`;
  private readonly saveQuery = `INSERT INTO costs (source, amount_usd, trace_id, user_id, data, created_at) VALUES ($source, $amount_usd, $trace_id, $user_id, $data, $created_at)`;
  private readonly breakdownBySourceQuery = `SELECT source, COALESCE(SUM(amount_usd), 0) AS total_usd FROM costs WHERE created_at >= $windowStartMs AND created_at < $windowEndMs GROUP BY source ORDER BY source ASC`;
  private readonly hourlyTotalsQuery =
    `SELECT (created_at - (created_at % 3600000)) AS hour_start_ms, COALESCE(SUM(amount_usd), 0) AS total_usd FROM costs WHERE created_at >= $windowStartMs AND created_at < $windowEndMs GROUP BY hour_start_ms ORDER BY hour_start_ms ASC`;

  constructor(private readonly db: Database) { }

  save(cost: Cost): void {
    this.db
      .query<never, Omit<CostsRow, 'id'>>(this.saveQuery)
      .run({ source: cost.source, amount_usd: cost.amountUsd, trace_id: cost.traceId ?? null, user_id: cost.userId ?? null, data: JSON.stringify(cost.data ?? {}), created_at: Date.now() });
  }

  getTotalUsdForWindow(windowStartMs: number, windowEndMs: number): number {
    const row = this.db.query<{ total_usd: number }, { windowStartMs: number; windowEndMs: number }>(this.totalUsdForWindowQuery).get({ windowStartMs, windowEndMs });
    return row?.total_usd ?? 0;
  }

  getHourlyTotals(windowStartMs: number, windowEndMs: number): { hourStartMs: number; totalUsd: number }[] {
    const rows = this.db.query<{ hour_start_ms: number; total_usd: number }, { windowStartMs: number; windowEndMs: number }>(this.hourlyTotalsQuery).all({ windowStartMs, windowEndMs });
    return rows.map((row) => ({ hourStartMs: row.hour_start_ms, totalUsd: row.total_usd }));
  }

  getCostBreakdownBySource(windowStartMs: number, windowEndMs: number): { source: string; totalUsd: number }[] {
    const rows = this.db.query<{ source: string; total_usd: number }, { windowStartMs: number; windowEndMs: number }>(this.breakdownBySourceQuery).all({ windowStartMs, windowEndMs });
    return rows.map((row) => ({ source: row.source, totalUsd: row.total_usd }));
  }
}
