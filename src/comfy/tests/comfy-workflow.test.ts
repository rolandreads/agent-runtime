import { test, expect, describe } from 'bun:test';
import { buildComfyWorkflow } from '../comfy-workflow';
import { Characters } from '../../characters/character-catalog';
import { ImageRecipe } from '../../image-requests/image-recipe';
import { SWINIR_4X_ASSET, type ComfyAsset, PIPELINE_C_VAE_ASSET, DETAIL_PASS_SAM_ASSET, DETAIL_PASS_BBOX_ASSET, PIPELINE_C_TEXT_ENCODER_ASSET } from '../comfy-assets';

const checkpoint = {
  sizeBytes: 100,
  group: 'checkpoints',
  filename: 'test-checkpoint.safetensors',
  source: { kind: 'r2', key: 'checkpoints/test-checkpoint.safetensors' },
} as const satisfies ComfyAsset;

const lora = {
  sizeBytes: 20,
  group: 'loras',
  filename: 'test-lora.safetensors',
  source: { kind: 'r2', key: 'loras/test-lora.safetensors' },
} as const satisfies ComfyAsset;

const zImageModel = {
  sizeBytes: 200,
  group: 'diffusion_models',
  filename: 'test-z-image.safetensors',
  source: { kind: 'r2', key: 'diffusion_models/test-z-image.safetensors' },
} as const satisfies ComfyAsset;

const standardInput = (detailPass: boolean) => ({
  checkpoint,
  width: 832,
  clipSkip: 2,
  height: 1216,
  positivePrompt: 'lorem ipsum',
  negativePrompt: 'bad quality',
  kind: 'standard-diffusion' as const,
  loras: [{ asset: lora, modelStrength: 0.4, clipStrength: 0.3 }],
  sampling: { seed: 1, steps: 22, cfg: 7, denoise: 0.8, samplerName: 'euler_ancestral', scheduler: 'normal' },
  ...(detailPass
    ? {
        detailPass: {
          steps: 11,
          denoise: 0.12,
          guideSize: 512,
          bboxCropFactor: 1.35,
          samModel: DETAIL_PASS_SAM_ASSET,
          bboxModel: DETAIL_PASS_BBOX_ASSET,
        },
      }
    : {}),
});

describe('buildComfyWorkflow', () => {
  test('builds Agent B with selectable model-only LoRAs and all direct-download dependencies', () => {
    const image = Characters.agent_b.image;
    const recipe = ImageRecipe.create({ seed: 42, prompt: 'A product render on a white studio table.', image, detailPassEnabled: false, loras: image.loras.map(({ id, strength }) => ({ id, strength: strength.current })) });
    const built = buildComfyWorkflow(recipe);
    expect(built.workflow).toMatchObject({
      save_final: { class_type: 'SaveImageJPEG' },
      sampler: { inputs: { model: ['lora_5', 0] } },
      empty_latent: { class_type: 'EmptyLatentImage' },
      text_encoder: { inputs: { type: 'pipeline_d' } },
      lora_5: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['lora_4', 0] } },
      lora_1: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['diffusion_model', 0] } },
      negative_prompt: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['positive_prompt', 0] } },
    });
    expect(built.requiredAssets.map(({ group }) => group)).toEqual(['diffusion_models', 'text_encoders', 'vae', ...image.loras.map(() => 'loras' as const)]);
    expect(built.requiredAssets.every(({ source }) => source.kind !== 'r2')).toBe(true);
    const unselected = buildComfyWorkflow(ImageRecipe.create({ seed: 42, prompt: recipe.requestedPrompt, image, detailPassEnabled: false, loras: [] }));
    expect(unselected.workflow).toMatchObject({ sampler: { inputs: { model: ['diffusion_model', 0] } } });
    expect(unselected.requiredAssets).toHaveLength(3);
  });

  test('builds a standard workflow and derives every referenced asset', () => {
    const builtWorkflow = buildComfyWorkflow(standardInput(true));

    expect(builtWorkflow.workflow).toMatchObject({
      sampler: { inputs: { denoise: 0.8 } },
      face_detailer: { class_type: 'FaceDetailer' },
      save_pre_detail_pass: { class_type: 'SaveImageJPEG' },
      face_sam_loader: { inputs: { device_mode: 'Prefer GPU' } },
      checkpoint_model: { inputs: { ckpt_name: checkpoint.filename } },
      lora_1: { inputs: { lora_name: lora.filename, strength_model: 0.4, strength_clip: 0.3 } },
    });
    expect(builtWorkflow.requiredAssets).toEqual([checkpoint, lora, DETAIL_PASS_BBOX_ASSET, DETAIL_PASS_SAM_ASSET]);
    expect(builtWorkflow.outputNodeIds).toEqual({ final: 'save_final', preDetailPass: 'save_pre_detail_pass' });
  });

  test('omits detail pass nodes and assets when the resolved input has no detail pass', () => {
    const builtWorkflow = buildComfyWorkflow(standardInput(false));

    expect(builtWorkflow.workflow.face_detailer).toBeUndefined();
    expect(builtWorkflow.workflow.save_pre_detail_pass).toBeUndefined();
    expect(builtWorkflow.requiredAssets).toEqual([checkpoint, lora]);
    expect(builtWorkflow.outputNodeIds).toEqual({ final: 'save_final' });
  });

  test('builds an image-space high-res pass and includes its model asset', () => {
    const builtWorkflow = buildComfyWorkflow({
      ...standardInput(false),
      highResPass: {
        cfg: 4,
        steps: 4,
        scale: 1.5,
        denoise: 0.2,
        scheduler: 'normal',
        upscaler: SWINIR_4X_ASSET,
        samplerName: 'euler_ancestral',
      },
    });

    expect(builtWorkflow.workflow).toMatchObject({
      save_final: { inputs: { images: ['highres_vae_decode', 0] } },
      highres_sampler: { inputs: { steps: 4, cfg: 4, denoise: 0.2 } },
      highres_upscale_model: { inputs: { model_name: SWINIR_4X_ASSET.filename } },
    });
    expect(builtWorkflow.requiredAssets).toEqual([checkpoint, lora, SWINIR_4X_ASSET]);
  });

  test('builds a Z-Image workflow and derives its complete dependency set', () => {
    const builtWorkflow = buildComfyWorkflow({
      width: 896,
      height: 1344,
      negativePrompt: '',
      kind: 'z-image-turbo',
      vae: PIPELINE_C_VAE_ASSET,
      diffusionModel: zImageModel,
      positivePrompt: 'lorem ipsum dolor',
      textEncoder: PIPELINE_C_TEXT_ENCODER_ASSET,
      loras: [{ asset: lora, modelStrength: 0.65, clipStrength: 0.65 }],
      sampling: { seed: 9, steps: 9, cfg: 1, denoise: 1, samplerName: 'res_multistep', scheduler: 'simple' },
    });

    expect(builtWorkflow.workflow).toMatchObject({
      vae: { class_type: 'VAELoader' },
      lora_1: { class_type: 'LoraLoader' },
      text_encoder: { class_type: 'CLIPLoader' },
      diffusion_model: { class_type: 'UNETLoader' },
      sampler: { inputs: { model: ['lora_1', 0] } },
    });
    expect(builtWorkflow.workflow.model_sampling).toBeUndefined();
    expect(builtWorkflow.requiredAssets.map((asset) => asset.group)).toEqual(['diffusion_models', 'text_encoders', 'vae', 'loras']);
  });

  test('applies an detail Z-Image model-sampling shift', () => {
    const builtWorkflow = buildComfyWorkflow({
      loras: [],
      width: 768,
      height: 1280,
      negativePrompt: '',
      kind: 'z-image-turbo',
      modelSamplingShift: 9,
      vae: PIPELINE_C_VAE_ASSET,
      diffusionModel: zImageModel,
      positivePrompt: 'natural framing',
      textEncoder: PIPELINE_C_TEXT_ENCODER_ASSET,
      sampling: { seed: 9, steps: 9, cfg: 1, denoise: 1, samplerName: 'euler', scheduler: 'simple' },
    });

    expect(builtWorkflow.workflow).toMatchObject({
      sampler: { inputs: { model: ['model_sampling', 0] } },
      model_sampling: { inputs: { shift: 9, model: ['diffusion_model', 0] } },
    });
  });
});
