import { CharacterPersonas } from '../prompts/character-personas';
import type { CheckpointAssetId } from '../image-assets/image-checkpoints';
import type { LoraAssetId, LoraStrength } from '../image-assets/image-loras';

export type CharacterId = keyof typeof Characters;
export type CharacterLora = { readonly id: LoraAssetId; readonly strength: LoraStrength };
export type CharacterImage = { readonly loras: readonly CharacterLora[]; readonly checkpointAssetId: CheckpointAssetId };

const defaultLoras: readonly CharacterLora[] = [
  { id: 'style_a', strength: { current: 0.8, min: 0, max: 1 } },
  { id: 'style_b', strength: { current: 0.6, min: 0, max: 1 } },
  { id: 'detail_boost', strength: { current: 0.5, min: 0, max: 1 } },
];

export const Characters = {
  agent_b: {
    name: 'Agent B',
    persona: CharacterPersonas.agent_b,
    image: { checkpointAssetId: 'checkpoint_d', loras: defaultLoras },
  },
  agent_c: {
    name: 'Agent C',
    persona: CharacterPersonas.agent_c,
    image: { checkpointAssetId: 'checkpoint_c', loras: defaultLoras },
  },
  agent_d: {
    name: 'Agent D',
    persona: CharacterPersonas.agent_d,
    image: { checkpointAssetId: 'checkpoint_b', loras: defaultLoras },
  },
  agent_e: {
    name: 'Agent E',
    persona: CharacterPersonas.agent_e,
    image: { checkpointAssetId: 'checkpoint_b', loras: defaultLoras },
  },
  agent_f: {
    name: 'Agent F',
    persona: CharacterPersonas.agent_f,
    image: { checkpointAssetId: 'checkpoint_a', loras: defaultLoras },
  },
  agent_g: {
    name: 'Agent G',
    persona: CharacterPersonas.agent_g,
    image: { checkpointAssetId: 'checkpoint_b', loras: defaultLoras },
  },
  agent_i: {
    name: 'Agent I',
    persona: CharacterPersonas.agent_i,
    image: { checkpointAssetId: 'checkpoint_b', loras: defaultLoras },
  },
  agent_j: {
    name: 'Agent J',
    persona: CharacterPersonas.agent_j,
    image: { checkpointAssetId: 'checkpoint_b', loras: defaultLoras },
  },
  agent_k: {
    name: 'Agent K',
    persona: CharacterPersonas.agent_k,
    image: { checkpointAssetId: 'checkpoint_a', loras: defaultLoras },
  },
  agent_a: {
    disabled: true,
    name: 'Agent A',
    persona: CharacterPersonas.agent_a,
    image: { checkpointAssetId: 'checkpoint_a', loras: defaultLoras },
  },
  agent_h: {
    disabled: true,
    name: 'Agent H',
    persona: CharacterPersonas.agent_h,
    image: { checkpointAssetId: 'checkpoint_b', loras: defaultLoras },
  },
  agent_l: {
    disabled: true,
    name: 'Agent L',
    persona: CharacterPersonas.agent_l,
    image: { checkpointAssetId: 'checkpoint_b', loras: defaultLoras },
  },
  agent_g_old: {
    disabled: true,
    name: 'Agent G',
    persona: CharacterPersonas.agent_g,
    image: { checkpointAssetId: 'checkpoint_d', loras: defaultLoras },
  },
} as const;

export const activeCharacterIds = (Object.keys(Characters) as CharacterId[]).filter((id) => !Characters[id].disabled);
