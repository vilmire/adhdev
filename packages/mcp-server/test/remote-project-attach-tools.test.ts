import assert from 'node:assert/strict';
import test from 'node:test';

import { ASSISTANT_TOOL_VERBS, ASSISTANT_WRITE_TOOLS } from '@adhdev/mesh-shared';
import { ALL_MESH_TOOLS } from '../src/tools/mesh-tools.js';
import { ALL_ASSISTANT_TOOLS, callAssistantTool } from '../src/tools/assistant-tools.js';
import { resolveMeshToolHandler } from '../src/tools/mesh-tool-dispatch.js';
import { TOOL_ANNOTATIONS } from '../src/tools/tool-annotations.js';
import { getTimeoutMs, isRetryableProbeCommand } from '../src/transports/ipc.js';

/**
 * Authenticated remote project attach — the two supported tool surfaces
 * (`project_attach_remote` for the assistant, `mesh_attach_remote` for a
 * coordinator). Both reach the daemon's setup verb with exactly the project and
 * the owner-selected target: no credential field exists to pass, and the mesh
 * tool takes its project from the active mesh, never from an argument.
 */

const CREDENTIALISH = /token|secret|password|credential|auth|url|path|workspace/i;

function schemaOf(tools: readonly any[], name: string) {
  const tool = tools.find(t => t.name === name);
  assert.ok(tool, `${name} is published`);
  return tool;
}

test('both attach schemas take only the project and the exact target — no credential, URL or path field', () => {
  const mesh = schemaOf(ALL_MESH_TOOLS, 'mesh_attach_remote');
  assert.deepEqual(Object.keys(mesh.inputSchema.properties), ['targetDaemonId']);
  assert.deepEqual(mesh.inputSchema.required, ['targetDaemonId']);
  const assistant = schemaOf(ALL_ASSISTANT_TOOLS, 'project_attach_remote');
  assert.deepEqual(Object.keys(assistant.inputSchema.properties).sort(), ['project', 'targetDaemonId']);
  assert.deepEqual([...assistant.inputSchema.required].sort(), ['project', 'targetDaemonId']);
  for (const key of [...Object.keys(mesh.inputSchema.properties), ...Object.keys(assistant.inputSchema.properties)]) {
    assert.equal(CREDENTIALISH.test(key), false, `${key} must not look like a credential or path input`);
  }
});

test('both are write tools: never read-only, so MCP clients keep confirmation', () => {
  assert.equal(TOOL_ANNOTATIONS.mesh_attach_remote?.readOnlyHint, false);
  assert.equal(TOOL_ANNOTATIONS.project_attach_remote?.readOnlyHint, false);
  assert.equal(ASSISTANT_WRITE_TOOLS.includes('project_attach_remote'), true);
});

test('mesh_attach_remote dispatches attach_remote_project for the active mesh and the given target only', async () => {
  const calls: Array<{ type: string; args: Record<string, unknown> }> = [];
  const ctx: any = {
    mesh: { id: 'mesh_active' },
    transport: { command: async (type: string, args: Record<string, unknown>) => { calls.push({ type, args }); return { success: false, code: 'LOCAL_ONLY_PROJECT', stage: 'registration' }; } },
  };
  const handler = resolveMeshToolHandler('mesh_attach_remote');
  assert.ok(handler);
  const text = await handler!(ctx, { targetDaemonId: 'daemon_mach_target1', meshId: 'mesh_other', token: 'ghp_x' });
  assert.deepEqual(calls, [{ type: 'attach_remote_project', args: { meshId: 'mesh_active', targetDaemonId: 'daemon_mach_target1' } }]);
  // The daemon's truthful refusal is relayed as-is.
  assert.deepEqual(JSON.parse(text), { success: false, code: 'LOCAL_ONLY_PROJECT', stage: 'registration' });
});

test('project_attach_remote calls its verb and surfaces a refusal as an error', async () => {
  const calls: Array<{ type: string; args: Record<string, unknown> }> = [];
  const transport = { command: async (type: string, args: Record<string, unknown>) => { calls.push({ type, args }); return { success: false, code: 'AUTH_REQUIRED', stage: 'authentication' }; } };
  const res = await callAssistantTool(transport, 'project_attach_remote', { project: 'batrp', targetDaemonId: 'daemon_mach_target1' }, 'sess-1');
  assert.equal(calls[0]?.type, ASSISTANT_TOOL_VERBS.project_attach_remote);
  assert.equal(calls[0]?.type, 'assistant_project_attach_remote');
  assert.equal(calls[0]?.args.targetDaemonId, 'daemon_mach_target1');
  assert.equal(res.isError, true);
  assert.match(res.text, /AUTH_REQUIRED/);
});

test('IPC waits longer than the attach bridge, and the mutating verbs are never auto-retried', () => {
  for (const verb of ['attach_remote_project', 'assistant_project_attach_remote']) {
    assert.ok(getTimeoutMs(verb, '') > 300_000, `${verb} must outlast the 300s cloud bridge`);
    assert.equal(isRetryableProbeCommand(verb), false, `${verb} mutates and must not be retried on timeout`);
  }
});
