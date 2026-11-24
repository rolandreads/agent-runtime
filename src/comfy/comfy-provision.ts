import { S3Client } from 'bun';
import { quoteShellValue } from '../utils';
import type { ComfyAsset } from './comfy-assets';
import { comfyWorkerConfig, r2GenerativeAssetsConfig } from '../environment';

export type WorkerCommandResult = { stdout: string; stderr: string; exitCode: number };

export type ComfyProvisionConfig = {
  caddy: { port: number; authToken: string };
  tls: { caCertB64: string; certB64: string; keyB64: string };
  ssh: { host: string; port: number; username?: string; privateKeyPath: string; knownHostsPath: string; hostKeyAlias: string };
};

export type ComfyAssetSyncResult = { objectCount: number; skippedCount: number; downloadedBytes: number };

const r2Client = new S3Client(r2GenerativeAssetsConfig);

export const comfyAssetManifestB64 = async (entries: readonly ComfyAsset[]): Promise<string> => {
  const manifest = await Promise.all(entries.map(async ({ source, ...asset }) => {
    return { ...asset, url };
    if (source.kind === 'http') {
      const response = await fetch(url, { method: 'HEAD', redirect: 'manual', headers: { 'User-Agent': 'agent-runtime/1.0', Authorization: `Bearer ${comfyWorkerConfig.modelhostApiKey}` }, signal: AbortSignal.timeout(15_000) });
      const location = response.headers.get('location');
      if (response.status < 300 || response.status >= 400 || !location) throw new Error(`Model Host download authorization failed for ${asset.filename}: HTTP ${String(response.status)}`);
      url = location;
    }
    let url = source.kind === 'r2' ? r2Client.presign(source.key, { expiresIn: 3600 }) : source.url;
  }));
  return Buffer.from(JSON.stringify(manifest), 'utf8').toString('base64');
};

export class ComfyProvision {
  constructor(private readonly config: ComfyProvisionConfig) {}

  async bootstrap(): Promise<void> {
    const result = await this.runCommand({
      command: '/usr/local/bin/agent-runtime-worker-start',
      env: {
        RUNTIME_TLS_KEY_B64: this.config.tls.keyB64,
        RUNTIME_TLS_CERT_B64: this.config.tls.certB64,
        RUNTIME_CA_CERT_B64: this.config.tls.caCertB64,
        RUNTIME_CADDY_PORT: String(this.config.caddy.port),
        RUNTIME_CADDY_AUTH_TOKEN: this.config.caddy.authToken,
      },
    });

    if (result.exitCode !== 0) throw new Error(`Comfy worker bootstrap failed: ${JSON.stringify(result)}`);
  }

  async syncAssets(entries: readonly ComfyAsset[]): Promise<ComfyAssetSyncResult> {
    const result = await this.runCommand({
      command: '/usr/local/bin/agent-runtime-worker-assets',
      env: {
        RUNTIME_HF_TOKEN: comfyWorkerConfig.huggingFaceToken,
        RUNTIME_ASSET_MANIFEST_B64: await comfyAssetManifestB64(entries),
      },
    });
    if (result.exitCode !== 0) throw new Error(`Comfy asset sync failed with exit ${String(result.exitCode)}: ${JSON.stringify(result)}`);

    const match = result.stdout.match(/\bRESULT downloaded_bytes=(\d+) object_count=(\d+) skipped_count=(\d+)\b/);
    if (match === null) throw new Error(`Comfy asset sync did not report a RESULT line: ${JSON.stringify(result)}`);

    return {
      objectCount: Number(match[2]),
      skippedCount: Number(match[3]),
      downloadedBytes: Number(match[1]),
    };
  }

  private async runCommand({ command, env }: { command: string; env: Record<string, string> }): Promise<WorkerCommandResult> {
    const envExports = Object.entries(env).map(([name, value]) => {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error(`Invalid worker script env name: ${name}`);
      return `${name}=${quoteShellValue(value)}`;
    });
    const remoteCommand = `export ${envExports.join(' ')}; exec ${quoteShellValue(command)}`;

    const proc = Bun.spawn(
      [
        'ssh',
        '-i',
        this.config.ssh.privateKeyPath,
        '-p',
        String(this.config.ssh.port),
        '-o',
        'BatchMode=yes',
        '-o',
        'NumberOfPasswordPrompts=0',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        `UserKnownHostsFile=${this.config.ssh.knownHostsPath}`,
        '-o',
        `HostKeyAlias=${this.config.ssh.hostKeyAlias}`,
        '-o',
        'CheckHostIP=no',
        `${this.config.ssh.username ?? 'root'}@${this.config.ssh.host}`,
        `bash -lc ${quoteShellValue(remoteCommand)}`,
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    const [exitCode, stdout, stderr] = await Promise.all([proc.exited, readStream(proc.stdout), readStream(proc.stderr)]);
    return { exitCode, stdout, stderr };
  }
}

const readStream = async (stream: ReadableStream<Uint8Array> | undefined): Promise<string> => {
  if (stream === undefined) return '';
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const read = await reader.read();
    if (read.done) break;
    chunks.push(read.value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
};
