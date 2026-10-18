import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resolveWorkerModeTools, readWorkerCredentials, workerDriverTool } from '../src/tools/worker-tools.js';
import { resolveAssistantModeTools } from '../src/tools/assistant-tools.js';
import { handleAssistantToolCall } from '../src/assistant-server.js';
import { ALL_MESH_TOOLS, MESH_NOTIFY_WORKER_TOOL } from '../src/tools/mesh-tools.js';
import { resolveMeshToolHandler } from '../src/tools/mesh-tool-dispatch.js';
import { findUnannotatedTools, TOOL_ANNOTATIONS, annotateAll } from '../src/tools/tool-annotations.js';
import type { CommandTransport } from '../src/transports/mode.js';

const tools = { worker: resolveWorkerModeTools(), coordinator: [...ALL_MESH_TOOLS, ...annotateAll([MESH_NOTIFY_WORKER_TOOL])], assistant: resolveAssistantModeTools() };
const snapshot = JSON.parse(readFileSync(new URL('./fixtures/driver-tool-modes.snapshot.json', import.meta.url), 'utf8'));
for (const mode of ['worker', 'coordinator', 'assistant'] as const) {
  test(`${mode} tool-list snapshot: driver_invoke ${mode === 'worker' ? 'PRESENT' : 'ABSENT'}`, () => {
    const names = tools[mode].map(t => t.name);
    assert.deepEqual(names, snapshot[mode]);
    assert.equal(names.includes('driver_invoke'), mode === 'worker');
    assert.ok(names.includes('driver_list')); assert.ok(names.includes('driver_describe'));
  });
}
test('assertEveryToolAnnotated: all three modes and conservative driver hints', () => {
  for (const list of Object.values(tools)) {
    assert.deepEqual(findUnannotatedTools(list), []);
    for (const t of list) for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const)
      assert.equal(typeof t.annotations?.[key], 'boolean', `${t.name}.${key}`);
  }
  assert.equal(TOOL_ANNOTATIONS.driver_list.readOnlyHint, true);
  assert.equal(TOOL_ANNOTATIONS.driver_describe.readOnlyHint, true);
  assert.deepEqual(TOOL_ANNOTATIONS.driver_invoke, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
});
function transport() {
  const calls: Array<{ verb: string; args: Record<string, unknown> }> = [];
  return { calls, value: { command: async (verb: string, args: Record<string, unknown>) => {
    calls.push({ verb, args }); return { success: true, output: 'tool-result' };
  } } as unknown as CommandTransport };
}
for (const env of [{ ADHDEV_WORKER_SESSION_BIND: ' wsb_launch ' }, { ADHDEV_WORKER_TASK_TOKEN: ' wtk_launch ' }]) {
  test(`worker forwards ${Object.keys(env)[0]} from readWorkerCredentials, never model credentials`, async () => {
    const t = transport(); const credentials = readWorkerCredentials(env);
    const result = await workerDriverTool(t.value, credentials, 'driver_invoke', {
      type: 'browser', action: 'snapshot', args: { url: 'https://example.test' }, resource_key: 'profile',
      bind: 'forged', token: 'forged', meshId: 'forged', taskId: 'forged', target: 'remote',
    });
    assert.deepEqual(t.calls, [{ verb: 'driver_invoke', args: { type: 'browser', action: 'snapshot',
      args: { url: 'https://example.test' }, resourceKey: 'profile', ...credentials } }]);
    assert.deepEqual(JSON.parse(result.text), { success: true, output: 'tool-result' });
    assert.equal(result.isError, undefined);
  });
}
test('coordinator dispatches only local discovery and has no invoke handler', async () => {
  const t = transport(); const ctx = { transport: t.value } as any;
  await resolveMeshToolHandler('driver_list')!(ctx, { token: 'forged' });
  await resolveMeshToolHandler('driver_describe')!(ctx, { type: 'browser', token: 'forged' });
  assert.deepEqual(t.calls, [{ verb: 'driver_list', args: {} }, { verb: 'driver_describe', args: { type: 'browser' } }]);
  assert.equal(resolveMeshToolHandler('driver_invoke'), undefined);
});
test('assistant dispatches discovery and refuses invoke without daemon execution', async () => {
  const t = transport();
  for (const [name, args] of [['driver_list', {}], ['driver_describe', { type: 'browser' }]] as const) {
    assert.equal((await handleAssistantToolCall(t.value, tools.assistant, 'assistant-session', name, args)).isError, undefined);
  }
  const before = t.calls.length;
  assert.equal((await handleAssistantToolCall(t.value, tools.assistant, 'assistant-session', 'driver_invoke', { type: 'browser', action: 'snapshot', args: {} })).isError, true);
  assert.equal(t.calls.length, before);
});
test('worker exposes daemon rejection as an MCP error and has no credential arguments in its schemas', async () => {
  const t = { command: async () => ({ success: false, code: 'driver_not_approved' }) } as unknown as CommandTransport;
  const result = await workerDriverTool(t, { bind: 'wsb_launch' }, 'driver_invoke', { type: 'browser', action: 'snapshot', args: {} });
  assert.equal(result.isError, true); assert.equal(JSON.parse(result.text).code, 'driver_not_approved');
  for (const tool of tools.worker.filter(t => t.name.startsWith('driver_'))) {
    for (const forbidden of ['token', 'bind', 'taskId', 'sessionId', 'meshId'])
      assert.equal(Object.hasOwn(tool.inputSchema.properties ?? {}, forbidden), false);
  }
});
