export const COMFY_WORKER_REPOSITORY = 'docker.io/example/agent-runtime';

// Thin agent-runtime layer on Vast's host-cached ComfyUI template image; model assets are synced on demand.
const COMFY_WORKER_IMAGE_DIGEST = 'sha256:28ce6dcd85cb254fbda3b1081d6e49284713b4803cac97f4b38591c0c7c74086';

export type ComfyWorkerImageReference = `${typeof COMFY_WORKER_REPOSITORY}@${typeof COMFY_WORKER_IMAGE_DIGEST}`;

export const COMFY_WORKER_IMAGE_REFERENCE: ComfyWorkerImageReference = `${COMFY_WORKER_REPOSITORY}@${COMFY_WORKER_IMAGE_DIGEST}`;

export const isComfyWorkerImageReference = (reference: string): reference is ComfyWorkerImageReference => reference === COMFY_WORKER_IMAGE_REFERENCE;
