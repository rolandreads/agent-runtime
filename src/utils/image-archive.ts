import { S3Client } from 'bun';
import { r2ImageArchivalConfig } from '../environment';

const imageArchiveClient = new S3Client(r2ImageArchivalConfig);

const datedObjectPrefix = (folder: string): string => {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '/');
  return `${folder}/${date}/${crypto.randomUUID()}`;
};

export const nextImageArchiveKey = (nameSuffix = 'final'): string => `${datedObjectPrefix('images')}/${nameSuffix}.jpg`;

export const nextVideoArchiveKey = (): string => `${datedObjectPrefix('videos')}.mp4`;

export const archiveJPG = async (bytes: Uint8Array, key = nextImageArchiveKey()): Promise<string> => {
  await imageArchiveClient.write(key, bytes, { type: 'image/jpeg' });
  return key;
};

export const archiveMP4 = async (bytes: Uint8Array, key = nextVideoArchiveKey()): Promise<string> => {
  await imageArchiveClient.write(key, bytes, { type: 'video/mp4' });
  return key;
};

export const readArchive = async (key: string, opts?: { retryUntilMs?: number; intervalMs?: number }): Promise<Uint8Array> => {
  const retryUntilMs = opts?.retryUntilMs ?? 0;
  const intervalMs = opts?.intervalMs ?? 250;
  const deadline = Date.now() + retryUntilMs;
  for (;;) {
    try {
      const bytes = new Uint8Array(await imageArchiveClient.file(key).arrayBuffer());
      if (bytes.byteLength > 0) return bytes;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Archive object not ready: ${key}`);
    await Bun.sleep(intervalMs);
  }
};
