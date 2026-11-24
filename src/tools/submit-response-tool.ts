import { settings } from '../settings';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static, type TextContent } from '@earendil-works/pi-ai';

export type SubmittedResponse = { reply: string; prompts: readonly string[] };

const createParametersSchema = () => {
  const { llm, imageTool } = settings.get();
  return Type.Object(
    {
      reply: Type.String({ minLength: 0, maxLength: llm.replyMaxLength, description: 'Lorem ipsum. Empty string sends no text.' }),
      prompts: Type.Array(Type.String({ minLength: 1, maxLength: imageTool.promptMaxLength, description: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.' }), { minItems: 0, maxItems: imageTool.promptMaxItems, description: 'Lorem ipsum. Empty array when no still image was requested.' }),
    },
    { additionalProperties: false },
  );
};

export const buildSubmitResponseTool = (params: { submit: (response: SubmittedResponse) => Promise<void> }): AgentTool => {
  const ParametersSchema = createParametersSchema();
  const submitResponse: AgentTool<typeof ParametersSchema, { toolCallId: string; llmResponse: TextContent; toolParams: Static<typeof ParametersSchema> }> = {
    name: 'submit_response',
    label: 'Submit Response',
    parameters: ParametersSchema,
    constrainedSampling: { type: 'json_schema', strict: 'require' },
    description: 'Lorem ipsum dolor sit amet. Finish the turn once; put still-image batch in prompts.',
    execute: async (toolCallId, toolParams) => {
      if (!toolParams.reply && toolParams.prompts.length === 0) throw new Error('submit_response requires a text reply or at least one image prompt');
      await params.submit(toolParams);
      const llmResponse: TextContent = { type: 'text', text: JSON.stringify({ status: 'submitted' }) };
      return { content: [llmResponse], details: { toolCallId, llmResponse, toolParams } };
    },
  };
  return submitResponse;
};
