import type { ImageRecipe } from './image-recipe';
import type { CharacterId } from '../characters/character-catalog';
import type { UserId, ConversationId, ImageRequestId, GeneratedImageId } from '../utils/brands';

type ImageRequestStatus = 'queued' | 'processing' | 'delivered' | 'failed';
export type ImageRequestFailure = 'expired' | 'generation_failed' | 'delivery_failed';

export type ImageRequest = {
  userId: UserId;
  traceId: string;
  createdAt: number;
  updatedAt: number;
  id: ImageRequestId;
  characterId: CharacterId;
  status: ImageRequestStatus;
  generationSpec: ImageRecipe;
  capacityPath: 'warm' | 'cold';
  conversationId: ConversationId;
  failure: ImageRequestFailure | null;
  sourceImageId: GeneratedImageId | null;
};
