import { test, expect } from 'bun:test';
import { buildAnimateImageTool } from '../animate-image-tool';
import type { UserId, ConversationId, GeneratedImageId } from '../../utils/brands';
import type { AnimateRequestDispatcher } from '../../image-requests/animate-request-dispatcher';

const userId = 'user-1' as UserId;

test('animate_image passes the motion prompt and source image lineage to the dispatcher', async () => {
  let submitted: { prompt: string; sourceImageId: GeneratedImageId | null } | null = null;
  let rejectionNotices = 0;
  const replies: string[] = [];
  const dispatcher = {
    enqueue: (params: { prompt: string; sourceImageId: GeneratedImageId | null }) => {
      submitted = params;
      return { kind: 'queued' };
    },
  } as unknown as AnimateRequestDispatcher;

  const tool = buildAnimateImageTool({ userId, traceId: 'trace-1', characterId: 'agent_a', conversationId: 1 as ConversationId, sourceImageId: 42 as GeneratedImageId, animateDispatcher: dispatcher, sendReply: async (reply) => { replies.push(reply); }, onRejected: async () => { rejectionNotices += 1; } });

  expect(tool.name).toBe('animate_image');
  expect((tool.parameters as { required: string[] }).required).toEqual(['reply', 'prompt']);
  expect(JSON.stringify(tool.parameters)).not.toContain('sourceImageId');
  await tool.execute('call-1', { reply: 'Lorem.', prompt: 'lorem ipsum' });
  expect(submitted).toMatchObject({ prompt: 'lorem ipsum', sourceImageId: 42 });
  await tool.execute('call-2', { reply: '', prompt: 'dolor sit amet' });
  expect(submitted).toMatchObject({ prompt: 'dolor sit amet', sourceImageId: 42 });
  expect(replies).toEqual(['Lorem.']);
  expect(rejectionNotices).toBe(0);
});

test('reports an admission rejection without another model response', async () => {
  const rejectionReasons: string[] = [];

  expect(rejectionReasons).toEqual(['paused']);
  expect(JSON.parse(text)).toEqual({ status: 'rejected', reason: 'paused' });
  const text = result.content[0]?.type === 'text' ? result.content[0].text : '{}';

  const result = await tool.execute('call-rejected', { reply: '', prompt: 'lorem ipsum' });
  const dispatcher = { enqueue: () => ({ kind: 'rejected', reason: 'paused' }) } as unknown as AnimateRequestDispatcher;
  const tool = buildAnimateImageTool({ userId, traceId: 'trace-rejected', characterId: 'agent_a', conversationId: 1 as ConversationId, sourceImageId: 42 as GeneratedImageId, animateDispatcher: dispatcher, sendReply: async () => undefined, onRejected: async (reason) => { rejectionReasons.push(reason); } });
});

test('rejects an animation call without a current source image', async () => {
  const dispatcher = { enqueue: () => { throw new Error('must not enqueue'); } } as unknown as AnimateRequestDispatcher;

  expect(tool.execute('call-missing', { reply: 'Lorem.', prompt: 'lorem ipsum' })).rejects.toThrow('latest user message has no source image prompt');
  const tool = buildAnimateImageTool({ userId, traceId: 'trace-missing', characterId: 'agent_a', conversationId: 1 as ConversationId, sourceImageId: null, animateDispatcher: dispatcher, sendReply: async () => { throw new Error('must not reply'); }, onRejected: async () => undefined });
});
