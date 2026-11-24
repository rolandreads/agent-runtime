import type { GeneratedImageId } from '../utils/brands';
import type { LoraConfig } from '../image-assets/image-loras';

export const ImageActions = {
  animate: { label: 'animate', emoji: '🪄' },
  random_style: { label: 'style', emoji: '🎲' },
  reroll_seed: { label: 'reroll', emoji: '🎲' },
  random_camera: { label: 'camera', emoji: '🎲' },
  random_composition: { label: 'composition', emoji: '🎲' },
} as const;

export type ImageActionKind = keyof typeof ImageActions;

export const ImageActionKinds: readonly ImageActionKind[] = Object.keys(ImageActions) as ImageActionKind[];

export class GeneratedImageUnavailableError extends Error {
  constructor(frontendMessageId: string) {
    super(`Frontend message ${frontendMessageId} has no generated image for this user and character`);
    this.name = 'GeneratedImageUnavailableError';
  }
}

export type GeneratedImageSource = {
  prompt: string;
  imageId: GeneratedImageId;
  loras: readonly LoraConfig[];
};

export type ImageSettings = { detailPassEnabled: boolean; loras: readonly LoraConfig[] };
