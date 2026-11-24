import type { UserId, ConversationId } from '../utils/brands';
import type { CharacterId } from '../characters/character-catalog';
import type { ImageAction, GeneratedImageSource } from '../image-requests/image-action';

export type Frontend = 'discord' | 'eval';

export type FrontendMessageContent =
  | { type: 'text'; text: string }
  | { type: 'reply_to_generated_image'; sourceImage: GeneratedImageSource }
  | ({ type: 'image_action'; sourceImage: GeneratedImageSource } & ImageAction);

export type FrontendMessage = {
  id: number;
  userId: UserId;
  traceId: string;
  timestamp: number;
  frontend: Frontend;
  characterId: CharacterId;
  frontendChannelId: string;
  frontendMessageId: string;
  conversationId: ConversationId;
  content: [FrontendMessageContent, ...FrontendMessageContent[]];
};

export type InboundFrontendMessage = Omit<FrontendMessage, 'id' | 'conversationId'>;
