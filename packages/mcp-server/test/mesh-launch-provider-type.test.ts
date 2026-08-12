import assert from 'node:assert/strict';
import test from 'node:test';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshLaunchSession, meshListNodes } from '../src/tools/mesh-tools.js';
import { getNodeLaunchReadiness, readProviderPriority } from '../src/tools/mesh-tools-internal.js';
import { buildMeshNodeCapabilityTags } from '@adhdev/daemon-core';

// CURSOR-CLI-GENERATING-STUCK-SELFHOST precondition — mesh_launch_session must honor
// an explicitly-requested provider `type` when the node's capability slots declare
// it, and capabilityTags must advertise EVERY slot provider so
// required_tags: ["provider=cursor-cli"] is satisfiable on a node whose slots include
// cursor-cli even when providerPriority[0] is claude-cli.

function makeCtx(nodePolicy: Record<string, unknown>, existingSessions: any[] = []) {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const launchCalls: Array<{ command: string; args: Record<string, unknown> }> = [];
  transport.command = async (command, args = {}) => {
    // MESH-LAUNCH-DUP-GUARD probes live status before launch; tests may seed existing sessions.
    if (command === 'get_status_metadata') return { success: true, status: { sessions: existingSessions } };
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

// PROVIDER-PRIORITY-FROM-SLOTS: a node with capability slots but no explicit
// providerPriority must still resolve a type-omitted launch (slot order =
// preference) and report launchReady — previously it fail-closed with
// missing_provider_priority even though the slots fully determine the order.
test('explicit type omitted, no providerPriority → resolves from slots order', async () => {
  const { ctx, launchCalls } = makeCtx({
    slots: [{ provider: 'codex-cli' }, { provider: 'claude-cli' }],
  });
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-mac' }));
  assert.equal(result.success !== false, true, `launch should succeed: ${JSON.stringify(result)}`);
  const launch = launchCalls.find(c => c.command === 'launch_cli');
  assert.ok(launch, 'launch_cli was issued');
  assert.equal(launch!.args.cliType, 'codex-cli');
});

test('readiness: slots-only node is launchReady via the slots-derived priority', () => {
  const node = { id: 'n', policy: { slots: [{ provider: 'claude-cli' }, { provider: 'codex-cli' }] } } as any;
  const readiness = getNodeLaunchReadiness(node);
  assert.equal(readiness.launchReady, true);
  assert.deepEqual(readiness.providerPriority, ['claude-cli', 'codex-cli']);
});

test('readiness: explicit providerPriority wins over the slots-derived order', () => {
  const node = { id: 'n', policy: { providerPriority: ['codex-cli'], slots: [{ provider: 'claude-cli' }] } } as any;
  assert.deepEqual(readProviderPriority(node.policy), ['codex-cli']);
  assert.equal(getNodeLaunchReadiness(node).launchReady, true);
});

test('readiness: no providerPriority and no slots → still missing_provider_priority', () => {
  const node = { id: 'n', policy: {} } as any;
  const readiness = getNodeLaunchReadiness(node);
  assert.equal(readiness.launchReady, false);
  assert.equal(readiness.launchBlockedReason, 'missing_provider_priority');
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

// PROVIDER-MISMATCH-REUSE dup-guard: mesh_launch_session(type:X, force=false) must NOT
// reuse an existing idle session of a DIFFERENT provider. It previously returned any
// non-terminal mesh-owned session, handing back the wrong provider (antigravity) for a
// claude-cli request. The guard now compares the resolved provider before reusing.

function idleMeshSession(meshId: string, nodeId: string, providerType: string, sessionId: string) {
  // Minimal record that isMeshOwnedDelegateSession + isIdleSessionRecord accept.
  return {
    sessionId,
    status: 'idle',
    providerType,
    settings: { meshNodeFor: meshId, meshNodeId: nodeId },
  };
}

test('dup-guard: provider mismatch → launch a fresh session (no reuse)', async () => {
  const { ctx, launchCalls } = makeCtx(
    { providerPriority: ['claude-cli'], slots: [{ provider: 'claude-cli' }, { provider: 'antigravity' }] },
    [idleMeshSession('mesh-cursor', 'node-mac', 'antigravity', 'antigravity-1')],
  );
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-mac', type: 'claude-cli' }));
  // Must NOT be an idempotent reuse of the antigravity session.
  assert.notEqual(result.reused, true, `should not reuse mismatched provider: ${JSON.stringify(result)}`);
  const launch = launchCalls.find(c => c.command === 'launch_cli');
  assert.ok(launch, 'a fresh launch_cli was issued for the requested provider');
  assert.equal(launch!.args.cliType, 'claude-cli');
});

test('dup-guard: provider match → reuse the existing session (no duplicate launch)', async () => {
  const { ctx, launchCalls } = makeCtx(
    { providerPriority: ['claude-cli'], slots: [{ provider: 'claude-cli' }] },
    [idleMeshSession('mesh-cursor', 'node-mac', 'claude-cli', 'claude-1')],
  );
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-mac', type: 'claude-cli' }));
  assert.equal(result.reused, true, `matching provider should reuse: ${JSON.stringify(result)}`);
  assert.equal(result.sessionId, 'claude-1');
  // No new session spawned.
  assert.equal(launchCalls.some(c => c.command === 'launch_cli'), false);
});

test('dup-guard: existing session with UNKNOWN provider is still reused (regression guard)', async () => {
  // The provider filter only rejects on a DEFINITE mismatch — both sides known and unequal.
  // A live session whose record carries no resolvable provider (older/partial status record)
  // must keep the original "reuse the idle worker" behaviour so the guard never regresses into
  // spawning a duplicate against a session it simply can't classify.
  const unknownProviderSession = {
    sessionId: 'unknown-1',
    status: 'idle',
    settings: { meshNodeFor: 'mesh-cursor', meshNodeId: 'node-mac' },
  };
  const { ctx, launchCalls } = makeCtx(
    { providerPriority: ['claude-cli'], slots: [{ provider: 'claude-cli' }] },
    [unknownProviderSession],
  );
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-mac', type: 'claude-cli' }));
  assert.equal(result.reused, true, `unknown-provider session should still be reused: ${JSON.stringify(result)}`);
  assert.equal(result.sessionId, 'unknown-1');
  assert.equal(launchCalls.some(c => c.command === 'launch_cli'), false);
});

test('dup-guard: force=true bypasses the guard entirely (always launches)', async () => {
  const { ctx, launchCalls } = makeCtx(
    { providerPriority: ['claude-cli'], slots: [{ provider: 'claude-cli' }] },
    [idleMeshSession('mesh-cursor', 'node-mac', 'claude-cli', 'claude-1')],
  );
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-mac', type: 'claude-cli', force: true }));
  assert.notEqual(result.reused, true, `force=true must not reuse: ${JSON.stringify(result)}`);
  const launch = launchCalls.find(c => c.command === 'launch_cli');
  assert.ok(launch, 'force=true always issues a launch');
  assert.equal(launch!.args.cliType, 'claude-cli');
});
