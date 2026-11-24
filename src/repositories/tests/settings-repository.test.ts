import { Database } from 'bun:sqlite';
import { applySchema } from '../../db/db';
import { SettingsRepository } from '../settings-repository';
import { test, expect, describe, afterEach, beforeEach } from 'bun:test';

describe('SettingsRepository', () => {
  let db: Database;
  let settings: SettingsRepository;

  beforeEach(() => {
    db = new Database(':memory:', { strict: true });
    db.run('PRAGMA foreign_keys = ON');
    applySchema(db);
    settings = new SettingsRepository(db);
  });

  afterEach(() => db.close());

  test('listCurrent is empty when no settings rows exist', () => {
    expect(settings.listCurrent()).toEqual([]);
  });

  test('replace inserts a current row', () => {
    settings.replace('gate', 'closed');
    expect(settings.listCurrent()).toEqual([{ key: 'gate', value: 'closed' }]);
  });

  test('replace shelves the previous value when a key is written again', () => {
    settings.replace('gate', 'closed');
    settings.replace('gate', 'text_only');
    expect(settings.listCurrent()).toEqual([{ key: 'gate', value: 'text_only' }]);
    expect(db.query('SELECT value, replaced_at IS NULL AS current FROM settings WHERE key = ? ORDER BY id').all('gate')).toEqual([
      { value: 'closed', current: 0 },
      { value: 'text_only', current: 1 },
    ]);
  });
});
