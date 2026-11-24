import type { ComfyAsset } from '../comfy/comfy-assets';
import type { ImageBaseModel } from './image-checkpoints';

export type LoraConfig = { id: LoraAssetId; strength: number };
export type LoraStrength = { current: number; min: number; max: number };

export type LoraAsset = {
  trigger?: string;
  sourceUrl: string;
  displayName: string;
  comfyAsset: ComfyAsset;
  baseModels: readonly ImageBaseModel[];
};

export type LoraAssetId = keyof typeof LoraAssets;

const lora = (name: string, filename: string): LoraAsset => ({
  displayName: name,
  trigger: 'lorem ipsum',
  sourceUrl: `https://example.com/adapters/${filename}`,
  baseModels: ['FamilyA', 'FamilyB', 'FamilyC', 'FamilyD'],
  comfyAsset: {
    filename,
    group: 'loras',
    sizeBytes: 50_000_000,
    source: { kind: 'r2', key: `loras/${filename}` },
  },
});

/** Generic adapters — commercial adapter product names omitted. */
export const LoraAssets = {
  style_a: lora('Style A', 'style_a.safetensors'),
  style_b: lora('Style B', 'style_b.safetensors'),
  style_c: lora('Style C', 'style_c.safetensors'),
  detail_boost: lora('Detail Boost', 'detail_boost.safetensors'),
  lighting_soft: lora('Soft Lighting', 'lighting_soft.safetensors'),
} as const;
