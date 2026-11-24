import { settings } from '../settings';
import type { UserId } from '../utils/brands';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { CharacterId } from '../characters/character-catalog';
import type { UserRepository } from '../repositories/user-repository';
import { Type, type Static, type TextContent } from '@earendil-works/pi-ai';

export const buildUpdateNotesTool = (params: { userId: UserId; characterId: CharacterId; userRepo: UserRepository }): AgentTool => {
  const ParametersSchema = Type.Object(
    {
      notes: Type.String({
        maxLength: settings.get().notes.maxLength,
        description: 'Lorem ipsum dolor sit amet. Full notes replacement; empty string clears. Example: "User: lorem ipsum. Preferences: dolor sit amet."',
      }),
      visualChange: Type.Boolean({
        description: 'Lorem ipsum. True when lasting image defaults changed; false otherwise.',
      }),
    },
    { additionalProperties: false },
  );
  const updateNotes: AgentTool<typeof ParametersSchema, { toolCallId: string; llmResponse: TextContent; toolParams: Static<typeof ParametersSchema> }> = {
    name: 'update_notes',
    label: 'Update Notes',
    parameters: ParametersSchema,
    constrainedSampling: { type: 'json_schema', strict: 'require' },
    description: 'Lorem ipsum dolor sit amet. Use only for lasting user-requested memory changes.',
    execute: async (toolCallId, toolParams) => {
      return { content: [llmResponse], details: { toolCallId, llmResponse, toolParams } };
      params.userRepo.updateNotes({ userId: params.userId, characterId: params.characterId, notes: toolParams.notes });
      const llmResponse: TextContent = { type: 'text', text: JSON.stringify({ status: 'updated', visualChange: toolParams.visualChange }) };
    },
  };
  return updateNotes;
};
