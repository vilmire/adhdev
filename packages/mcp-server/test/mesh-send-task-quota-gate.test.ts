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

// QUOTA GATE (direct dispatch, preview rc.43 run 10). The QUEUE claim path
// (mesh-queue-assignment.ts's evaluateQuotaClaimGateForAssignment, daemon-side)
// already refuses to pull a pending task onto an idle session whose provider is
// measurably quota-exhausted, but `mesh_send_task` direct dispatch (session_id
// explicit) went straight to send with no such check. Live evidence: the owner
// ledger's mesh_direct attempt ed31090f… spent ~10 minutes talking to a MainPC
// claude-cli worker whose own chat already showed "You've hit your session
// limit · resets 10:10pm (Asia/Seoul)". This suite pins the tool-boundary
// refusal added to meshSendTask (mesh-tools-session.ts) + ipcDispatchToRemoteAgent
// (mesh-tools-internal.ts), reusing evaluateProviderQuotaGate — the SAME
// predicate the claim gate and the manual-launch path already call.

const COORDINATOR = 'daemon-coordinator';
const NODE = 'node-local';
const SESSION = 'sess-local';
const PROVIDER = 'claude-cli';
const HOUR = 60 * 60 * 1000;

function quotaFacts(perProvider: Record<string, unknown>, { reportedAt = Date.now() }: { reportedAt?: number } = {}) {
    return { schemaVersion: 1, reportedAt, quota: perProvider };
}

/** A fresh, healthy 'ok' snapshot with plenty of headroom on both windows. */
function healthy(provider: string, now = Date.now()) {
    return {
        provider,
        status: 'ok',
        session: { usedPercent: 10, windowMinutes: 300, resetsAt: now + 4 * HOUR },
        weekly: { usedPercent: 10, windowMinutes: 10080, resetsAt: now + 5 * 24 * HOUR },
        updatedAt: now,
        error: null,
    };
}

/**
 * The run-10 shape: a fresh 'ok' snapshot with the SESSION window exhausted
 * ("You've hit your session limit · resets 10:10pm"). resetsAt is a concrete
 * epoch so the refusal payload's evidence (resetsAt) can be asserted exactly.
 */
function sessionExhausted(provider: string, now = Date.now()) {
    const resetsAt = now + 90 * 60 * 1000; // "resets in 90 min" — arbitrary concrete value
    return {
        provider,
        status: 'ok',
        session: { usedPercent: 100, windowMinutes: 300, resetsAt },
        weekly: { usedPercent: 30, windowMinutes: 10080, resetsAt: now + 5 * 24 * HOUR },
        updatedAt: now,
        error: null,
    };
}

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

function createLocalCtx(meshId: string, opts: { nodeFacts?: unknown } = {}) {
    const session = {
        id: SESSION,
        providerType: PROVIDER,
        status: 'idle',
        settings: { meshNodeFor: meshId, meshNodeId: NODE, meshCoordinatorDaemonId: COORDINATOR, launchedByCoordinator: true },
    };
    const mesh = {
        id: meshId, name: 'Quota Gate', repoIdentity: 'example/repo',
        policy: {},
        coordinator: {},
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        nodes: [{
            id: NODE, workspace: '/tmp/local-repo', repoRoot: '/tmp/local-repo',
            daemonId: COORDINATOR, machineId: 'machine-coordinator', userOverrides: {},
            policy: { providerPriority: [PROVIDER] }, sessions: [session],
            ...(opts.nodeFacts ? { nodeFacts: opts.nodeFacts } : {}),
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

test('quota-exhausted session (run-10 shape) → local direct dispatch refused provider_quota_exhausted with the reset time', async () => {
    const meshId = `mesh-quotagate-exhausted-${randomUUID().slice(0, 8)}`;
    cleanupMesh(meshId);
    const now = Date.now();
    const facts = quotaFacts({ [PROVIDER]: sessionExhausted(PROVIDER, now) }, { reportedAt: now });
    const h = createLocalCtx(meshId, { nodeFacts: facts });
    try {
        await withLedger(async () => {
            const res = await send(h.ctx);
            assert.equal(res.success, false, JSON.stringify(res));
            assert.equal(res.code, 'provider_quota_exhausted');
            assert.equal(res.quotaBlock?.window, 'session');
            assert.equal(res.quotaBlock?.resetsAt, (facts.quota[PROVIDER] as any).session.resetsAt, 'names WHEN the window resets');
            assert.equal(getQueue(meshId).length, 0, 'a refused dispatch never materializes a task row');
        });
    } finally {
        cleanupMesh(meshId);
    }
});

test('unknown quota (no nodeFacts reported) → dispatch proceeds (fail-open)', async () => {
    const meshId = `mesh-quotagate-unknown-${randomUUID().slice(0, 8)}`;
    cleanupMesh(meshId);
    const h = createLocalCtx(meshId, {});
    try {
        await withLedger(async () => {
            const res = await send(h.ctx);
            assert.notEqual(res.code, 'provider_quota_exhausted');
        });
    } finally {
        cleanupMesh(meshId);
    }
});

test('healthy quota → dispatch proceeds', async () => {
    const meshId = `mesh-quotagate-healthy-${randomUUID().slice(0, 8)}`;
    cleanupMesh(meshId);
    const now = Date.now();
    const facts = quotaFacts({ [PROVIDER]: healthy(PROVIDER, now) }, { reportedAt: now });
    const h = createLocalCtx(meshId, { nodeFacts: facts });
    try {
        await withLedger(async () => {
            const res = await send(h.ctx);
            assert.notEqual(res.code, 'provider_quota_exhausted');
        });
    } finally {
        cleanupMesh(meshId);
    }
});

test('allow_quota_exhausted:true bypasses the refusal on an exhausted session', async () => {
    const meshId = `mesh-quotagate-bypass-${randomUUID().slice(0, 8)}`;
    cleanupMesh(meshId);
    const now = Date.now();
    const facts = quotaFacts({ [PROVIDER]: sessionExhausted(PROVIDER, now) }, { reportedAt: now });
    const h = createLocalCtx(meshId, { nodeFacts: facts });
    try {
        await withLedger(async () => {
            const res = await send(h.ctx, { allow_quota_exhausted: true });
            assert.notEqual(res.code, 'provider_quota_exhausted');
        });
    } finally {
        cleanupMesh(meshId);
    }
});

test('camelCase allowQuotaExhausted alias also bypasses the refusal', async () => {
    const meshId = `mesh-quotagate-bypass-camel-${randomUUID().slice(0, 8)}`;
    cleanupMesh(meshId);
    const now = Date.now();
    const facts = quotaFacts({ [PROVIDER]: sessionExhausted(PROVIDER, now) }, { reportedAt: now });
    const h = createLocalCtx(meshId, { nodeFacts: facts });
    try {
        await withLedger(async () => {
            const res = await send(h.ctx, { allowQuotaExhausted: true });
            assert.notEqual(res.code, 'provider_quota_exhausted');
        });
    } finally {
        cleanupMesh(meshId);
    }
});

test('readonly direct dispatch is still gated (quota, unlike the git-gate, is not write-scoped)', async () => {
    // The quota gate blocks the PROVIDER from doing any work at all, unlike the
    // git-gate which only guards write races — a readonly task still cannot run.
    const meshId = `mesh-quotagate-readonly-${randomUUID().slice(0, 8)}`;
    cleanupMesh(meshId);
    const now = Date.now();
    const facts = quotaFacts({ [PROVIDER]: sessionExhausted(PROVIDER, now) }, { reportedAt: now });
    const h = createLocalCtx(meshId, { nodeFacts: facts });
    try {
        await withLedger(async () => {
            const res = await send(h.ctx, { task_mode: 'live_debug_readonly', readonly: true });
            assert.equal(res.code, 'provider_quota_exhausted');
        });
    } finally {
        cleanupMesh(meshId);
    }
});
