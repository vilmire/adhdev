import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshStatus, meshViewQueue } from '../src/tools/mesh-tools.js';
import { enqueueTask, getLedgerDir } from '@adhdev/daemon-core';
import { __clearMeshQueueForTests } from '../../daemon-core/src/mesh/mesh-work-queue.js';
import { __clearMeshLedgerForTests } from '../../daemon-core/src/mesh/mesh-ledger.js';
import { __clearMeshPendingEventsForTests } from '../../daemon-core/src/mesh/mesh-events-pending.js';

// Budget the compact (LLM-facing) payload must stay under regardless of how many
// worktree nodes / sessions / queued tasks a mesh has. The live regression that
// motivated this was mesh_status ~76KB and mesh_view_queue ~73KB exceeding the MCP
// token cap. Compact must stay well under the cap; verbose stays unbounded/full.
const COMPACT_BUDGET = 25_000;

// A realistic ~300-char stale-daemon-build warning that previously appeared
// verbatim on EVERY node in compact mode.
const STALE_WARNING = 'Live daemon build f6b15b05 is BEHIND workspace HEAD 79d5793c — merged daemon-runtime changes are not live until rebuild/redeploy + restart. A local daemon-core dist rebuild does not update a cloud daemon. Do not assume a just-merged fix is active on this daemon.';

function cleanupMesh(meshId: string): void {
  __clearMeshQueueForTests(meshId);
  __clearMeshLedgerForTests(meshId);
  __clearMeshPendingEventsForTests(meshId);
  const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
  for (const suffix of ['.jsonl', '.queue.json', '.queue.lock', '.pending-events.jsonl']) {
    const path = join(getLedgerDir(), `${safe}${suffix}`);
    if (existsSync(path)) unlinkSync(path);
  }
}

function buildManyNodeCtx(meshId: string, nodeCount: number) {
  const nodes = [];
  for (let i = 0; i < nodeCount; i++) {
    nodes.push({
      id: `node-${i}`,
      workspace: `/Users/dev/Work/.adhdev-worktrees/adhdev/feature-branch-${i}`,
      repoRoot: `/Users/dev/Work/.adhdev-worktrees/adhdev/feature-branch-${i}`,
      daemonId: i < 2 ? 'daemon-A' : 'daemon-B',
      machineId: i < 2 ? 'machine-A' : 'machine-B',
      isLocalWorktree: true,
      worktreeBranch: `fix/some-long-feature-branch-name-${i}`,
      userOverrides: {},
      policy: { providerPriority: ['claude-code', 'hermes-cli'] },
    });
  }
  const mesh = {
    id: meshId, name: 'Big Mesh', repoIdentity: 'vilmire/adhdev', policy: {}, coordinator: {},
    defaultBranch: 'main',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), nodes,
  };
  const transport = new IpcTransport() as any;
  const responder = (command: string) => {
    if (command === 'get_mesh') return { success: true, mesh };
    if (command === 'get_pending_mesh_events') return { events: [] };
    if (command === 'mesh_forward_event') return { success: true, forwarded: 0 };
    if (command === 'git_status') {
      return { success: true, status: {
        isGitRepo: true, isDirty: false, branch: 'fix/some-long-feature-branch-name', headCommit: 'abcdef1234567890',
        upstream: 'origin/fix/some-long-feature-branch-name', upstreamStatus: 'ahead', ahead: 3, behind: 0,
        changedFiles: Array.from({ length: 8 }, (_, i) => `packages/server/src/some/path/file-${i}.ts`),
        submodules: [
          { path: 'oss', commit: '4b8e5bbbaaaa1111', outOfSync: true, status: 'modified', branch: 'main' },
          { path: 'oss/packages/adhdev-providers', commit: 'deadbeef99887766', outOfSync: false, status: 'clean', branch: 'main' },
        ],
        daemonBuildBehind: {
          scope: 'oss/daemon-core', buildCommit: 'f6b15b05aaaa', buildCommitShort: 'f6b15b05', head: '79d5793caaaa',
          isDaemonAffecting: true, affectedPackages: ['@adhdev/daemon-core', '@adhdev/mcp-server'], warning: STALE_WARNING,
        },
      } };
    }
    if (command === 'get_status_metadata') {
      return { success: true, status: {
        daemonBuild: { commit: 'f6b15b05aaaa1111', commitShort: 'f6b15b05', version: '0.5.267' },
        sessions: Array.from({ length: 4 }, (_, i) => ({
          id: `sess-${i}`, instanceId: `sess-${i}`, providerType: 'claude-code',
          status: i === 0 ? 'generating' : 'idle',
          settings: { meshNodeFor: meshId, meshCoordinatorDaemonId: 'daemon-A' },
        })),
      } };
    }
    if (command === 'agent_command') return { success: true };
    return { success: true };
  };
  transport.command = async (command: string) => responder(command);
  transport.meshCommand = async (_daemonId: string, command: string) => responder(command);
  return { ctx: { mesh, transport, localDaemonId: 'daemon-A', localMachineId: 'machine-A', coordinatorHostname: 'coord-host' }, mesh };
}

test('mesh_status compact payload stays under the token budget with many nodes/sessions/stale-builds', async () => {
  const meshId = 'mesh-status-compact-budget';
  cleanupMesh(meshId);
  const { ctx } = buildManyNodeCtx(meshId, 12);
  try {
    const compactStr = await meshStatus(ctx as any);
    const compact = JSON.parse(compactStr);
    const verboseStr = await meshStatus(ctx as any, { verbose: true });
    const verbose = JSON.parse(verboseStr);

    // Primary assertion: compact stays comfortably under the MCP cap even with 12
    // worktree nodes × 4 sessions × stale daemon builds × submodules.
    assert.ok(
      compactStr.length < COMPACT_BUDGET,
      `compact mesh_status must stay under ${COMPACT_BUDGET} bytes; got ${compactStr.length}`,
    );
    assert.equal(compact.payloadMode, 'compact');
    assert.equal(verbose.payloadMode, 'full');

    // The ~300-char stale-build warning must NOT be repeated verbatim on every node
    // in compact — it lives once at the top level. Count occurrences in the string.
    const warnOccurrences = compactStr.split(STALE_WARNING).length - 1;
    assert.ok(warnOccurrences <= 1, `stale warning text must appear at most once in compact; appeared ${warnOccurrences} times`);
    // But the actionable aggregate stays present.
    assert.ok(Array.isArray(compact.staleDaemonBuilds) && compact.staleDaemonBuilds.length > 0);
    assert.ok(typeof compact.staleDaemonBuildWarning === 'string');

    // Compact still exposes every node id — either in the nodes array (detailed or
    // stub) or, on huge meshes, in the foldedNodes id list. Nothing is undiscoverable.
    const arrayIds = (compact.nodes ?? []).map((n: any) => n.nodeId);
    const foldedIds = compact.foldedNodes?.nodeIds ?? [];
    const compactIds = new Set([...arrayIds, ...foldedIds]);
    assert.equal(compactIds.size, 12, 'every node id must remain discoverable in compact');

    // Verbose retains the full per-node detail: full warning per node, full git blob.
    assert.equal(verbose.nodes.length, 12);
    const verboseWarnOccurrences = verboseStr.split(STALE_WARNING).length - 1;
    assert.ok(verboseWarnOccurrences >= 12, `verbose must keep the full per-node warning; got ${verboseWarnOccurrences}`);
    // Verbose keeps the full changed-file list inside the git blob (dropped in compact).
    assert.ok(verboseStr.includes('changedFiles'), 'verbose must keep the full git blob');
    assert.ok(!compactStr.includes('changedFiles'), 'compact must drop the full git blob');
  } finally {
    cleanupMesh(meshId);
  }
});

test('mesh_view_queue compact payload stays under the token budget with many active tasks', async () => {
  const meshId = 'mesh-view-queue-compact-budget';
  cleanupMesh(meshId);
  const { ctx } = buildManyNodeCtx(meshId, 3);
  const bigMessage = 'Implement the requested feature with full validation and tests. '.repeat(20);
  try {
    for (let i = 0; i < 80; i++) enqueueTask(meshId, `${bigMessage} task #${i}`);

    const compactStr = await meshViewQueue(ctx as any, { view: 'active' });
    const compact = JSON.parse(compactStr);
    const verboseStr = await meshViewQueue(ctx as any, { view: 'active', verbose: true });
    const verbose = JSON.parse(verboseStr);

    assert.ok(
      compactStr.length < COMPACT_BUDGET,
      `compact mesh_view_queue must stay under ${COMPACT_BUDGET} bytes; got ${compactStr.length}`,
    );
    assert.equal(compact.payloadMode, 'compact');

    // Active row count is source-of-truth correct even though rows are capped.
    assert.equal(compact.activeCount, 80);
    assert.ok(compact.queue.length <= 15, 'compact caps the number of serialized active rows');
    assert.ok(compact.activeRowsOmitted > 0, 'compact reports how many active rows it omitted');
    // Per-row message is truncated in compact.
    assert.ok(compact.queue.every((t: any) => typeof t.message !== 'string' || t.message.length <= 160));
    // The verbatim activeQueue duplicate is dropped in compact (replaced by a hint).
    assert.equal(compact.activeQueue, undefined);
    assert.ok(typeof compact.activeQueueHint === 'string');

    // Verbose keeps every active row, untruncated, plus the full activeQueue array.
    assert.equal(verbose.queue.length, 80);
    assert.equal(verbose.activeQueue.length, 80);
    assert.ok(verbose.queue.some((t: any) => typeof t.message === 'string' && t.message.length > 200));
    assert.ok(compactStr.length * 1.5 < verboseStr.length, `compact (${compactStr.length}) must be substantially smaller than verbose (${verboseStr.length})`);
  } finally {
    cleanupMesh(meshId);
  }
});

test('mesh_status compact node fold preserves dashboard-grade verbose output byte-for-byte', async () => {
  // Determinism guard: the verbose payload (the dashboard-facing shape) must be
  // unaffected by the compact folding. We snapshot the verbose node array for a
  // fixed input and assert it is unchanged by toggling compact, modulo the
  // top-level refreshedAt timestamp which is intentionally time-based.
  const meshId = 'mesh-status-verbose-stability';
  cleanupMesh(meshId);
  const { ctx } = buildManyNodeCtx(meshId, 4);
  try {
    const v1 = JSON.parse(await meshStatus(ctx as any, { verbose: true }));
    const v2 = JSON.parse(await meshStatus(ctx as any, { verbose: true }));
    // Strip the intentionally non-deterministic timestamp.
    delete v1.refreshedAt; delete v2.refreshedAt;
    assert.deepEqual(v1.nodes, v2.nodes, 'verbose node array must be stable for a fixed input');
    // Verbose nodes carry the full machine.identityEvidence and branchConvergence.nextStep
    // that compact strips — prove they survive in verbose.
    assert.ok(Array.isArray(v1.nodes[0].machine.identityEvidence), 'verbose keeps machine.identityEvidence');
    assert.ok(typeof v1.nodes[0].branchConvergence.nextStep === 'string', 'verbose keeps branchConvergence.nextStep');
  } finally {
    cleanupMesh(meshId);
  }
});
