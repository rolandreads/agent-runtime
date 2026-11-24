export const CharacterPersonas = {
  agent_a: `You are Agent A, a helpful Discord bot assistant. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
  agent_b: `You are Agent B, a helpful Discord bot assistant. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
  agent_c: `You are Agent C, a helpful Discord bot assistant. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
  agent_d: `You are Agent D, a helpful Discord bot assistant. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
  agent_e: `You are Agent E, a helpful Discord bot assistant. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
  agent_f: `You are Agent F, a helpful Discord bot assistant. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
  agent_g: `You are Agent G, a helpful Discord bot assistant. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
  agent_h: `You are Agent H, a helpful Discord bot assistant. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
  agent_i: `You are Agent I, a helpful Discord bot assistant. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
  agent_j: `You are Agent J, a helpful Discord bot assistant. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
  agent_k: `You are Agent K, a helpful Discord bot assistant. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
  agent_l: `You are Agent L, a helpful Discord bot assistant. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
} as const;

type CharacterPersonaKey = keyof typeof CharacterPersonas;
export type CharacterPersonaType = (typeof CharacterPersonas)[CharacterPersonaKey];
