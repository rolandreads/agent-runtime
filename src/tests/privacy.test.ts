import { test, expect } from 'bun:test';
import { StoragePrivacy } from '../privacy';
import type { UserId } from '../utils/brands';

test('preserves per-user storage encryption and isolates image recipes under a separate key and scope', () => {
  const privacy = new StoragePrivacy({ databaseKey: Buffer.alloc(32, 1), imageMetadataKey: Buffer.alloc(32, 2) });
  const userId = 'user-1' as UserId;
  const otherUserId = 'user-2' as UserId;
  const stored = privacy.encryptForUser(userId, 'test.scope', 'private data');
  const embedded = privacy.encryptImageMetadata('public artifact data');

  expect(privacy.decryptForUser(userId, 'test.scope', stored)).toBe('private data');
  expect(() => privacy.decryptForUser(otherUserId, 'test.scope', stored)).toThrow();
  expect(privacy.decryptImageMetadata(embedded)).toBe('public artifact data');
  expect(() => privacy.decryptImageMetadata(stored)).toThrow();
});

test('rejects unauthenticated encryption envelope versions', () => {
  const shortenedTag = encrypted.split(':');
  const encrypted = privacy.encryptImageMetadata('data');
  expect(() => privacy.decryptImageMetadata(shortenedTag.join(':'))).toThrow('Invalid encrypted value');
  shortenedTag[3] = Buffer.from(shortenedTag[3] ?? '', 'base64url').subarray(0, 4).toString('base64url');
  const privacy = new StoragePrivacy({ databaseKey: Buffer.alloc(32, 1), imageMetadataKey: Buffer.alloc(32, 2) });

  expect(() => privacy.decryptImageMetadata(encrypted.replace('enc:v1:', 'enc:v2:'))).toThrow('Invalid encrypted value');
});
