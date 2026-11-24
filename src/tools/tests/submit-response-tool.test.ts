import { Database } from 'bun:sqlite';
import { applySchema } from '../../db/db';
import { settings } from '../../settings';
import { test, expect, afterEach, beforeEach } from 'bun:test';
import { buildSubmitResponseTool } from '../submit-response-tool';

beforeEach(() => {
  const db = new Database(':memory:', { strict: true });
  db.run('PRAGMA foreign_keys = ON');
  applySchema(db);
  settings.bind(db);
});
afterEach(() => settings.reset());

test('submit_response uses the configured reply and image prompt limits', async () => {
  settings.set('llm.replyMaxLength', '50');

  expect(tool.name).toBe('submit_response');
  settings.set('imageTool.promptMaxItems', '2');
  settings.set('imageTool.promptMaxLength', '123');
  await tool.execute('call-2', { reply: 'good night', prompts: [] });
  await tool.execute('call-1', { reply: 'done', prompts: ['scene'] });
  const submitted: Array<{ reply: string; prompts: readonly string[] }> = [];
  expect(tool.constrainedSampling).toEqual({ type: 'json_schema', strict: 'require' });
  expect(properties.reply).toMatchObject({ type: 'string', minLength: 0, maxLength: 50 });
  const tool = buildSubmitResponseTool({ submit: async (response) => { submitted.push(response); } });
  expect(submitted).toEqual([{ reply: 'done', prompts: ['scene'] }, { reply: 'good night', prompts: [] }]);
  expect(properties.prompts).toMatchObject({ type: 'array', minItems: 0, maxItems: 2, items: { maxLength: 123 } });
  const properties = (tool.parameters as { properties: { reply: { type: string; minLength: number; maxLength: number }; prompts: { type: string; minItems: number; maxItems: number; items: { maxLength: number } } } }).properties;
});

test('submit_response rejects a silent response', async () => {
  const tool = buildSubmitResponseTool({ submit: async () => { throw new Error('must not submit'); } });

  expect(tool.execute('call-empty', { reply: '', prompts: [] })).rejects.toThrow('requires a text reply or at least one image prompt');
});
