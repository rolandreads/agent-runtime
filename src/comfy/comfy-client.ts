import { z } from 'zod';
import { settings } from '../settings';
import { randomUUID } from 'node:crypto';
import type { ComfyPromptId } from '../utils/brands';

export type NodeTiming = {
  nodeId: string;
  startedAt: number;
  durationMs: number;
};

const comfyPromptResponseSchema = z.object({ prompt_id: z.string().min(1), node_errors: z.record(z.string(), z.unknown()).nullish() });
const comfyImageMetadataSchema = z.object({ type: z.string().min(1), filename: z.string().min(1), subfolder: z.string().nullish() });
type ComfyImageMetadata = z.infer<typeof comfyImageMetadataSchema>;

export type ComfyOutputImage = { nodeId: string; bytes: Uint8Array; metadata: ComfyImageMetadata };
export type ComfyPromptResult = { images: ComfyOutputImage[]; nodeTimings: NodeTiming[] };

const comfyEnvelopeSchema = z.object({ type: z.string(), data: z.unknown() });
const comfyPromptDataSchema = z.object({ prompt_id: z.string().min(1) });
const comfyMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('executing'), data: comfyPromptDataSchema.extend({ node: z.string().nullish() }) }),
  z.object({ type: z.literal('executed'), data: comfyPromptDataSchema.extend({ node: z.string().min(1), output: z.object({ images: z.array(comfyImageMetadataSchema).nullish() }).nullable() }) }),
  z.object({ type: z.literal(['execution_error', 'execution_interrupted']), data: comfyPromptDataSchema.extend({ exception_type: z.string().nullish(), exception_message: z.string().nullish() }) }),
  z.object({ type: z.literal('execution_success'), data: comfyPromptDataSchema }),
]);
const comfyMessageTypes = new Set<string>(comfyMessageSchema.options.flatMap((schema) => [...schema.shape.type.values]));

type ComfyPrompt = {
  id: ComfyPromptId;
  activeStartedAt: number;
  nodeTimings: NodeTiming[];
  activeNodeId: string | null;
  timer: ReturnType<typeof setTimeout>;
  pendingImages: Omit<ComfyOutputImage, 'bytes'>[];
  completion: PromiseWithResolvers<ComfyPromptResult>;
};

export class ComfyClient {
  private readonly caCert: string;
  private readonly workerHost: string;
  private readonly workerPort: number;
  private readonly bearerToken: string;
  private socket: WebSocket | null = null;
  private readonly clientId = randomUUID();
  private readonly prompts = new Map<ComfyPromptId, ComfyPrompt>();
  private readonly onTransportLost: (error: unknown) => void;

  constructor(opts: {
    caCert: string;
    workerHost: string;
    bearerToken: string;
    workerPort?: number;
    onTransportLost: (error: unknown) => void;
  }) {
    this.caCert = opts.caCert;
    this.workerHost = opts.workerHost;
    this.bearerToken = opts.bearerToken;
    this.workerPort = opts.workerPort ?? 443;
    this.onTransportLost = opts.onTransportLost;
  }

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;

    const socket = new WebSocket(`wss://${this.workerHost}:${String(this.workerPort)}/ws?clientId=${encodeURIComponent(this.clientId)}`, { headers: { Authorization: `Bearer ${this.bearerToken}` }, tls: { ca: this.caCert } });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error('Comfy websocket connect timed out'));
      }, settings.get().gpu.comfyTimeoutMs);

      socket.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.addEventListener('error', () => {
        clearTimeout(timeout);
        socket.close();
        reject(new Error('Comfy websocket connect failed'));
      });
    });

    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      void this.handleSocketMessage(event).catch((error: unknown) => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.rejectPrompts(error);
        socket.close();
        this.onTransportLost(error);
      });
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      const error = new Error('Comfy websocket disconnected');
      this.rejectPrompts(error);
      this.onTransportLost(error);
    });

    this.socket = socket;
  }

  disconnect(): void {
    const socket = this.socket;
    this.socket = null;
    this.rejectPrompts(new Error('Comfy client disconnected'));
    socket?.close();
  }

  async submit(workflow: Record<string, unknown>): Promise<{ completion: Promise<ComfyPromptResult> }> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Comfy websocket is not connected');
    const response = await this.fetch('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: this.clientId }),
    });

    const payload = comfyPromptResponseSchema.parse(await response.json());

    if (payload.node_errors && Object.keys(payload.node_errors).length > 0) {
      const errorNodes = Object.keys(payload.node_errors).join(', ');
      throw new Error(`Comfy /prompt has node errors in nodes: ${errorNodes}`);
    }

    if (this.socket !== socket || socket?.readyState !== WebSocket.OPEN) throw new Error('Comfy websocket disconnected during prompt submission');

    const promptId = payload.prompt_id as ComfyPromptId;
    const completion = Promise.withResolvers<ComfyPromptResult>();
    this.prompts.set(promptId, {
      completion,
      id: promptId,
      nodeTimings: [],
      pendingImages: [],
      activeNodeId: null,
      activeStartedAt: Date.now(),
      timer: setTimeout(() => { this.settlePrompt(promptId)?.completion.reject(new Error('Comfy prompt execution timed out')); }, settings.get().gpu.promptTimeoutMs),
    });
    return { completion: completion.promise };
  }

  private settlePrompt(promptId: ComfyPromptId): ComfyPrompt | undefined {
    const prompt = this.prompts.get(promptId);
    if (!prompt) return;
    this.prompts.delete(promptId);
    clearTimeout(prompt.timer);
    return prompt;
  }

  private rejectPrompts(error: unknown): void {
    const prompts = [...this.prompts.values()];
    this.prompts.clear();
    for (const prompt of prompts) {
      clearTimeout(prompt.timer);
      prompt.completion.reject(error);
    }
  }

  private async handleSocketMessage(event: MessageEvent): Promise<void> {
    if (typeof event.data !== 'string') return;
    const envelope = comfyEnvelopeSchema.parse(JSON.parse(event.data));
    if (!comfyMessageTypes.has(envelope.type)) return;
    const promptId = comfyPromptDataSchema.parse(envelope.data).prompt_id as ComfyPromptId;
    const prompt = this.prompts.get(promptId);
    if (!prompt) return;
    const parsed = comfyMessageSchema.safeParse(envelope);
    if (!parsed.success) {
      this.settlePrompt(promptId)?.completion.reject(parsed.error);
      return;
    }
    const message = parsed.data;

    if (message.type === 'executing') {
      this.recordNodeTiming(prompt, message.data.node ?? null);
    }
    if (message.type === 'executed') {
      const images = message.data.output?.images ?? [];
      if (images.length === 0) return;
      const nodeId = message.data.node;
      prompt.pendingImages.push(...images.map((metadata) => ({ nodeId, metadata })));
      return;
    }
    if (message.type === 'execution_error' || message.type === 'execution_interrupted') {
      this.settlePrompt(promptId)?.completion.reject(message.data?.exception_message ?? message.data?.exception_type ?? message.type);
      return;
    }
    if (message.type === 'execution_success') {
      this.recordNodeTiming(prompt, null);
      try {
        const images = await Promise.all(
          prompt.pendingImages.map(async (image) => ({
            ...image,
            bytes: await this.fetchImage(image.metadata),
          })),
        );
        this.settlePrompt(prompt.id)?.completion.resolve({ images, nodeTimings: prompt.nodeTimings });
      } catch (error) {
        this.settlePrompt(prompt.id)?.completion.reject(error);
      }
      return;
    }
  }

  private recordNodeTiming(prompt: ComfyPrompt, nodeId: string | null): void {
    const now = Date.now();
    if (prompt.activeNodeId !== null) {
      prompt.nodeTimings.push({
        nodeId: prompt.activeNodeId,
        startedAt: prompt.activeStartedAt,
        durationMs: Math.max(0, now - prompt.activeStartedAt),
      });
    }
    prompt.activeNodeId = nodeId;
    prompt.activeStartedAt = now;
  }

  private async fetchImage(image: ComfyImageMetadata): Promise<Uint8Array> {
    const params = new URLSearchParams({ filename: image.filename, type: image.type, ...(image.subfolder ? { subfolder: image.subfolder } : {}) });
    const response = await this.fetch(`/view?${params.toString()}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  private async fetch(path: string, request: RequestInit = {}): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.set('Authorization', `Bearer ${this.bearerToken}`);
    let response: Response;
    try {
      response = await fetch(`https://${this.workerHost}:${String(this.workerPort)}${path}`, {
        headers,
        ...request,
        tls: { ca: this.caCert },
        signal: AbortSignal.timeout(settings.get().gpu.comfyTimeoutMs),
      });
    } catch (error) {
      this.rejectPrompts(error);
      this.onTransportLost(error);
      throw error;
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Comfy ${path} failed: ${response.status} ${body.slice(0, 500)}`);
    }
    return response;
  }
}
