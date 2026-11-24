import type { UserMessage } from '@earendil-works/pi-ai';
import { buildTurnPrompt } from '../prompts/turn-prompts';
import type { FrontendMessage } from '../frontends/frontend-message';
import type { GeneratedImageSource } from '../image-requests/image-action';

export const buildTurnInput = (messages: [FrontendMessage, ...FrontendMessage[]]): { message: UserMessage; sourceImage: GeneratedImageSource | null } => {
  const content = messages.flatMap((message) => message.content);
  const sourceImage = content.find((item) => item.type === 'image_action' || item.type === 'reply_to_generated_image')?.sourceImage ?? null;
  const prompt = buildTurnPrompt(content);

  return {
    sourceImage,
    message: { timestamp: messages[0].timestamp, role: 'user', content: prompt },
  };
};
