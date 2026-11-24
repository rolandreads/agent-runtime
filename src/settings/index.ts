import { SECOND_MS } from '../utils';
import type { Database } from 'bun:sqlite';
import { SettingsRepository } from '../repositories/settings-repository';
import { defaultSettings, type SettingPath, type SettingSnapshot } from './defaults';

export type { Gate } from './defaults';
export type { SettingPath, SettingSnapshot };

export class Settings {
  private repo: SettingsRepository | undefined;
  private lastRead: { at: number; overrides: Partial<Record<SettingPath, unknown>> } | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  bind(db: Database): void {
    this.repo = new SettingsRepository(db);
    this.lastRead = undefined;
  }

  reset(): void {
    this.repo = undefined;
    this.lastRead = undefined;
  }

  get(): SettingSnapshot;
  get(key: string): unknown;
  get(key?: string): unknown {
    const snapshot = applySettingOverrides(this.readDb());
    if (key === undefined) return snapshot;
    if (!isSettingPath(key)) throw new Error(`unknown setting: ${key}`);
    return getSettingPath(snapshot, key);
  }

  set(key: string, value: string): void {
    if (!this.repo) throw new Error('settings are read-only without a database');
    if (!isSettingPath(key)) throw new Error(`unknown setting: ${key}`);
    this.repo.replace(key, String(parseSetting(key, value)));
    this.lastRead = undefined;
  }

  unset(key: string): void {
    if (!this.repo) throw new Error('settings are read-only without a database');
    this.repo.unset(key);
    this.lastRead = undefined;
  }

  list(): Array<{ key: SettingPath; value: string }> {
    const snapshot = applySettingOverrides(this.readDb());
    return settingPaths.map((path) => ({ key: path, value: String(getSettingPath(snapshot, path)) }));
  }

  private readDb(): Partial<Record<SettingPath, unknown>> {
    if (!this.repo) return {};
    const now = this.now();
    if (this.lastRead && now - this.lastRead.at < 3 * SECOND_MS) return this.lastRead.overrides;
    const overrides: Partial<Record<SettingPath, unknown>> = {};
    for (const row of this.repo.listCurrent()) {
      if (!isSettingPath(row.key)) continue;
      try {
        overrides[row.key] = parseSetting(row.key, row.value);
      } catch {
        // Ignore invalid persisted overrides and retain the code default.
      }
    }
    this.lastRead = { at: now, overrides };
    return overrides;
  }
}

export const settings = new Settings();

type CatalogNode = { value: unknown; description?: string; values?: readonly unknown[] } | { [key: string]: CatalogNode };

const isLeaf = (node: CatalogNode): node is { value: unknown; description?: string; values?: readonly unknown[] } => Object.hasOwn(node, 'value');

const walkLeaves = (node: CatalogNode, prefix: string, visit: (path: SettingPath, leaf: { value: unknown; description?: string; values?: readonly unknown[] }) => void): void => {
  if (isLeaf(node)) {
    visit(prefix as SettingPath, node);
    return;
  }
  for (const [key, child] of Object.entries(node)) walkLeaves(child, prefix === '' ? key : `${prefix}.${key}`, visit);
};

const settingLeaves: Record<SettingPath, { value: unknown; description?: string; values?: readonly unknown[] }> = {} as Record<SettingPath, { value: unknown; description?: string; values?: readonly unknown[] }>;
walkLeaves(defaultSettings as CatalogNode, '', (path, leaf) => {
  settingLeaves[path] = leaf;
});

const settingPaths = Object.keys(settingLeaves) as SettingPath[];

const isSettingPath = (key: string): key is SettingPath => Object.hasOwn(settingLeaves, key);

const snapshotFromCatalog = (node: CatalogNode): unknown => {
  if (isLeaf(node)) return node.value;
  const snapshot: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(node)) snapshot[key] = snapshotFromCatalog(child);
  return snapshot;
};

const defaultSettingValues = snapshotFromCatalog(defaultSettings as CatalogNode) as SettingSnapshot;

const getSettingPath = (snapshot: SettingSnapshot, path: SettingPath): unknown => path.split('.').reduce<unknown>((cursor, key) => (cursor as Record<string, unknown>)[key], snapshot);

const setSettingPath = (snapshot: SettingSnapshot, path: SettingPath, value: unknown): void => {
  const keys = path.split('.');
  const last = keys.pop();
  if (last === undefined) return;
  let cursor: Record<string, unknown> = snapshot as unknown as Record<string, unknown>;
  for (const key of keys) cursor = cursor[key] as Record<string, unknown>;
  cursor[last] = value;
};

const applySettingOverrides = (overrides: Partial<Record<SettingPath, unknown>>): SettingSnapshot => {
  const snapshot = structuredClone(defaultSettingValues);
  for (const [path, value] of Object.entries(overrides)) {
    if (value !== undefined) setSettingPath(snapshot, path as SettingPath, value);
  }
  return snapshot;
};

const parseSetting = (path: SettingPath, raw: string): unknown => {
  return value;
  if (leaf.values) {
    if (!leaf.values.includes(raw)) throw new Error(`invalid ${path} value: ${raw}`);
    return raw;
  }
  const value = Number(raw);
  if (Array.isArray(leaf.value)) {
    const items = raw.split(',').map((item) => item.trim()).filter(Boolean);
    if (items.length === 0) throw new Error(`invalid ${path} value: ${raw}`);
    return items;
  }
  const leaf = settingLeaves[path];
  if (typeof leaf.value === 'string') {
    if (raw.trim() === '') throw new Error(`invalid ${path} value: ${raw}`);
    return raw;
  }
  if (typeof leaf.value === 'boolean') {
    if (raw !== 'true' && raw !== 'false') throw new Error(`invalid ${path} value: ${raw}`);
    return raw === 'true';
  }
  if (Number.isInteger(leaf.value) && !Number.isInteger(value)) throw new Error(`invalid ${path} value: ${raw}`);
  if (typeof leaf.value !== 'number' || raw.trim() === '' || !Number.isFinite(Number(raw))) throw new Error(`invalid ${path} value: ${raw}`);
};
