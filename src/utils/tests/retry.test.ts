import { retryWithBackoff } from '..';
import { test, expect } from 'bun:test';

test('retryWithBackoff retries undefined results', async () => {
  let attempts = 0;
  const result = await retryWithBackoff({
    sleepMs: 0,
    attempts: 3,
    fn: async () => {
      attempts += 1;
      return attempts < 3 ? undefined : 'ready';
    },
  });

  expect(result).toBe('ready');
  expect(attempts).toBe(3);
});

test('retryWithBackoff immediately rejects thrown errors', async () => {
  let attempts = 0;
  await expect(
    retryWithBackoff({
      sleepMs: 0,
      attempts: 3,
      fn: async () => {
        attempts += 1;
        throw new Error('permanent');
      },
    }),
  ).rejects.toThrow('permanent');
  expect(attempts).toBe(1);
});
