import assert from 'node:assert/strict';
import test from 'node:test';

import { CANONICAL_MESH_TOOL_NAMES, WORKER_TOOLS } from '@adhdev/mesh-shared';
import { WORKER_MCP_DAEMON_VERBS, isWorkerMcpDaemonVerb } from '@adhdev/daemon-core';

import {
  ALLOWED_ARTIFACT_KINDS,
  ARTIFACT_LIST_TOOL,
  ARTIFACT_REGISTER_TOOL,
  STANDARD_ARTIFACT_REGISTER_TOOL,
  callCoordinatorArtifactList,
  callStandardArtifactList,
  callStandardArtifactRegister,
  callWorkerArtifactRegister,
} from '../src/tools/artifact-tools.js';
import {
  readWorkerCredentials,
  resolveWorkerModeTools,
  workerArtifactRegister,
} from '../src/tools/worker-tools.js';
import { ALL_MESH_TOOLS } from '../src/tools/mesh-tool-schemas.js';
import { resolveMeshToolHandler } from '../src/tools/mesh-tool-dispatch.js';
import { ALL_ASSISTANT_TOOLS } from '../src/tools/assistant-tools.js';
import { TOOL_ANNOTATIONS } from '../src/tools/tool-annotations.js';
import { enumValueError, unknownToolArgsError, validateMeshToolArgs } from '../src/tools/validate-tool-args.js';
import { buildMcpHelpText } from '../src/help.js';
import type { CommandTransport } from '../src/transports/mode.js';
import type { MeshContext } from '../src/tools/mesh-tools-internal.js';

function createRecordingTransport(response: unknown = { success: true }) {
  const calls: Array<{ verb: string; payload: Record<string, unknown> }> = [];
  const transport: CommandTransport = {
    command: async (verb: string, payload: Record<string, unknown> = {}) => {
      calls.push({ verb, payload });
      return typeof response === 'function' ? (response as any)(verb, payload) : response;
    },
    getStatus: async () => ({ status: {} }),
    ping: async () => true,
  };
  return { transport, calls };
}

test('mode exposure: worker exposes artifact_register only; coordinator exposes artifact_list only; artifact_fetch/read never exposed on MCP', () => {
  const workerNames = resolveWorkerModeTools().map((t) => t.name);
  const meshNames = ALL_MESH_TOOLS.map((t) => t.name);
  const assistantNames = ALL_ASSISTANT_TOOLS.map((t) => t.name);
  const help = buildMcpHelpText();

  // Worker mode
  assert.ok(WORKER_TOOLS.includes('artifact_register'));
  assert.ok(workerNames.includes('artifact_register'));
  assert.equal(workerNames.includes('artifact_list'), false);
  assert.equal(workerNames.includes('artifact_fetch'), false);
  assert.equal(workerNames.includes('artifact_read'), false);

  // Coordinator / mesh mode
  assert.ok(CANONICAL_MESH_TOOL_NAMES.includes('artifact_list'));
  assert.ok(meshNames.includes('artifact_list'));
  assert.equal(meshNames.includes('artifact_register'), false);
  assert.equal(meshNames.includes('artifact_fetch'), false);
  assert.equal(meshNames.includes('artifact_read'), false);

  // Assistant mode untouched
  assert.equal(assistantNames.includes('artifact_register'), false);
  assert.equal(assistantNames.includes('artifact_list'), false);
  assert.equal(assistantNames.includes('artifact_fetch'), false);
  assert.equal(assistantNames.includes('artifact_read'), false);

  // Help text standard mode includes artifact_register and artifact_list, never fetch/read
  const standardLine = help.split('\n').find((l) => l.startsWith('Standard tools:')) ?? '';
  assert.match(standardLine, /\bartifact_register\b/);
  assert.match(standardLine, /\bartifact_list\b/);
  assert.doesNotMatch(help, /\bartifact_fetch\b/);
  assert.doesNotMatch(help, /\bartifact_read\b/);
});

test('standalone worker-scope daemon verb allowlist admits artifact_register and denies list/fetch/read', () => {
  assert.ok(WORKER_MCP_DAEMON_VERBS.includes('artifact_register'));
  assert.equal(isWorkerMcpDaemonVerb('artifact_register'), true);
  assert.equal(isWorkerMcpDaemonVerb('artifact_list'), false);
  assert.equal(isWorkerMcpDaemonVerb('artifact_fetch'), false);
  assert.equal(isWorkerMcpDaemonVerb('artifact_read'), false);
});

test('behavior annotations and input schemas for artifact_register and artifact_list', () => {
  assert.deepEqual(TOOL_ANNOTATIONS.artifact_register, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(TOOL_ANNOTATIONS.artifact_list, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });

  // 5 allowed kinds only (no html/svg)
  assert.deepEqual([...ALLOWED_ARTIFACT_KINDS], ['markdown', 'image', 'diff', 'json', 'text']);
  const workerProps = ARTIFACT_REGISTER_TOOL.inputSchema.properties as Record<string, any>;
  assert.deepEqual(Object.keys(workerProps).sort(), ['kind', 'path', 'title']);
  assert.deepEqual(ARTIFACT_REGISTER_TOOL.inputSchema.required, ['path']);
  assert.deepEqual(workerProps.kind.enum, ['markdown', 'image', 'diff', 'json', 'text']);

  for (const forbidden of ['token', 'bind', 'taskId', 'sessionId', 'session_id', 'targetSessionId', 'meshId', 'workspace', 'workspaceRoot']) {
    assert.equal(forbidden in workerProps, false, `worker artifact_register schema must not expose ${forbidden}`);
  }

  // Standard schema allows optional session_id but never workspace or credentials
  const standardProps = STANDARD_ARTIFACT_REGISTER_TOOL.inputSchema.properties as Record<string, any>;
  assert.deepEqual(Object.keys(standardProps).sort(), ['kind', 'path', 'session_id', 'title']);
  for (const forbidden of ['token', 'bind', 'taskId', 'targetSessionId', 'meshId', 'workspace', 'workspaceRoot']) {
    assert.equal(forbidden in standardProps, false, `standard artifact_register schema must not expose ${forbidden}`);
  }

  // Unknown-arg and enum gates reject forged overrides and disallowed kinds
  assert.ok(unknownToolArgsError('artifact_register', workerProps, { path: 'a.md', workspace: '/etc' }));
  assert.ok(unknownToolArgsError('artifact_register', workerProps, { path: 'a.md', targetSessionId: 's_other' }));
  assert.ok(unknownToolArgsError('artifact_register', workerProps, { path: 'a.md', session_id: 's_other' }));
  assert.ok(enumValueError('artifact_register', workerProps, { path: 'a.svg', kind: 'svg' }));
  assert.ok(enumValueError('artifact_register', workerProps, { path: 'a.html', kind: 'html' }));
  assert.equal(unknownToolArgsError('artifact_register', workerProps, { path: 'docs/report.md', title: 'Report', kind: 'markdown' }), null);
  assert.equal(enumValueError('artifact_register', workerProps, { path: 'docs/report.md', title: 'Report', kind: 'markdown' }), null);

  // Coordinator mesh gate for artifact_list
  assert.equal(validateMeshToolArgs('artifact_list', {}), null);
  assert.equal(validateMeshToolArgs('artifact_list', { session_id: 'sess_1', limit: 10 }), null);
  assert.ok(validateMeshToolArgs('artifact_list', { workspace: '/tmp/evil' }));
});

test('worker artifact_register forwards trusted MCP credentials and strips forged payload overrides', async () => {
  const { transport, calls } = createRecordingTransport({
    success: true,
    artifactId: 'art_0123456789abcdef',
    sessionId: 'sess_worker_trusted',
    taskId: 'task_trusted_1',
    isUpdate: false,
  });

  const creds = readWorkerCredentials({
    ADHDEV_WORKER_SESSION_BIND: 'wsb_trusted_bind',
    ADHDEV_WORKER_TASK_TOKEN: 'wtt_trusted_token',
  });

  const res = await workerArtifactRegister(transport, creds, {
    path: 'reports/summary.md',
    title: 'Summary Report',
    kind: 'markdown',
    // Forged fields a caller might try to smuggle past schema validation:
    bind: 'wsb_forged',
    token: 'wtt_forged',
    sessionId: 'sess_forged',
    session_id: 'sess_forged',
    targetSessionId: 'sess_forged',
    workspace: '/etc',
    workspaceRoot: '/etc',
    taskId: 'task_forged',
    meshId: 'mesh_forged',
  });

  assert.equal(res.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].verb, 'artifact_register');
  assert.deepEqual(calls[0].payload, {
    path: 'reports/summary.md',
    title: 'Summary Report',
    kind: 'markdown',
    bind: 'wsb_trusted_bind',
    token: 'wtt_trusted_token',
  });
});

test('worker artifact_register rejects missing path, disallowed kind, and propagates daemon refusal as isError', async () => {
  const { transport, calls } = createRecordingTransport({
    success: false,
    code: 'path_traversal_denied',
    error: 'Artifact path escapes workspace root (path_traversal_denied)',
  });
  const creds = readWorkerCredentials({ ADHDEV_WORKER_SESSION_BIND: 'wsb_1' });

  const emptyPath = await workerArtifactRegister(transport, creds, { path: '   ' });
  assert.equal(emptyPath.isError, true);
  assert.equal(JSON.parse(emptyPath.text).code, 'invalid_arguments');
  assert.equal(calls.length, 0);

  const badKind = await workerArtifactRegister(transport, creds, { path: 'x.svg', kind: 'svg' });
  assert.equal(badKind.isError, true);
  assert.equal(JSON.parse(badKind.text).code, 'unsupported_artifact_kind');
  assert.equal(calls.length, 0);

  const daemonDenied = await workerArtifactRegister(transport, creds, { path: '../secret.txt' });
  assert.equal(daemonDenied.isError, true);
  assert.equal(JSON.parse(daemonDenied.text).code, 'path_traversal_denied');
  assert.equal(calls.length, 1);
});

test('coordinator artifact_list resolves authorized session/mesh scope and rejects foreign session_id', async () => {
  const { transport, calls } = createRecordingTransport((verb: string, payload: Record<string, unknown>) => {
    if (verb === 'tool_call_record') return { rateLimited: false };
    return {
      success: true,
      sessionId: payload.sessionId,
      artifacts: [],
      attachments: [],
    };
  });

  const ctx: MeshContext = {
    transport,
    coordinatorSessionId: 'sess_coord_main',
    mesh: {
      id: 'mesh_alpha',
      name: 'Alpha',
      repoIdentity: 'github.com/acme/alpha',
      nodes: [
        {
          id: 'node_worker_1',
          workspace: '/repo/wt1',
          activeSessionId: 'sess_worker_1',
          sessions: [{ id: 'sess_worker_2' }],
        } as any,
      ],
    } as any,
  };

  // 1) Default call (no session_id) resolves coordinator's own session + meshId
  const handler = resolveMeshToolHandler('artifact_list');
  assert.equal(typeof handler, 'function');
  const defaultOut = JSON.parse(await handler!(ctx, {}));
  assert.equal(defaultOut.success, true);
  assert.equal(defaultOut.sessionId, 'sess_coord_main');
  const listCalls1 = calls.filter((c) => c.verb === 'artifact_list');
  assert.equal(listCalls1.length, 1);
  assert.deepEqual(listCalls1[0].payload, {
    sessionId: 'sess_coord_main',
    callerSessionId: 'sess_coord_main',
    meshId: 'mesh_alpha',
  });

  // 2) Explicit mesh worker session within the coordinator's mesh is allowed
  const workerOut = JSON.parse(await callCoordinatorArtifactList(ctx, { session_id: 'sess_worker_2', limit: 20 }));
  assert.equal(workerOut.success, true);
  assert.equal(workerOut.sessionId, 'sess_worker_2');
  const listCalls2 = calls.filter((c) => c.verb === 'artifact_list');
  assert.equal(listCalls2.length, 2);
  assert.deepEqual(listCalls2[1].payload, {
    sessionId: 'sess_worker_2',
    meshId: 'mesh_alpha',
    limit: 20,
  });

  // 3) Foreign session outside coordinatorSessionId and mesh nodes is denied before reaching transport
  const foreignOut = JSON.parse(await callCoordinatorArtifactList(ctx, { session_id: 'sess_foreign_other_project' }));
  assert.equal(foreignOut.success, false);
  assert.equal(foreignOut.code, 'artifact_session_mismatch');
  assert.equal(calls.filter((c) => c.verb === 'artifact_list').length, 2);
});

test('standard mode artifact_register and artifact_list use transport.command and strip forged fields', async () => {
  const { transport, calls } = createRecordingTransport({
    success: true,
    artifacts: [],
    attachments: [],
  });

  const regText = await callStandardArtifactRegister(transport, {
    path: 'output/chart.png',
    title: 'Chart',
    kind: 'image',
    session_id: 'sess_std_1',
    workspace: '/forged/root',
    workspaceRoot: '/forged/root',
    bind: 'wsb_forged',
    token: 'wtt_forged',
    targetSessionId: 'sess_forged',
  });
  assert.equal(JSON.parse(regText).success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].verb, 'artifact_register');
  assert.deepEqual(calls[0].payload, {
    path: 'output/chart.png',
    title: 'Chart',
    kind: 'image',
    sessionId: 'sess_std_1',
  });

  const listText = await callStandardArtifactList(transport, {
    session_id: 'sess_std_1',
    limit: 15,
    workspace: '/forged/root',
  });
  assert.equal(JSON.parse(listText).success, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].verb, 'artifact_list');
  assert.deepEqual(calls[1].payload, {
    sessionId: 'sess_std_1',
    limit: 15,
  });

  // Direct callWorkerArtifactRegister also strips forged fields
  await callWorkerArtifactRegister(
    transport,
    { bind: 'wsb_direct' },
    { path: 'a.json', kind: 'json', workspace: '/bad' },
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].payload, {
    path: 'a.json',
    kind: 'json',
    bind: 'wsb_direct',
  });
});
