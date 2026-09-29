import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// Stopped queue `depends_on` work is always told: the coordinator gets ONE
// notice (ids + reason CODES + the next tools) when a dependency ends
// failed/cancelled, through the same notice row a PTY-hosted and an MCP-only
// coordinator both read. The housekeeping sweep re-derives the same notice
// for a dead dependency nobody announced, deduped by the same eventId.

const testTmpDir = path.join(tmpdir(), `adhdev-queue-dep-${randomUUID().slice(0, 8)}`);
const testConfigDir = path.join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' } as any),
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));
const meshConfig = vi.hoisted(() => ({ policy: undefined as Record<string, unknown> | undefined }));
vi.mock('../../src/config/mesh-config.js', () => ({
    getMesh: vi.fn(() => (meshConfig.policy ? { id: 'm', policy: meshConfig.policy } : undefined)),
    getMeshByRepo: vi.fn(),
    listMeshes: vi.fn(() => [] as any[]),
}));
vi.mock('../../src/config/mesh-config-routing.js', async (importOriginal) => ({
    ...(await importOriginal<any>()),
    getDifficultyBrains: vi.fn(() => undefined),
}));

import {
    __clearMeshQueueForTests,
    __resetMeshRuntimeStoreForTests,
    cancelTask,
    enqueueTask,
    getQueueEntryById,
    requeueTask,
} from '../../src/mesh/mesh-work-queue.js';
import { meshRuntimeTxnHost } from '../../src/mesh/turn-ledger/runtime-ledger.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import {
    reasonCodeOf,
    renderQueueDependencyNotice,
    sweepQueueDependencyStalls,
    type MeshQueueDependencyNotice,
} from '../../src/mesh/mesh-queue-dependency-notice.js';
import { bindMeshNoticeRuntime, createCoordinatorNotifier, createTurnDeliverCounters, createTurnDeliverHandler, readCoordinatorNotices, type CoordinatorNotice, type TurnDeliverDeps } from '../../src/mesh/turn-ledger/deliver.js';
import { T0, fakePublisher, ledgerOn, memDb } from '../turn-ledger/ledger-harness.js';

/** Never allowed in any notice: task message text and operator free text. */
const SECRET = 'SECRET-7c1e-task-body-never-in-a-notice';

let currentMesh: string | undefined;
afterEach(() => {
    if (currentMesh) __clearMeshQueueForTests(currentMesh);
    currentMesh = undefined;
    meshConfig.policy = undefined;
    bindMeshNoticeRuntime(null);
    __resetMeshRuntimeStoreForTests();
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function newMesh(tag: string): string {
    currentMesh = `mesh_qdep_${tag}_${randomUUID().slice(0, 8)}`;
    return currentMesh;
}

/** A notice runtime that dedupes on eventId like the turn_events PK does. */
function captureNotices(): CoordinatorNotice[] {
    const seen = new Set<string>();
    const out: CoordinatorNotice[] = [];
    bindMeshNoticeRuntime({
        notify(notice: CoordinatorNotice) {
            const id = notice.eventId ?? `${notice.event}:${out.length}`;
            if (seen.has(id)) return { eventId: id, queued: false };
            seen.add(id);
            out.push(notice);
            return { eventId: id, queued: true };
        },
        retract: () => 0,
    } as any);
    return out;
}

function queueChain(mesh: string) {
    const opts = { taskMode: 'code_change', difficulty: 'medium' } as any;
    const root = enqueueTask(mesh, `${SECRET} root`, opts);
    const e = enqueueTask(mesh, `${SECRET} e`, { ...opts, dependsOn: [root.id] });
    const f = enqueueTask(mesh, `${SECRET} f`, { ...opts, dependsOn: [e.id] });
    return { root, e, f };
}

describe('queue chains — the default block policy is kept, and made visible', () => {
    it('★ live shape: cancelling a chain root pages ONCE "N tasks still wait on the task you cancelled"; dependents stay pending', () => {
        const mesh = newMesh('qcancel');
        const q = queueChain(mesh);
        const notices = captureNotices();
        cancelTask(mesh, q.root.id, { reason: `${SECRET}: no longer needed` });

        // block (default) is preserved: nothing is cancelled silently.
        expect(getQueueEntryById(mesh, q.e.id)!.status).toBe('pending');
        expect(getQueueEntryById(mesh, q.f.id)!.status).toBe('pending');
        expect(notices).toHaveLength(1);
        const n = notices[0];
        expect(n.event).toBe('mesh:queue_dependency_blocked');
        expect(n.metadataEvent).toMatchObject({
            source: 'mesh_queue_dependency',
            taskId: q.root.id,
            rootOutcome: 'cancelled',
            reasonCode: 'operator_cancel',
            waitingTaskIds: [q.e.id, q.f.id],
            policy: 'block',
        });
        expect(n.coordinatorMessage!.startsWith(`2 task(s) still wait on the task you cancelled, ${q.root.id.slice(0, 8)} (task_id ${q.root.id})`)).toBe(true);
        expect(n.coordinatorMessage).toContain(`mesh_queue_cancel(task_id=…) for '${q.e.id}', '${q.f.id}'`);
        expect(n.coordinatorMessage).toContain(`mesh_queue_requeue(task_id='${q.root.id}', force=true)`);
        expect(JSON.stringify(n)).not.toContain(SECRET);
        // The sweep re-derives the SAME eventId: nothing pages twice.
        expect(sweepQueueDependencyStalls(mesh)).toMatchObject({ stalledRoots: 1, noticesQueued: 0 });
        expect(notices).toHaveLength(1);
    });

    it('a failed root names its reason code and the retry', () => {
        const mesh = newMesh('qfail');
        const q = queueChain(mesh);
        const notices = captureNotices();
        requeueTask(mesh, q.root.id, { maxRetries: 0 });
        expect(notices).toHaveLength(1);
        expect(notices[0].coordinatorMessage).toContain(`Queue task ${q.root.id.slice(0, 8)} (task_id ${q.root.id}) failed (reason: max_retries_exceeded) and 2 task(s) still wait on it`);
        expect(notices[0].coordinatorMessage).toContain(`retry it with mesh_queue_requeue(task_id='${q.root.id}', force=true)`);
    });

    it('the ledger path (meshRuntimeTxnHost.taskTerminal) carries its machine reason code', () => {
        const mesh = newMesh('qledger');
        const q = queueChain(mesh);
        const notices = captureNotices();
        const now = Date.now();
        MeshRuntimeStore.getInstance().transaction(() => meshRuntimeTxnHost.taskTerminal(
            { kind: 'task_terminal', meshId: mesh, taskId: q.root.id, outcome: 'failed' } as any,
            { nowMs: now, attempt: { sessionId: 's1', attemptId: 'a1', attemptNo: 0, terminal: { reason: 'reclaim_budget_exhausted', at: now } } } as any,
        ));
        expect(notices).toHaveLength(1);
        expect(notices[0].metadataEvent).toMatchObject({ reasonCode: 'reclaim_budget_exhausted' });
    });

    it('under mesh policy cancel: ONE queue_dependency_cancelled notice lists the cascade', () => {
        const mesh = newMesh('qcascade');
        meshConfig.policy = { onDependencyFailure: 'cancel' };
        const q = queueChain(mesh);
        const notices = captureNotices();
        requeueTask(mesh, q.root.id, { maxRetries: 0 });
        expect(getQueueEntryById(mesh, q.e.id)!.status).toBe('cancelled');
        expect(getQueueEntryById(mesh, q.f.id)!.status).toBe('cancelled');
        expect(notices).toHaveLength(1);
        expect(notices[0].event).toBe('mesh:queue_dependency_cancelled');
        expect(notices[0].metadataEvent).toMatchObject({ cancelledTaskIds: [q.e.id, q.f.id], policy: 'cancel' });
        expect(notices[0].coordinatorMessage).toContain('Under on_dependency_failure=cancel, 2 dependent task(s) were cancelled');
    });

    it('stall sweep: a chain behind a dead task with NO notice pages once', () => {
        const mesh = newMesh('qstall');
        const q = queueChain(mesh);
        // A root that went terminal without the notice (pre-upgrade / bypass).
        const store = MeshRuntimeStore.getInstance();
        const root = store.findQueueEntryById(mesh, q.root.id)!;
        root.status = 'failed';
        store.updateQueueEntry(root);
        const notices = captureNotices();
        expect(sweepQueueDependencyStalls(mesh)).toMatchObject({ stalledRoots: 1, noticesQueued: 1 });
        expect(sweepQueueDependencyStalls(mesh)).toMatchObject({ stalledRoots: 1, noticesQueued: 0 });
        expect(notices).toHaveLength(1);
        expect(notices[0].event).toBe('mesh:queue_dependency_blocked');
        expect(notices[0].metadataEvent).toMatchObject({ source: 'mesh_queue_stall_sweep', reasonCode: 'task_failed' });
        expect(JSON.stringify(notices[0])).not.toContain(SECRET);
    });

    it('a retried root that fails AGAIN pages again (new output version = new generation)', () => {
        const mesh = newMesh('qagain');
        const q = queueChain(mesh);
        const notices = captureNotices();
        requeueTask(mesh, q.root.id, { maxRetries: 0 });
        requeueTask(mesh, q.root.id, { force: true } as any);
        requeueTask(mesh, q.root.id, { maxRetries: 0 });
        expect(notices.map(n => n.eventId)).toHaveLength(new Set(notices.map(n => n.eventId)).size);
        expect(notices.length).toBeGreaterThanOrEqual(2);
    });
});

describe('N delivery — one notice row serves a PTY-hosted AND an MCP-only coordinator', () => {
    function deliverFixture() {
        const db = memDb();
        const publisher = fakePublisher('w-dc');
        const clock = { now: T0 };
        const ledger = ledgerOn(db, { publisher, now: () => clock.now, selfDaemonId: 'dc' });
        const calls: any[] = [];
        const deps: TurnDeliverDeps = {
            ledger,
            selfDaemonIds: () => ['dc'],
            port: { async submit(msg: any) { calls.push(msg); return { kind: 'delivered' } as any; } },
            coordinators: () => [{ sessionId: 'coord', idle: true, modalParked: false }],
            waiter: { wait: async () => 'edge' as const, wake: () => {} } as any,
            now: () => clock.now,
            counters: createTurnDeliverCounters(),
        };
        const notifier = createCoordinatorNotifier({ ledger, selfDaemonIds: () => ['dc'], now: () => clock.now });
        return { ledger, publisher, deps, calls, notifier };
    }

    const notice: MeshQueueDependencyNotice = {
        kind: 'queue_dependency_blocked', meshId: 'm1', generation: 1, source: 'mesh_queue_dependency',
        root: { taskId: 't-root-1234567890', outcome: 'failed', reasonCode: 'max_retries_exceeded' },
        waiting: [{ taskId: 't-d-1234567890' }],
    };

    it('PTY: the deliver cursor injects the rendered text; the same eventId never queues twice', async () => {
        const f = deliverFixture();
        const r = renderQueueDependencyNotice(notice);
        const n = { meshId: 'm1', event: r.event, nodeLabel: r.nodeLabel, eventId: r.eventId, metadataEvent: r.metadataEvent, coordinatorMessage: r.coordinatorMessage };
        expect(f.notifier.notify(n).queued).toBe(true);
        expect(f.notifier.notify(n).queued).toBe(false);
        await f.ledger.flushPublish();
        const e = f.publisher.entries.find(x => x.entry.k === 'turn.notify')!;
        // The topic entry carries no text — only the local row does.
        expect(JSON.stringify(e.entry)).not.toContain('still wait on it');
        const res = await createTurnDeliverHandler(f.deps)({ meshId: e.meshId, writer: e.writer, seq: e.seq, kind: e.entry.k, payload: e.entry, own: true } as any, new AbortController().signal);
        expect(res).toMatchObject({ outcome: 'delivered' });
        expect(f.calls[0].input.textFallback).toContain(r.coordinatorMessage);
    });

    it('MCP-only: get_pending_mesh_events (readCoordinatorNotices) returns the same text', async () => {
        const f = deliverFixture();
        const r = renderQueueDependencyNotice(notice);
        f.notifier.notify({ meshId: 'm1', event: r.event, nodeLabel: r.nodeLabel, eventId: r.eventId, metadataEvent: r.metadataEvent, coordinatorMessage: r.coordinatorMessage });
        await f.ledger.flushPublish();
        const read = readCoordinatorNotices(f.deps, 'm1');
        expect(read).toHaveLength(1);
        expect(JSON.stringify(read[0])).toContain('mesh_queue_requeue');
    });
});

describe('reason codes never carry free text', () => {
    it('keeps a leading machine code and drops everything else', () => {
        expect(reasonCodeOf('max_retries_exceeded: requeued 2 time(s), limit is 1')).toBe('max_retries_exceeded');
        expect(reasonCodeOf('dependency_failed:abc')).toBe('dependency_failed');
        expect(reasonCodeOf('reclaim_budget_exhausted')).toBe('reclaim_budget_exhausted');
        expect(reasonCodeOf("workspace 'ws' is failed and can never become ready")).toBe('unspecified');
        expect(reasonCodeOf(`${SECRET} free text`)).toBe('unspecified');
        expect(reasonCodeOf(undefined)).toBe('unspecified');
        // The real live operator reason (2026-09-25): a dashed/cased token is text, not a code.
        expect(reasonCodeOf('live-check: cancel behind open gate')).toBe('unspecified');
        expect(reasonCodeOf('Operator: stop it')).toBe('unspecified');
    });
});
