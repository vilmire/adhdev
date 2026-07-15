import assert from 'node:assert/strict';
import test from 'node:test';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshLaunchSession, meshListNodes } from '../src/tools/mesh-tools.js';
import { buildMeshNodeCapabilityTags } from '@adhdev/daemon-core';

// CURSOR-CLI-GENERATING-STUCK-SELFHOST precondition — mesh_launch_session must honor
// an explicitly-requested provider `type` when the node's capability slots declare
// it, and capabilityTags must advertise EVERY slot provider so
// required_tags: ["provider=cursor-cli"] is satisfiable on a node whose slots include
// cursor-cli even when providerPriority[0] is claude-cli.

function makeCtx(nodePolicy: Record<string, unknown>) {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const launchCalls: Array<{ command: string; args: Record<string, unknown> }> = [];
  transport.command = async (command, args = {}) => {
    // MESH-LAUNCH-DUP-GUARD probes live status before launch; no existing session here.
    if (command === 'get_status_metadata') return { success: true, status: { sessions: [] } };
    if (command === 'get_mesh') return { success: true, mesh: (args as any).inlineMesh || mesh };
    if (command === 'trigger_mesh_queue') return { success: true, trigger: { success: true } };
    if (command === 'launch_cli') {
      launchCalls.push({ command, args });
      return { success: true, sessionId: 'session-1' };
    }
    if (command === 'detect_provider') {
      // Any provider probed via priority resolution "detects".
      return { success: true, detected: true };
    }
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (_daemonId, command, args = {}) => {
    if (command === 'get_status_metadata') return { success: true, result: { status: { sessions: [] } } };
    if (command === 'launch_cli') {
      launchCalls.push({ command, args });
      return { success: true, result: { success: true, sessionId: 'session-1' } };
    }
    if (command === 'detect_provider') return { success: true, result: { success: true, detected: true } };
    return { success: true, result: { success: true } };
  };

  const mesh = {
    id: 'mesh-cursor',
    name: 'Cursor Mesh',
    repoIdentity: 'example/repo',
    policy: {},
    coordinator: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [{
      id: 'node-mac',
      workspace: '/repo',
      repoRoot: '/repo',
      // No daemonId → treated as a local control-plane node so launch goes through
      // transport.command('launch_cli') without a coordinator-daemon-id requirement.
      userOverrides: {},
      policy: nodePolicy,
    }],
  };
  const ctx = { mesh, transport, localDaemonId: 'daemon-mac' } as any;
  return { ctx, launchCalls, mesh };
}

test('explicit type is honored when the node has a slot for it', async () => {
  const { ctx, launchCalls } = makeCtx({
    providerPriority: ['claude-cli'],
    slots: [
      { provider: 'claude-cli' },
      { provider: 'cursor-cli' },
      { provider: 'kimi' },
    ],
  });
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-mac', type: 'cursor-cli' }));
  assert.equal(result.success !== false, true, `launch should succeed: ${JSON.stringify(result)}`);
  const launch = launchCalls.find(c => c.command === 'launch_cli');
  assert.ok(launch, 'launch_cli was issued');
  // The launched provider must be the requested cursor-cli, NOT providerPriority[0] (claude-cli).
  assert.equal(launch!.args.cliType, 'cursor-cli');
});

test('explicit type omitted resolves from providerPriority order', async () => {
  const { ctx, launchCalls } = makeCtx({
    providerPriority: ['claude-cli', 'cursor-cli'],
    slots: [{ provider: 'claude-cli' }, { provider: 'cursor-cli' }],
  });
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-mac' }));
  assert.equal(result.success !== false, true, `launch should succeed: ${JSON.stringify(result)}`);
  const launch = launchCalls.find(c => c.command === 'launch_cli');
  assert.ok(launch, 'launch_cli was issued');
  assert.equal(launch!.args.cliType, 'claude-cli');
});

test('explicit type requested but no slot → fail closed (no silent fallback)', async () => {
  const { ctx, launchCalls } = makeCtx({
    providerPriority: ['claude-cli'],
    slots: [{ provider: 'claude-cli' }, { provider: 'codex-cli' }],
  });
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-mac', type: 'cursor-cli' }));
  assert.equal(result.success, false);
  assert.equal(result.code, 'mesh_provider_type_unsupported');
  assert.deepEqual(result.supportedProviders, ['claude-cli', 'codex-cli']);
  // Critically: NO launch was issued — never silently launched claude-cli.
  assert.equal(launchCalls.some(c => c.command === 'launch_cli'), false);
});

test('capabilityTags advertise every slot provider (required_tags satisfiability)', () => {
  const node = {
    id: 'node-mac',
    policy: {
      providerPriority: ['claude-cli'],
      slots: [{ provider: 'claude-cli' }, { provider: 'cursor-cli' }, { provider: 'kimi' }],
    },
  } as any;
  const tags = buildMeshNodeCapabilityTags(node);
  assert.ok(tags.includes('provider=claude-cli'), 'first slot provider advertised');
  assert.ok(tags.includes('provider=cursor-cli'), 'slot-only cursor-cli advertised (the bug)');
  assert.ok(tags.includes('provider=kimi'), 'slot-only kimi advertised');
});

test('a pinned providerType still yields only that provider tag', () => {
  const node = {
    id: 'node-mac',
    policy: { slots: [{ provider: 'claude-cli' }, { provider: 'cursor-cli' }] },
  } as any;
  const tags = buildMeshNodeCapabilityTags(node, 'cursor-cli');
  assert.ok(tags.includes('provider=cursor-cli'));
  assert.ok(!tags.includes('provider=claude-cli'), 'pinned set excludes other providers');
});

test('capabilityTags fall back to providerPriority when no slots declared', () => {
  const node = { id: 'n', policy: { providerPriority: ['claude-cli', 'codex-cli'] } } as any;
  const tags = buildMeshNodeCapabilityTags(node);
  assert.ok(tags.includes('provider=claude-cli'));
  assert.ok(tags.includes('provider=codex-cli'));
});

test('mesh_list_nodes capabilityTagsByProvider covers slot-only providers', async () => {
  const { ctx } = makeCtx({
    providerPriority: ['claude-cli'],
    slots: [{ provider: 'claude-cli' }, { provider: 'cursor-cli' }],
  });
  const listed = JSON.parse(await meshListNodes(ctx));
  const node = listed.nodes.find((n: any) => n.nodeId === 'node-mac');
  assert.ok(node, 'node-mac present');
  assert.deepEqual(Object.keys(node.capabilityTagsByProvider).sort(), ['claude-cli', 'cursor-cli']);
  assert.ok(node.capabilityTagsByProvider['cursor-cli'].includes('provider=cursor-cli'));
});
