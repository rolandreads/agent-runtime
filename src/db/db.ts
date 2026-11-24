import { join } from 'node:path';
import { checksum } from '../utils';
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';

export const openDatabase = (dbPath: string): Database => {
  const db = new Database(dbPath, { create: true, strict: true });
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA synchronous = NORMAL');
  db.run('PRAGMA busy_timeout = 5000');
  db.run('PRAGMA foreign_keys = ON');
  return db;
};

export const applySchema = (db: Database) => db.run(readFileSync(join(process.cwd(), 'src/db/schema.sql'), 'utf8'));

export const migrateDatabase = (db: Database): void => {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      checksum   TEXT NOT NULL,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL,
      version    INTEGER PRIMARY KEY
    )
  `);

  const migrations = listSqlMigrations();

  const rows = db.prepare(`SELECT version, name, checksum FROM schema_migrations ORDER BY version`).all() as AppliedMigrationRow[];
  const appliedMigrations = new Map(rows.map((row) => [row.version, row]));

  if (appliedMigrations.size === 0) {
    console.log('Initializing fresh database schema');
    db.transaction(() => {
      applySchema(db);
      const insertMigration = db.prepare(`INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES ($version, $name, $checksum, $appliedAt)`);
      for (const migration of migrations) insertMigration.run({ ...migration, appliedAt: Date.now() });
    })();
  } else {
    applyPendingMigrations(db, migrations, appliedMigrations);
    applySchema(db);
  }

  verifyDatabase(db);
};

const listSqlMigrations = (): Migration[] => {
  const migrationsDir = join(process.cwd(), 'src/db/migrations');
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => {
      const match = /^(\d{14})_[a-z0-9_]+\.sql$/.exec(name);
      if (match === null) throw new Error(`invalid migration filename: ${name}`);
      const version = Number(match[1]);
      const sql = readFileSync(join(migrationsDir, name), 'utf8');
      return { version, name, sql, checksum: checksum(sql) };
    })
    .sort((left, right) => left.version - right.version);
};

// DROP COLUMN fails if the column is still referenced: index, UNIQUE/PK, CHECK, FK, trigger, or view.
// Drop those first (DROP INDEX …, then ALTER TABLE … DROP COLUMN).
const applyPendingMigrations = (db: Database, migrations: Migration[], appliedMigrations: Map<number, AppliedMigrationRow>): void => {
  for (const migration of migrations) {
    const appliedMigration = appliedMigrations.get(migration.version);
    if (appliedMigration !== undefined && (appliedMigration.name !== migration.name || appliedMigration.checksum !== migration.checksum)) {
      throw new Error(`database migration ${String(migration.version)} does not match ${migration.name}`);
    }
  }

  const pendingMigrations = migrations.filter((migration) => !appliedMigrations.has(migration.version));
  if (pendingMigrations.length === 0) return;

  for (const migration of pendingMigrations) {
    console.log(`Applying database migration ${migration.name}`);
    db.transaction(() => {
      db.run(migration.sql);
      db.prepare(`INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES ($version, $name, $checksum, $appliedAt)`).run({
        name: migration.name,
        appliedAt: Date.now(),
        version: migration.version,
        checksum: migration.checksum,
      });
    })();
  }
};

const listUserTables = (db: Database): string[] =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream_%' AND name != 'schema_migrations'`).all() as Array<{ name: string }>)
    .map((row) => row.name)
    .sort();
const listColumns = (db: Database, table: string): string[] => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name).sort();
const snapshotSchema = (db: Database): Map<string, string[]> => new Map(listUserTables(db).map((table) => [table, listColumns(db, table)]));

const verifyDatabase = (db: Database): void => {
  const integrityRows = db.prepare('PRAGMA integrity_check').all() as IntegrityCheckRow[];
  const integrityFailures = integrityRows.map((row) => row.integrity_check).filter((result) => result !== 'ok');
  if (integrityFailures.length > 0) throw new Error(`SQLite integrity_check failed: ${integrityFailures.join('; ')}`);

  const foreignKeyFailures = db.prepare('PRAGMA foreign_key_check').all() as ForeignKeyCheckRow[];
  if (foreignKeyFailures.length > 0) throw new Error(`SQLite foreign_key_check failed: ${JSON.stringify(foreignKeyFailures)}`);

  const expected = new Database(':memory:', { strict: true });
  try {
    applySchema(expected);
    const expectedSchema = snapshotSchema(expected);
    const actualSchema = snapshotSchema(db);
    const mismatches: string[] = [];
    for (const table of new Set([...expectedSchema.keys(), ...actualSchema.keys()])) {
      const expectedColumns = expectedSchema.get(table);
      const actualColumns = actualSchema.get(table);
      if (!expectedColumns) mismatches.push(`extra table ${table}`);
      else if (!actualColumns) mismatches.push(`missing table ${table}`);
      else {
        for (const column of expectedColumns) if (!actualColumns.includes(column)) mismatches.push(`missing ${table}.${column}`);
        for (const column of actualColumns) if (!expectedColumns.includes(column)) mismatches.push(`extra ${table}.${column}`);
      }
    }
    if (mismatches.length > 0) throw new Error(`database schema does not match schema.sql: ${mismatches.join(', ')}`);
  } finally {
    expected.close();
  }
};

type Migration = {
  sql: string;
  name: string;
  version: number;
  checksum: string;
};

type AppliedMigrationRow = {
  name: string;
  version: number;
  checksum: string;
};

type ForeignKeyCheckRow = {
  fkid: number;
  rowid: number;
  table: string;
  parent: string;
};

type IntegrityCheckRow = {
  integrity_check: string;
};
