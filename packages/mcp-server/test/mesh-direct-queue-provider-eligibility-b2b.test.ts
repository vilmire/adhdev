/**
 * B2b — direct / queue provider eligibility parity (same policy context).
 *
 * Hypothesis under test (was unproven RCA): remote sessionless direct dispatch
 * prefilling providerPriority[0] before idle auto-pick discarded sole eligible
 * idle sessions of other providers, while queue idle claim uses the session's
 * own provider. Explicit pins / named sessions must not be silently changed;
 * bound idle reuse vs brand-new sessionless launch may still differ on winner.
 *
 * Cases: preferred busy→fallback idle, gated preferred→clear idle, exact pin no
 * fallback, both preferred+fallback idle→prefer priority order, no idle→sessionless
 * priority/quota-clear fallback, unknown quota fail-open.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import { IpcTransport } from '../src/transports/ipc.js';
import { resolveRemoteDispatchTarget } from '../src/tools/mesh-remote-dispatch.js';
import { fakeCoordinatorTransport } from './helpers/fake-coordinator-tool-answers.js';
import { answerTurnIpc, isTurnIpcCommand } from './helpers/turn-ledger-ipc.js';

const NODE = 'node_buildbox';
const WORKER = 'daemon_buildbox';
const COORD = 'daemon_coordinator';
const HOUR = 60 * 60 * 1000;

function meshSession(meshId: string, id: string, providerType: string, status = 'idle') {
  return {
    id,
    status,
    providerType,
    settings: {
      meshNodeFor: meshId,
      meshNodeId: NODE,
      meshCoordinatorDaemonId: COORD,
      launchedByCoordinator: true,
    },
  };
}

function buildboxPolicy() {
  return {
    providerPriority: ['claude-cli', 'cursor-cli', 'antigravity-cli'],
    slots: [
      { provider: 'claude-cli', difficulty: ['medium'], maxParallel: 1 },
      { provider: 'cursor-cli', difficulty: ['medium'], maxParallel: 1 },
      { provider: 'antigravity-cli', difficulty: ['easy'] },
    ],
  };
}

function quotaFacts(perProvider: Record<string, unknown>, reportedAt = Date.now()) {
  return { schemaVersion: 1, reportedAt, quota: perProvider };
}

function healthy(provider: string, now = Date.now()) {
  return {
    provider,
    status: 'ok',
    session: { usedPercent: 10, limitMinutes: 300, resetsAt: now + 4 * HOUR },
    weekly: { usedPercent: 10, limitMinutes: 10080, resetsAt: now + 5 * 24 * HOUR },
    updatedAt: now,
    error: null,
  };
}

function sessionExhausted(provider: string, now = Date.now()) {
  return {
    provider,
    status: 'ok',
    session: { usedPercent: 100, limitMinutes: 300, resetsAt: now + 90 * 60 * 1000 },
    weekly: { usedPercent: 30, limitMinutes: 10080, resetsAt: now + 5 * 24 * HOUR },
    updatedAt: now,
    error: null,
  };
}

function makeRemoteCtx(opts: {
  sessions: any[];
  nodeFacts?: unknown;
  quotaRouting?: unknown;
}) {
  const meshId = `mesh_b2b_elig_${randomUUID().slice(0, 8)}`;
  for (const session of opts.sessions) {
    if (session?.settings) session.settings.meshNodeFor = meshId;
  }
  const node: any = {
    id: NODE,
    workspace: '/repo/buildbox',
    daemonId: WORKER,
    machineId: 'machine_buildbox',
    reportedPlatform: 'win32',
    policy: buildboxPolicy(),
    ...(opts.nodeFacts ? { nodeFacts: opts.nodeFacts } : {}),
  };
  const mesh: any = {
    id: meshId,
    name: 'B2b eligibility',
    nodes: [
      {
        id: 'node_coord',
        workspace: '/repo/coord',
        daemonId: COORD,
        machineId: 'machine_coord',
        policy: { providerPriority: ['claude-cli'] },
      },
      node,
    ],
    policy: opts.quotaRouting ? { quotaRouting: opts.quotaRouting } : {},
    coordinator: { preferredNodeId: 'node_coord' },
  };

  const t = {
    command: async (cmd: string, args: Record<string, unknown> = {}) => {
      if (isTurnIpcCommand(cmd)) return answerTurnIpc(cmd, args);
      if (cmd === 'get_mesh') return { success: true, mesh };
      if (cmd === 'get_status_metadata') {
        return { success: true, status: { instanceId: COORD, sessions: [] } };
      }
      if (cmd === 'mesh_status') {
        return {
          success: true,
          nodes: [{
            nodeId: NODE,
            heldRuntime: {
              source: 'member_push',
              observedAt: Date.now(),
              refreshing: false,
              sessions: opts.sessions,
            },
          }],
        };
      }
      return { success: true };
    },
    meshCommand: async () => ({ success: true }),
    getStatus: async () => ({ sessions: [] }),
  } as any;
  Object.setPrototypeOf(t, IpcTransport.prototype);
  const transport = fakeCoordinatorTransport(t);
  const ctx = { mesh, transport, localDaemonId: COORD, localMachineId: 'machine_coord' } as any;
  return { ctx, node, meshId };
}

async function resolve(ctx: any, node: any, extra: Record<string, unknown> = {}) {
  return resolveRemoteDispatchTarget(ctx, node, {
    coordinatorDaemonId: COORD,
    ...extra,
  } as any);
}

function assertTarget(target: unknown, expect: { sessionId: string; providerType: string }) {
  assert.equal(
    typeof target === 'object' && target !== null && 'success' in target && (target as any).success === false,
    false,
    JSON.stringify(target),
  );
  assert.equal((target as any).sessionId, expect.sessionId, JSON.stringify(target));
  assert.equal((target as any).providerType, expect.providerType, JSON.stringify(target));
}

test('B2b HARNESS: preferred provider busy — unpinned direct adopts sole eligible idle of priority[1] (queue claim parity)', async () => {
  const idleCursor = meshSession('tmp', 'sess_cursor_idle', 'cursor-cli', 'idle');
  const busyClaude = meshSession('tmp', 'sess_claude_busy', 'claude-cli', 'generating');
  const { ctx, node } = makeRemoteCtx({ sessions: [busyClaude, idleCursor] });
  assertTarget(await resolve(ctx, node), { sessionId: 'sess_cursor_idle', providerType: 'cursor-cli' });
});

test('B2b: when both preferred and fallback idle exist, preference keeps priority[0] (not force-equal winners)', async () => {
  const idleClaude = meshSession('tmp', 'sess_claude_idle', 'claude-cli');
  const idleCursor = meshSession('tmp', 'sess_cursor_idle', 'cursor-cli');
  // cursor listed first in the held array — preference must still keep claude-cli.
  const { ctx, node } = makeRemoteCtx({ sessions: [idleCursor, idleClaude] });
  assertTarget(await resolve(ctx, node), { sessionId: 'sess_claude_idle', providerType: 'claude-cli' });
});

test('B2b: exact provider pin does not fall back to a non-pinned idle', async () => {
  const idleCursor = meshSession('tmp', 'sess_cursor', 'cursor-cli');
  const { ctx, node } = makeRemoteCtx({ sessions: [idleCursor] });
  assertTarget(await resolve(ctx, node, { requiredTags: ['provider=claude-cli'] }), {
    sessionId: '',
    providerType: 'claude-cli',
  });
});

test('B2b: no idle → unpinned sessionless still falls back to priority[0] (CONTROL)', async () => {
  const { ctx, node } = makeRemoteCtx({ sessions: [] });
  assertTarget(await resolve(ctx, node), { sessionId: '', providerType: 'claude-cli' });
});

test('B2b: preferred provider quota-gated — unpinned adopts clear idle of next eligible provider', async () => {
  const now = Date.now();
  const facts = quotaFacts({
    'claude-cli': sessionExhausted('claude-cli', now),
    'cursor-cli': healthy('cursor-cli', now),
  }, now);
  const idleCursor = meshSession('tmp', 'sess_cursor_clear', 'cursor-cli');
  const { ctx, node } = makeRemoteCtx({
    sessions: [idleCursor],
    nodeFacts: facts,
    quotaRouting: { enabled: true, thresholdPercent: 5 },
  });
  assertTarget(await resolve(ctx, node), { sessionId: 'sess_cursor_clear', providerType: 'cursor-cli' });
});

test('B2b: unknown quota snapshot remains fail-open (dispatch proceeds)', async () => {
  const idle = meshSession('tmp', 'sess_any', 'cursor-cli');
  const { ctx, node } = makeRemoteCtx({ sessions: [idle] });
  assertTarget(await resolve(ctx, node), { sessionId: 'sess_any', providerType: 'cursor-cli' });
});

test('B2b: named session provider is authoritative (pin/priority never silently rewrite)', async () => {
  const agy = meshSession('tmp', 'sess_agy', 'antigravity-cli');
  const { ctx, node } = makeRemoteCtx({ sessions: [agy] });
  assertTarget(await resolve(ctx, node, { session_id: 'sess_agy', verifiedSession: agy }), {
    sessionId: 'sess_agy',
    providerType: 'antigravity-cli',
  });
});
