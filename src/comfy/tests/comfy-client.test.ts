import { Database } from 'bun:sqlite';
import { applySchema } from '../../db/db';
import { settings } from '../../settings';
import { ComfyClient } from '../comfy-client';
import { mock, test, expect, afterEach } from 'bun:test';

const originalFetch = globalThis.fetch;
const OriginalWebSocket = globalThis.WebSocket;

afterEach(() => {
  settings.reset();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = OriginalWebSocket;
  FauxWebSocket.last = undefined;
});

test('unexpected websocket close reports transport loss', async () => {
  installPromptFetch();
  const onTransportLost = mock((_error: unknown) => undefined);
  const client = new ComfyClient({ caCert: 'test', workerHost: '127.0.0.1', bearerToken: 'test', onTransportLost });
  const socket = await connect(client);
  const attempt = await client.submit({});

  socket.close();

  await expect(attempt.completion).rejects.toThrow('Comfy websocket disconnected');
  expect(onTransportLost).toHaveBeenCalledTimes(1);
  expect(onTransportLost.mock.calls[0]?.[0]).toBeInstanceOf(Error);
});

test('intentional disconnect does not report transport loss', async () => {
  installPromptFetch();
  const onTransportLost = mock((_error: unknown) => undefined);
  const client = new ComfyClient({ caCert: 'test', workerHost: '127.0.0.1', bearerToken: 'test', onTransportLost });
  await connect(client);
  const attempt = await client.submit({});

  client.disconnect();

  await expect(attempt.completion).rejects.toThrow('Comfy client disconnected');
  expect(onTransportLost).not.toHaveBeenCalled();
});

test('HTTP transport failure reports transport loss', async () => {
  const failure = new Error('connection refused');
  const onTransportLost = mock((_error: unknown) => undefined);
  const client = new ComfyClient({ caCert: 'test', workerHost: '127.0.0.1', bearerToken: 'test', onTransportLost });
  await connect(client);
  globalThis.fetch = Object.assign(
    mock(async () => Promise.reject(failure)),
    { preconnect: originalFetch.preconnect },
  );

  await expect(client.submit({})).rejects.toBe(failure);
  expect(onTransportLost).toHaveBeenCalledWith(failure);
});

test('does not POST a prompt without an open websocket', async () => {
  globalThis.fetch = promptFetch;

  expect(promptFetch).not.toHaveBeenCalled();

  await expect(client.submit({ node: { class_type: 'TestNode' } })).rejects.toThrow('Comfy websocket is not connected');
  const client = new ComfyClient({ caCert: 'test', workerHost: '127.0.0.1', bearerToken: 'test', onTransportLost: () => undefined });
  const promptFetch = Object.assign(mock(async () => Response.json({ prompt_id: 'prompt-1' })), { preconnect: originalFetch.preconnect });
});

test('does not accept a prompt after its websocket disconnects during submission', async () => {
  const response = Promise.withResolvers<Response>();
  globalThis.fetch = Object.assign(mock(() => response.promise), { preconnect: originalFetch.preconnect });
  const client = new ComfyClient({ caCert: 'test', workerHost: '127.0.0.1', bearerToken: 'test', onTransportLost: () => undefined });
  const socket = await connect(client);

  const submission = client.submit({ node: { class_type: 'TestNode' } });
  socket.close();
  response.resolve(Response.json({ prompt_id: 'prompt-1' }));

  await expect(submission).rejects.toThrow('Comfy websocket disconnected during prompt submission');
});

test('execution and image download failures reject completion', async () => {
  installPromptFetch();
  const client = new ComfyClient({ caCert: 'test', workerHost: '127.0.0.1', bearerToken: 'test', onTransportLost: () => undefined });
  const socket = await connect(client);

  const executionAttempt = await client.submit({});
  socket.emitMessage({ type: 'execution_error', data: { prompt_id: 'prompt-1', exception_message: 'workflow failed' } });
  await expect(executionAttempt.completion).rejects.toBe('workflow failed');

  const failure = new Error('image download failed');
  globalThis.fetch = Object.assign(
    mock(async (input: string | URL | Request) => String(input).includes('/view?') ? Promise.reject(failure) : Response.json({ prompt_id: 'prompt-2' })),
    { preconnect: originalFetch.preconnect },
  );
  const downloadAttempt = await client.submit({});
  socket.emitMessage({ type: 'executed', data: { prompt_id: 'prompt-2', node: 'output', output: { images: [{ type: 'output', filename: 'image.jpg' }] } } });
  socket.emitMessage({ type: 'execution_success', data: { prompt_id: 'prompt-2' } });
  await expect(downloadAttempt.completion).rejects.toBe(failure);
});

test('submits a workflow and returns completed output through Comfy transports', async () => {
  const imageBytes = new Uint8Array([1, 2, 3]);
  globalThis.fetch = Object.assign(
    mock(async (input: string | URL | Request) => (String(input).includes('/view?') ? new Response(imageBytes) : Response.json({ prompt_id: 'prompt-1' }))),
    { preconnect: originalFetch.preconnect },
  );
  const client = new ComfyClient({ caCert: 'test', workerHost: '127.0.0.1', bearerToken: 'test', onTransportLost: () => undefined });
  const socket = await connect(client);

  const attempt = await client.submit({ node: { class_type: 'TestNode' } });
  // ComfyUI v0.30.0 can emit cached-node UI output as null.
  socket.emitMessage({ type: 'executed', data: { prompt_id: 'prompt-1', node: 'cached', output: null } });
  socket.emitMessage({ type: 'executed', data: { prompt_id: 'prompt-1', node: 'output', output: { images: [{ type: 'output', filename: 'image.jpg' }] } } });
  socket.emitMessage({ type: 'execution_success', data: { prompt_id: 'prompt-1' } });

  const result = await attempt.completion;
  expect(result.images).toEqual([{ nodeId: 'output', bytes: imageBytes, metadata: { type: 'output', filename: 'image.jpg' } }]);
  expect(result.nodeTimings).toEqual([]);
  client.disconnect();
});

test('prompt that never completes fails after the execution timeout', async () => {
  const db = new Database(':memory:', { strict: true });
  db.run('PRAGMA foreign_keys = ON');
  applySchema(db);
  settings.bind(db);
  settings.set('gpu.promptTimeoutMs', '0');
  installPromptFetch();
  const client = new ComfyClient({ caCert: 'test', workerHost: '127.0.0.1', bearerToken: 'test', onTransportLost: () => undefined });
  const socket = await connect(client);

  const attempt = await client.submit({ node: { class_type: 'TestNode' } });
  await expect(attempt.completion).rejects.toThrow('Comfy prompt execution timed out');

  socket.emitMessage({ type: 'execution_success', data: { prompt_id: 'prompt-1' } });
  await expect(attempt.completion).rejects.toThrow('Comfy prompt execution timed out');
  client.disconnect();
  db.close();
});

test('rejects malformed image output only for its prompt and ignores unrelated events', async () => {
  let promptId = 0;
  globalThis.fetch = Object.assign(mock(async () => Response.json({ prompt_id: `prompt-${String(++promptId)}` })), { preconnect: originalFetch.preconnect });
  const onTransportLost = mock(() => undefined);
  const client = new ComfyClient({ caCert: 'test', workerHost: '127.0.0.1', bearerToken: 'test', onTransportLost });
  const socket = await connect(client);
  const first = await client.submit({});
  const second = await client.submit({});

  socket.emitMessage({ type: 'custom_progress', data: ['ignored'] });
  socket.emitMessage({ type: 'progress', data: { prompt_id: 'prompt-2', value: 1 } });
  socket.emitMessage({ type: 'executed', data: { prompt_id: 'prompt-1', node: 'output', output: { images: [{ type: 'output', filename: 42 }] } } });
  await expect(first.completion).rejects.toThrow();
  socket.emitMessage({ type: 'execution_success', data: { prompt_id: 'prompt-2' } });
  await expect(second.completion).resolves.toEqual({ images: [], nodeTimings: [] });
  expect(onTransportLost).not.toHaveBeenCalled();
  client.disconnect();
});

test('malformed websocket JSON rejects pending work and reports transport loss', async () => {
  installPromptFetch();
  const onTransportLost = mock(() => undefined);
  const client = new ComfyClient({ caCert: 'test', workerHost: '127.0.0.1', bearerToken: 'test', onTransportLost });
  const socket = await connect(client);
  const attempt = await client.submit({});

  socket.emit('message', new MessageEvent('message', { data: '{invalid' }));
  await expect(attempt.completion).rejects.toThrow();
  expect(onTransportLost).toHaveBeenCalledTimes(1);
  await expect(client.submit({})).rejects.toThrow('Comfy websocket is not connected');
});

const installPromptFetch = (): void => {
  globalThis.fetch = Object.assign(
    mock(async () => Response.json({ prompt_id: 'prompt-1' })),
    { preconnect: originalFetch.preconnect },
  );
};

const connect = async (client: ComfyClient): Promise<FauxWebSocket> => {
  globalThis.WebSocket = FauxWebSocket as unknown as typeof WebSocket;
  const connected = client.connect();
  const socket = FauxWebSocket.last;
  if (!socket) throw new Error('Comfy client did not create a websocket');
  socket.emit('open');
  await connected;
  return socket;
};

class FauxWebSocket {
  static readonly OPEN = 1;
  static last: FauxWebSocket | undefined;
  readyState = 0;
  private readonly listeners = new Map<string, FauxEventListener[]>();

  constructor() {
    FauxWebSocket.last = this;
  }

  addEventListener(type: string, listener: FauxEventListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close(): void {
    this.emit('close');
  }

  emit(type: string, event: Event = new Event(type)): void {
    if (type === 'open') this.readyState = FauxWebSocket.OPEN;
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === 'function') listener.call(this as unknown as EventTarget, event);
      else listener.handleEvent(event);
    }
  }

  emitMessage(message: object): void {
    this.emit('message', new MessageEvent('message', { data: JSON.stringify(message) }));
  }
}

type FauxEventListener = ((event: Event) => void) | { handleEvent(event: Event): void };
