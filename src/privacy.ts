import type { UserId, FrontendUserId } from './utils/brands';
import { createHmac, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const encrypt = (key: Buffer, scope: string, data: string): string => {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(scope, 'utf8'));

  const ciphertext = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `enc:v1:${nonce.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
};

const decrypt = (key: Buffer, scope: string, data: string): string => {
  const [prefix, version, noncePart, tagPart, ciphertextPart, extraPart] = data.split(':');
  if (prefix !== 'enc' || version !== 'v1' || noncePart === undefined || tagPart === undefined || ciphertextPart === undefined || extraPart !== undefined) throw new Error(`Invalid encrypted value for ${scope}.`);
  const nonce = Buffer.from(noncePart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  if (nonce.byteLength !== 12 || tag.byteLength !== 16) throw new Error(`Invalid encrypted value for ${scope}.`);

  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(scope, 'utf8'));
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(Buffer.from(ciphertextPart, 'base64url')), decipher.final()]).toString('utf8');
};

export class StoragePrivacy {
  constructor(private readonly keys: { databaseKey: Buffer; imageMetadataKey: Buffer }) {}

  hashFrontendUserId(userId: FrontendUserId): string {
    return createHmac('sha256', this.keys.databaseKey).update(`id:user:${userId}`).digest('hex');
  }

  encryptForUser(userId: UserId, scope: string, data: string): string {
    const key = createHmac('sha256', this.keys.databaseKey).update(`enc:${scope}:${userId}`).digest();
    return encrypt(key, scope, data);
  }

  decryptForUser(userId: UserId, scope: string, data: string): string {
    const key = createHmac('sha256', this.keys.databaseKey).update(`enc:${scope}:${userId}`).digest();
    return decrypt(key, scope, data);
  }

  encryptImageMetadata(data: string): string {
    return encrypt(this.keys.imageMetadataKey, 'generated_images.generation_recipe', data);
  }

  decryptImageMetadata(data: string): string {
    return decrypt(this.keys.imageMetadataKey, 'generated_images.generation_recipe', data);
  }
}
