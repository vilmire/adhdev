import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// SUBMIT-UNCONFIRMED-RECLAIM ①, ledger side: the worker instance turns a
// PROVEN-unsent write of its CURRENT mesh dispatch (the driver cleared the
// composer after its budget and one re-paste) into
// `dispatch_failed{reason:'submit_unconfirmed'}`, and R24 reclaims the attempt
// from `delivered` (deliverTaskToSession books `delivered` the moment
// send_chat returns, long before the submit verdict) — the queue row goes back
// to pending under a NEW nonce, i.e. a new `task:<id>:n<nonce>` messageId that
// the worker's settled dedupe does not know. Real MeshRuntimeStore + the
// production runtime ledger, the real provider-side evidence port.

const testTmpDir = path.join(tmpdir(), `adhdev-submit-unconfirmed-${randomUUID().slice(0, 8)}`);
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
vi.mock('../../src/config/mesh-config.js', () => ({
    getMesh: vi.fn(),
    getMeshByRepo: vi.fn(),
    listMeshes: vi.fn(() => [] as any[]),
}));

import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask, getQueue } from '../../src/mesh/mesh-work-queue.js';
import { createMeshRuntimeTurnLedger } from '../../src/mesh/turn-ledger/runtime-ledger.js';
import { dispatchMessageId } from '../../src/mesh/mesh-queue-dispatch-evidence.js';
import { createTurnEvidencePort } from '../../src/providers/turn-evidence-port.js';
import { currentMeshDispatchMessageId, reportMeshSubmitUnconfirmed } from '../../src/providers/cli-provider-mesh-assignment.js';
import { T0, evd, fakePublisher, recordingPorts } from './ledger-harness.js';

afterEach(() => {
    vi.restoreAllMocks();
    __resetMeshRuntimeStoreForTests();
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const consumption = { check: 'not_consumed' as 'consumed' | 'not_consumed' | 'unknown' };
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };

function setup() {
    consumption.check = 'not_consumed';
    const mesh = `mesh_su_${randomUUID().slice(0, 8)}`;
    const task = enqueueTask(mesh, 'work', { taskMode: 'code_change', difficulty: 'medium' } as any);
    const store = MeshRuntimeStore.getInstance();
    const row = getQueue(mesh).find((t) => t.id === task.id)!;
    store.updateQueueEntry({ ...row, status: 'assigned', assignedNodeId: 'n1', assignedSessionId: 's1', updatedAt: new Date().toISOString() } as any);
    const ports = recordingPorts();
    const baseCancel = ports.cancelDispatch;
    ports.cancelDispatch = (r) => { baseCancel?.(r); return { ...r, success: true, quiescent: true, incarnation: 'fixture-native-writer' }; };
    const ledger = createMeshRuntimeTurnLedger({ selfDaemonId: 'dc', now: () => T0 + 10_000, publisher: fakePublisher(), ports: { bus: ports.bus, cancelDispatch: ports.cancelDispatch } });
    const nonce = store.findQueueEntryById(mesh, task.id)!.dispatchNonce ?? 0;
    const messageId = dispatchMessageId({ id: task.id, dispatchNonce: nonce });
    const ref = { attemptRef: { attemptId: `att-${task.id}`, generation: 0 }, taskId: task.id };
    ledger.observe(evd('dispatch_accepted', { scope: 'mesh_queue', messageId, meshId: mesh, coordinator: { daemonId: 'dc', coordinatorRunId: 'r', sessionId: 'coord' } }, { ...ref, source: 'dispatch', observedBy: 'dc' }));
    // The transport confirm — booked synchronously on send_chat's return.
    ledger.observe(evd('delivered', { messageId, outcome: 'delivered', via: 'local' }, { ...ref, source: 'dispatch' }));
    // The worker instance, as attachMeshAssignment stamped it.
    const host = {
        instanceId: 's1',
        settings: { meshNodeFor: mesh, meshActiveTaskId: task.id, meshActiveDispatchNonce: nonce, meshActiveAttemptId: ref.attemptRef.attemptId, meshActiveAttemptGeneration: 0 } as Record<string, any>,
        turnEvidencePort: createTurnEvidencePort({ observe: (e) => { ledger.observe(e); }, selfDaemonId: 'dc', confirmConsumption: async () => consumption.check }),
    };
    return { mesh, task, store, ledger, ref, ports, nonce, messageId, host, firstWrittenAt: Date.now() - 1_000 };
}

describe('submit unconfirmed → dispatch_failed → R24 reclaim under a new nonce', () => {
    it('the instance reports its current dispatch; after a fresh read shows no agent activity the ledger reclaims from delivered and the row is re-armed with nonce+1', async () => {
        const f = setup();
        try {
            expect(f.ledger.openAttemptForSession('s1')).toMatchObject({ state: 'delivered', generation: 0 });
            expect(currentMeshDispatchMessageId(f.host.settings)).toBe(f.messageId);

            expect(reportMeshSubmitUnconfirmed(f.host, f.messageId, f.firstWrittenAt)).toBe(true);
            await flush();

            const row = f.store.findQueueEntryById(f.mesh, f.task.id)!;
            expect(row.status).toBe('pending');
            expect(row.assignedSessionId).toBeUndefined();
            expect(row.dispatchNonce).toBe(f.nonce + 1);
            // The redispatch carries a messageId the worker's settled dedupe has never seen.
            expect(dispatchMessageId({ id: f.task.id, dispatchNonce: row.dispatchNonce })).not.toBe(f.messageId);
            // Review d75636d6 F4: g0 is cut on the old session WITH a stop — its
            // bind is revoked, so it must not be reused for the redispatch.
            expect(f.ports.calls).toContain('cancel:s1:g0');
            const cancelRows = f.store.db.prepare(`SELECT payload_json FROM turn_events WHERE kind = 'cancel_dispatch'`).all() as Array<{ payload_json: string }>;
            expect(cancelRows).toHaveLength(1);
            const payload = JSON.parse(cancelRows[0].payload_json);
            expect(payload).toMatchObject({ meshId: f.mesh, messageId: f.messageId });
            expect(payload.keepSession).toBeUndefined();
            const failed = f.store.db.prepare(`SELECT payload_json FROM turn_events WHERE kind = 'dispatch_failed'`).all() as Array<{ payload_json: string }>;
            expect(failed).toHaveLength(1);
            expect(failed[0].payload_json).toContain('submit_unconfirmed');
        } finally {
            __clearMeshQueueForTests(f.mesh);
        }
    });

    it.each(['not_consumed', 'unknown'] as const)('review R5-1: a %s transcript read is not evidence either way — the composer proof stands and the dispatch is reclaimed', async (check) => {
        const f = setup();
        try {
            consumption.check = check;
            expect(reportMeshSubmitUnconfirmed(f.host, f.messageId, f.firstWrittenAt)).toBe(true);
            await flush();
            expect(f.store.findQueueEntryById(f.mesh, f.task.id)!.dispatchNonce).toBe(f.nonce + 1);
            expect(f.ledger.getAttempt(f.ref.attemptRef.attemptId)).toMatchObject({ state: 'accepted', generation: 1 });
            // The old session took the body after all and starts a turn — late
            // consumption evidence for g0 is recorded against the stale
            // generation and cut; g1 keeps its fresh nonce (R1: never twice).
            const late = f.ledger.observe(evd('turn_started', { retro: false }, f.ref));
            expect(late.rule).toMatch(/^R28/);
            expect(f.ledger.getAttempt(f.ref.attemptRef.attemptId)).toMatchObject({ state: 'accepted', generation: 1 });
        } finally {
            __clearMeshQueueForTests(f.mesh);
        }
    });

    it('review f8c79690 R4-1: a fresh read that shows agent activity reports turn_started instead — no reclaim, no cancel', async () => {
        const f = setup();
        try {
            consumption.check = 'consumed';
            expect(reportMeshSubmitUnconfirmed(f.host, f.messageId, f.firstWrittenAt)).toBe(true);
            await flush();
            expect(f.ledger.getAttempt(f.ref.attemptRef.attemptId)).toMatchObject({ state: 'generating', generation: 0 });
            expect(f.ports.calls.filter((c) => c.startsWith('cancel:'))).toEqual([]);
            expect(f.store.findQueueEntryById(f.mesh, f.task.id)!.status).toBe('assigned');
            expect(f.store.db.prepare(`SELECT COUNT(*) AS n FROM turn_events WHERE kind = 'dispatch_failed'`).get()).toEqual({ n: 0 });
        } finally {
            __clearMeshQueueForTests(f.mesh);
        }
    });

    it('review R5-2 (+0 write / +20 activity / +25 same-identity re-stamp / +35.59 report): the read is anchored at the FIRST write, so the +20 activity vetoes the reclaim', async () => {
        const f = setup();
        try {
            const t0 = f.firstWrittenAt;
            const activityAt = t0 + 20_000;
            const seen: number[] = [];
            f.host.turnEvidencePort = createTurnEvidencePort({
                observe: (e) => { f.ledger.observe(e); }, selfDaemonId: 'dc',
                confirmConsumption: async (_s, since) => { seen.push(since); return activityAt >= since ? 'consumed' : 'not_consumed'; },
            });
            (f.host as any).meshTaskInjectedAt = t0 + 25_000; // the re-stamp a scalar anchor would have used
            expect(reportMeshSubmitUnconfirmed(f.host, f.messageId, t0)).toBe(true);
            await flush();
            expect(seen).toEqual([t0]);
            expect(f.ledger.getAttempt(f.ref.attemptRef.attemptId)).toMatchObject({ state: 'generating', generation: 0 });
            expect(f.store.db.prepare(`SELECT COUNT(*) AS n FROM turn_events WHERE kind = 'dispatch_failed'`).get()).toEqual({ n: 0 });
        } finally {
            __clearMeshQueueForTests(f.mesh);
        }
    });

    it('review f8c79690 R4-1: a dispatch that moved on during the read (new nonce / attempt) is not reported', async () => {
        const f = setup();
        try {
            let release!: (v: 'not_consumed') => void;
            f.host.turnEvidencePort = createTurnEvidencePort({ observe: (e) => { f.ledger.observe(e); }, selfDaemonId: 'dc', confirmConsumption: () => new Promise<'not_consumed'>((r) => { release = r; }) });
            expect(reportMeshSubmitUnconfirmed(f.host, f.messageId, f.firstWrittenAt)).toBe(true);
            f.host.settings.meshActiveDispatchNonce = f.nonce + 1; // re-stamped while the read was in flight
            release('not_consumed');
            await flush();
            expect(f.ledger.getAttempt(f.ref.attemptRef.attemptId)).toMatchObject({ state: 'delivered', generation: 0 });
        } finally {
            __clearMeshQueueForTests(f.mesh);
        }
    });

    it('a give-up of any OTHER message (dashboard send, stale nonce) never fails the dispatch', () => {
        const f = setup();
        try {
            expect(reportMeshSubmitUnconfirmed(f.host, 'msg_dashboard_1', f.firstWrittenAt)).toBe(false);
            expect(reportMeshSubmitUnconfirmed(f.host, dispatchMessageId({ id: f.task.id, dispatchNonce: f.nonce + 7 }), f.firstWrittenAt)).toBe(false);
            expect(f.store.findQueueEntryById(f.mesh, f.task.id)!.status).toBe('assigned');
            expect(f.ledger.openAttemptForSession('s1')).toMatchObject({ state: 'delivered', generation: 0 });
        } finally {
            __clearMeshQueueForTests(f.mesh);
        }
    });

    it('a dispatch the worker already started is not reclaimed by a late give-up', async () => {
        const f = setup();
        try {
            f.ledger.observe(evd('turn_started', { retro: false }, f.ref));
            reportMeshSubmitUnconfirmed(f.host, f.messageId, f.firstWrittenAt);
            await flush();
            expect(f.store.findQueueEntryById(f.mesh, f.task.id)!.status).toBe('assigned');
            expect(f.ledger.openAttemptForSession('s1')).toMatchObject({ state: 'generating', generation: 0 });
        } finally {
            __clearMeshQueueForTests(f.mesh);
        }
    });
});
