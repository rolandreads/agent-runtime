import { settings } from '../settings';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { CharacterId } from '../characters/character-catalog';
import { Type, type Static, type TextContent } from '@earendil-works/pi-ai';
import type { UserId, ConversationId, GeneratedImageId } from '../utils/brands';
import type { AnimateRequestDispatcher, AnimateRequestRejectionReason } from '../image-requests/animate-request-dispatcher';

const createParametersSchema = () =>
  Type.Object(
    {
      reply: Type.String({ minLength: 0, maxLength: settings.get().llm.replyMaxLength, description: 'Text to send the user. Use an empty string to send no text.' }),
      prompt: Type.String({
        minLength: 1,
        maxLength: settings.get().imageTool.animatePromptMaxLength,
        description: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
      }),
    },
    { additionalProperties: false },
  );

export const buildAnimateImageTool = (params: {
  userId: UserId;
  traceId: string;
  characterId: CharacterId;
  conversationId: ConversationId;
  sourceImageId: GeneratedImageId | null;
  sendReply: (text: string) => Promise<void>;
  animateDispatcher: Pick<AnimateRequestDispatcher, 'enqueue'>;
  onRejected: (reason: AnimateRequestRejectionReason) => Promise<void>;
}): AgentTool => {
  const { userId, traceId, characterId, conversationId, sourceImageId, animateDispatcher, sendReply, onRejected } = params;
  const ParametersSchema = createParametersSchema();

  const animateImage: AgentTool<typeof ParametersSchema, { toolCallId: string; llmResponse: TextContent; toolParams: Static<typeof ParametersSchema> }> = {
    name: 'animate_image',
    label: 'Animate Image',
    parameters: ParametersSchema,
    constrainedSampling: { type: 'json_schema', strict: 'require' },
    description: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Queue animation when the latest message asks for video or GIF.',
    execute: async (toolCallId, toolParams) => {
      if (!sourceImageId) throw new Error('Cannot animate because the latest user message has no source image prompt');
      if (toolParams.reply) await sendReply(toolParams.reply);
      const result = animateDispatcher.enqueue({
        userId,
        traceId,
        characterId,
        sourceImageId,
        conversationId,
        prompt: toolParams.prompt,
      });
      if (result.kind === 'rejected') await onRejected(result.reason);

      const llmResponse: TextContent = {
        type: 'text',
        text: JSON.stringify(result.kind === 'queued' ? { status: 'queued' } : { status: 'rejected', reason: result.reason }),
      };
      return { content: [llmResponse], details: { toolCallId, llmResponse, toolParams } };
    },
  };

  return animateImage;
};
