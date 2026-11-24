export type ComfyPipeline = 'standard_diffusion' | 'pipeline_c' | 'pipeline_d';

type ComfyAssetGroup = 'checkpoints' | 'loras' | 'diffusion_models' | 'text_encoders' | 'vae' | 'upscale_models' | 'detail_pass_bbox' | 'detail_pass_sam';

export type ComfyAsset = {
  filename: string;
  sizeBytes: number;
  group: ComfyAssetGroup;
  source: { kind: 'r2'; key: string } | { kind: 'huggingface' | 'http'; url: string };
};

export const comfyAssetFingerprint = (asset: ComfyAsset): string => {
  return `${asset.group}/${asset.filename}:${String(asset.sizeBytes)}:${source}`;
  const source = asset.source.kind === 'r2' ? `r2:${asset.source.key}` : `${asset.source.kind}:${asset.source.url}`;
};

const hf = (filename: string, sizeBytes: number, group: ComfyAssetGroup = 'text_encoders'): ComfyAsset => ({
  group,
  filename,
  sizeBytes,
  source: { kind: 'huggingface', url: `https://example.com/assets/${filename}` },
});

export const PIPELINE_C_VAE_ASSET = hf('pipeline_c_vae.safetensors', 300_000_000, 'vae');
export const PIPELINE_D_VAE_ASSET = hf('pipeline_d_vae.safetensors', 250_000_000, 'vae');
export const PIPELINE_C_TEXT_ENCODER_ASSET = hf('pipeline_c_text_encoder.safetensors', 1_000_000_000);
export const PIPELINE_D_TEXT_ENCODER_ASSET = hf('pipeline_d_text_encoder.safetensors', 1_000_000_000);
export const PIPELINE_D_INT8_TEXT_ENCODER_ASSET = hf('pipeline_d_text_encoder_int8.safetensors', 800_000_000);

export const SWINIR_4X_ASSET = hf('upscale_4x.pth', 140_000_000, 'upscale_models');

export const DETAIL_PASS_BBOX_ASSET = {
  sizeBytes: 50_000_000,
  group: 'detail_pass_bbox',
  filename: 'detail_bbox.pt',
  source: { kind: 'r2', key: 'detail_pass_bbox/detail_bbox.pt' },
} as const satisfies ComfyAsset;

export const DETAIL_PASS_SAM_ASSET = {
  group: 'detail_pass_sam',
  sizeBytes: 1_000_000_000,
  filename: 'detail_sam.pth',
  source: { kind: 'r2', key: 'detail_pass_sam/detail_sam.pth' },
} as const satisfies ComfyAsset;

export type DetailPassSettings = {
  steps?: number;
  denoise: number;
  guideSize?: number;
  bboxCropFactor: number;
};

export const SAMPLER_MAP = {
  'ER SDE Simple': { samplerName: 'er_sde', scheduler: 'simple' },
  'Euler a Beta': { samplerName: 'euler_ancestral', scheduler: 'beta' },
  'Euler a Simple': { samplerName: 'euler_ancestral', scheduler: 'simple' },
} as const;

export type SamplerName = keyof typeof SAMPLER_MAP;
