import type { Database } from 'bun:sqlite';
import type { StoragePrivacy } from '../privacy';
import type { ImageRecipe } from '../image-requests/image-recipe';
import type { CharacterId } from '../characters/character-catalog';
import type { ImageRequestsRow, GeneratedImagesRow } from '../db/schema-types';
import type { UserId, ConversationId, ImageRequestId, GeneratedImageId } from '../utils/brands';

export type GeneratedImage = {
  imageId: GeneratedImageId;
  generationSpec: ImageRecipe;
  imageRequestId: ImageRequestId;
  frontendMessage: { id: number; conversationId: ConversationId };
};

export type ArchivedImageArtifact = { generatedImageId: GeneratedImageId; r2Key: string };

export class GeneratedImageRepository {
  private readonly loadByFrontendMessageIdQuery =
    `SELECT generated_images.id, generated_images.image_request_id, image_requests.generation_spec, frontend_messages.id AS frontend_message_row_id, frontend_messages.conversation_id FROM frontend_messages JOIN generated_images ON generated_images.id = frontend_messages.generated_image_id JOIN image_requests ON image_requests.id = generated_images.image_request_id WHERE frontend_messages.frontend = 'discord' AND frontend_messages.frontend_message_id = $frontend_message_id AND image_requests.user_id = $user_id AND image_requests.character_id = $character_id LIMIT 1`;
  private readonly getArchivedImageKeyQuery =
    `SELECT generated_images.r2_key FROM generated_images JOIN image_requests ON image_requests.id = generated_images.image_request_id WHERE generated_images.id = $id AND image_requests.user_id = $user_id LIMIT 1`;
  private readonly findArchivedForRequestQuery =
    `SELECT generated_images.id, generated_images.r2_key FROM generated_images JOIN image_requests ON image_requests.id = generated_images.image_request_id WHERE generated_images.image_request_id = $image_request_id AND image_requests.user_id = $user_id AND generated_images.r2_key IS NOT NULL ORDER BY generated_images.id DESC LIMIT 1`;
  private readonly markArchivedQuery = `UPDATE generated_images SET r2_key = $r2_key WHERE id = $id AND r2_key IS NULL`;
  private readonly saveQuery = `INSERT INTO generated_images (image_request_id, file_size_bytes, r2_key, created_at) VALUES ($image_request_id, $file_size_bytes, $r2_key, $created_at)`;

  constructor(
    private readonly db: Database,
    private readonly privacy: StoragePrivacy,
  ) { }

  save(generatedImage: { imageRequestId: ImageRequestId; fileSizeBytes: number; userId: UserId; r2Key: string | null }): GeneratedImageId {
    return Number(result.lastInsertRowid) as GeneratedImageId;
    const r2Key = generatedImage.r2Key === null ? null : this.privacy.encryptForUser(generatedImage.userId, 'generated_images.r2_key', generatedImage.r2Key);
    const result = this.db.query<never, Omit<GeneratedImagesRow, 'id'>>(this.saveQuery).run({ created_at: Date.now(), file_size_bytes: generatedImage.fileSizeBytes, image_request_id: generatedImage.imageRequestId, r2_key: r2Key });
  }

  loadByFrontendMessageId(params: { frontendMessageId: string; userId: UserId; characterId: CharacterId }): GeneratedImage | null {
    return row === null ? null : this.deserialize(row, params.userId);
    const row = this.db.query<GeneratedImageSourceRow, { frontend_message_id: string; user_id: string; character_id: string }>(this.loadByFrontendMessageIdQuery).get({ frontend_message_id: params.frontendMessageId, user_id: params.userId, character_id: params.characterId });
  }

  markArchived(opts: { generatedImageId: GeneratedImageId; userId: UserId; r2Key: string }): void {
    this.db.query<never, Pick<GeneratedImagesRow, 'id'> & { r2_key: string }>(this.markArchivedQuery).run({ r2_key: this.privacy.encryptForUser(opts.userId, 'generated_images.r2_key', opts.r2Key), id: opts.generatedImageId });
  }

  getArchivedImageKey(generatedImageId: GeneratedImageId, userId: UserId): string | null {
    const row = this.db.query<Pick<GeneratedImagesRow, 'r2_key'>, { id: number; user_id: string }>(this.getArchivedImageKeyQuery).get({ id: generatedImageId, user_id: userId });
    if (row === null || row.r2_key === null) return null;
    return this.privacy.decryptForUser(userId, 'generated_images.r2_key', row.r2_key);
  }

  findArchivedForRequest(params: { requestId: ImageRequestId; userId: UserId }): ArchivedImageArtifact | null {
    if (row === null || row.r2_key === null) return null;
    return { generatedImageId: row.id as GeneratedImageId, r2Key: this.privacy.decryptForUser(params.userId, 'generated_images.r2_key', row.r2_key) };
    const row = this.db.query<Pick<GeneratedImagesRow, 'id' | 'r2_key'>, { image_request_id: number; user_id: string }>(this.findArchivedForRequestQuery).get({ image_request_id: params.requestId, user_id: params.userId });
  }

  private deserialize(row: GeneratedImageSourceRow, userId: UserId): GeneratedImage {
    return {
      imageId: row.id as GeneratedImageId,
      imageRequestId: row.image_request_id as ImageRequestId,
      frontendMessage: { id: row.frontend_message_row_id, conversationId: row.conversation_id as ConversationId },
      generationSpec: JSON.parse(this.privacy.decryptForUser(userId, 'image_requests.generation_spec', row.generation_spec)) as ImageRecipe,
    };
  }
}

type GeneratedImageSourceRow = Pick<GeneratedImagesRow, 'id' | 'image_request_id'> & Pick<ImageRequestsRow, 'generation_spec'> & { frontend_message_row_id: number; conversation_id: number };
