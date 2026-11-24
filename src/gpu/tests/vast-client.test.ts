import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { settings } from '../../settings';
import { rm, mkdtemp } from 'node:fs/promises';
import type { EventLog } from '../../utils/event-log';
import type { Event } from '../../repositories/event-repository';
import { mock, test, expect, afterAll, describe, afterEach } from 'bun:test';
import { COMFY_WORKER_IMAGE_REFERENCE } from '../../comfy/comfy-worker-images';

const testDirectory = await mkdtemp(join(tmpdir(), 'agent-runtime-vast-client-test-'));
const testSshKeyPath = join(testDirectory, 'id_ed25519');
const testEgressSignalPath = join(testDirectory, 'egress-refresh-requested');
await Bun.write(`${testSshKeyPath}.pub`, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest agent-runtime-test');

mock.module('../../environment', () => ({
  r2GenerativeAssetsConfig: { bucket: 'test', accessKeyId: 'test', secretAccessKey: 'test' },
  comfyWorkerConfig: { huggingFaceToken: 'test-token', caddyAuthToken: 'test-token', caKeyPath: '/tmp/test-ca.key', caCertPath: '/tmp/test-ca.crt' },
  vastConfig: {
    runtimePort: 8443,
    apiKey: 'test-api-key',
    apiBaseUrl: 'https://console.vast.ai',
    egressRefreshSignalPath: testEgressSignalPath,
    imagePullCredentials: { registry: 'docker.io', username: 'example', token: 'test-read-token' },
    ssh: {
      privateKeyPath: testSshKeyPath,
      knownHostsPath: '/tmp/test-agent-runtime/vast-known-hosts',
    },
  },
}));

const { VastClient } = await import('../vast-client');

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  await rm(testDirectory, { recursive: true, force: true });
});

const makeClient = () => {
  const log = mock((_event: Event) => {});
  const events = { log, error: mock(() => {}) } as unknown as EventLog;
  return { client: new VastClient(events, new Set(), async () => {}), events, log };
};

const mockStartResponse = (payload: unknown): void => {
  globalThis.fetch = Object.assign(
    mock(async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })),
    {
      preconnect: originalFetch.preconnect,
    },
  );
};

describe('VastClient.startWorker', () => {
  test('returns scheduling when Vast queues the start for unavailable resources', async () => {

    await expect(makeClient().client.startWorker(123)).resolves.toEqual({ kind: 'scheduling' });
    mockStartResponse({ success: false, error: 'resources_unavailable', msg: 'Required resources are currently unavailable, state change queued.' });
  });

  test('returns started when Vast accepts the state change', async () => {
    mockStartResponse({ success: true });

    await expect(makeClient().client.startWorker(123)).resolves.toEqual({ kind: 'started' });
  });

  test('throws for non-scheduling Vast application errors', async () => {
    mockStartResponse({ success: false, error: 'invalid_state', msg: 'Cannot start instance.' });

    await expect(makeClient().client.startWorker(123)).rejects.toThrow(/invalid_state/);
  });
});

describe('VastClient.listWorkers', () => {
  test('returns only agent-runtime worker rentals', async () => {
    let requestUrl = '';
    const image = { reference: COMFY_WORKER_IMAGE_REFERENCE };
    globalThis.fetch = Object.assign(
      mock(async (input: string | URL | Request) => {
        requestUrl = String(input);
        const instance = (id: number, imageReference: string) => ({
          id,
          ports: null,
          dph_base: 0.7,
          dph_total: 0.8,
          machine_id: id,
          storage_cost: 0.2,
          inet_up_cost: 0.004,
          cur_state: 'running',
          inet_down_cost: 0.002,
          status_msg: 'running',
          geolocation: 'Test, US',
          actual_status: 'running',
          storage_total_cost: 0.01,
          image_uuid: imageReference,
          intended_status: 'running',
          public_ipaddr: '127.0.0.1',
        });
        return new Response(JSON.stringify({ instances: [instance(1, image.reference), instance(2, `docker.io/example/agent-runtime@sha256:${'a'.repeat(64)}`), instance(3, 'docker.io/someone/else@sha256:unrelated')] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
      { preconnect: originalFetch.preconnect },
    );

    const workers = await makeClient().client.listWorkers();

    expect(new URL(requestUrl).searchParams.has('select_filters')).toBeFalse();
    expect(workers.map(({ contractId, imageReference }) => ({ contractId, imageReference }))).toEqual([
      { contractId: 1, imageReference: image.reference },
      { contractId: 2, imageReference: `docker.io/example/agent-runtime@sha256:${'a'.repeat(64)}` },
    ]);
  });
});

describe('VastClient.rentWorker', () => {
  test('prefers lower total price, breaks price ties by bandwidth, and prefers unused countries', async () => {
    let createBody: Record<string, unknown> | undefined;
    const bundleBodies: Record<string, unknown>[] = [];
    const rentedOfferIds: number[] = [];
    const image = { reference: COMFY_WORKER_IMAGE_REFERENCE };
    const offer = {
      id: 1,
      dph_base: 0.7,
      machine_id: 2,
      disk_bw: 1_200,
      dph_total: 0.8,
      inet_down: 8_000,
      reliability: 0.99,
      storage_cost: 0.2,
      inet_up_cost: 0.004,
      gpu_name: 'RTX 4090',
      inet_down_cost: 0.002,
      geolocation: 'Test, US',
      storage_total_cost: 0.01,
    };
    const highDownloadCost = { ...offer, id: 6, geolocation: 'Test, IT', dph_total: 0.4063, inet_down: 7_045, inet_down_cost: 0.0390625 };
    const cheap = { ...offer, id: 4, geolocation: 'Test, IS', dph_total: 0.4278, inet_down: 2_872.3, inet_down_cost: 0.002604 };
    const fast = { ...offer, id: 2, geolocation: 'Test, ES', dph_total: 0.473, inet_down: 5_882.9, inet_down_cost: 0.0091146 };
    const fasterAtSamePrice = { ...fast, id: 5, inet_down: 6_446.7 };
    const ultra = { ...offer, id: 3, geolocation: 'Test, US', dph_total: 0.5089, inet_down: 13_630, inet_down_cost: 0.01 };
    let listedOffers = [highDownloadCost, fast, ultra, cheap, fasterAtSamePrice];
    globalThis.fetch = Object.assign(
      mock(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === '/api/v0/bundles/') {
          bundleBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response(JSON.stringify({ offers: listedOffers }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.pathname.startsWith('/api/v0/asks/')) {
          rentedOfferIds.push(Number(url.pathname.split('/')[4]));
          createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(JSON.stringify({ new_contract: 3 }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(
          JSON.stringify({
            instances: {
              id: 3,
              ports: null,
              dph_base: 0.7,
              machine_id: 2,
              dph_total: 0.8,
              storage_cost: 0.2,
              inet_up_cost: 0.004,
              cur_state: 'running',
              inet_down_cost: 0.002,
              geolocation: 'Test, US',
              actual_status: 'loading',
              storage_total_cost: 0.01,
              intended_status: 'running',
              public_ipaddr: '127.0.0.1',
              image_uuid: image.reference,
              status_msg: 'Pulling image',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
      { preconnect: originalFetch.preconnect },
    );
    const { client, log } = makeClient();

    await client.rentWorker({ assetManifestB64: 'bWFuaWZlc3Q=', countriesAlreadyTried: new Set() });
    await client.rentWorker({ assetManifestB64: 'bWFuaWZlc3Q=', countriesAlreadyTried: new Set(['IS']) });
    await client.rentWorker({ assetManifestB64: 'bWFuaWZlc3Q=', countriesAlreadyTried: new Set(['IS', 'ES']) });
    await client.rentWorker({ assetManifestB64: 'bWFuaWZlc3Q=', countriesAlreadyTried: new Set(['IS', 'ES', 'US']) });
    listedOffers = [highDownloadCost];
    await client.rentWorker({ assetManifestB64: 'bWFuaWZlc3Q=', countriesAlreadyTried: new Set() });

    expect(rentedOfferIds).toEqual([4, 5, 3, 4, 6]);
    expect(bundleBodies).toHaveLength(5);
    expect(bundleBodies[0]).toMatchObject({ inet_down: { gte: 3500 }, disk_bw: { gte: 3000 }, cuda_max_good: { gte: 13 } });
    expect(bundleBodies[0]).not.toHaveProperty('inet_down_cost');
    expect(createBody).toMatchObject({
      runtype: 'args',
      image: image.reference,
      target_state: 'running',
      image_login: '-u example -p test-read-token docker.io',
      env: {
        '-p 22:22': '1',
        '-p 8443:8443': '1',
        RUNTIME_ASSET_MANIFEST_B64: 'bWFuaWZlc3Q=',
        RUNTIME_SSH_PUBLIC_KEY_B64: Buffer.from('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest agent-runtime-test').toString('base64'),
      },
    });
    expect(createBody).not.toHaveProperty('onstart');
    expect(createBody).not.toHaveProperty('label');
    const login = String(createBody?.image_login);
    expect(JSON.stringify(log.mock.calls)).not.toContain(login);
    const decisions = log.mock.calls.map(([event]) => event).filter((event) => event.type === 'vast_client_rent_decision');
    expect(decisions).toHaveLength(5);
    expect(decisions[0]).toMatchObject({
      data: {
        selectedOffer: cheap,
        blockedMachineIds: [],
        countriesAlreadyTried: [],
        candidateOfferIds: [4, 5, 2, 3],
        policy: settings.get().gpu.offer,
        eligibleOfferIds: [6, 4, 5, 2, 3],
        selectionPool: 'preferred_download_cost',
        algorithm: 'price_download_cost_country_v1',
        availableOffers: [highDownloadCost, fast, ultra, cheap, fasterAtSamePrice],
        query: expect.objectContaining({ gpu_name: { eq: 'RTX 4090' }, inet_down: { gte: 3500 } }),
      },
      type: 'vast_client_rent_decision',
    });
    expect(log).toHaveBeenCalledWith({ type: 'vast_client_rent_worker', data: { workerId: 3, imageReference: image.reference, selectedOffer: ultra } });
  });

  test('records the decision snapshot when no offer can be selected', async () => {
    mockStartResponse({ offers: [] });
    const { client, log } = makeClient();

    const decision = log.mock.calls.map(([event]) => event).find((event) => event.type === 'vast_client_rent_decision');

    await expect(client.rentWorker({ assetManifestB64: 'bWFuaWZlc3Q=', countriesAlreadyTried: new Set(['US']) })).rejects.toThrow('No Vast offers matched policy');
    expect(decision).toMatchObject({ data: { countriesAlreadyTried: ['US'], availableOffers: [], eligibleOfferIds: [], candidateOfferIds: [], selectedOffer: null } });
  });
});

describe('VastClient.waitForSsh', () => {
  test('signals the host before probing SSH', async () => {
    const { client } = makeClient();
    const worker = {
      machineId: 456,
      contractId: 123,
      countryCode: 'US',
      status: 'running' as const,
      ssh: { host: '127.0.0.1', port: 10022 },
      https: { host: '127.0.0.1', port: 18443 },
      imageReference: { reference: COMFY_WORKER_IMAGE_REFERENCE }.reference,
      costs: { hourlyUsd: 0.8, gpuHourlyUsd: 0.7, uploadPerGbUsd: 0.004, storageHourlyUsd: 0.01, downloadPerGbUsd: 0.002, storagePerGbMonthUsd: 0.2 },
      providerState: { actualStatus: 'running' as const, currentState: 'running' as const, intendedState: 'running' as const, statusMessage: 'running', portsReady: true },
    };
    (client as unknown as { probeSsh: () => Promise<string> }).probeSsh = async () => ((await Bun.file(testEgressSignalPath).text()).trim() === String(worker.contractId) ? '' : 'not signalled');

    await expect(client.waitForSsh(worker)).resolves.toBe(1);

    expect((await Bun.file(testEgressSignalPath).text()).trim()).toBe(String(worker.contractId));
  });
});

describe('VastClient.getWorker', () => {
  test('retries when Vast temporarily returns no instance', async () => {
    let calls = 0;
    globalThis.fetch = Object.assign(
      mock(async () => {
        calls += 1;
        return new Response(
          JSON.stringify({
            instances:
              calls === 1
                ? null
                : {
                    id: 123,
                    machine_id: 456,
                    geolocation: 'Test, US',
                    actual_status: 'loading',
                    cur_state: 'running',
                    intended_status: 'running',
                    dph_base: 0.8,
                    dph_total: 0.85,
                    storage_cost: 0.2,
                    storage_total_cost: 0.01,
                    inet_down_cost: 0.002,
                    inet_up_cost: 0.004,
                    image_uuid: 'test-image',
                  },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
      { preconnect: originalFetch.preconnect },
    );
    const { client, events } = makeClient();

    await expect(client.getWorker(123)).resolves.toMatchObject({ contractId: 123, status: 'loading' });
    expect(calls).toBe(2);
    expect(events.log).toHaveBeenCalledWith({ type: 'vast_client_worker_missing_retry_scheduled', data: { attempt: 1, workerId: 123 } });
  });

  test('logs the safe Vast lifecycle state without unrelated instance fields', async () => {
    mockStartResponse({
      instances: {
        id: 123,
        dph_base: 0,
        ssh_port: 22,
        dph_total: 0.03,
        machine_id: 456,
        storage_cost: 0.2,
        inet_up_cost: 0.004,
        cur_state: 'stopped',
        inet_down_cost: 0.002,
        actual_status: 'exited',
        geolocation: 'Test, US',
        image_uuid: 'test-image',
        machine_dir_ssh_port: 22,
        storage_total_cost: 0.03,
        intended_status: 'stopped',
        public_ipaddr: '127.0.0.1',
        ssh_host: 'ssh.example.com',
        status_msg: 'Container exited',
        jupyter_token: 'must-not-be-logged',
        ports: {
          '22/tcp': [{ HostPort: '10022' }],
          '8443/tcp': [{ HostPort: '18443' }],
        },
      },
    });
    const { client, events, log } = makeClient();

    const worker = await client.getWorker(123);

    expect(worker.ssh).toEqual({ host: '127.0.0.1', port: 10022 });

    expect(events.log).toHaveBeenCalledWith({
      data: {
        workerId: 123,
        machineId: 456,
        workerStatus: 'stopped',
        providerState: { actualStatus: 'exited', currentState: 'stopped', intendedState: 'stopped', statusMessage: 'Container exited', portsReady: true },
      },
      type: 'vast_client_fetch_worker',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('must-not-be-logged');
  });

  test('retries a read after Vast rate limits it', async () => {
    let calls = 0;
    globalThis.fetch = Object.assign(
      mock(async () => {
        calls += 1;
        if (calls === 1) return new Response('API requests too frequent', { status: 429 });
        return new Response(
          JSON.stringify({
            instances: {
              id: 123,
              dph_base: 0.8,
              dph_total: 0.85,
              machine_id: 456,
              storage_cost: 0.2,
              inet_up_cost: 0.004,
              cur_state: 'running',
              inet_down_cost: 0.002,
              status_msg: 'running',
              geolocation: 'Test, US',
              actual_status: 'running',
              image_uuid: 'test-image',
              storage_total_cost: 0.01,
              intended_status: 'running',
              public_ipaddr: '127.0.0.1',
              ports: { '22/tcp': [{ HostPort: '10022' }], '8443/tcp': [{ HostPort: '18443' }] },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
      { preconnect: originalFetch.preconnect },
    );
    const { client, events } = makeClient();

    await expect(client.getWorker(123)).resolves.toMatchObject({ contractId: 123, status: 'running' });
    expect(calls).toBe(2);
    expect(events.log).toHaveBeenCalledWith({ type: 'vast_client_retry_scheduled', data: { attempt: 1, method: 'GET', path: '/api/v0/instances/123/', status: 429 } });
  });

  test('does not retry a permanent read error', async () => {
    let calls = 0;
    globalThis.fetch = Object.assign(
      mock(async () => {
        calls += 1;
        return new Response('missing', { status: 404 });
      }),
      { preconnect: originalFetch.preconnect },
    );

    await expect(makeClient().client.getWorker(123)).rejects.toThrow(/404/);
    expect(calls).toBe(1);
  });

  test('throws the last retryable read error after attempts are exhausted', async () => {
    let calls = 0;
    globalThis.fetch = Object.assign(
      mock(async () => {
        calls += 1;
        return new Response(`rate limited ${String(calls)}`, { status: 429 });
      }),
      { preconnect: originalFetch.preconnect },
    );

    await expect(makeClient().client.getWorker(123)).rejects.toThrow(/429/);
    expect(calls).toBe(settings.get().gpu.vastApiAttempts);
  });
});

describe('VastClient.destroyWorker', () => {
  test('does not retry a mutating request', async () => {
    let calls = 0;
    globalThis.fetch = Object.assign(
      mock(async () => {
        calls += 1;
        return new Response('upstream unavailable', { status: 503 });
      }),
      { preconnect: originalFetch.preconnect },
    );

    await expect(makeClient().client.destroyWorker(123)).rejects.toThrow(/503/);
    expect(calls).toBe(1);
  });
});

// A successful HTTP status must not turn malformed/rejected commands into accepted mutations.
test.each(['startWorker', 'stopWorker', 'destroyWorker'] as const)('%s rejects malformed acknowledgements without retrying', async (method) => {
  for (const payload of [{}, { success: false, error: 'invalid_state', msg: 'Cannot change instance.' }]) {
    mockStartResponse(payload);
    await expect(makeClient().client[method](123)).rejects.toThrow();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  }
});

test('rejects a malformed rental result without creating another rental', async () => {
  const createCalls: string[] = [];
  globalThis.fetch = Object.assign(
    mock(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/v0/bundles/')
        return Response.json({
          offers: [
            {
              id: 1,
              disk_bw: 1200,
              dph_base: 0.7,
              dph_total: 0.8,
              gpu_name: 'RTX 4090',
              inet_down: 8000,
              machine_id: 2,
              geolocation: 'Test, US',
              reliability: 0.99,
              storage_cost: 0.2,
              inet_up_cost: 0.004,
              inet_down_cost: 0.002,
              storage_total_cost: 0.01,
            },
          ],
        });
      createCalls.push(path);
      return Response.json({ new_contract: null });
    }),
    { preconnect: originalFetch.preconnect },
  );

  await expect(makeClient().client.rentWorker({ assetManifestB64: 'bWFuaWZlc3Q=', countriesAlreadyTried: new Set() })).rejects.toThrow('invalid response');
  expect(createCalls).toEqual(['/api/v0/asks/1/']);
});
