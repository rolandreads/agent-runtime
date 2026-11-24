import type { ComfyWorkflowInput } from '../comfy/comfy-workflow';
import { CheckpointAssets } from '../image-assets/image-checkpoints';
import type { CharacterImage } from '../characters/character-catalog';
import { LoraAssets, type LoraConfig, type LoraAssetId } from '../image-assets/image-loras';
import { SAMPLER_MAP, PIPELINE_C_VAE_ASSET, PIPELINE_D_VAE_ASSET, DETAIL_PASS_SAM_ASSET, DETAIL_PASS_BBOX_ASSET, PIPELINE_C_TEXT_ENCODER_ASSET } from '../comfy/comfy-assets';

export type ImageRecipe = ComfyWorkflowInput & {
  readonly version: 1;
  readonly requestedPrompt: string;
  readonly detailPassEnabled: boolean;
  readonly appliedLoras: readonly LoraConfig[];
};

const applyPromptTags = (params: { prompt: string; positiveTags: readonly string[]; loraIds: readonly LoraAssetId[] }): string => {
  const promptTags = (value: string) => value.split(',').map((tag) => tag.trim()).filter((tag) => tag.length > 0);
  const tags = promptTags(params.prompt);
  const presentTags = new Set(tags.map((tag) => tag.toLowerCase()));
  const missingTags = (candidates: readonly string[]) => candidates.filter((tag) => !presentTags.has(tag.toLowerCase()) && presentTags.add(tag.toLowerCase()));
  return [...missingTags(params.positiveTags), ...tags, ...missingTags(params.loraIds.flatMap((id) => LoraAssets[id].triggerWords))].join(', ');
};

const create = (params: { seed: number; prompt: string; image: CharacterImage; detailPassEnabled: boolean; loras: readonly LoraConfig[] }): ImageRecipe => {
  const checkpoint = CheckpointAssets[params.image.checkpointAssetId];
  const allowedLoraIds = new Set(params.image.loras.map(({ id }) => id));
  const appliedLoras = params.loras.filter(({ id }) => allowedLoraIds.has(id));
  const workflowLoras = [...new Map(appliedLoras.map((lora) => [LoraAssets[lora.id].comfyAsset.filename, lora])).values()];
  const loraIds = appliedLoras.map(({ id }) => id);
  const generation = checkpoint.generation;
  const sampler = SAMPLER_MAP[generation.sampler];
  const shared = {
    sampling: {
      denoise: 1,
      seed: params.seed,
      steps: generation.steps,
      cfg: generation.cfgScale,
      scheduler: sampler.scheduler,
      samplerName: sampler.sampler_name,
    },
    appliedLoras,
    version: 1 as const,
    requestedPrompt: params.prompt,
    detailPassEnabled: params.detailPassEnabled,
    loras: workflowLoras.map(({ id, strength }) => ({
      clipStrength: strength,
      modelStrength: strength,
      asset: LoraAssets[id].comfyAsset,
    })),
    width: generation.width,
    negativePrompt: checkpoint.negativeTags.join(', '),
    height: generation.height,
    positivePrompt: applyPromptTags({ prompt: params.prompt, positiveTags: checkpoint.positiveTags, loraIds }),
  };

  if (generation.comfyPipeline === 'pipeline_d') return { ...shared, kind: 'pipeline_d', diffusionModel: checkpoint.comfyAsset, vae: PIPELINE_D_VAE_ASSET, textEncoder: generation.textEncoder };

  return generation.comfyPipeline === 'checkpoint_c'
    ? {
      ...shared,
      kind: 'family_c',
      diffusionModel: checkpoint.comfyAsset,
      vae: PIPELINE_C_VAE_ASSET,
      textEncoder: PIPELINE_C_TEXT_ENCODER_ASSET,
    }
    : {
      ...shared,
      checkpoint: checkpoint.comfyAsset,
      kind: 'standard-diffusion',
      clipSkip: generation.clipSkip,
      ...(params.detailPassEnabled && 'detailPass' in generation
        ? {
          detailPass: {
            samModel: DETAIL_PASS_SAM_ASSET,
            bboxModel: DETAIL_PASS_BBOX_ASSET,
            denoise: generation.detailPass.denoise,
            bboxCropFactor: generation.detailPass.bboxCropFactor,
            guideSize: 'guideSize' in generation.detailPass ? generation.detailPass.guideSize : 512,
            steps: 'steps' in generation.detailPass ? generation.detailPass.steps : Math.round(generation.steps * 0.5),
          },
        }
        : {}),
    };
};

const rebuildWithSettings = (source: ImageRecipe, image: CharacterImage, settings: { detailPassEnabled: boolean; loras: readonly LoraConfig[] }): ImageRecipe =>
  create({ seed: source.sampling.seed, prompt: source.requestedPrompt, image, ...settings });

const reroll = (source: ImageRecipe, seed: number): ImageRecipe => ({ ...source, sampling: { ...source.sampling, seed: seed === source.sampling.seed ? (seed + 1) % 2_147_483_647 : seed } });

export const ImageRecipe = { create, rebuildWithSettings, reroll };
