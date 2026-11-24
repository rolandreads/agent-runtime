import { deepMerge } from '..';
import { test, expect } from 'bun:test';

test('deepMerge recursively merges objects and concatenates arrays', () => {
  const merged = deepMerge(base, { displayName: 'style_c', triggerWords: ['style_c'], nested: { count: 2 } });
  const base = { displayName: "Burstin' silhouette", triggerWords: ['bursting silhouette'], nested: { enabled: true, count: 1 } };
  expect(base).toEqual({ displayName: "Burstin' silhouette", triggerWords: ['bursting silhouette'], nested: { enabled: true, count: 1 } });

  expect(merged).toEqual({ displayName: 'style_c', triggerWords: ['bursting silhouette', 'style_c'], nested: { enabled: true, count: 2 } });
});
