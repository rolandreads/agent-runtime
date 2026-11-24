import type { S3Options } from 'bun';

export const environmentString = (envVar: string, defaultValue?: string): string => {
  const value = process.env[envVar];
  if (value !== undefined) return value;
  if (defaultValue !== undefined) return defaultValue;
  throw new Error(`missing ${envVar} environment variable`);
};

export const databaseConfig = {
  path: environmentString('DATABASE_PATH', 'data/app.db'),
};

export const r2ImageArchivalConfig: S3Options = {
  region: 'auto',
  endpoint: environmentString('R2_ENDPOINT'),
  bucket: environmentString('R2_IMAGES_BUCKET'),
  accessKeyId: environmentString('R2_IMAGES_ACCESS_KEY_ID'),
  secretAccessKey: environmentString('R2_IMAGES_SECRET_ACCESS_KEY'),
};

export const r2GenerativeAssetsConfig: S3Options = {
  region: 'auto',
  endpoint: environmentString('R2_ENDPOINT'),
  bucket: environmentString('R2_MODEL_BUCKET'),
  accessKeyId: environmentString('R2_MODEL_ACCESS_KEY_ID'),
  secretAccessKey: environmentString('R2_MODEL_SECRET_ACCESS_KEY'),
};

const stateDir = environmentString('RUNTIME_STATE_DIR', 'data');

export const vastConfig = {
  runtimePort: 8443,
  apiBaseUrl: 'https://console.vast.ai',
  apiKey: environmentString('VAST_API_KEY'),
  egressRefreshSignalPath: `${stateDir}/egress-refresh-requested`,
  imagePullCredentials: {
    username: 'example',
    registry: 'docker.io',
    token: environmentString('DOCKERHUB_READ_TOKEN'),
  },
  ssh: {
    knownHostsPath: `${stateDir}/vast-known-hosts`,
    privateKeyPath: environmentString('VAST_SSH_KEY_PATH', `${environmentString('HOME')}/.local/share/agent-runtime/ssh/id_ed25519`),
  },
} as const;

export const comfyWorkerConfig = {
  huggingFaceToken: environmentString('HF_TOKEN'),
  modelhostApiKey: environmentString('ASSET_HOST_API_KEY', ''),
  caddyAuthToken: environmentString('RUNTIME_GPU_RUNTIME_TOKEN'),
  caKeyPath: environmentString('RUNTIME_GPU_CA_KEY_PATH', `${environmentString('HOME')}/.local/share/agent-runtime/tls/ca.key`),
  caCertPath: environmentString('RUNTIME_GPU_CA_CERT_PATH', `${environmentString('HOME')}/.local/share/agent-runtime/tls/ca.crt`),
} as const;

export const privacyConfig = (() => {
  const readEncryptionKey = (name: string): Buffer => {
    const key = Buffer.from(environmentString(name), 'base64url');
    if (key.length !== 32) throw new Error(`${name} must be 32 bytes`);
    return key;
  };
  return {
    databaseKey: readEncryptionKey('DATA_ENCRYPTION_KEY'),
    imageMetadataKey: readEncryptionKey('IMAGE_RECIPE_ENCRYPTION_KEY'),
  };
})();

export const openRouterConfig = {
  apiBaseUrl: 'https://openrouter.ai/api/v1',
  apiKey: environmentString('OPENROUTER_API_KEY'),
} as const;

export const grokConfig = {
  baseUrl: 'https://api.x.ai/v1',
  tokenPath: `${stateDir}/grok-auth.json`,
} as const;
