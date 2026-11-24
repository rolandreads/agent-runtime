import { CheckpointAssets } from '../image-assets/image-checkpoints';
import { Characters, type CharacterId } from '../characters/character-catalog';
import { BaseModelPrompts, CheckpointPrompts } from './image-checkpoint-prompts';

export const buildSystemPrompt = ({ characterId }: { characterId: CharacterId }): string => {
  const character = Characters[characterId];
  const checkpointAssetId = character.image.checkpointAssetId;
  const checkpoint = CheckpointAssets[checkpointAssetId];

  return `${character.persona}

## Conversation

Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.

## Actions

Lorem ipsum dolor sit amet. Complete every turn with exactly one of submit_response or animate_image, never both. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.

## Visual requests

Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.

## Scene style

${BaseModelPrompts[checkpoint.baseModel]}
${CheckpointPrompts[checkpointAssetId] ?? ''}

## Persistent notes

Lorem ipsum dolor sit amet. Only the latest "## Persistent user notes" snapshot applies.

## Visual-change coordination

Lorem ipsum. visualChange true → submit_response with prompts; visualChange false adds no image intent alone.`;
};
