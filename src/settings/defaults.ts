import { HOUR_MS, MINUTE_MS, SECOND_MS } from '../utils';
import type { GrokVideoResolution } from '../grok/grok-video';

export const defaultSettings = {
  notes: {
    maxLength: { value: 10_000, description: 'Max characters stored in persistent user notes.' },
  },
  onboarding: {
    guildId: { value: '000000000000000000', description: 'Discord server whose new members Agent K welcomes with a DM.' },
  },
  turn: {
    maxModelRounds: { value: 3, description: 'How many model rounds a turn may run, including the first and later corrective rounds.' },
  },
  gate: { value: 'open', values: ['open', 'text_only', 'closed'] as const, description: 'open = chat and images; text_only = chat only; closed = reject everything.' },
  admission: { value: 'allowlist', values: ['allowlist', 'everyone'] as const, description: 'allowlist = only operator-admitted users; everyone = auto-admit new users (revoked stay blocked).' },
  imageTool: {
    promptMaxLength: { value: 2_000 },
    animatePromptMaxLength: { value: 1_000 },
    promptMaxItems: { value: 2, description: 'Maximum prompts/images to generate per tool call' },
    promptMinItems: { value: 1, description: 'Minimum prompts/images to generate per tool call' },
  },
  grok: {
    durationSec: { value: 5 },
    maxWaitMs: { value: 5 * MINUTE_MS },
    pollIntervalMs: { value: SECOND_MS },
    refreshSkewMs: { value: 5 * MINUTE_MS },
    model: { value: 'grok-imagine-video-1.5' },
    sourceArchiveRetryMs: { value: 30 * SECOND_MS },
    resolution: { value: '480p', values: ['480p', '720p', '1080p'] as const satisfies readonly GrokVideoResolution[] },
  },
  llm: {
    maxRetries: { value: 2 },
    timeoutMs: { value: MINUTE_MS },
    maxOutputTokens: { value: 2_000 },
    provider: { value: 'openrouter' },
    maxRetryDelayMs: { value: 30 * SECOND_MS },
    model: { value: 'deepseek/deepseek-v4-pro-0813' },
    replyMaxLength: { value: 2_000, description: 'Max characters for a user-facing tool reply.' },
    thinkingLevel: { value: 'off', values: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const },
    conversationHistoryMaxAgeMs: { value: 6 * HOUR_MS, description: 'Completed turns older than this stay out of the LLM context.' },
    openRouterProviders: { value: ['alibaba', 'siliconflow'], description: 'OpenRouter provider slugs tried in order; requests never fall back outside this list.' },
    conversationHistoryTurnStep: { value: 4, description: 'History window step: the LLM sees between step and 2*step-1 recent completed turns, and the window start only moves every step turns so consecutive prompts share a cacheable prefix.' },
  },
  gpu: {
    maxWorkers: { value: 3, description: 'Maximum GPU workers the application may target.' },
    vastApiTimeoutMs: { value: 15 * SECOND_MS, description: 'Timeout for one Vast HTTP request.' },
    vastApiAttempts: { value: 3, description: 'GET/POST tries against the Vast API before failing.' },
    minWorkers: { value: 0, description: 'Minimum desired GPU workers; zero allows a fully cold fleet.' },
    vastApiRetryJitterMs: { value: 250, description: 'Random extra wait added between Vast API retries.' },
    sshConnectTimeoutSec: { value: 1, description: 'How long an SSH readiness probe may wait to connect.' },
    readyAttempts: { value: 300, description: 'Times we poll a Vast instance before giving up on readiness.' },
    readyPollIntervalMs: { value: SECOND_MS, description: 'Wait between Vast state and SSH readiness probes.' },
    comfyTimeoutMs: { value: 15 * SECOND_MS, description: 'Timeout for Comfy websocket connect and HTTP calls.' },
    queueDepth: { value: 2, description: 'Max in-flight Comfy prompts on the worker: one executing and one pending.' },
    vastApiRetryBaseMs: { value: 500, description: 'Base wait before retrying a Vast API call; doubles each attempt.' },
    activeUsersPerWorker: { value: 2, description: 'Distinct queued or processing image users targeted per GPU worker.' },
    coldStartCandidates: { value: 3, description: 'Concurrent candidates in the zero-GPU cold-start hedge, capped by maxWorkers.' },
    promptTimeoutMs: { value: 5 * MINUTE_MS, description: 'Fail a submitted Comfy prompt that has not finished within this long.' },
    hibernateIdleMs: { value: 5 * MINUTE_MS, description: 'Destroy the rented Vast instance after this long with nothing in flight.' },
    offer: {
      diskGb: { value: 100 },
      maxHourlyUsd: { value: 0.9 },
      gpuName: { value: 'RTX 4090' },
      minReliability: { value: 0.9 },
      minInetDownMbps: { value: 3500 },
      minCudaVersion: { value: 13, description: 'The worker image ships torch for CUDA 13; hosts whose driver supports less cannot run it.' },
      minDiskBwMbps: { value: 3000, description: 'Image extraction and asset sync are disk-write bound; live 4090 offers cluster at 3000-8000 MB/s.' },
      preferredMaxDownloadCostPerGbUsd: { value: 0.01, description: 'Prefer offers at or below this download price without failing capacity when none are available.' },
    },
  },
} as const;

export type Gate = (typeof defaultSettings.gate.values)[number];

type CatalogValues<T> = T extends { values: readonly (infer U)[] }
  ? U
  : T extends { value: infer V }
  ? V extends number
  ? number
  : V extends string
  ? string
  : V extends boolean
  ? boolean
  : V
  : { -readonly [K in keyof T]: CatalogValues<T[K]> };

export type SettingSnapshot = CatalogValues<typeof defaultSettings>;

type SettingPathOf<T, Prefix extends string = ''> = T extends { value: unknown } ? Prefix : { [K in keyof T & string]: SettingPathOf<T[K], Prefix extends '' ? K : `${Prefix}.${K}`> }[keyof T & string];

export type SettingPath = SettingPathOf<typeof defaultSettings>;
