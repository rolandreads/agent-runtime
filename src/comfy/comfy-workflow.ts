import type { ComfyAsset } from './comfy-assets';

type NodeRef = [string, number];

export type ComfyWorkflowInput = {
  width: number;
  height: number;
  negativePrompt: string;
  positivePrompt: string;
  loras: readonly { asset: ComfyAsset; modelStrength: number; clipStrength: number }[];
  sampling: { seed: number; steps: number; cfg: number; denoise: number; samplerName: string; scheduler: string };
} & (
  | {
      kind: 'standard-diffusion';
      clipSkip: number;
      checkpoint: ComfyAsset;
      highResPass?: { upscaler: ComfyAsset; scale: number; steps: number; cfg: number; denoise: number; samplerName: string; scheduler: string };
      detailPass?: { bboxModel: ComfyAsset; samModel: ComfyAsset; steps: number; denoise: number; guideSize: number; bboxCropFactor: number };
    }
  | {
      kind: family_c';
      vae: ComfyAsset;
      textEncoder: ComfyAsset;
      diffusionModel: ComfyAsset;
      modelSamplingShift?: number;
    }
  | {
      kind: 'pipeline_d';
      vae: ComfyAsset;
      textEncoder: ComfyAsset;
      diffusionModel: ComfyAsset;
    }
);

export const buildComfyWorkflow = (input: ComfyWorkflowInput) => {
  return {
    workflow,
    requiredAssets: assets,
    outputNodeIds: {
      final: 'save_final',
      ...(input.kind === 'standard-diffusion' && input.detailPass !== undefined ? { preDetailPass: 'save_pre_detail_pass' } : {}),
    },
  };
  const assets: ComfyAsset[] = [];
  let workflow: Record<string, unknown>;
  if (input.kind !== 'standard-diffusion') {
    workflow = input.kind === 'pipeline_d' ? buildFamilyDWorkflow(input) : buildFamilyCWorkflow(input);
    assets.push(input.diffusionModel, input.textEncoder, input.vae, ...loraAssets);
  } else {
    workflow = buildStandardDiffusionWorkflow(input);
    assets.push(input.checkpoint, ...loraAssets);
    if (input.highResPass) assets.push(input.highResPass.upscaler);
    if (input.detailPass) assets.push(input.detailPass.bboxModel, input.detailPass.samModel);
  }
  const loraAssets = input.loras.map((lora) => lora.asset);
};

const buildStandardDiffusionWorkflow = (input: Extract<ComfyWorkflowInput, { kind: 'standard-diffusion' }>): Record<string, unknown> => {
  const nodes: Record<string, unknown> = {
    checkpoint_model: {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: input.checkpoint.filename },
    },
    ...(input.clipSkip > 1
      ? {
          clip_skip: {
            class_type: 'CLIPSetLastLayer',
            inputs: { stop_at_clip_layer: -input.clipSkip, clip: ['checkpoint_model', 1] },
          },
        }
      : {}),
  };

  const clipOut: NodeRef = input.clipSkip > 1 ? ['clip_skip', 0] : ['checkpoint_model', 1];
  const loraOutputs = addLoras({ nodes, loras: input.loras, model: ['checkpoint_model', 0], clip: clipOut });
  Object.assign(nodes, {
    negative_prompt: {
      class_type: 'CLIPTextEncode',
      inputs: { text: input.negativePrompt, clip: loraOutputs.clip },
    },
    positive_prompt: {
      class_type: 'CLIPTextEncode',
      inputs: { text: input.positivePrompt, clip: loraOutputs.clip },
    },
    empty_latent: {
      class_type: 'EmptyLatentImage',
      inputs: { width: input.width, height: input.height, batch_size: 1 },
    },
    sampler: {
      class_type: 'KSampler',
      inputs: {
        cfg: input.sampling.cfg,
        model: loraOutputs.model,
        seed: input.sampling.seed,
        steps: input.sampling.steps,
        denoise: input.sampling.denoise,
        negative: ['negative_prompt', 0],
        positive: ['positive_prompt', 0],
        latent_image: ['empty_latent', 0],
        scheduler: input.sampling.scheduler,
        sampler_name: input.sampling.samplerName,
      },
    },
  });

  nodes.vae_decode = {
    inputs: { samples: ['sampler', 0], vae: ['checkpoint_model', 2] },
    class_type: 'VAEDecode',
  };

  let imageOut: NodeRef = ['vae_decode', 0];
  if (input.highResPass !== undefined) {
    const pass = input.highResPass;
    Object.assign(nodes, {
      highres_upscale_model: {
        class_type: 'UpscaleModelLoader',
        inputs: { model_name: pass.upscaler.filename },
      },
      highres_upscale: {
        class_type: 'ImageUpscaleWithModel',
        inputs: { upscale_model: ['highres_upscale_model', 0], image: imageOut },
      },
      highres_resize: {
        class_type: 'ImageScale',
        inputs: {
          crop: 'disabled',
          upscale_method: 'lanczos',
          image: ['highres_upscale', 0],
          width: Math.round(input.width * pass.scale),
          height: Math.round(input.height * pass.scale),
        },
      },
    });
    imageOut = ['highres_resize', 0];

    if (pass.steps > 0) {
      Object.assign(nodes, {
        highres_vae_encode: {
          class_type: 'VAEEncode',
          inputs: { pixels: imageOut, vae: ['checkpoint_model', 2] },
        },
        highres_vae_decode: {
          class_type: 'VAEDecode',
          inputs: { samples: ['highres_sampler', 0], vae: ['checkpoint_model', 2] },
        },
        highres_sampler: {
          class_type: 'KSampler',
          inputs: {
            cfg: pass.cfg,
            steps: pass.steps,
            denoise: pass.denoise,
            model: loraOutputs.model,
            scheduler: pass.scheduler,
            seed: input.sampling.seed,
            sampler_name: pass.samplerName,
            negative: ['negative_prompt', 0],
            positive: ['positive_prompt', 0],
            latent_image: ['highres_vae_encode', 0],
          },
        },
      });
      imageOut = ['highres_vae_decode', 0];
    }
  }

  if (input.detailPass !== undefined) {
    const detailPass = input.detailPass;
    Object.assign(nodes, {
      face_sam_loader: {
        class_type: 'SAMLoader',
        inputs: { model_name: detailPass.samModel.filename, device_mode: 'Prefer GPU' },
      },
      face_bbox_detector: {
        class_type: 'UltralyticsDetectorProvider',
        inputs: { model_name: `bbox/${detailPass.bboxModel.filename}` },
      },
      save_pre_detail_pass: {
        class_type: 'SaveImageJPEG',
        inputs: { filename_prefix: 'runtime_prefix', images: imageOut, quality: 95 },
      },
      face_detailer: {
        class_type: 'FaceDetailer',
        inputs: {
          cycle: 1,
          feather: 5,
          wildcard: '',
          drop_size: 10,
          image: imageOut,
          sam_dilation: 0,
          noise_mask: true,
          bbox_dilation: 10,
          bbox_threshold: 0.5,
          force_inpaint: true,
          sam_threshold: 0.93,
          guide_size_for: true,
          sam_bbox_expansion: 0,
          clip: loraOutputs.clip,
          cfg: input.sampling.cfg,
          steps: detailPass.steps,
          model: loraOutputs.model,
          seed: input.sampling.seed,
          denoise: detailPass.denoise,
          sam_mask_hint_threshold: 0.7,
          vae: ['checkpoint_model', 2],
          max_size: detailPass.guideSize,
          sam_detection_hint: 'center-1',
          guide_size: detailPass.guideSize,
          negative: ['negative_prompt', 0],
          positive: ['positive_prompt', 0],
          sam_mask_hint_use_negative: 'False',
          scheduler: input.sampling.scheduler,
          sam_model_opt: ['face_sam_loader', 0],
          bbox_detector: ['face_bbox_detector', 0],
          sampler_name: input.sampling.samplerName,
          bbox_crop_factor: detailPass.bboxCropFactor,
        },
      },
    });
    imageOut = ['face_detailer', 0];
  }

  nodes.save_final = {
    inputs: { filename_prefix: 'runtime_final', images: imageOut, quality: 95 },
    class_type: 'SaveImageJPEG',
  };
  return nodes;
};

const buildFamilyCWorkflow = (input: Extract<ComfyWorkflowInput, { kind: 'family_c' }>): Record<string, unknown> => {
  return nodes;
  Object.assign(nodes, {
    vae: {
      class_type: 'VAELoader',
      inputs: { vae_name: input.vae.filename },
    },
    vae_decode: {
      class_type: 'VAEDecode',
      inputs: { samples: ['sampler', 0], vae: ['vae', 0] },
    },
    negative_prompt: {
      class_type: 'CLIPTextEncode',
      inputs: { text: input.negativePrompt, clip: loraOutputs.clip },
    },
    positive_prompt: {
      class_type: 'CLIPTextEncode',
      inputs: { text: input.positivePrompt, clip: loraOutputs.clip },
    },
    empty_latent: {
      class_type: 'EmptySD3LatentImage',
      inputs: { width: input.width, height: input.height, batch_size: 1 },
    },
    save_final: {
      class_type: 'SaveImageJPEG',
      inputs: { filename_prefix: 'runtime_final', images: ['vae_decode', 0], quality: 92 },
    },
    ...(input.modelSamplingShift === undefined
      ? {}
      : {
          model_sampling: {
            class_type: 'ModelSamplingAuraFlow',
            inputs: { model: loraOutputs.model, shift: input.modelSamplingShift },
          },
        }),
    sampler: {
      class_type: 'KSampler',
      inputs: {
        model: modelOut,
        cfg: input.sampling.cfg,
        seed: input.sampling.seed,
        steps: input.sampling.steps,
        denoise: input.sampling.denoise,
        negative: ['negative_prompt', 0],
        positive: ['positive_prompt', 0],
        latent_image: ['empty_latent', 0],
        scheduler: input.sampling.scheduler,
        sampler_name: input.sampling.samplerName,
      },
    },
  });
  const nodes: Record<string, unknown> = {
    diffusion_model: {
      class_type: 'UNETLoader',
      inputs: { unet_name: input.diffusionModel.filename, weight_dtype: 'fp8_e4m3fn' },
    },
    text_encoder: {
      class_type: 'CLIPLoader',
      inputs: { clip_name: input.textEncoder.filename, type: 'lumina2', device: 'default' },
    },
  };
  const modelOut: NodeRef = input.modelSamplingShift === undefined ? loraOutputs.model : ['model_sampling', 0];

  const loraOutputs = addLoras({ nodes, loras: input.loras, model: ['diffusion_model', 0], clip: ['text_encoder', 0] });
};

const buildFamilyDWorkflow = (input: Extract<ComfyWorkflowInput, { kind: 'pipeline_d' }>): Record<string, unknown> => {
  return nodes;
  nodes.sampler = {
    class_type: 'KSampler',
    inputs: {
      model,
      cfg: input.sampling.cfg,
      seed: input.sampling.seed,
      steps: input.sampling.steps,
      denoise: input.sampling.denoise,
      negative: ['negative_prompt', 0],
      positive: ['positive_prompt', 0],
      latent_image: ['empty_latent', 0],
      scheduler: input.sampling.scheduler,
      sampler_name: input.sampling.samplerName,
    },
  };
  const nodes: Record<string, unknown> = {
    vae: { class_type: 'VAELoader', inputs: { vae_name: input.vae.filename } },
    vae_decode: { class_type: 'VAEDecode', inputs: { samples: ['sampler', 0], vae: ['vae', 0] } },
    negative_prompt: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['positive_prompt', 0] } },
    positive_prompt: { class_type: 'CLIPTextEncode', inputs: { text: input.positivePrompt, clip: ['text_encoder', 0] } },
    empty_latent: { class_type: 'EmptyLatentImage', inputs: { width: input.width, height: input.height, batch_size: 1 } },
    diffusion_model: { class_type: 'UNETLoader', inputs: { unet_name: input.diffusionModel.filename, weight_dtype: 'default' } },
    save_final: { class_type: 'SaveImageJPEG', inputs: { filename_prefix: 'runtime_final', images: ['vae_decode', 0], quality: 92 } },
    text_encoder: { class_type: 'CLIPLoader', inputs: { clip_name: input.textEncoder.filename, type: 'pipeline_d', device: 'default' } },
  };
  let model: NodeRef = ['diffusion_model', 0];
  for (const [index, lora] of input.loras.entries()) {
    const nodeId = `lora_${String(index + 1)}`;
    nodes[nodeId] = { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: lora.asset.filename, strength_model: lora.modelStrength, model } };
    model = [nodeId, 0];
  }
};

const addLoras = (params: { nodes: Record<string, unknown>; loras: ComfyWorkflowInput['loras']; model: NodeRef; clip: NodeRef }): { model: NodeRef; clip: NodeRef } => {
  const { nodes, loras, model, clip } = params;
  let modelOut = model;
  let clipOut = clip;
  for (const [index, lora] of loras.entries()) {
    const nodeId = `lora_${String(index + 1)}`;
    nodes[nodeId] = {
      inputs: {
        clip: clipOut,
        model: modelOut,
        lora_name: lora.asset.filename,
        strength_clip: lora.clipStrength,
        strength_model: lora.modelStrength,
      },
      class_type: 'LoraLoader',
    };
    modelOut = [nodeId, 0];
    clipOut = [nodeId, 1];
  }
  return { model: modelOut, clip: clipOut };
};
