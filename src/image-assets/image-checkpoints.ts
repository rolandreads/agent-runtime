import { type ComfyAsset, type SamplerName, type ComfyPipeline, type DetailPassSettings } from '../comfy/comfy-assets';

export type ImageBaseModel = 'FamilyA' | 'FamilyB' | 'FamilyC' | 'FamilyD';

type CheckpointGeneration = {
  steps: number;
  width: number;
  height: number;
  cfgScale: number;
  clipSkip: number;
  aspectRatio: string;
  sampler: SamplerName;
  textEncoder?: ComfyAsset;
  comfyPipeline: ComfyPipeline;
  detailPass?: DetailPassSettings;
};

export type CheckpointAsset = {
  sourceUrl: string;
  displayName: string;
  comfyAsset: ComfyAsset;
  baseModel: ImageBaseModel;
  negativeTags: readonly string[];
  positiveTags: readonly string[];
  generation: CheckpointGeneration;
};

const mk = (params: {
  idLabel: string;
  pipeline: ComfyPipeline;
  baseModel: ImageBaseModel;
  detailPass?: DetailPassSettings;
}): CheckpointAsset => ({
  baseModel: params.baseModel,
  displayName: params.idLabel,
  positiveTags: ['lorem ipsum'],
  negativeTags: ['low quality', 'watermark'],
  sourceUrl: `https://example.com/models/${params.idLabel.toLowerCase().replace(/ /g, '-')}`,
  generation: {
    steps: 28,
    width: 832,
    cfgScale: 5,
    clipSkip: 2,
    height: 1216,
    aspectRatio: '2:3',
    sampler: 'Euler a Simple',
    comfyPipeline: params.pipeline,
    ...(params.detailPass ? { detailPass: params.detailPass } : {}),
  },
  comfyAsset: {
    group: 'checkpoints',
    sizeBytes: 1_000_000_000,
    filename: `${params.idLabel.toLowerCase().replace(/ /g, '_')}.safetensors`,
    source: { kind: 'r2', key: `checkpoints/${params.idLabel.toLowerCase().replace(/ /g, '_')}.safetensors` },
  },
});

const detail = { denoise: 0.35, bboxCropFactor: 1.8 } as const;

/** Generic deployable checkpoints — commercial model product names omitted. */
export const CheckpointAssets = {
  checkpoint_c: mk({ idLabel: 'Checkpoint C', baseModel: 'FamilyC', pipeline: 'pipeline_c' }),
  checkpoint_d: mk({ idLabel: 'Checkpoint D', baseModel: 'FamilyD', pipeline: 'pipeline_d' }),
  checkpoint_a: mk({ idLabel: 'Checkpoint A', baseModel: 'FamilyA', pipeline: 'standard_diffusion', detailPass: detail }),
  checkpoint_b: mk({ idLabel: 'Checkpoint B', baseModel: 'FamilyB', pipeline: 'standard_diffusion', detailPass: detail }),
} as const;

export type CheckpointAssetId = keyof typeof CheckpointAssets;
