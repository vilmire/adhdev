import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshSendTask } from '../src/tools/mesh-tools.js';
import { getLedgerDir, getQueue, createMeshRuntimeTurnLedger, setActiveTurnLedgerForIpc } from '@adhdev/daemon-core';
import { __clearMeshQueueForTests } from '../../daemon-core/src/mesh/mesh-work-queue.js';
import { __clearLocalRecordsForTests } from '@adhdev/daemon-core';
import { __clearMeshPendingEventsForTests } from './helpers/pending-notices.js';
import { closeOpenTestAttempts, isTurnIpcCommand, answerTurnIpc } from './helpers/turn-ledger-ipc.js';

// GIT-GATE (owner-requested follow-up to H1, wiring-unification). The claim-time gate
// (mesh-queue-assignment.ts, daemon-side) and the auto-launch spawn gate
// (mesh-queue-autolaunch.ts) already refuse write work on a dirty/stale-behind node, but
// `mesh_send_task` direct dispatch bypassed both entirely — it targets a node/session
// explicitly and never goes through either gate. This suite pins the tool-boundary refusal
// added directly to meshSendTask (mesh-tools-session.ts), using the SAME isDirtyNode /
// isMeshNodeFreshEnoughToLaunch predicates re-exported from daemon-core's index.ts.

const COORDINATOR = 'daemon-coordinator';
const NODE = 'node-local';
const SESSION = 'sess-local';

function cleanupMesh(meshId: string): void {
    __clearMeshQueueForTests(meshId);
    __clearLocalRecordsForTests(meshId);
    __clearMeshPendingEventsForTests(meshId);
    const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
    for (const suffix of ['.jsonl', '.queue.json', '.queue.lock', '.pending-events.jsonl']) {
        const path = join(getLedgerDir(), `${safe}${suffix}`);
        if (existsSync(path)) unlinkSync(path);
    }
}

function createLocalCtx(meshId: string, opts: {
    git?: Record<string, unknown>;
    autoFastForward?: Record<string, unknown>;
    /** Make the node a worktree node on this branch. */
    worktreeBranch?: string;
    /** Extra (possibly retired) mesh policy keys. */
    policy?: Record<string, unknown>;
    /** Answer `agent_command` with a successful delivery. */
    acceptDelivery?: boolean;
}) {
    const session = {
        id: SESSION,
        providerType: 'claude-cli',
        status: 'idle',
        settings: { meshNodeFor: meshId, meshNodeId: NODE, meshCoordinatorDaemonId: COORDINATOR, launchedByCoordinator: true },
    };
    const mesh = {
        id: meshId, name: 'Git Gate', repoIdentity: 'example/repo',
        policy: { ...(opts.autoFastForward ? { autoFastForward: opts.autoFastForward } : {}), ...(opts.policy ?? {}) },
        coordinator: {},
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        nodes: [{
            id: NODE, workspace: '/tmp/local-repo', repoRoot: '/tmp/local-repo',
            daemonId: COORDINATOR, machineId: 'machine-coordinator', userOverrides: {},
            policy: { providerPriority: ['claude-cli'] }, sessions: [session],
            ...(opts.git ? { git: opts.git } : {}),
            ...(opts.worktreeBranch ? { isLocalWorktree: true, worktreeBranch: opts.worktreeBranch } : {}),
        }],
    };
    const transport = new IpcTransport() as any;
    const localCommands: Array<{ command: string; args: Record<string, unknown> }> = [];
    transport.command = async (command: string, args: Record<string, unknown> = {}) => {
        if (isTurnIpcCommand(command)) return answerTurnIpc(command, args);
        localCommands.push({ command, args });
        if (command === 'get_mesh') return { success: true, mesh };
        if (command === 'get_pending_mesh_events') return { events: [] };
        if (command === 'trigger_mesh_queue') return { success: true };
        if (command === 'get_status_metadata') return { success: true, status: { sessions: [session] } };
        if (command === 'agent_command' && opts.acceptDelivery) return { success: true, sessionId: SESSION, providerType: 'claude-cli' };
        if (command === 'record_local' || command === 'mesh_record_local') return { success: true };
        throw new Error(`unexpected LOCAL command: ${command}`);
    };
    const ctx = { mesh, transport, localDaemonId: COORDINATOR, localMachineId: 'machine-coordinator', coordinatorSessionId: 'sess-coord' } as any;
    return { ctx, localCommands };
}

function withLedger<T>(fn: () => Promise<T>): Promise<T> {
    const ledger = createMeshRuntimeTurnLedger({ selfDaemonId: COORDINATOR, publisher: null });
    setActiveTurnLedgerForIpc(ledger);
    return fn().finally(() => { closeOpenTestAttempts(); setActiveTurnLedgerForIpc(null); });
}

async function send(ctx: any, extra: Record<string, unknown> = {}) {
    return JSON.parse(await meshSendTask(ctx, {
        node_id: NODE, session_id: SESSION, message: 'write task body', difficulty: 'medium', ...extra,
    } as any));
}

test('dirty BASE node → non-readonly direct dispatch refused dirty_workspace', async () => {
    const meshId = `mesh-gitgate-dirty-${randomUUID().slice(0, 8)}`;
    cleanupMesh(meshId);
    const h = createLocalCtx(meshId, { git: { dirty: true } });
    try {
        await withLedger(async () => {
            const res = await send(h.ctx);
            assert.equal(res.success, false, JSON.stringify(res));
            assert.equal(res.code, 'dirty_workspace');
            assert.match(res.error, /dirty base node/);
            assert.equal(getQueue(meshId).length, 0, 'a refused dispatch never materializes a task row');
        });
    } finally {
        cleanupMesh(meshId);
    }
});

test('behind upstream beyond maxBehind → non-readonly direct dispatch refused node_stale_behind_upstream', async () => {
    const meshId = `mesh-gitgate-stale-${randomUUID().slice(0, 8)}`;
    cleanupMesh(meshId);
    const h = createLocalCtx(meshId, { git: { behind: 7, isGitRepo: true }, autoFastForward: { maxBehind: 0 } });
    try {
        await withLedger(async () => {
            const res = await send(h.ctx);
            assert.equal(res.success, false, JSON.stringify(res));
            assert.equal(res.code, 'node_stale_behind_upstream');
            assert.match(res.error, /7/, 'names the concrete behind count');
        });
    } finally {
        cleanupMesh(meshId);
    }
});

test('behind within configured maxBehind → dispatch proceeds (claimed via local queue)', async () => {
    const meshId = `mesh-gitgate-within-threshold-${randomUUID().slice(0, 8)}`;
    cleanupMesh(meshId);
    const h = createLocalCtx(meshId, { git: { behind: 2, isGitRepo: true }, autoFastForward: { maxBehind: 5 } });
    try {
        await withLedger(async () => {
            const res = await send(h.ctx);
            assert.notEqual(res.code, 'node_stale_behind_upstream');
            assert.notEqual(res.code, 'dirty_workspace');
        });
    } finally {
        cleanupMesh(meshId);
    }
});

test('missing git telemetry → fail-open, never refused', async () => {
    const meshId = `mesh-gitgate-no-telemetry-${randomUUID().slice(0, 8)}`;
    cleanupMesh(meshId);
    const h = createLocalCtx(meshId, {});
    try {
        await withLedger(async () => {
            const res = await send(h.ctx);
            assert.notEqual(res.code, 'node_stale_behind_upstream');
            assert.notEqual(res.code, 'dirty_workspace');
        });
    } finally {
        cleanupMesh(meshId);
    }
});

test('readonly direct dispatch to a dirty node is never gated', async () => {
    const meshId = `mesh-gitgate-readonly-${randomUUID().slice(0, 8)}`;
    cleanupMesh(meshId);
    const h = createLocalCtx(meshId, { git: { dirty: true } });
    try {
        await withLedger(async () => {
            const res = await send(h.ctx, { task_mode: 'live_debug_readonly', readonly: true });
            assert.notEqual(res.code, 'dirty_workspace');
        });
    } finally {
        cleanupMesh(meshId);
    }
});

test('allow_stale_node:true bypasses the refusal on a dirty node', async () => {
    const meshId = `mesh-gitgate-bypass-${randomUUID().slice(0, 8)}`;
    cleanupMesh(meshId);
    const h = createLocalCtx(meshId, { git: { dirty: true } });
    try {
        await withLedger(async () => {
            const res = await send(h.ctx, { allow_stale_node: true });
            assert.notEqual(res.code, 'dirty_workspace');
        });
    } finally {
        cleanupMesh(meshId);
    }
});

// ── Dirty-write verdict (daemon-core mesh-dirty-write-verdict.ts; docs/design/
// 2026-10-07-mesh-workspace-policy.md §B). A direct send names its node, so a dirty
// WORKTREE is a branch continuation: dispatched with a one-line commit notice, never
// checkpointed by the daemon. The retired dirtyWorkspaceBehavior changes nothing.

test('dirty WORKTREE node → dispatched as a branch continuation with the commit notice; no checkpoint', async () => {
    const meshId = `mesh-gitgate-wt-${randomUUID().slice(0, 8)}`;
    cleanupMesh(meshId);
    const h = createLocalCtx(meshId, { git: { dirty: true, modified: 2, untracked: 1 }, worktreeBranch: 'feat/a', acceptDelivery: true });
    try {
        await withLedger(async () => {
            const res = await send(h.ctx);
            assert.equal(res.success, true, JSON.stringify(res));
            assert.match(String(res.dirtyWorkspaceNotice), /Branch feat\/a has 3 uncommitted change/);
            const delivery = h.localCommands.find(c => c.command === 'agent_command');
            assert.ok(delivery, 'delivered');
            assert.match(String((delivery!.args as any).message), /commit before you finish/, 'the worker sees the notice');
            assert.ok(!h.localCommands.some(c => c.command === 'git_checkpoint'), 'the daemon never commits on the worker\'s behalf');
        });
    } finally {
        cleanupMesh(meshId);
    }
});

test('clean WORKTREE node → no continuation notice', async () => {
    const meshId = `mesh-gitgate-wt-clean-${randomUUID().slice(0, 8)}`;
    cleanupMesh(meshId);
    const h = createLocalCtx(meshId, { worktreeBranch: 'feat/a', acceptDelivery: true });
    try {
        await withLedger(async () => {
            const res = await send(h.ctx);
            assert.equal(res.success, true, JSON.stringify(res));
            assert.equal(res.dirtyWorkspaceNotice, undefined);
        });
    } finally {
        cleanupMesh(meshId);
    }
});

test('a retired dirtyWorkspaceBehavior on the mesh policy changes nothing (dirty base still refused)', async () => {
    const meshId = `mesh-gitgate-retired-${randomUUID().slice(0, 8)}`;
    cleanupMesh(meshId);
    const h = createLocalCtx(meshId, { git: { dirty: true }, policy: { dirtyWorkspaceBehavior: 'warn', requirePreTaskCheckpoint: true } });
    try {
        await withLedger(async () => {
            const res = await send(h.ctx);
            assert.equal(res.code, 'dirty_workspace', JSON.stringify(res));
            assert.ok(!h.localCommands.some(c => c.command === 'git_checkpoint'));
        });
    } finally {
        cleanupMesh(meshId);
    }
});

