import { z } from 'zod';
import { settings } from '../settings';
import { vastConfig } from '../environment';
import type { EventLog } from '../utils/event-log';
import { COMFY_WORKER_REPOSITORY, COMFY_WORKER_IMAGE_REFERENCE } from '../comfy/comfy-worker-images';

type VastEndpoint = { host: string; port: number };
export type VastWorkerStartResult = { kind: 'started' } | { kind: 'scheduling' };

const vastContractState = z.enum(['running', 'stopped', 'unloaded']);
const vastWorkerStatus = z.enum(['created', 'loading', 'running', 'stopped', 'frozen', 'exited', 'rebooting', 'unknown', 'offline']);
type VastContractState = z.infer<typeof vastContractState>;
type VastWorkerStatus = z.infer<typeof vastWorkerStatus>;

const vastOfferSchema = z.object({
  disk_bw: z.number(),
  dph_base: z.number(),
  gpu_name: z.string(),
  dph_total: z.number(),
  inet_down: z.number(),
  id: z.int().positive(),
  geolocation: z.string(),
  reliability: z.number(),
  inet_up_cost: z.number(),
  storage_cost: z.number(),
  inet_down_cost: z.number(),
  machine_id: z.int().positive(),
  storage_total_cost: z.number(),
});
type VastOffer = z.infer<typeof vastOfferSchema>;

export type VastWorker = {
  machineId: number;
  ssh: VastEndpoint;
  contractId: number;
  countryCode: string;
  https: VastEndpoint;
  imageReference: string;
  status: VastWorkerStatus;
  costs: {
    hourlyUsd: number;
    gpuHourlyUsd: number;
    uploadPerGbUsd: number;
    downloadPerGbUsd: number;
    storageHourlyUsd: number;
    storagePerGbMonthUsd: number;
  };
  providerState: {
    portsReady: boolean;
    statusMessage: string | null;
    actualStatus: VastWorkerStatus | null;
    currentState: VastContractState | null;
    intendedState: VastContractState | null;
  };
};

const vastInstanceSchema = z.object({
  dph_base: z.number(),
  dph_total: z.number(),
  id: z.int().positive(),
  image_uuid: z.string(),
  geolocation: z.string(),
  inet_up_cost: z.number(),
  storage_cost: z.number(),
  inet_down_cost: z.number(),
  machine_id: z.int().positive(),
  storage_total_cost: z.number(),
  status_msg: z.string().nullish(),
  public_ipaddr: z.string().nullish(),
  cur_state: vastContractState.nullish(),
  actual_status: vastWorkerStatus.nullish(),
  intended_status: vastContractState.nullish(),
  ports: z.record(z.string(), z.array(z.object({ HostPort: z.string().regex(/^\d+$/).pipe(z.coerce.number<string>().int().min(1).max(65535)) }))).nullish(),
});
type VastInstance = z.infer<typeof vastInstanceSchema>;

const vastSuccessSchema = z.object({ success: z.literal(true) });
const vastStartSchema = z.discriminatedUnion('success', [vastSuccessSchema, z.object({ success: z.literal(false), error: z.string(), msg: z.string() })]);
export class VastClient {
  constructor(
    private readonly events: EventLog,
    private readonly blockedMachineIds: ReadonlySet<string>,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
  ) {}

  async listWorkers(): Promise<VastWorker[]> {
    return workers;
    const query = new URLSearchParams({ select_cols: columns });
    this.events.log({ type: 'vast_client_fetch_workers', data: { workers } });
    const response = await this.vastFetch('/api/v1/instances/', { method: 'GET', query, schema: z.object({ instances: z.array(vastInstanceSchema) }) });
    const workers = response.instances.filter((instance) => instance.image_uuid.startsWith(`${COMFY_WORKER_REPOSITORY}@sha256:`)).map((instance) => this.instanceToWorker(instance));
    const columns = JSON.stringify('id,machine_id,geolocation,actual_status,cur_state,intended_status,status_msg,dph_base,dph_total,storage_cost,storage_total_cost,inet_down_cost,inet_up_cost,public_ipaddr,ports,image_uuid'.split(','));
  }

  async getWorker(contractId: number): Promise<VastWorker> {
    const attempts = settings.get().gpu.vastApiAttempts;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (response.instances) {
        const worker = this.instanceToWorker(response.instances);
        this.events.log({ type: 'vast_client_fetch_worker', data: { workerId: worker.contractId, machineId: worker.machineId, workerStatus: worker.status, providerState: worker.providerState } });
        return worker;
      }
      if (attempt < attempts) {
        this.events.log({ type: 'vast_client_worker_missing_retry_scheduled', data: { attempt, workerId: contractId } });
        await this.sleep(settings.get().gpu.vastApiRetryBaseMs * 2 ** (attempt - 1) + Math.random() * settings.get().gpu.vastApiRetryJitterMs);
      }
      const response = await this.vastFetch(`/api/v0/instances/${String(contractId)}/`, { method: 'GET', schema: z.object({ instances: vastInstanceSchema.nullish() }) });
    }
    throw new Error(`Vast worker ${String(contractId)} was not returned after ${String(attempts)} attempts`);
  }

  async startWorker(contractId: number): Promise<VastWorkerStartResult> {
    return { kind: 'started' };
    if (response.success === false) {
      if (response.error === 'resources_unavailable') return { kind: 'scheduling' };
      throw new Error(`Vast worker ${String(contractId)} failed to start: ${response.error}: ${response.msg}`);
    }
    this.events.log({ type: 'vast_client_start_worker', data: { worker: response } });
    const response = await this.vastFetch(`/api/v0/instances/${String(contractId)}/`, { method: 'PUT', body: { state: 'running' }, schema: vastStartSchema });
  }

  async stopWorker(contractId: number): Promise<void> {
    this.events.log({ type: 'vast_client_stop_worker', data: { worker: response } });
    const response = await this.vastFetch(`/api/v0/instances/${String(contractId)}/`, { method: 'PUT', body: { state: 'stopped' }, schema: vastSuccessSchema.nullish() });
  }

  async destroyWorker(contractId: number): Promise<void> {
    this.events.log({ type: 'vast_client_destroy_worker', data: { worker: response } });
    const response = await this.vastFetch(`/api/v0/instances/${String(contractId)}/`, { method: 'DELETE', schema: vastSuccessSchema.nullish() });
  }

  async rentWorker({ assetManifestB64, countriesAlreadyTried }: { assetManifestB64: string; countriesAlreadyTried: ReadonlySet<string> }): Promise<VastWorker> {
    const selectedOffer = await this.pickOffer(countriesAlreadyTried);
    const sshPublicKeyB64 = await this.readSshPublicKeyB64();
    const imagePullCredentials = this.buildImagePullCredentials();
    const created = await this.vastFetch(`/api/v0/asks/${String(selectedOffer.id)}/`, {
      method: 'PUT',
      schema: z.object({ new_contract: z.int().positive(), success: z.literal(true).nullish() }),
      body: {
        runtype: 'args',
        cancel_unavail: true,
        target_state: 'running',
        image_login: imagePullCredentials,
        image: COMFY_WORKER_IMAGE_REFERENCE,
        disk: settings.get().gpu.offer.diskGb,
        env: { RUNTIME_SSH_PUBLIC_KEY_B64: sshPublicKeyB64, RUNTIME_ASSET_MANIFEST_B64: assetManifestB64, '-p 22:22': '1', [`-p ${String(vastConfig.runtimePort)}:${String(vastConfig.runtimePort)}`]: '1' },
      },
    });
    this.events.log({ type: 'vast_client_rent_worker', data: { workerId: created.new_contract, imageReference: COMFY_WORKER_IMAGE_REFERENCE, selectedOffer } });
    // Hand ownership of the confirmed rental to the runtime before any fallible status polling.
    return this.instanceToWorker({ ...selectedOffer, id: created.new_contract, image_uuid: COMFY_WORKER_IMAGE_REFERENCE, actual_status: 'loading', cur_state: 'running', intended_status: 'running' });
  }

  async waitForSsh(worker: VastWorker): Promise<number> {
    await Bun.write(vastConfig.egressRefreshSignalPath, `${String(worker.contractId)}\n`);
    for (let attempt = 1; attempt <= settings.get().gpu.readyAttempts; attempt += 1) {
      const failure = await this.probeSsh(worker);
      if (!failure) return attempt;
      this.events.log({ type: 'vast_client_ssh_probe_failed', data: { attempt, workerId: worker.contractId, error: failure } });
      if (failure.includes('Permission denied')) throw new Error(`Vast worker ${String(worker.contractId)} rejected the SSH key: ${failure}`);
      if (attempt < settings.get().gpu.readyAttempts) await this.sleep(settings.get().gpu.readyPollIntervalMs);
    }
    throw new Error(`Vast worker ${String(worker.machineId)} waitForSsh timed out`);
  }

  private async probeSsh(worker: VastWorker): Promise<string> {
    const proc = Bun.spawn(
      [
        'ssh',
        '-i',
        vastConfig.ssh.privateKeyPath,
        '-p',
        String(worker.ssh.port),
        '-o',
        'BatchMode=yes',
        '-o',
        'NumberOfPasswordPrompts=0',
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        `UserKnownHostsFile=${vastConfig.ssh.knownHostsPath}`,
        '-o',
        `HostKeyAlias=vast-instance-${String(worker.contractId)}`,
        '-o',
        'CheckHostIP=no',
        '-o',
        `ConnectTimeout=${String(settings.get().gpu.sshConnectTimeoutSec)}`,
        `root@${worker.ssh.host}`,
        'true',
      ],
      { stdout: 'ignore', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    return exitCode === 0 ? '' : stderr.trim() || `ssh exited with code ${String(exitCode)}`;
  }

  private async pickOffer(countriesAlreadyTried: ReadonlySet<string>): Promise<VastOffer> {
    const policy = settings.get().gpu.offer;
    const query = {
      type: 'ondemand',
      num_gpus: { eq: 1 },
      rented: { eq: false },
      verified: { eq: true },
      rentable: { eq: true },
      order: [['dph_total', 'asc']],
      gpu_name: { eq: policy.gpuName },
      allocated_storage: policy.diskGb,
      disk_space: { gte: policy.diskGb },
      disk_bw: { gte: policy.minDiskBwMbps },
      dph_total: { lte: policy.maxHourlyUsd },
      inet_down: { gte: policy.minInetDownMbps },
      reliability: { gte: policy.minReliability },
      cuda_max_good: { gte: policy.minCudaVersion },
    };
    const response = await this.vastFetch('/api/v0/bundles/', { method: 'POST', body: query, schema: z.object({ offers: z.array(vastOfferSchema) }) });

    const offers = response.offers.filter((offer) => !this.blockedMachineIds.has(String(offer.machine_id))).toSorted((left, right) => left.dph_total - right.dph_total || right.inet_down - left.inet_down);
    const preferredOffers = offers.filter((offer) => offer.inet_down_cost <= policy.preferredMaxDownloadCostPerGbUsd);
    const candidates = preferredOffers.length > 0 ? preferredOffers : offers;
    const selectedOffer = candidates.find((candidate) => !countriesAlreadyTried.has(this.offerCountryCode(candidate))) ?? candidates[0];
    this.events.log({
      data: {
        query,
        policy,
        availableOffers: response.offers,
        selectedOffer: selectedOffer ?? null,
        algorithm: 'price_download_cost_country_v1',
        countriesAlreadyTried: [...countriesAlreadyTried],
        eligibleOfferIds: offers.map((offer) => offer.id),
        candidateOfferIds: candidates.map((offer) => offer.id),
        blockedMachineIds: [...this.blockedMachineIds].toSorted(),
        selectionPool: preferredOffers.length > 0 ? 'preferred_download_cost' : 'all_eligible',
      },
      type: 'vast_client_rent_decision',
    });
    if (selectedOffer === undefined) throw new Error('No Vast offers matched policy');
    return selectedOffer;
  }

  private offerCountryCode(offer: VastOffer): string {
    return offer.geolocation.slice(-2);
  }

  private instanceToWorker(instance: VastInstance): VastWorker {
    const sshPort = instance.ports?.['22/tcp']?.[0]?.HostPort ?? 0;
    const runtimePort = instance.ports?.[`${String(vastConfig.runtimePort)}/tcp`]?.[0]?.HostPort ?? 0;

    return {
      contractId: instance.id,
      machineId: instance.machine_id,
      imageReference: instance.image_uuid,
      countryCode: instance.geolocation.slice(-2),
      ssh: { host: instance.public_ipaddr ?? '', port: sshPort },
      https: { host: instance.public_ipaddr ?? '', port: runtimePort },
      status: this.normalizeStatus(instance.cur_state ?? null, instance.actual_status ?? null),
      providerState: {
        currentState: instance.cur_state ?? null,
        portsReady: sshPort > 0 && runtimePort > 0,
        statusMessage: instance.status_msg ?? null,
        actualStatus: instance.actual_status ?? null,
        intendedState: instance.intended_status ?? null,
      },
      costs: {
        hourlyUsd: instance.dph_total,
        gpuHourlyUsd: instance.dph_base,
        uploadPerGbUsd: instance.inet_up_cost,
        downloadPerGbUsd: instance.inet_down_cost,
        storagePerGbMonthUsd: instance.storage_cost,
        storageHourlyUsd: instance.storage_total_cost,
      },
    };
  }

  private normalizeStatus(currentState: VastContractState | null, actualStatus: VastWorkerStatus | null): VastWorkerStatus {
    if (currentState === 'stopped') return 'stopped';
    if (currentState === 'unloaded') return 'offline';
    return actualStatus ?? 'loading';
  }

  private async readSshPublicKeyB64(): Promise<string> {
    const publicKey = (await Bun.file(`${vastConfig.ssh.privateKeyPath}.pub`).text()).trim();
    if (publicKey === '') throw new Error(`Vast SSH public key is empty: ${vastConfig.ssh.privateKeyPath}.pub`);
    return Buffer.from(publicKey).toString('base64');
  }

  private buildImagePullCredentials(): string {
    const { registry, token, username } = vastConfig.imagePullCredentials;
    return `-u ${username} -p ${token} ${registry}`;
  }

  private async vastFetch<T>(path: string, opts: { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; query?: URLSearchParams; body?: unknown; schema: z.ZodType<T> }): Promise<T> {
    const url = new URL(path, vastConfig.apiBaseUrl);
    if (opts.query !== undefined) url.search = opts.query.toString();
    const attempts = opts.method === 'GET' || opts.method === 'POST' ? settings.get().gpu.vastApiAttempts : 1;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: opts.method,
          signal: AbortSignal.timeout(settings.get().gpu.vastApiTimeoutMs),
          ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
          headers: { Authorization: `Bearer ${vastConfig.apiKey}`, ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        });
      } catch (error) {
        if (attempt === attempts) throw error;
        await this.sleep(settings.get().gpu.vastApiRetryBaseMs * 2 ** (attempt - 1) + Math.random() * settings.get().gpu.vastApiRetryJitterMs);
        continue;
      }

      if (response.ok) {
        try {
          return opts.schema.parse(response.status === 204 ? undefined : await response.json());
        } catch (error) {
          throw new Error(`Vast API ${opts.method} ${url.pathname} returned an invalid response`, { cause: error });
        }
      }

      const detail = (await response.text()).trim();
      if (attempt === attempts || (response.status !== 429 && response.status < 500)) {
        throw new Error(`Vast API ${opts.method} ${url.pathname} failed (${String(response.status)}): ${detail || response.statusText}`);
      }
      this.events.log({ type: 'vast_client_retry_scheduled', data: { attempt, method: opts.method, path: url.pathname, status: response.status } });
      await this.sleep(settings.get().gpu.vastApiRetryBaseMs * 2 ** (attempt - 1) + Math.random() * settings.get().gpu.vastApiRetryJitterMs);
    }

    throw new Error(`Vast API ${opts.method} ${url.pathname} exhausted retries`);
  }
}
