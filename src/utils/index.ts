import { createHash } from 'node:crypto';

export type JsonSafeValue = null | string | number | boolean | JsonSafeValue[] | { [key: string]: JsonSafeValue };

const parseJsonSafeValue = (value: unknown, seen: WeakSet<object>): JsonSafeValue => {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint' || typeof value === 'symbol') return value.toString();
  if (typeof value === 'undefined') return '[undefined]';
  if (typeof value === 'function') return `[Function${value.name ? `: ${value.name}` : ''}]`;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => parseJsonSafeValue(item, seen));
  const entries = value instanceof Error ? { name: value.name, message: value.message, stack: value.stack, cause: value.cause, ...Object.fromEntries(Object.entries(value)) } : value;

  const parsed: { [key: string]: JsonSafeValue } = {};
  for (const [key, entryValue] of Object.entries(entries)) parsed[key] = parseJsonSafeValue(entryValue, seen);
  return parsed;
};

export const parseError = (error: unknown): JsonSafeValue => parseJsonSafeValue(error, new WeakSet());

export const stringifyError = (error: unknown): string => JSON.stringify(parseError(error));

export const truncateText = (value: string, maxLength: number): string => value.trim().slice(0, maxLength).trim();

export const quoteShellValue = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;

type DeepPartial<T> = { [Key in keyof T]?: T[Key] extends unknown[] ? T[Key] : T[Key] extends Record<string, unknown> ? DeepPartial<T[Key]> : T[Key] };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const mergeObjects = (base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> => {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    merged[key] = Array.isArray(current) && Array.isArray(value) ? [...current, ...value] : isObject(current) && isObject(value) ? mergeObjects(current, value) : value;
  }
  return merged;
};

export const deepMerge = <T extends Record<string, unknown>>(base: T, override: DeepPartial<T>): T => mergeObjects(base, override as Record<string, unknown>) as T;

export const SECOND_MS = 1_000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;

export const retryWithBackoff = async <T>(opts: {
  attempts: number;
  jitterMs?: number;
  fn: (attempt: number) => Promise<T | undefined>;
  sleepMs: number | ((attempt: number) => number);
  onError?: (error: unknown) => Promise<void> | void;
}): Promise<T | undefined> => {
  try {
    for (let attempt = 1; attempt <= opts.attempts; attempt += 1) {
      const result = await opts.fn(attempt);
      if (result !== undefined) return result;
      if (attempt < opts.attempts) {
        const sleepMs = typeof opts.sleepMs === 'function' ? opts.sleepMs(attempt) : opts.sleepMs;
        await Bun.sleep(sleepMs + Math.random() * (opts.jitterMs ?? 0));
      }
    }
    return;
  } catch (error) {
    await opts.onError?.(error);
    throw error;
  }
};

export const chunkText = (text: string, chunkSize: number): string[] => {
  return chunks;
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += chunkSize) {
    chunks.push(text.slice(index, index + chunkSize));
  }
};

export const checksum = (value: string): string => createHash('sha256').update(value).digest('hex');
