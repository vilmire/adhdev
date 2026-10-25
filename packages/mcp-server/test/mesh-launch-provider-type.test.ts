import assert from 'node:assert/strict';
import test from 'node:test';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshLaunchSession, meshListNodes } from '../src/tools/mesh-tools.js';
import { getNodeLaunchReadiness, readProviderPriority } from '../src/tools/mesh-tools-internal-core.js';
import { buildMeshNodeCapabilityTags, readSessionModel } from '@adhdev/daemon-core';
import { resolveLaunchProvenance } from '../../daemon-core/src/commands/cli-manager-launch.js';
import { buildProviderState, type ProviderStateHost } from '../../daemon-core/src/providers/cli-provider-state-projection.js';
import { allowedClassifiedDifficultiesForSession, taskMeetsSessionDifficultyFloor } from '../../daemon-core/src/mesh/mesh-difficulty-floor.js';

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
  // MESH-LAUNCH-AUDIT capture: every mesh_launch_session call must produce exactly
  // one tool_call_record row (caller identity) and one record_local ledger audit
  // (outcome + safe fields).
  const toolCallRecords: Array<Record<string, unknown>> = [];
  const localRecords: Array<Record<string, unknown>> = [];
  transport.command = async (command, args = {}) => {
    // MESH-LAUNCH-DUP-GUARD probes live status before launch; tests may seed existing sessions.
    if (command === 'get_status_metadata') return { success: true, status: { sessions: existingSessions } };
    if (command === 'get_mesh') return { success: true, mesh: (args as any).inlineMesh || mesh };
    if (command === 'trigger_mesh_queue') return { success: true, trigger: { success: true } };
    if (command === 'tool_call_record') {
      toolCallRecords.push(args);
      return { success: true, rateLimitExceeded: false, callsInWindow: 1, advisory: null };
    }
    if (command === 'record_local') {
      localRecords.push(args);
      return { success: true, eventId: 'evt-1', timestamp: new Date().toISOString(), storedLocally: true, published: false };
    }
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
  return { ctx, launchCalls, toolCallRecords, localRecords, mesh };
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
  assert.deepEqual(result.providerPinWarnings[0].requestedProviders, ['cursor-cli']);
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
  assert.equal(result.providerPinWarnings, undefined);
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

// PRECEDENCE FLIPPED (launch/auto-launch path agreement): slots are the
// authoritative capability list (node capability slots design, 2026-07-09) and the auto-launch
// path resolves from them, so the manual path must too — otherwise the two
// dispatch paths pick DIFFERENT first providers for the same node. This test
// previously asserted the opposite precedence; the assertion was the pin on the
// mismatch, so it flips with the behaviour. providerPriority survives as the
// legacy fallback (covered by the next test).
test('readiness: slots win over the legacy providerPriority order', () => {
  const node = { id: 'n', policy: { providerPriority: ['codex-cli'], slots: [{ provider: 'claude-cli' }] } } as any;
  assert.deepEqual(readProviderPriority(node.policy), ['claude-cli']);
  assert.equal(getNodeLaunchReadiness(node).launchReady, true);
});

// LEGACY-NODE FALLBACK: providerPriority is NOT removed. A node that declares no
// slots has it as its only preference signal — dropping the fallback would report
// such a node as missing_provider_priority (unlaunchable).
test('readiness: slots-less legacy node still resolves from providerPriority', () => {
  const node = { id: 'n', policy: { providerPriority: ['codex-cli', 'claude-cli'] } } as any;
  assert.deepEqual(readProviderPriority(node.policy), ['codex-cli', 'claude-cli']);
  assert.equal(getNodeLaunchReadiness(node).launchReady, true);
});

test('readiness: no providerPriority and no slots → still missing_provider_priority', () => {
  const node = { id: 'n', policy: {} } as any;
  const readiness = getNodeLaunchReadiness(node);
  assert.equal(readiness.launchReady, false);
  assert.equal(readiness.launchBlockedReason, 'missing_provider_priority');
});

// DEFAULT FROM NODE FACTS (2026-10-09): a node with no providerPriority and no
// slots defaults to the providers it reports enabled — the same rule daemon-core
// auto-launch applies (mesh-shared defaultProviderPriorityFromNodeFacts), so the
// node is not launchReady on one surface and missing_provider_priority on another.
const reportedFacts = {
  schemaVersion: 1,
  reportedAt: Date.now(),
  providerEnablement: { kimi: { enabled: true, quotaEnabled: true }, 'codex-cli': { enabled: true, quotaEnabled: true }, 'cursor-cli': { enabled: false, quotaEnabled: true } },
};

test('readiness: no providerPriority/slots but reported enabled providers → launchReady with the default order', () => {
  const node = { id: 'n', policy: {}, nodeFacts: reportedFacts } as any;
  const readiness = getNodeLaunchReadiness(node);
  assert.equal(readiness.launchReady, true);
  assert.deepEqual(readiness.providerPriority, ['codex-cli', 'kimi']);
});

test('explicit type omitted, no providerPriority/slots → resolves from the node-reported default', async () => {
  const { ctx, launchCalls, mesh } = makeCtx({});
  (mesh.nodes[0] as any).nodeFacts = reportedFacts;
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-mac' }));
  assert.equal(result.success !== false, true, `launch should succeed: ${JSON.stringify(result)}`);
  const launch = launchCalls.find(c => c.command === 'launch_cli');
  assert.ok(launch, 'launch_cli was issued');
  assert.equal(launch!.args.cliType, 'codex-cli');
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

// ── MESH-LAUNCH-AUDIT ─────────────────────────────────────────────────────────
// Every mesh_launch_session call must land in the structured audit path:
//   - ONE mesh_tool_call_log row via tool_call_record (caller identity from the
//     trusted ctx.coordinatorSessionId, never from a tool argument), and
//   - ONE session_launch_requested ledger record with the outcome + safe fields.
// Previously neither fired for launches, so a manual duplicate launch (the
// 2026-10-10 orphan incident) was unattributable after the fact.

function launchAudit(records: Array<Record<string, unknown>>) {
  const found = records.filter(r => r.kind === 'session_launch_requested');
  assert.equal(found.length, 1, `exactly one session_launch_requested record, got ${found.length}`);
  return found[0];
}

test('audit: a fresh launch records tool_call_record + session_launch_requested(launched)', async () => {
  const { ctx, toolCallRecords, localRecords } = makeCtx({
    providerPriority: ['claude-cli'],
    slots: [{ provider: 'claude-cli' }],
  });
  ctx.coordinatorSessionId = 'coord-session-1';
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-mac', type: 'claude-cli' }));
  assert.equal(result.success !== false, true, `launch should succeed: ${JSON.stringify(result)}`);

  assert.deepEqual(toolCallRecords.map(r => r.tool), ['mesh_launch_session']);
  assert.equal(toolCallRecords[0].meshId, 'mesh-cursor');
  assert.equal(toolCallRecords[0].sessionId, 'coord-session-1');
  assert.equal(toolCallRecords[0].callerRole, 'coordinator');

  const audit = launchAudit(localRecords);
  assert.equal(audit.meshId, 'mesh-cursor');
  assert.equal(audit.nodeId, 'node-mac');
  assert.equal(audit.providerType, 'claude-cli');
  assert.equal(audit.sessionId, 'session-1');
  const payload = audit.payload as Record<string, unknown>;
  assert.equal(payload.outcome, 'launched');
  assert.equal(payload.force, false);
  assert.equal(payload.requestedType, 'claude-cli');
  assert.equal(payload.resolvedProviderType, 'claude-cli');
  assert.equal(payload.callerRole, 'coordinator');
  assert.equal(payload.coordinatorSessionId, 'coord-session-1');
});

test('audit: dup-guard reuse records outcome reused (and no launch_cli)', async () => {
  const { ctx, launchCalls, toolCallRecords, localRecords } = makeCtx(
    { providerPriority: ['claude-cli'], slots: [{ provider: 'claude-cli' }] },
    [idleMeshSession('mesh-cursor', 'node-mac', 'claude-cli', 'claude-1')],
  );
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-mac', type: 'claude-cli' }));
  assert.equal(result.reused, true);
  assert.equal(launchCalls.some(c => c.command === 'launch_cli'), false);

  assert.deepEqual(toolCallRecords.map(r => r.tool), ['mesh_launch_session']);
  // No coordinator session in ctx → callerRole is 'unknown', never fabricated.
  assert.equal(toolCallRecords[0].callerRole, 'unknown');
  assert.equal('sessionId' in toolCallRecords[0], false);

  const audit = launchAudit(localRecords);
  const payload = audit.payload as Record<string, unknown>;
  assert.equal(payload.outcome, 'reused');
  assert.equal(payload.force, false);
  assert.equal(audit.sessionId, 'claude-1');
});

test('audit: force=true bypass records outcome launched with force:true', async () => {
  const { ctx, localRecords } = makeCtx(
    { providerPriority: ['claude-cli'], slots: [{ provider: 'claude-cli' }] },
    [idleMeshSession('mesh-cursor', 'node-mac', 'claude-cli', 'claude-1')],
  );
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-mac', type: 'claude-cli', force: true }));
  assert.notEqual(result.reused, true);
  const payload = launchAudit(localRecords).payload as Record<string, unknown>;
  assert.equal(payload.outcome, 'launched');
  assert.equal(payload.force, true);
});

test('audit: an unsupported-provider refusal records outcome refused with its code', async () => {
  const { ctx, launchCalls, localRecords } = makeCtx({
    providerPriority: ['claude-cli'],
    slots: [{ provider: 'claude-cli' }, { provider: 'codex-cli' }],
  });
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-mac', type: 'cursor-cli' }));
  assert.equal(result.success, false);
  assert.equal(launchCalls.some(c => c.command === 'launch_cli'), false);

  const audit = launchAudit(localRecords);
  const payload = audit.payload as Record<string, unknown>;
  assert.equal(payload.outcome, 'refused');
  assert.equal(payload.code, 'mesh_provider_type_unsupported');
  assert.equal(payload.requestedType, 'cursor-cli');
});

test('audit: a failed launch_cli records outcome failed (not launched)', async () => {
  const { ctx, localRecords, mesh } = makeCtx({
    providerPriority: ['claude-cli'],
    slots: [{ provider: 'claude-cli' }],
  });
  ctx.transport.command = (async (command: string, args: Record<string, unknown> = {}) => {
    if (command === 'launch_cli') throw new Error('daemon mesh transport unavailable');
    if (command === 'tool_call_record') return { success: true, rateLimitExceeded: false, callsInWindow: 1, advisory: null };
    if (command === 'record_local') {
      localRecords.push(args);
      return { success: true, eventId: 'evt-1', timestamp: new Date().toISOString(), storedLocally: true, published: false };
    }
    if (command === 'get_status_metadata') return { success: true, status: { sessions: [] } };
    if (command === 'get_mesh') return { success: true, mesh };
    throw new Error(`unexpected direct command: ${command}`);
  }) as any;
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-mac', type: 'claude-cli' }));
  assert.equal(result.success, false);
  assert.equal(result.recoverable !== undefined, true, 'recoverable classification present');

  const audits = localRecords.filter(r => r.kind === 'session_launch_requested');
  assert.equal(audits.length, 1, `exactly one session_launch_requested record, got ${audits.length}`);
  assert.equal((audits[0].payload as Record<string, unknown>).outcome, 'failed');
  // The detailed failure classification still lands under its existing kind —
  // the audit row supplements it, never replaces it.
  assert.ok(localRecords.some(r => r.kind === 'recovery_attempted'), 'existing failure ledger row preserved');
});


test('audit: invalid provider input keeps the refusal but omits unsafe requestedType', async () => {
  for (const type of ['claude-cli\nprivate prompt text', '/private/example/credentials', 'x'.repeat(65)]) {
    const { ctx, launchCalls, toolCallRecords, localRecords } = makeCtx({
      providerPriority: ['claude-cli'], slots: [{ provider: 'claude-cli' }],
    });
    ctx.coordinatorSessionId = 'coord-session-1';
    const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-mac', type }));
    assert.equal(result.success, false);
    assert.equal(result.code, 'mesh_provider_type_unsupported');
    assert.equal(result.requestedType, type, 'existing error response is preserved');
    assert.equal(launchCalls.some(c => c.command === 'launch_cli'), false);
    assert.deepEqual(toolCallRecords.map(r => r.tool), ['mesh_launch_session']);
    assert.equal(toolCallRecords[0].sessionId, 'coord-session-1');
    const audit = launchAudit(localRecords);
    const payload = audit.payload as Record<string, unknown>;
    assert.equal(payload.outcome, 'refused');
    assert.equal(payload.code, 'mesh_provider_type_unsupported');
    assert.equal(payload.callerRole, 'coordinator');
    assert.equal(payload.coordinatorSessionId, 'coord-session-1');
    assert.equal('requestedType' in payload, false);
    assert.equal(JSON.stringify(audit).includes(type), false);
  }
});


test('audit: a legacy-node failed launch cannot echo unsafe resolvedProviderType', async () => {
  const type = '/private/example/credentials\nprivate prompt text';
  const { ctx, toolCallRecords, localRecords } = makeCtx({ providerPriority: ['claude-cli'] });
  const command = ctx.transport.command;
  ctx.transport.command = async (name: string, args: Record<string, unknown> = {}) => {
    if (name === 'launch_cli') return { success: false, error: 'unsupported provider' };
    return command(name, args);
  };
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-mac', type }));
  assert.equal(result.success, false);
  assert.equal(result.resolvedProviderType, type, 'existing error response is preserved');
  assert.deepEqual(toolCallRecords.map(r => r.tool), ['mesh_launch_session']);
  const audit = launchAudit(localRecords);
  const payload = audit.payload as Record<string, unknown>;
  assert.equal(payload.outcome, 'failed');
  assert.equal('requestedType' in payload, false);
  assert.equal('resolvedProviderType' in payload, false);
  assert.equal('providerType' in audit, false);
  assert.equal(JSON.stringify(audit).includes(type), false);
});


const manualProfileSlots = [
  { provider: 'codex-cli', model: 'gpt-6.1-sol', thinkingLevel: 'high', difficulty: ['difficult'] },
  { provider: 'codex-cli', model: 'gpt-6-sol', thinkingLevel: 'medium', difficulty: ['medium'] },
  { provider: 'codex-cli', model: 'gpt-6-luna', thinkingLevel: 'low', difficulty: ['easy'] },
];

// The real CliProviderInstance.getState consumer, with an isolated inert adapter.
function manualLaunchState(settings: Record<string, any>, controlValues = {}): ReturnType<typeof buildProviderState> {
  const host: ProviderStateHost = {
    type: 'codex-cli', workingDir: '/repo', instanceId: 'fake-manual',
    provider: { type: 'codex-cli', name: 'Codex', category: 'cli' } as any,
    presentationMode: 'terminal', settings, lastStatus: 'idle',
    errorMessage: undefined, errorReason: undefined, activeInteractivePrompt: null,
    controlValues, summaryMetadata: undefined, suppressIdleHistoryReplay: false,
    autoApproveBusy: false, historyWriter: { appendNewMessages: () => {} } as any,
    runtimeMessages: [], parsedIngestTimestamps: { stamp: (messages: unknown[]) => messages } as any,
    lastPersistedHistoryMessages: [], lastCompletionSummary: null,
    adapter: { getStatus: () => ({ status: 'idle' }), getRuntimeMetadata: () => null },
    stabilizeFlappingApprovalStatus: state => state,
    maybeAutoApproveStatus: () => false, autoApproveMaskStalled: () => false,
    maybeAppendRuntimeRecoveryMessage: () => {}, shouldSuppressFreshLaunchStartupReplay: () => false,
    promoteProviderSessionId: () => {}, shouldHydrateExistingProviderHistory: () => false,
    syncCanonicalSavedHistoryIfNeeded: () => false, shouldSuppressStaleParsedBusyStatus: () => false,
    applyProviderResponse: () => {},
  };
  return buildProviderState(host);
}

function difficultClaimAllowed(node: any, state: any): boolean {
  return taskMeetsSessionDifficultyFloor({ difficulty: 'difficult' },
    allowedClassifiedDifficultiesForSession(node, node.policy.slots, 'codex-cli', readSessionModel(state)));
}

function profileWorker(overrides: Record<string, unknown> = {}) {
  return {
    id: 'profile-worker', providerType: 'codex-cli', status: 'idle',
    settings: { role: 'worker', meshNodeFor: 'mesh-cursor', meshNodeId: 'node-mac', initialModel: 'gpt-6.1-sol', initialThinkingLevel: 'high' },
    ...overrides,
  };
}

test('manual configured profile reaches launch port and claim state on a multi-model provider', async () => {
  const { ctx, launchCalls, mesh } = makeCtx({ providerPriority: ['claude-cli'], slots: manualProfileSlots });
  assert.equal(difficultClaimAllowed(mesh.nodes[0], { settings: {} }), false, 'original omission conservatively refuses difficult');
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-mac', type: 'codex-cli' }));
  assert.equal(result.success, true);
  const args = launchCalls[0].args as any;
  // These are the real launch_cli keys; CliProviderInstance.getState projects settings.
  assert.equal(args.initialModel, 'gpt-6.1-sol');
  assert.equal(args.initialThinkingLevel, 'high');
  assert.equal(args.settings.initialModel, args.initialModel);
  assert.equal(args.settings.initialThinkingLevel, args.initialThinkingLevel);
  assert.deepEqual(resolveLaunchProvenance(args, args.settings), { launchedBy: 'mesh', modelSource: 'mesh_slot', thinkingLevelSource: 'mesh_slot' });
  const state = manualLaunchState(args.settings);
  assert.equal(readSessionModel(state), 'gpt-6.1-sol');
  assert.equal(difficultClaimAllowed(mesh.nodes[0], state), true);
  for (const model of ['gpt-6-sol', 'gpt-6-luna', 'unsupported-model']) {
    assert.equal(difficultClaimAllowed(mesh.nodes[0], manualLaunchState(args.settings, { model })), false,
      'observed mismatched or unsupported runtime model overrides requested settings');
  }
  assert.equal(difficultClaimAllowed(mesh.nodes[0], { settings: {} }), false, 'unknown model remains fail closed');
  assert.equal(args.cliType, 'codex-cli', 'explicit provider never follows another priority');
});

test('manual omitted provider propagates only its configured first profile', async () => {
  const { ctx, launchCalls } = makeCtx({ providerPriority: ['codex-cli'], slots: manualProfileSlots });
  await meshLaunchSession(ctx, { node_id: 'node-mac' });
  assert.equal(launchCalls[0].args.cliType, 'codex-cli');
  assert.equal(launchCalls[0].args.initialModel, 'gpt-6.1-sol');
  assert.equal(launchCalls[0].args.initialThinkingLevel, 'high');
});

test('manual profile selection preserves configured order without upgrading a lower first slot', async () => {
  const { ctx, launchCalls, mesh } = makeCtx({ slots: [manualProfileSlots[2], manualProfileSlots[0]] });
  await meshLaunchSession(ctx, { node_id: 'node-mac', type: 'codex-cli' });
  const args = launchCalls[0].args as any;
  assert.equal(args.initialModel, 'gpt-6-luna');
  assert.equal(args.initialThinkingLevel, 'low');
  assert.equal(difficultClaimAllowed(mesh.nodes[0], { settings: args.settings }), false);
});

test('manual profile-compatible worker is reused without a fake launch', async () => {
  const { ctx, launchCalls } = makeCtx({ slots: manualProfileSlots }, [profileWorker()]);
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-mac', type: 'codex-cli' }));
  assert.equal(result.reused, true);
  assert.equal(launchCalls.length, 0);
});

for (const [label, worker] of [
  ['mismatched model', profileWorker({ controlValues: { model: 'gpt-6-sol' } })],
  ['unknown model', profileWorker({ settings: { role: 'worker', meshNodeFor: 'mesh-cursor', meshNodeId: 'node-mac' } })],
  ['mismatched thinking', profileWorker({ settings: { role: 'worker', meshNodeFor: 'mesh-cursor', meshNodeId: 'node-mac', initialModel: 'gpt-6.1-sol', initialThinkingLevel: 'low' } })],
  ['unknown provider', profileWorker({ providerType: undefined })],
  ['unknown thinking', profileWorker({ settings: { role: 'worker', meshNodeFor: 'mesh-cursor', meshNodeId: 'node-mac', initialModel: 'gpt-6.1-sol' } })],
  ['observed thinking mismatch', profileWorker({ controlValues: { thinkingLevel: 'low' } })],
] as const) {
  test(`manual configured profile does not reuse a worker with ${label}`, async () => {
    const { ctx, launchCalls } = makeCtx({ slots: manualProfileSlots }, [worker]);
    const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-mac', type: 'codex-cli' }));
    assert.equal(result.reused, undefined);
    assert.equal(launchCalls.length, 1);
    assert.equal(launchCalls[0].args.initialModel, 'gpt-6.1-sol');
  });
}

test('manual provider-default slot never invents a launch model or thinking provenance', async () => {
  const { ctx, launchCalls } = makeCtx({ slots: [{ provider: 'codex-cli' }] });
  await meshLaunchSession(ctx, { node_id: 'node-mac', type: 'codex-cli' });
  const args = launchCalls[0].args as any;
  assert.equal(args.initialModel, undefined);
  assert.equal(args.initialThinkingLevel, undefined);
  assert.equal(args.settings.initialModel, undefined);
  assert.equal(resolveLaunchProvenance(args, args.settings).modelSource, undefined);
  assert.equal(resolveLaunchProvenance(args, args.settings).thinkingLevelSource, undefined);
});


test('manual Antigravity configured model and thinking are forwarded verbatim', async () => {
  const model = 'Claude Opus 4.6 (Thinking)';
  const { ctx, launchCalls } = makeCtx({ providerPriority: ['codex-cli'], slots: [
    ...manualProfileSlots,
    { provider: 'antigravity-cli', model, thinkingLevel: 'high', difficulty: ['difficult'] },
    { provider: 'antigravity-cli', model: 'Gemini Flash', thinkingLevel: 'low', difficulty: ['easy'] },
  ] });
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-mac', type: 'antigravity-cli' }));
  assert.equal(result.resolvedProviderType, 'antigravity-cli');
  assert.equal(launchCalls[0].args.initialModel, model);
  assert.equal(launchCalls[0].args.initialThinkingLevel, 'high');
});

test('manual reused profile accepts actual launch evidence without invented settings', async () => {
  const { ctx, launchCalls } = makeCtx({ slots: manualProfileSlots }, [profileWorker({
    settings: { role: 'worker', meshNodeFor: 'mesh-cursor', meshNodeId: 'node-mac' },
    launchRecord: { model: { launchValue: 'gpt-6.1-sol' }, thinkingLevel: { launchValue: 'high' } },
  })]);
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-mac', type: 'codex-cli' }));
  assert.equal(result.reused, true);
  assert.equal(launchCalls.length, 0);
});
