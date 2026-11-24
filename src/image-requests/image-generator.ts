import type { ComfyAsset } from '../comfy/comfy-assets';
import type { ComfyPromptResult } from '../comfy/comfy-client';

type ImageGenerationAttempt = { readonly completion: Promise<ComfyPromptResult> };
export type ImageGenerationSubmitResult = { kind: 'accepted'; attempt: ImageGenerationAttempt } | { kind: 'busy' };

export type ImageGenerationSubmission = { workflow: Record<string, unknown>; requiredAssets: readonly ComfyAsset[] };

export type ImageGenerator = {
  connectedWorkerCount(): number;
  prefetch(requiredAssets: readonly ComfyAsset[]): Promise<void>;
  submit(submission: ImageGenerationSubmission): Promise<ImageGenerationSubmitResult>;
};
