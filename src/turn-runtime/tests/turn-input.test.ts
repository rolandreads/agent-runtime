import { test, expect } from 'bun:test';
import { buildTurnInput } from '../turn-input';
import type { UserId, ConversationId, GeneratedImageId } from '../../utils/brands';
import type { FrontendMessage, FrontendMessageContent } from '../../frontends/frontend-message';

const frontendMessage = (content: [FrontendMessageContent, ...FrontendMessageContent[]]): FrontendMessage => ({
  id: 1,
  content,
  timestamp: 10,
  frontend: 'discord',
  characterId: 'agent_a',
  userId: 'user-1' as UserId,
  traceId: 'discord:message-1',
  frontendChannelId: 'channel-1',
  frontendMessageId: 'message-1',
  conversationId: 1 as ConversationId,
});

test('gives generated-image replies prompt context and source lineage without pixels', () => {
  const sourceImageId = 42 as GeneratedImageId;
  const input = buildTurnInput([
    frontendMessage([
      { type: 'reply_to_generated_image', sourceImage: { imageId: sourceImageId, prompt: 'lorem ipsum dolor sit amet', loras: [{ id: 'style_b', strength: 1.2 }, { id: 'style_a', strength: 0.8 }] } },
      { type: 'text', text: 'Make the scene brighter.' },
    ]),
  ]);

  expect(input.sourceImage).toEqual({ imageId: sourceImageId, prompt: 'lorem ipsum dolor sit amet', loras: [{ id: 'style_b', strength: 1.2 }, { id: 'style_a', strength: 0.8 }] });
  expect(input.message.content).toContain('lorem ipsum dolor sit amet');
  expect(input.message.content).toContain('Make the scene brighter.');
});
