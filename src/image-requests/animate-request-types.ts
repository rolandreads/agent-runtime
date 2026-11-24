import type { CharacterId } from '../characters/character-catalog';
import type { UserId, ConversationId, AnimateRequestId, GeneratedImageId } from '../utils/brands';

type AnimateRequestStatus = 'queued' | 'processing' | 'delivered' | 'failed';
export type AnimateRequestFailure = 'generation_failed' | 'delivery_failed' | 'refused';

export type AnimateRequest = {
  r2Key: string;
  prompt: string;
  userId: UserId;
  traceId: string;
  createdAt: number;
  updatedAt: number;
  id: AnimateRequestId;
  costUsd: number | null;
  characterId: CharacterId;
  fileSizeBytes: number | null;
  grokRequestId: string | null;
  status: AnimateRequestStatus;
  conversationId: ConversationId;
  sourceImageId: GeneratedImageId;
  failure: AnimateRequestFailure | null;
};
