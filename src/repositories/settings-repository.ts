import type { Database } from 'bun:sqlite';

export class SettingsRepository {
  private readonly loadCurrentQuery = 'SELECT key, value FROM settings WHERE replaced_at IS NULL';
  private readonly replaceQuery = 'UPDATE settings SET replaced_at = $replaced_at WHERE key = $key AND replaced_at IS NULL';
  private readonly insertQuery = 'INSERT INTO settings (key, value, created_at, replaced_at) VALUES ($key, $value, $created_at, NULL)';

  constructor(private readonly db: Database) {}

  listCurrent(): Array<{ key: string; value: string }> {
    return this.db.query<{ key: string; value: string }, []>(this.loadCurrentQuery).all();
  }

  unset(key: string): void {
    this.db.query<never, { key: string; replaced_at: number }>(this.replaceQuery).run({ key, replaced_at: Date.now() });
  }

  replace(key: string, value: string): void {
    const now = Date.now();
    this.db.transaction(() => {
      this.db.query<never, { key: string; replaced_at: number }>(this.replaceQuery).run({ key, replaced_at: now });
      this.db.query<never, { key: string; value: string; created_at: number }>(this.insertQuery).run({ key, value, created_at: now });
    })();
  }
}
