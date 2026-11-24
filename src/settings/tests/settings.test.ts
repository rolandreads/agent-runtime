import { Database } from 'bun:sqlite';
import { applySchema } from '../../db/db';
import { Settings, settings, type Gate } from '..';
import { test, expect, describe, afterEach, beforeEach } from 'bun:test';
import { SettingsRepository } from '../../repositories/settings-repository';

afterEach(() => settings.reset());

describe('settings', () => {
  test('rejects writes before bind', () => {
    expect(() => settings.set('gate', 'closed')).toThrow();
    expect(() => settings.unset('gate')).toThrow();
  });

  test('get returns a clone so callers cannot mutate live settings', () => {
    const original: Gate = settings.get().gate;
    const first = settings.get();
    first.gate = original === 'closed' ? 'open' : 'closed';
    expect(settings.get().gate).toBe(original);
  });

  test('provides the initial GPU fleet policy', () => {
    expect(settings.get().gpu).toMatchObject({ minWorkers: 0, maxWorkers: 3, activeUsersPerWorker: 2, coldStartCandidates: 3 });
  });
});

describe('settings.bind', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:', { strict: true });
    db.run('PRAGMA foreign_keys = ON');
    applySchema(db);
    settings.bind(db);
  });

  afterEach(() => db.close());

  test('skips an illegal stored value and still serves other settings', () => {
    const defaults = new Settings().get();
    new SettingsRepository(db).replace('imageTool.promptMaxItems', 'nope');
    expect(settings.get().imageTool.promptMaxItems).toBe(defaults.imageTool.promptMaxItems);
    expect(settings.get().gate).toBe(defaults.gate);
  });

  test('overlays a stored setting on the code default', () => {
    settings.set('imageTool.promptMaxItems', '4');
    expect(settings.get().imageTool.promptMaxItems).toBe(4);
    settings.set('llm.provider', 'custom-provider');
    settings.set('llm.model', 'claude-opus-4-8');
    expect(settings.get().llm).toMatchObject({ provider: 'custom-provider', model: 'claude-opus-4-8' });
  });

  test('set and unset refresh the cached value while preserving override history', () => {
    const defaultGate = settings.get().gate;
    settings.set('gate', 'closed');
    expect(settings.get().gate).toBe('closed');
    settings.unset('gate');
    expect(settings.get().gate).toBe(defaultGate);
    const repo = new SettingsRepository(db);
    repo.replace('retired.setting', '1000');
    settings.unset('retired.setting');
    expect(repo.listCurrent()).toEqual([]);
    expect(db.query<{ key: string; value: string }, []>('SELECT key, value FROM settings WHERE replaced_at IS NOT NULL ORDER BY key').all()).toEqual([
      { key: 'gate', value: 'closed' },
      { key: 'retired.setting', value: '1000' },
    ]);
  });

  test('get refreshes a database write from another process after the lookup interval', () => {
    let now = 0;
    const app = new Settings(() => now);
    app.bind(db);
    const initialGate = app.get().gate;
    settings.set('gate', 'text_only');
    expect(app.get().gate).toBe(initialGate);
    now = Number.MAX_SAFE_INTEGER;
    expect(app.get().gate).toBe('text_only');
  });

  test('rejects unknown keys and illegal values', () => {
    expect(() => settings.get('missing')).toThrow();
    expect(() => settings.set('missing', 'open')).toThrow();
    const invalid: string = 'banana';
    expect(() => settings.set('gate', invalid)).toThrow();
    expect(() => settings.set('llm.thinkingLevel', 'min')).toThrow();
    expect(() => settings.set('grok.resolution', invalid)).toThrow();
    expect(() => settings.set('imageTool.promptMaxItems', 'nope')).toThrow();
  });
});
