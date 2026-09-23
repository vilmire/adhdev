import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';

const testTmpDir = join(tmpdir(), `adhdev-mesh-runtime-store-test-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');
const runtimeRequire = createRequire(import.meta.url);

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));

import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { seedMeshAttempt, advanceSeededAttempt } from '../helpers/turn-attempt-seed.js';
import { createMeshRuntimeTurnLedger } from '../../src/mesh/turn-ledger/runtime-ledger.js';
import { setActiveTurnLedger } from '../../src/mesh/turn-ledger/active-ledger.js';
import { fakePublisher } from '../turn-ledger/ledger-harness.js';
import {
    getActiveDirectDispatches,
    cancelDirectDispatchAttempts,
    __resetMeshRuntimeStoreForTests,
    enqueueTask,
    claimNextTask,
    getQueue,
    getMeshQueueStats,
    cancelTask,
    requeueTask,
    updateTaskStatus, __writeTaskStatusForTests,
    recordDirectDispatchTask,
    __clearMeshQueueForTests,
} from '../../src/mesh/mesh-work-queue.js';

describe('mesh-runtime-store', () => {
    beforeEach(() => {
        if (!existsSync(testConfigDir)) {
            mkdirSync(testConfigDir, { recursive: true });
        }
    });

    afterEach(() => {
        __resetMeshRuntimeStoreForTests();
        try {
            rmSync(testTmpDir, { recursive: true, force: true });
        } catch { /* cleanup best-effort */ }
    });

    describe('store file migration', () => {
        it('migrates an existing beads.db file to mesh-runtime.db on first open', () => {
            const Database = runtimeRequire('better-sqlite3') as any;
            const ledgerDir = join(testConfigDir, 'mesh-ledger');
            mkdirSync(ledgerDir, { recursive: true });
            const legacyDbPath = join(ledgerDir, 'beads.db');
            const nextDbPath = join(ledgerDir, 'mesh-runtime.db');

            const legacyDb = new Database(legacyDbPath);
            legacyDb.exec(`CREATE TABLE legacy_probe (id TEXT PRIMARY KEY);`);
            legacyDb.prepare('INSERT INTO legacy_probe (id) VALUES (?)').run('carried');
            legacyDb.close();

            const db = MeshRuntimeStore.getInstance() as any;
            expect(existsSync(legacyDbPath)).toBe(false);
            expect(existsSync(nextDbPath)).toBe(true);
            // The file itself moved (rows included) — C-W8 retired the fingerprint table
            // this test used to probe with, so it probes a table of its own.
            expect(db.db.prepare('SELECT id FROM legacy_probe').get()).toEqual({ id: 'carried' });
        });
    });

    // C-W8: a direct dispatch IS its open `mesh_direct` turn-ledger attempt; the
    // retired mesh_direct_dispatches table (insert / status flips / stale sweeps /
    // deletes) and its suites are gone. These pin the read that replaced it.
    describe('direct dispatches read off open mesh_direct attempts (C-W8)', () => {
        const direct = (meshId: string, taskId: string, sessionId: string, stage: Parameters<typeof seedMeshAttempt>[0]['stage'] = 'delivered', nowMs?: number) =>
            seedMeshAttempt({ meshId, taskId, sessionId, scope: 'mesh_direct', nodeId: 'node-d', providerType: 'claude-cli', stage, ...(nowMs !== undefined ? { nowMs } : {}) });

        it('lists open mesh_direct attempts with the queue message; maps pre-turn to dispatched, started to acked', () => {
            const meshId = `mesh-dd-${randomUUID().slice(0, 8)}`;
            const t1 = randomUUID();
            const t2 = randomUUID();
            recordDirectDispatchTask(meshId, 'first task body', { id: t1, assignedNodeId: 'node-d', assignedSessionId: 's1', taskMode: 'code_change', difficulty: 'medium' });
            direct(meshId, t1, 's1', 'delivered', Date.now() - 1000);
            direct(meshId, t2, 's2', 'generating');
            const active = getActiveDirectDispatches(meshId);
            expect(active.map((d) => [d.taskId, d.status])).toEqual([[t1, 'dispatched'], [t2, 'acked']]);
            expect(active[0]).toMatchObject({ meshId, nodeId: 'node-d', sessionId: 's1', providerType: 'claude-cli', message: 'first task body', taskMode: 'code_change' });
            // No queue row yet (the short pre-materialisation window): an empty message, never a throw.
            expect(active[1].message).toBe('');
        });

        it('excludes terminal attempts, non-direct scopes and other meshes', () => {
            const meshId = `mesh-dd-${randomUUID().slice(0, 8)}`;
            const other = `mesh-dd-${randomUUID().slice(0, 8)}`;
            const done = direct(meshId, randomUUID(), 's-done', 'generating');
            advanceSeededAttempt(done.attemptId, 'completed');
            seedMeshAttempt({ meshId, taskId: randomUUID(), sessionId: 's-queue', scope: 'mesh_queue', stage: 'generating' });
            direct(other, randomUUID(), 's-other', 'generating');
            const keep = direct(meshId, randomUUID(), 's-keep', 'consumed');
            expect(getActiveDirectDispatches(meshId).map((d) => d.taskId)).toEqual([keep.taskId]);
            expect(getActiveDirectDispatches(other)).toHaveLength(1);
        });

        it('resolves the ONE active direct task a session holds (taskId-less event fallback)', () => {
            const meshId = `mesh-dd-${randomUUID().slice(0, 8)}`;
            const a = direct(meshId, randomUUID(), 's-sole', 'generating');
            const store = MeshRuntimeStore.getInstance();
            expect(store.getSoleActiveDirectDispatchTaskId(meshId, 's-sole')).toBe(a.taskId);
            expect(store.getSoleActiveDirectDispatchTaskId(meshId, 's-none')).toBeNull();
            advanceSeededAttempt(a.attemptId, 'cancelled');
            expect(store.getSoleActiveDirectDispatchTaskId(meshId, 's-sole')).toBeNull();
        });

        it('cancelDirectDispatchAttempts closes the attempt on this process\'s ledger (no ledger → 0)', () => {
            const meshId = `mesh-dd-${randomUUID().slice(0, 8)}`;
            const ledger = createMeshRuntimeTurnLedger({ selfDaemonId: 'dc', publisher: fakePublisher() });
            const taskId = randomUUID();
            ledger.observe({
                eventId: `open-${taskId}`, at: Date.now(), source: 'dispatch', sessionId: 's-c', taskId, observedBy: 'dc',
                kind: 'dispatch_accepted', scope: 'mesh_direct', messageId: taskId, meshId, nodeId: 'node-d',
            } as any);
            expect(getActiveDirectDispatches(meshId).map((d) => d.taskId)).toEqual([taskId]);
            expect(cancelDirectDispatchAttempts(meshId, [taskId])).toBe(0); // no ledger bound
            setActiveTurnLedger(ledger);
            try {
                expect(cancelDirectDispatchAttempts(meshId, [taskId])).toBe(1);
                expect(getActiveDirectDispatches(meshId)).toHaveLength(0);
                expect(cancelDirectDispatchAttempts(meshId, [taskId])).toBe(0); // idempotent
            } finally {
                setActiveTurnLedger(null);
            }
        });
    });

    describe('claimNextQueueTask — MeshRuntimeStore level', () => {
        afterEach(() => {
            __resetMeshRuntimeStoreForTests();
        });

        it('claims the oldest pending task when no active assignment exists', () => {
            const meshId = `mesh-claim-oldest-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            db.insertQueueEntry({ id: 'task-1', meshId, message: 'first', status: 'pending', createdAt: new Date(Date.now() - 1000).toISOString(), updatedAt: new Date(Date.now() - 1000).toISOString() });
            db.insertQueueEntry({ id: 'task-2', meshId, message: 'second', status: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

            const result = db.claimNextQueueTask(meshId, 'node1', 'sess1');
            expect(result?.id).toBe('task-1');
            expect(result?.status).toBe('assigned');
            expect(result?.assignedNodeId).toBe('node1');
            expect(result?.assignedSessionId).toBe('sess1');

            __clearMeshQueueForTests(meshId);
        });

        it('persists the assignedTranscriptProfile stamp on claim and omits it when absent', () => {
            const meshId = `mesh-claim-profile-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            db.insertQueueEntry({ id: 'task-p1', meshId, message: 'stamped', status: 'pending', createdAt: new Date(Date.now() - 1000).toISOString(), updatedAt: new Date(Date.now() - 1000).toISOString() });
            db.insertQueueEntry({ id: 'task-p2', meshId, message: 'unstamped', status: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

            const profile = { class: 'native-source', timing: 'floor', emitsPtyTurnEvents: false } as const;
            const stamped = db.claimNextQueueTask(meshId, 'node1', 'sess1', [], { assignedTranscriptProfile: profile });
            expect(stamped?.id).toBe('task-p1');
            expect(stamped?.assignedTranscriptProfile).toEqual(profile);
            // Round-trips through the persisted payload, not just the in-memory entry.
            const persisted = db.getQueueEntries(meshId, ['assigned']).find(e => e.id === 'task-p1');
            expect(persisted?.assignedTranscriptProfile).toEqual(profile);

            // Older-daemon shape: no stamp option → no field on the row.
            const unstamped = db.claimNextQueueTask(meshId, 'node2', 'sess2');
            expect(unstamped?.id).toBe('task-p2');
            expect(unstamped?.assignedTranscriptProfile).toBeUndefined();

            __clearMeshQueueForTests(meshId);
        });

        it('returns null when node/session already has an active assignment', () => {
            const meshId = `mesh-claim-active-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            db.insertQueueEntry({ id: 'task-a', meshId, message: 'first task', status: 'pending', createdAt: new Date(Date.now() - 2000).toISOString(), updatedAt: new Date(Date.now() - 2000).toISOString() });

            // Claim the first task
            db.claimNextQueueTask(meshId, 'node1', 'sess1');

            // Insert another task
            db.insertQueueEntry({ id: 'task-b', meshId, message: 'second task', status: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

            // Same session: null
            expect(db.claimNextQueueTask(meshId, 'node1', 'sess1')).toBeNull();
            // Same node, different session: null
            expect(db.claimNextQueueTask(meshId, 'node1', 'sess2')).toBeNull();

            __clearMeshQueueForTests(meshId);
        });

        it('prioritizes session-targeted task over unconstrained task', () => {
            const meshId = `mesh-claim-sess-prio-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            db.insertQueueEntry({ id: 'unconstrained-1', meshId, message: 'unconstrained', status: 'pending', createdAt: new Date(Date.now() - 1000).toISOString(), updatedAt: new Date(Date.now() - 1000).toISOString() });
            db.insertQueueEntry({ id: 'session-targeted-1', meshId, message: 'session targeted', status: 'pending', targetSessionId: 'sess-target', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

            const claimed = db.claimNextQueueTask(meshId, 'node1', 'sess-target');
            expect(claimed?.id).toBe('session-targeted-1');
            expect(claimed?.targetSessionId).toBe('sess-target');

            __clearMeshQueueForTests(meshId);
        });

        it('prioritizes node-targeted (no session) over unconstrained', () => {
            const meshId = `mesh-claim-node-prio-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            db.insertQueueEntry({ id: 'unconstrained-2', meshId, message: 'unconstrained', status: 'pending', createdAt: new Date(Date.now() - 1000).toISOString(), updatedAt: new Date(Date.now() - 1000).toISOString() });
            db.insertQueueEntry({ id: 'node-targeted-1', meshId, message: 'node targeted', status: 'pending', targetNodeId: 'node-a', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

            const claimed = db.claimNextQueueTask(meshId, 'node-a', 'sess1');
            expect(claimed?.id).toBe('node-targeted-1');
            expect(claimed?.targetNodeId).toBe('node-a');

            __clearMeshQueueForTests(meshId);
        });

        it('returns null when queue is empty', () => {
            const meshId = `mesh-claim-empty-${randomUUID().slice(0, 8)}`;
            expect(MeshRuntimeStore.getInstance().claimNextQueueTask(meshId, 'node1', 'sess1')).toBeNull();
        });

        // WORKTREE-CLAIM-GATE: a node-pinned task enqueued under the config-form
        // daemon id (`daemon_mach_<hex>`) must still be claimable by a session that
        // stamps the bare stamp-form (`mach_<hex>`) of the SAME machine. The pre-fix
        // SQL pre-filter bound a single `target_node_id = ?` on the stamp-form, so it
        // never SELECTed the config-form row and the worktree session came up empty.
        // Exercises the real claimNextQueueTask path (SQL fetch + JS targetMatches).
        it('claims a node-pinned task enqueued under config-form daemon id with a stamp-form session', () => {
            const meshId = `mesh-claim-idform-${randomUUID().slice(0, 8)}`;
            const core = `mach_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
            const configForm = `daemon_${core}`; // enqueue stamps the coordinator config-form
            const stampForm = core;              // the worktree session stamps the bare form
            const db = MeshRuntimeStore.getInstance();
            db.insertQueueEntry({ id: 'node-pinned-idform', meshId, message: 'pinned to config-form node', status: 'pending', targetNodeId: configForm, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

            const claimed = db.claimNextQueueTask(meshId, stampForm, 'sess-worktree');
            expect(claimed?.id).toBe('node-pinned-idform');
            expect(claimed?.status).toBe('assigned');
            expect(claimed?.assignedNodeId).toBe(stampForm);

            __clearMeshQueueForTests(meshId);
        });

        // The same node-pinned task must still be REJECTED for a session on a
        // DIFFERENT machine — id-form normalization must not collapse distinct cores.
        it('does NOT claim a node-pinned config-form task with a session on a different machine', () => {
            const meshId = `mesh-claim-idform-neg-${randomUUID().slice(0, 8)}`;
            const targetCore = `mach_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
            const otherCore = `mach_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
            const db = MeshRuntimeStore.getInstance();
            db.insertQueueEntry({ id: 'node-pinned-other', meshId, message: 'pinned elsewhere', status: 'pending', targetNodeId: `daemon_${targetCore}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

            // A session on a different machine must not absorb the pinned task.
            expect(db.claimNextQueueTask(meshId, otherCore, 'sess-other')).toBeNull();
            // The original machine (any form) still claims it.
            expect(db.claimNextQueueTask(meshId, targetCore, 'sess-target')?.id).toBe('node-pinned-other');

            __clearMeshQueueForTests(meshId);
        });

        // R3 (a): the node-busy serialization gate must be FORM-AWARE. A write task
        // claimed with an assigned_node_id stamped in the config-form (`daemon_mach_X`)
        // must mark the node busy for a SECOND session that stamps the bare stamp-form
        // (`mach_X`) of the SAME machine. The pre-fix hasActiveNodeAssignment bound a raw
        // `assigned_node_id = ?` on a single form, so it missed the form-variant assigned
        // row, saw the node as idle, and let a second write task claim it — breaking
        // worktree isolation (duplicate claim / base leak). Mirrors the node-pinned
        // SELECT's expandDaemonIdForms IN (...) matching.
        it('marks a node busy across daemon-id forms (form-variant assigned_node_id)', () => {
            const meshId = `mesh-nodebusy-idform-${randomUUID().slice(0, 8)}`;
            const core = `mach_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
            const configForm = `daemon_${core}`; // first claim stamps the config-form
            const stampForm = core;              // a sibling session stamps the bare form
            const db = MeshRuntimeStore.getInstance();
            db.insertQueueEntry({ id: 'w-first', meshId, message: 'write 1', status: 'pending', taskMode: 'code_change', createdAt: new Date(Date.now() - 2000).toISOString(), updatedAt: new Date(Date.now() - 2000).toISOString() });
            db.insertQueueEntry({ id: 'w-second', meshId, message: 'write 2', status: 'pending', taskMode: 'code_change', createdAt: new Date(Date.now() - 1000).toISOString(), updatedAt: new Date(Date.now() - 1000).toISOString() });

            // First write task claimed with the config-form node id → assigned_node_id = daemon_mach_X
            const first = db.claimNextQueueTask(meshId, configForm, 'sess1');
            expect(first?.id).toBe('w-first');
            expect(first?.assignedNodeId).toBe(configForm);

            // A second session on the SAME machine (bare stamp-form) must see the node
            // busy and be blocked — even though the assigned row is in a different form.
            expect(db.claimNextQueueTask(meshId, stampForm, 'sess2')).toBeNull();

            // A session on a DIFFERENT machine is NOT falsely blocked (expansion stays
            // within a single machine core) — it claims the still-pending second task.
            const otherCore = `mach_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
            expect(db.claimNextQueueTask(meshId, otherCore, 'sess3')?.id).toBe('w-second');

            __clearMeshQueueForTests(meshId);
        });
    });

    // ── Read-only concurrent claim (P2: solution A) ──────────────────────────
    // Read-only (live_debug_readonly) tasks carry no isolation/merge cost, so the
    // one-active-per-node invariant is bypassed for them: N read-only tasks may be
    // claimed concurrently on the same node by distinct sessions. Write tasks keep
    // the one-active-per-node invariant (worktree isolation). A single session still
    // executes only one task at a time regardless of mode.
    describe('claimNextQueueTask — read-only concurrent claim', () => {
        afterEach(() => {
            __resetMeshRuntimeStoreForTests();
        });

        const insertReadonly = (db: any, meshId: string, id: string, ageMs: number) => {
            const iso = new Date(Date.now() - ageMs).toISOString();
            db.insertQueueEntry({ id, meshId, message: 'diagnose', status: 'pending', taskMode: 'live_debug_readonly', createdAt: iso, updatedAt: iso });
        };
        const insertWrite = (db: any, meshId: string, id: string, ageMs: number) => {
            const iso = new Date(Date.now() - ageMs).toISOString();
            db.insertQueueEntry({ id, meshId, message: 'edit code', status: 'pending', taskMode: 'code_change', createdAt: iso, updatedAt: iso });
        };

        it('allows N read-only tasks to be claimed concurrently on the same node (gate A bypass)', () => {
            const meshId = `mesh-ro-concurrent-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            insertReadonly(db, meshId, 'ro-1', 3000);
            insertReadonly(db, meshId, 'ro-2', 2000);
            insertReadonly(db, meshId, 'ro-3', 1000);

            const c1 = db.claimNextQueueTask(meshId, 'node1', 'sess1');
            const c2 = db.claimNextQueueTask(meshId, 'node1', 'sess2');
            const c3 = db.claimNextQueueTask(meshId, 'node1', 'sess3');

            expect(c1?.id).toBe('ro-1');
            expect(c2?.id).toBe('ro-2');
            expect(c3?.id).toBe('ro-3');
            // All three are now assigned on the same node.
            const assigned = db.getQueueStatsByStatus(meshId).find((s: any) => s.status === 'assigned');
            expect(assigned?.count).toBe(3);

            __clearMeshQueueForTests(meshId);
        });

        it('still blocks a single session from claiming two tasks at once even for read-only', () => {
            const meshId = `mesh-ro-session-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            insertReadonly(db, meshId, 'ro-a', 2000);
            insertReadonly(db, meshId, 'ro-b', 1000);

            expect(db.claimNextQueueTask(meshId, 'node1', 'sess1')?.id).toBe('ro-a');
            // Same session must not claim a second concurrent task.
            expect(db.claimNextQueueTask(meshId, 'node1', 'sess1')).toBeNull();

            __clearMeshQueueForTests(meshId);
        });

        it('keeps one-active-per-node for write tasks (gate A retained)', () => {
            const meshId = `mesh-write-node-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            insertWrite(db, meshId, 'w-1', 2000);
            insertWrite(db, meshId, 'w-2', 1000);

            const c1 = db.claimNextQueueTask(meshId, 'node1', 'sess1');
            expect(c1?.id).toBe('w-1');
            // Different session, same node: the node is busy with a write task → blocked.
            expect(db.claimNextQueueTask(meshId, 'node1', 'sess2')).toBeNull();

            __clearMeshQueueForTests(meshId);
        });

        it('a write task cannot claim a node already running a read-only task', () => {
            const meshId = `mesh-mixed-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            // Read-only claimed first, then a write task arrives.
            insertReadonly(db, meshId, 'ro-first', 2000);
            const ro = db.claimNextQueueTask(meshId, 'node1', 'sess1');
            expect(ro?.id).toBe('ro-first');

            insertWrite(db, meshId, 'w-after', 1000);
            // The node now has an active (read-only) assignment, so the write task is
            // blocked by the per-candidate node-conflict gate.
            expect(db.claimNextQueueTask(meshId, 'node1', 'sess2')).toBeNull();

            __clearMeshQueueForTests(meshId);
        });

        it('a read-only task can claim a node already running a write task', () => {
            const meshId = `mesh-mixed2-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            insertWrite(db, meshId, 'w-first', 2000);
            const w = db.claimNextQueueTask(meshId, 'node1', 'sess1');
            expect(w?.id).toBe('w-first');

            insertReadonly(db, meshId, 'ro-after', 1000);
            // Read-only bypasses node-busy, so it claims even though a write is running.
            const ro = db.claimNextQueueTask(meshId, 'node1', 'sess2');
            expect(ro?.id).toBe('ro-after');

            __clearMeshQueueForTests(meshId);
        });
    });

    // QUEUE-NODE-SERIALIZATION: the node-conflict gate is now driven by the unified
    // isTaskReadonly predicate, whose explicit boolean axis (readonly: true) is
    // orthogonal to taskMode. These assert that a task flagged read-only via the
    // BOOLEAN (not the legacy live_debug_readonly enum) gets identical scheduling:
    // parallel claim on one node, while a non-readonly task keeps write isolation.
    describe('claimNextQueueTask — readonly boolean axis (predicate unification)', () => {
        afterEach(() => {
            __resetMeshRuntimeStoreForTests();
        });

        // Note: NOT live_debug_readonly — a plain task_mode (or none) plus readonly:true.
        const insertBoolReadonly = (db: any, meshId: string, id: string, ageMs: number) => {
            const iso = new Date(Date.now() - ageMs).toISOString();
            db.insertQueueEntry({ id, meshId, message: 'diagnose', status: 'pending', taskMode: 'validation', readonly: true, createdAt: iso, updatedAt: iso });
        };
        const insertWrite = (db: any, meshId: string, id: string, ageMs: number) => {
            const iso = new Date(Date.now() - ageMs).toISOString();
            db.insertQueueEntry({ id, meshId, message: 'edit code', status: 'pending', taskMode: 'validation', createdAt: iso, updatedAt: iso });
        };

        it('readonly:true tasks claim in parallel on one node (not serialized), even with a non-readonly taskMode', () => {
            const meshId = `mesh-boolro-parallel-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            insertBoolReadonly(db, meshId, 'bro-1', 2000);
            insertBoolReadonly(db, meshId, 'bro-2', 1000);

            const c1 = db.claimNextQueueTask(meshId, 'node1', 'sess1');
            const c2 = db.claimNextQueueTask(meshId, 'node1', 'sess2');
            expect(c1?.id).toBe('bro-1');
            expect(c2?.id).toBe('bro-2');
            const assigned = db.getQueueStatsByStatus(meshId).find((s: any) => s.status === 'assigned');
            expect(assigned?.count).toBe(2);

            __clearMeshQueueForTests(meshId);
        });

        it('the same taskMode WITHOUT readonly:true keeps one-active-per-node write isolation', () => {
            const meshId = `mesh-boolro-iso-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            // Identical taskMode='validation' as the readonly case, but no readonly flag →
            // must be treated as a write task and serialized to one-per-node.
            insertWrite(db, meshId, 'wv-1', 2000);
            insertWrite(db, meshId, 'wv-2', 1000);

            expect(db.claimNextQueueTask(meshId, 'node1', 'sess1')?.id).toBe('wv-1');
            expect(db.claimNextQueueTask(meshId, 'node1', 'sess2')).toBeNull();

            __clearMeshQueueForTests(meshId);
        });
    });

    // ── Per-(node, provider) maxParallel cap (providerRoles) ─────────────────
    // The claim transaction bounds the number of active assignments for a given
    // (node, provider) combination by the providerMaxParallel passed in. The cap
    // is orthogonal to taskMode (it counts both read-only and write tasks) and is
    // a stricter-wins layer on top of the global/node-conflict gates. Omitting
    // providerMaxParallel preserves prior behavior (no per-provider cap).
    describe('claimNextQueueTask — per-(node, provider) maxParallel cap', () => {
        afterEach(() => {
            __resetMeshRuntimeStoreForTests();
        });

        const insertReadonly = (db: any, meshId: string, id: string, ageMs: number) => {
            const iso = new Date(Date.now() - ageMs).toISOString();
            db.insertQueueEntry({ id, meshId, message: 'diagnose', status: 'pending', taskMode: 'live_debug_readonly', createdAt: iso, updatedAt: iso });
        };

        const insertWrite = (db: any, meshId: string, id: string, ageMs: number) => {
            const iso = new Date(Date.now() - ageMs).toISOString();
            db.insertQueueEntry({ id, meshId, message: 'edit', status: 'pending', taskMode: 'code_change', createdAt: iso, updatedAt: iso });
        };

        it('blocks claiming once the (node, provider) active count reaches maxParallel', () => {
            const meshId = `mesh-prov-cap-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            // WRITE tasks, so this measures the cap boundary itself rather than the
            // read-only reservation (asserted separately below). Write claims always
            // see the full declared cap.
            insertWrite(db, meshId, 'w-1', 3000);
            insertWrite(db, meshId, 'w-2', 2000);
            insertWrite(db, meshId, 'w-3', 1000);

            const opts = { providerType: 'claude-cli', providerMaxParallel: 2 };
            // Distinct nodes on ONE daemon: the cap is a machine budget, so all three
            // claims contend for the same 2 slots. (A write task also requires an idle
            // node, hence one node each.)
            const daemonNodeIds = ['node1', 'node2', 'node3'];
            const c1 = db.claimNextQueueTask(meshId, 'node1', 'sess1', [], { ...opts, daemonNodeIds });
            const c2 = db.claimNextQueueTask(meshId, 'node2', 'sess2', [], { ...opts, daemonNodeIds });
            // Third claim on the same (daemon, provider) is over the cap → blocked.
            const c3 = db.claimNextQueueTask(meshId, 'node3', 'sess3', [], { ...opts, daemonNodeIds });

            expect(c1?.id).toBe('w-1');
            expect(c1?.assignedProviderType).toBe('claude-cli');
            expect(c2?.id).toBe('w-2');
            expect(c3).toBeNull();

            __clearMeshQueueForTests(meshId);
        });

        it('reserves the last slot for write work — read-only stops one short of the cap', () => {
            const meshId = `mesh-prov-cap-ro-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            insertReadonly(db, meshId, 'ro-1', 3000);
            insertReadonly(db, meshId, 'ro-2', 2000);

            const opts = { providerType: 'claude-cli', providerMaxParallel: 2 };
            const c1 = db.claimNextQueueTask(meshId, 'node1', 'sess1', [], opts);
            // Read-only may not take the LAST free slot of a cap-2 budget, so that a
            // write task is always reachable within one completion (starvation guard).
            const c2 = db.claimNextQueueTask(meshId, 'node1', 'sess2', [], opts);

            expect(c1?.id).toBe('ro-1');
            expect(c2).toBeNull();

            __clearMeshQueueForTests(meshId);
        });

        it('counts the cap per provider — a different provider on the same node has its own budget', () => {
            const meshId = `mesh-prov-cap-split-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            insertReadonly(db, meshId, 'ro-1', 4000);
            insertReadonly(db, meshId, 'ro-2', 3000);
            insertReadonly(db, meshId, 'ro-3', 2000);

            // claude-cli fills its cap of 1.
            const c1 = db.claimNextQueueTask(meshId, 'node1', 'sess1', [], { providerType: 'claude-cli', providerMaxParallel: 1 });
            expect(c1?.id).toBe('ro-1');
            // A second claude-cli claim is blocked at cap 1.
            expect(db.claimNextQueueTask(meshId, 'node1', 'sess2', [], { providerType: 'claude-cli', providerMaxParallel: 1 })).toBeNull();
            // codex-cli on the SAME node has its own independent budget → claims fine.
            const c3 = db.claimNextQueueTask(meshId, 'node1', 'sess3', [], { providerType: 'codex-cli', providerMaxParallel: 1 });
            expect(c3?.id).toBe('ro-2');
            expect(c3?.assignedProviderType).toBe('codex-cli');

            __clearMeshQueueForTests(meshId);
        });

        it('backward compatible: omitting providerMaxParallel imposes no per-provider cap', () => {
            const meshId = `mesh-prov-cap-none-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            insertReadonly(db, meshId, 'ro-1', 3000);
            insertReadonly(db, meshId, 'ro-2', 2000);
            insertReadonly(db, meshId, 'ro-3', 1000);

            // No providerMaxParallel → read-only concurrent claim is unbounded by provider.
            const c1 = db.claimNextQueueTask(meshId, 'node1', 'sess1', [], { providerType: 'claude-cli' });
            const c2 = db.claimNextQueueTask(meshId, 'node1', 'sess2', [], { providerType: 'claude-cli' });
            const c3 = db.claimNextQueueTask(meshId, 'node1', 'sess3', [], { providerType: 'claude-cli' });
            expect([c1?.id, c2?.id, c3?.id]).toEqual(['ro-1', 'ro-2', 'ro-3']);

            __clearMeshQueueForTests(meshId);
        });

        it('maxParallel:0 blocks all claims for that (node, provider)', () => {
            const meshId = `mesh-prov-cap-zero-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            insertReadonly(db, meshId, 'ro-1', 1000);
            expect(db.claimNextQueueTask(meshId, 'node1', 'sess1', [], { providerType: 'claude-cli', providerMaxParallel: 0 })).toBeNull();
            __clearMeshQueueForTests(meshId);
        });

        it('frees budget when an assigned task reaches a terminal status', () => {
            const meshId = `mesh-prov-cap-free-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            insertReadonly(db, meshId, 'ro-1', 2000);
            insertReadonly(db, meshId, 'ro-2', 1000);

            const opts = { providerType: 'claude-cli', providerMaxParallel: 1 };
            const c1 = db.claimNextQueueTask(meshId, 'node1', 'sess1', [], opts);
            expect(c1?.id).toBe('ro-1');
            // At cap → blocked.
            expect(db.claimNextQueueTask(meshId, 'node1', 'sess2', [], opts)).toBeNull();

            // Complete the first task: it is no longer 'assigned', freeing the budget.
            __writeTaskStatusForTests(meshId, 'ro-1', 'completed');
            const c2 = db.claimNextQueueTask(meshId, 'node1', 'sess2', [], opts);
            expect(c2?.id).toBe('ro-2');

            __clearMeshQueueForTests(meshId);
        });
    });

    describe('findQueueEntryById', () => {
        afterEach(() => {
            __resetMeshRuntimeStoreForTests();
        });

        it('returns entry when found, null for nonexistent', () => {
            const meshId = `mesh-find-by-id-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            const entryId = `entry-${randomUUID().slice(0, 8)}`;
            db.insertQueueEntry({ id: entryId, meshId, message: 'find me', status: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

            const found = db.findQueueEntryById(meshId, entryId);
            expect(found).not.toBeNull();
            expect(found?.message).toBe('find me');

            const notFound = db.findQueueEntryById(meshId, 'nonexistent');
            expect(notFound).toBeNull();

            __clearMeshQueueForTests(meshId);
        });
    });

    describe('findAssignedBySession', () => {
        afterEach(() => {
            __resetMeshRuntimeStoreForTests();
        });

        it('returns the assigned entry for a session', () => {
            const meshId = `mesh-assigned-sess-${randomUUID().slice(0, 8)}`;
            const sessionId = `sess-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            db.insertQueueEntry({ id: 'task-assigned-1', meshId, message: 'assigned task', status: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

            // Claim it so it becomes assigned
            db.claimNextQueueTask(meshId, 'node1', sessionId);

            const found = db.findAssignedBySession(meshId, sessionId);
            expect(found).not.toBeNull();
            expect(found?.status).toBe('assigned');

            const notFound = db.findAssignedBySession(meshId, 'unknown-session');
            expect(notFound).toBeNull();

            __clearMeshQueueForTests(meshId);
        });

        it('C2 clock skew: still resolves the assigned row when occurredAt is behind updated_at', () => {
            // Live bug repro: a remote worker's completion event carries the WORKER's
            // clock; updated_at carries the COORDINATOR's clock. Coordinator-ahead skew
            // makes occurredAt < updated_at. The old `updated_at <= occurredAt` filter
            // returned null here and stranded the finished task as `assigned` forever.
            const meshId = `mesh-assigned-skew-${randomUUID().slice(0, 8)}`;
            const sessionId = `sess-skew-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            db.insertQueueEntry({ id: 'task-skew-1', meshId, message: 'skew task', status: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

            // Claim just now — updatedAt (coordinator clock) = current time
            db.claimNextQueueTask(meshId, 'node1', sessionId);

            // Worker clock 5 minutes behind the coordinator.
            const workerClockIso = new Date(Date.now() - 5 * 60_000).toISOString();
            const found = db.findAssignedBySession(meshId, sessionId, workerClockIso);
            expect(found).not.toBeNull();
            expect(found?.status).toBe('assigned');
            expect(found?.id).toBe('task-skew-1');

            __clearMeshQueueForTests(meshId);
        });

        it('taskId exact match resolves the right row regardless of clock or order', () => {
            const meshId = `mesh-assigned-taskid-${randomUUID().slice(0, 8)}`;
            const sessionId = `sess-taskid-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();

            // Two sequential tasks A then B claimed on the same session. (After A's row
            // is forced terminal, B can be claimed onto the same session.)
            db.insertQueueEntry({ id: 'task-A', meshId, message: 'task A', status: 'pending', createdAt: new Date(Date.now() - 2000).toISOString(), updatedAt: new Date(Date.now() - 2000).toISOString() });
            db.claimNextQueueTask(meshId, 'node1', sessionId);
            const a = db.findQueueEntryById(meshId, 'task-A')!;
            a.status = 'completed';
            db.updateQueueEntry(a);

            db.insertQueueEntry({ id: 'task-B', meshId, message: 'task B', status: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
            db.claimNextQueueTask(meshId, 'node1', sessionId);

            // A late completion carrying taskId=A must NOT match B's assigned row.
            // A is no longer assigned, so the exact-id match yields null and falls
            // through; only B remains assigned so session match would resolve B.
            const byA = db.findAssignedBySession(meshId, sessionId, undefined, 'task-A');
            expect(byA?.id).toBe('task-B'); // A not assigned → fall through to the live assigned row
            const byB = db.findAssignedBySession(meshId, sessionId, undefined, 'task-B');
            expect(byB?.id).toBe('task-B');

            __clearMeshQueueForTests(meshId);
        });

        it('disambiguates multiple assigned rows for one session by immutable dispatchTimestamp', () => {
            const meshId = `mesh-assigned-multi-${randomUUID().slice(0, 8)}`;
            const sessionId = `sess-multi-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();

            // Force two assigned rows on the same session (abnormal but defensive).
            const older = new Date(Date.now() - 60_000).toISOString();
            const newer = new Date().toISOString();
            db.insertQueueEntry({ id: 'multi-old', meshId, message: 'old', status: 'assigned', assignedSessionId: sessionId, assignedNodeId: 'node1', dispatchTimestamp: older, createdAt: older, updatedAt: older });
            db.insertQueueEntry({ id: 'multi-new', meshId, message: 'new', status: 'assigned', assignedSessionId: sessionId, assignedNodeId: 'node1', dispatchTimestamp: newer, createdAt: newer, updatedAt: newer });

            // occurredAt between the two dispatches → latest dispatchTimestamp <= occurredAt = old.
            const between = new Date(Date.now() - 30_000).toISOString();
            expect(db.findAssignedBySession(meshId, sessionId, between)?.id).toBe('multi-old');

            // occurredAt before BOTH dispatches (severe skew) → fall back to most-recent dispatch.
            const beforeBoth = new Date(Date.now() - 120_000).toISOString();
            expect(db.findAssignedBySession(meshId, sessionId, beforeBoth)?.id).toBe('multi-new');

            __clearMeshQueueForTests(meshId);
        });
    });

    describe('getQueueStatsByStatus', () => {
        afterEach(() => {
            __resetMeshRuntimeStoreForTests();
        });

        it('returns accurate counts by status via SQL GROUP BY', () => {
            const meshId = `mesh-stats-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            const now = new Date().toISOString();

            // Insert 3 tasks
            db.insertQueueEntry({ id: 'stats-t1', meshId, message: 'task 1', status: 'pending', createdAt: now, updatedAt: now });
            db.insertQueueEntry({ id: 'stats-t2', meshId, message: 'task 2', status: 'pending', createdAt: now, updatedAt: now });
            db.insertQueueEntry({ id: 'stats-t3', meshId, message: 'task 3', status: 'pending', createdAt: now, updatedAt: now });

            // Cancel one via direct update
            const t2 = db.findQueueEntryById(meshId, 'stats-t2')!;
            t2.status = 'cancelled';
            db.updateQueueEntry(t2);

            // Assign one via claim
            db.claimNextQueueTask(meshId, 'node1', 'sess1');

            // t1 should now be assigned (oldest pending), t2 cancelled, t3 still pending
            const stats = db.getQueueStatsByStatus(meshId);
            const sorted = [...stats].sort((a, b) => a.status.localeCompare(b.status));
            expect(sorted).toContainEqual({ status: 'assigned', count: 1 });
            expect(sorted).toContainEqual({ status: 'cancelled', count: 1 });
            expect(sorted).toContainEqual({ status: 'pending', count: 1 });

            __clearMeshQueueForTests(meshId);
        });

        it('returns empty array for a mesh with no tasks', () => {
            const stats = MeshRuntimeStore.getInstance().getQueueStatsByStatus('empty-mesh-xyz-never-used');
            expect(stats).toEqual([]);
        });
    });

    describe('getActiveAssignmentDetails', () => {
        afterEach(() => {
            __resetMeshRuntimeStoreForTests();
        });

        it('returns node, session, and message for assigned tasks', () => {
            const meshId = `mesh-active-details-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            const now = new Date().toISOString();
            db.insertQueueEntry({ id: 'detail-t1', meshId, message: 'task message', status: 'pending', createdAt: new Date(Date.now() - 1000).toISOString(), updatedAt: new Date(Date.now() - 1000).toISOString() });
            db.insertQueueEntry({ id: 'detail-t2', meshId, message: 'pending task', status: 'pending', createdAt: now, updatedAt: now });

            db.claimNextQueueTask(meshId, 'node-x', 'sess-x');

            const details = db.getActiveAssignmentDetails(meshId);
            expect(details).toHaveLength(1);
            expect(details[0].nodeId).toBe('node-x');
            expect(details[0].sessionId).toBe('sess-x');
            expect(details[0].message).toBe('task message');

            __clearMeshQueueForTests(meshId);
        });
    });

    describe('insertQueueEntry + updateQueueEntry round-trip', () => {
        afterEach(() => {
            __resetMeshRuntimeStoreForTests();
        });

        it('insertQueueEntry persists and updateQueueEntry modifies in place', () => {
            const meshId = `mesh-roundtrip-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            const entryId = `roundtrip-${randomUUID().slice(0, 8)}`;
            const now = new Date().toISOString();

            db.insertQueueEntry({ id: entryId, meshId, message: 'update me', status: 'pending', createdAt: now, updatedAt: now });

            const before = db.findQueueEntryById(meshId, entryId);
            expect(before?.status).toBe('pending');

            before!.status = 'completed';
            before!.updatedAt = new Date().toISOString();
            db.updateQueueEntry(before!);

            const after = db.findQueueEntryById(meshId, entryId);
            expect(after?.status).toBe('completed');

            __clearMeshQueueForTests(meshId);
        });
    });

    describe('Phase E1: queue retry cap', () => {
        afterEach(() => {
            __resetMeshRuntimeStoreForTests();
            __clearMeshQueueForTests();
        });

        it('E1.1 — requeueTask fails task when requeueCount reaches maxRetries (default 1)', () => {
            const meshId = `mesh-e1-cap-${randomUUID().slice(0, 8)}`;
            const task = enqueueTask(meshId, 'test task', { difficulty: 'medium' });
            claimNextTask(meshId, 'node-1', 'sess-1');

            // First requeue: count 0 → 1 (under cap, succeeds)
            const first = requeueTask(meshId, task.id);
            expect(first!.status).toBe('pending');
            expect(first!.requeueCount).toBe(1);

            // Re-claim so we can requeue again
            claimNextTask(meshId, 'node-1', 'sess-1');

            // Second requeue: requeueCount is already 1, which equals maxRetries=1 → should fail
            const result = requeueTask(meshId, task.id);
            expect(result).not.toBeNull();
            expect(result!.status).toBe('failed');
            expect(result!.cancelReason).toMatch(/max_retries_exceeded/);
        });

        it('E1.2 — requeueTask succeeds when under cap', () => {
            const meshId = `mesh-e1-under-${randomUUID().slice(0, 8)}`;
            const task = enqueueTask(meshId, 'test task', { difficulty: 'medium' });
            claimNextTask(meshId, 'node-1', 'sess-1');

            // maxRetries=2: first requeue should succeed (0 → 1 < 2)
            const result = requeueTask(meshId, task.id, { maxRetries: 2 });
            expect(result).not.toBeNull();
            expect(result!.status).toBe('pending');
            expect(result!.requeueCount).toBe(1);
        });

        it('E1.3 — force=true bypasses retry cap', () => {
            const meshId = `mesh-e1-force-${randomUUID().slice(0, 8)}`;
            const task = enqueueTask(meshId, 'test task', { difficulty: 'medium' });
            claimNextTask(meshId, 'node-1', 'sess-1');

            // Exhaust cap: requeue until failed
            requeueTask(meshId, task.id);              // 0→1, pending
            claimNextTask(meshId, 'node-1', 'sess-1');
            const failed = requeueTask(meshId, task.id); // 1>=1, failed
            expect(failed!.status).toBe('failed');

            // Manual requeue with force=true should succeed despite failed status
            const forcedResult = requeueTask(meshId, task.id, { force: true });
            expect(forcedResult).not.toBeNull();
            expect(forcedResult!.status).toBe('pending');
        });

        it('E1.4 — failed task from cap has descriptive cancelReason', () => {
            const meshId = `mesh-e1-reason-${randomUUID().slice(0, 8)}`;
            const task = enqueueTask(meshId, 'test task', { difficulty: 'medium' });
            claimNextTask(meshId, 'node-1', 'sess-1');

            // First requeue succeeds (0 < 1)
            requeueTask(meshId, task.id, { maxRetries: 1 });
            claimNextTask(meshId, 'node-1', 'sess-1');

            // Second requeue hits cap (1 >= 1)
            const result = requeueTask(meshId, task.id, { maxRetries: 1 });
            expect(result!.status).toBe('failed');
            expect(result!.cancelReason).toContain('1');  // shows the cap value
        });
    });

    // ── Phase C1: mesh tool call rate limit ──────────────────────────────────

    describe('Phase C1: mesh_tool_call_log rate guard', () => {
        afterEach(() => {
            __resetMeshRuntimeStoreForTests();
        });

        it('C1.1 — returns no advisory when under the call limit', () => {
            const meshId = `mesh-c1-ok-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            for (let i = 0; i < 5; i++) {
                const result = db.recordMeshToolCall({ meshId, tool: 'mesh_status', windowMs: 10_000, maxCalls: 5 });
                expect(result.rateLimitExceeded).toBe(false);
                expect(result.advisory).toBeNull();
            }
        });

        it('C1.2 — returns advisory and rateLimitExceeded when over the limit', () => {
            const meshId = `mesh-c1-over-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            for (let i = 0; i < 5; i++) {
                db.recordMeshToolCall({ meshId, tool: 'mesh_status', windowMs: 10_000, maxCalls: 5 });
            }
            const result = db.recordMeshToolCall({ meshId, tool: 'mesh_status', windowMs: 10_000, maxCalls: 5 });
            expect(result.rateLimitExceeded).toBe(true);
            expect(result.callsInWindow).toBeGreaterThan(5);
            expect(typeof result.advisory).toBe('string');
            expect(result.advisory).toContain('mesh_status');
        });

        it('C1.3 — different tools have independent windows', () => {
            const meshId = `mesh-c1-sep-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            for (let i = 0; i < 6; i++) {
                db.recordMeshToolCall({ meshId, tool: 'mesh_status', windowMs: 10_000, maxCalls: 5 });
            }
            const queueResult = db.recordMeshToolCall({ meshId, tool: 'mesh_view_queue', windowMs: 10_000, maxCalls: 5 });
            expect(queueResult.rateLimitExceeded).toBe(false);
        });

        it('C1.4 — different mesh IDs have independent windows', () => {
            const meshId1 = `mesh-c1-m1-${randomUUID().slice(0, 8)}`;
            const meshId2 = `mesh-c1-m2-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            for (let i = 0; i < 6; i++) {
                db.recordMeshToolCall({ meshId: meshId1, tool: 'mesh_status', windowMs: 10_000, maxCalls: 5 });
            }
            const result = db.recordMeshToolCall({ meshId: meshId2, tool: 'mesh_status', windowMs: 10_000, maxCalls: 5 });
            expect(result.rateLimitExceeded).toBe(false);
        });
    });

    // ── Phase G2: Event Ledger SQLite ────────────────────────────────────────

    describe('Phase G2: mesh_event_ledger table', () => {
        afterEach(() => {
            __resetMeshRuntimeStoreForTests();
        });

        it('G2.1 — appendLedgerEntry persists and readLedgerEntries returns it', () => {
            const meshId = `mesh-g2-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            const id = randomUUID();
            db.appendLedgerEntry({
                id,
                meshId,
                timestamp: new Date().toISOString(),
                kind: 'task_completed',
                nodeId: 'node-1',
                sessionId: 'sess-1',
                providerType: 'claude-cli',
                payload: { taskId: 'task-1' },
            });
            const entries = db.readLedgerEntries(meshId, { tail: 10 });
            expect(entries).toHaveLength(1);
            expect(entries[0].id).toBe(id);
            expect(entries[0].kind).toBe('task_completed');
            expect((entries[0].payload as any).taskId).toBe('task-1');
        });

        it('G2.2 — duplicate id insert is silently ignored', () => {
            const meshId = `mesh-g2-dedup-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            const id = randomUUID();
            const entry = { id, meshId, timestamp: new Date().toISOString(), kind: 'task_dispatched', payload: {} };
            db.appendLedgerEntry(entry);
            db.appendLedgerEntry(entry);
            expect(db.ledgerEntryCount(meshId)).toBe(1);
        });

        it('G2.3 — importLedgerEntries skips existing ids', () => {
            const meshId = `mesh-g2-import-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            const now = new Date().toISOString();
            const entries = [
                { id: randomUUID(), meshId, timestamp: now, kind: 'task_dispatched', payload: {} },
                { id: randomUUID(), meshId, timestamp: now, kind: 'task_completed', payload: {} },
            ];
            const first = db.importLedgerEntries(entries);
            expect(first).toBe(2);
            const second = db.importLedgerEntries(entries); // same ids — should all skip
            expect(second).toBe(0);
            expect(db.ledgerEntryCount(meshId)).toBe(2);
        });

        it('G2.4 — readLedgerEntries kind filter works', () => {
            const meshId = `mesh-g2-kind-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            const now = new Date().toISOString();
            db.appendLedgerEntry({ id: randomUUID(), meshId, timestamp: now, kind: 'task_dispatched', payload: {} });
            db.appendLedgerEntry({ id: randomUUID(), meshId, timestamp: now, kind: 'task_completed', payload: {} });
            db.appendLedgerEntry({ id: randomUUID(), meshId, timestamp: now, kind: 'task_failed', payload: {} });
            const completed = db.readLedgerEntries(meshId, { kind: 'task_completed' });
            expect(completed).toHaveLength(1);
            expect(completed[0].kind).toBe('task_completed');
        });
    });

    // ── Phase G3 residue: the pending-events store retired with C-W3 (notices
    // are turn_events rows); only the ledger kind invariant test remains here.

    describe('Phase G3: ledger kind invariant', () => {
        afterEach(() => {
            __resetMeshRuntimeStoreForTests();
        });

        it('G3.7 — appendLedgerEntry / importLedgerEntries reject a blank kind (schema invariant)', () => {
            const meshId = `mesh-g3-blankkind-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            // Direct append with empty kind is refused (no row written).
            db.appendLedgerEntry({ id: randomUUID(), meshId, timestamp: new Date().toISOString(), kind: '' });
            db.appendLedgerEntry({ id: randomUUID(), meshId, timestamp: new Date().toISOString(), kind: '   ' });
            // Import path skips blank-kind entries but imports valid ones from the same batch.
            const imported = db.importLedgerEntries([
                { id: randomUUID(), meshId, timestamp: new Date().toISOString(), kind: '' },
                { id: randomUUID(), meshId, timestamp: new Date().toISOString(), kind: 'task_dispatched' },
            ]);
            expect(imported).toBe(1);
            expect(db.readLedgerEntriesOrdered(meshId).every(e => !!e.kind)).toBe(true);
        });
    });

    describe('counter independence (F3) — WAL checkpoint vs tool-call-log sweep', () => {
        // Regression guard: these two periodic chores ran off ONE shared counter, so
        // each one's write volume advanced the other's threshold and the cadences drifted.
        // They must increment fully independent counters.
        it('recordMeshToolCall advances only toolCallLogCounter, never walWriteCounter', () => {
            const db = MeshRuntimeStore.getInstance() as any;
            const walBefore = db.walWriteCounter;
            const toolBefore = db.toolCallLogCounter;
            db.recordMeshToolCall({ meshId: 'mesh-f3', tool: 'mesh_status' });
            db.recordMeshToolCall({ meshId: 'mesh-f3', tool: 'mesh_status' });
            expect(db.toolCallLogCounter).toBe(toolBefore + 2); // dedicated counter advanced
            expect(db.walWriteCounter).toBe(walBefore);          // WAL cadence untouched
        });

        it('a WAL-checkpointing write advances only walWriteCounter, never toolCallLogCounter', () => {
            const db = MeshRuntimeStore.getInstance() as any;
            const walBefore = db.walWriteCounter;
            const toolBefore = db.toolCallLogCounter;
            db.insertQueueEntry({ id: `t-f3-${randomUUID()}`, meshId: 'mesh-wal', message: 'm', status: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); // calls maybeCheckpointWal
            expect(db.walWriteCounter).toBe(walBefore + 1);      // WAL counter advanced
            expect(db.toolCallLogCounter).toBe(toolBefore);      // tool-log cadence untouched
        });
    });

    // MESH-ISOLATION-LEAK: remote_idle_sessions and mesh_completion_fingerprints used to
    // lack a mesh_id column. A machine that belongs to two meshes (two repos) with a
    // SHARED nodeId could then have mesh B claim mesh A's idle session, or mesh A's
    // completion suppress mesh B's dedup. These tests pin the per-mesh isolation.
    describe('mesh isolation (mesh_id scoping)', () => {
        const MESH_A = 'mesh_aaaaaaaa';
        const MESH_B = 'mesh_bbbbbbbb';
        const SHARED_NODE = 'node_shared_1'; // same nodeId present in BOTH meshes

        it('remote_idle_sessions: a shared nodeId does NOT let mesh B see mesh A\'s idle session', () => {
            const db = MeshRuntimeStore.getInstance();
            db.setRemoteIdleSession(MESH_A, SHARED_NODE, 'sess-a', 'claude-cli', Date.now() + 60_000);
            db.setRemoteIdleSession(MESH_B, SHARED_NODE, 'sess-b', 'claude-cli', Date.now() + 60_000);

            const a = db.getRemoteIdleSessions(MESH_A);
            const b = db.getRemoteIdleSessions(MESH_B);

            // Each mesh sees ONLY its own session even though the nodeId collides.
            expect(a.map(s => s.sessionId)).toEqual(['sess-a']);
            expect(b.map(s => s.sessionId)).toEqual(['sess-b']);
            // No cross-claim: mesh B's read never surfaces mesh A's session.
            expect(b.some(s => s.sessionId === 'sess-a')).toBe(false);
            expect(a.some(s => s.sessionId === 'sess-b')).toBe(false);
        });

        it('remote_idle_sessions: deleting in mesh A leaves mesh B\'s same-node session intact', () => {
            const db = MeshRuntimeStore.getInstance();
            db.setRemoteIdleSession(MESH_A, SHARED_NODE, 'sess-a', 'claude-cli', Date.now() + 60_000);
            db.setRemoteIdleSession(MESH_B, SHARED_NODE, 'sess-b', 'claude-cli', Date.now() + 60_000);

            db.deleteRemoteIdleSession(MESH_A, SHARED_NODE, 'sess-a');

            expect(db.getRemoteIdleSessions(MESH_A)).toEqual([]);
            expect(db.getRemoteIdleSessions(MESH_B).map(s => s.sessionId)).toEqual(['sess-b']);
        });

        it('remote_idle_sessions: an entry past its own expiresAt is never returned as a live candidate', () => {
            // CLAIM-RETRY-LOOP-LIFECYCLE (M-MESH-INFRA-0829 defect 5, evidence 4): expiry
            // pruning used to be a side effect of processing a NEW agent:ready event only —
            // no periodic timer. A node whose worker never sends another agent:ready (broken
            // bootstrap, removed node) left its row past its 5-minute TTL forever, and the
            // auto-launch drain kept reading it as claimable, re-logging the bootstrap-gate
            // warning every ~4s for hours. getRemoteIdleSessions must enforce its own row's
            // expiresAt rather than relying on prune-on-agent:ready to have already run.
            const db = MeshRuntimeStore.getInstance()
            const meshId = 'mesh_expiry_check'
            db.setRemoteIdleSession(meshId, 'node_stuck', 'sess-stuck', 'claude-cli', Date.now() - 1_000)
            db.setRemoteIdleSession(meshId, 'node_live', 'sess-live', 'claude-cli', Date.now() + 60_000)

            const rows = db.getRemoteIdleSessions(meshId)

            expect(rows.map(s => s.sessionId)).toEqual(['sess-live'])
            expect(rows.some(s => s.sessionId === 'sess-stuck')).toBe(false)
        })

    });

    // ── MESH-COMPLEXITY-AUDIT Part 8-1: legacy mesh_direct_delivered_events DROP ──
    // The retired R3 direct-delivered dedup marker left a dormant table behind. The
    // migration drops it once; a fresh store never had it. Both cases must end with
    // the table absent, and re-running the migration must stay a safe no-op.
    describe('Part 8-1: mesh_direct_delivered_events drop migration', () => {
        afterEach(() => {
            __resetMeshRuntimeStoreForTests();
        });

        const tableExists = (db: any): boolean => {
            // The better-sqlite3 handle is a private field; peek at it for the schema assertion.
            const row = (db as any).db
                .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='mesh_direct_delivered_events'`)
                .get();
            return row !== undefined;
        };

        it('drops a legacy mesh_direct_delivered_events table left in an existing store', () => {
            const Database = runtimeRequire('better-sqlite3') as any;
            const ledgerDir = join(testConfigDir, 'mesh-ledger');
            mkdirSync(ledgerDir, { recursive: true });
            const dbPath = join(ledgerDir, 'mesh-runtime.db');

            // Simulate an old install: create the store file with the dormant table present.
            const legacyDb = new Database(dbPath);
            legacyDb.exec(`
                CREATE TABLE mesh_direct_delivered_events (
                    coordinator_daemon_id TEXT NOT NULL,
                    fingerprint TEXT NOT NULL,
                    expires_at INTEGER NOT NULL
                );
            `);
            legacyDb.prepare('INSERT INTO mesh_direct_delivered_events VALUES (?, ?, ?)')
                .run('daemon-x', 'fp-1', Date.now() + 60_000);
            legacyDb.close();

            // Opening the store runs the migration, which drops the table.
            const db = MeshRuntimeStore.getInstance();
            expect(tableExists(db)).toBe(false);
        });

        it('is a no-op for a fresh store that never had the table', () => {
            const db = MeshRuntimeStore.getInstance();
            expect(tableExists(db)).toBe(false);
        });

        it('is idempotent: re-running the migration does not throw and keeps the table absent', () => {
            const db = MeshRuntimeStore.getInstance();
            // migrateMeshIsolationColumns is private but re-runnable; invoke via the same
            // path a second boot would (safe because every step is IF-EXISTS guarded).
            expect(() => (db as any).migrateMeshIsolationColumns()).not.toThrow();
            expect(tableExists(db)).toBe(false);
        });
    });

    // ── MESH-TOOL-CALL-CALLER-INSTRUMENTATION (1단계) ──────────────────────────────
    // recordMeshToolCall previously received only {meshId, tool} at every real call
    // site, so mesh_tool_call_log.session_id was NULL on all 48 observed rows — "who
    // called this" was unknowable, not merely absent. This wires sessionId/callerRole
    // through and proves the two classes land distinguishably in the row itself.
    describe('MESH-TOOL-CALL-CALLER-INSTRUMENTATION: caller_role / session_id recording', () => {
        it('records callerRole "coordinator" with the session id when both are supplied', () => {
            const db = MeshRuntimeStore.getInstance();
            const meshId = `mesh-caller-${randomUUID()}`;
            const sessionId = `sess-${randomUUID()}`;

            db.recordMeshToolCall({ meshId, tool: 'mesh_status', sessionId, callerRole: 'coordinator' });

            const [row] = db.getRecentToolCalls(meshId, 1);
            expect(row.sessionId).toBe(sessionId);
            expect(row.callerRole).toBe('coordinator');
        });

        it('records callerRole "unknown" with a null session id when the coordinator session id is absent', () => {
            const db = MeshRuntimeStore.getInstance();
            const meshId = `mesh-caller-${randomUUID()}`;

            db.recordMeshToolCall({ meshId, tool: 'mesh_view_queue', sessionId: null, callerRole: 'unknown' });

            const [row] = db.getRecentToolCalls(meshId, 1);
            expect(row.sessionId).toBeNull();
            expect(row.callerRole).toBe('unknown');
        });

        it('distinguishes coordinator and unknown calls to the same tool within one mesh', () => {
            const db = MeshRuntimeStore.getInstance();
            const meshId = `mesh-caller-${randomUUID()}`;
            const sessionId = `sess-${randomUUID()}`;

            db.recordMeshToolCall({ meshId, tool: 'mesh_graph_view', sessionId, callerRole: 'coordinator' });
            db.recordMeshToolCall({ meshId, tool: 'mesh_graph_view', sessionId: null, callerRole: 'unknown' });
            db.recordMeshToolCall({ meshId, tool: 'mesh_graph_view', sessionId, callerRole: 'coordinator' });

            const rows = db.getRecentToolCalls(meshId, 10);
            expect(rows).toHaveLength(3);
            const coordinatorRows = rows.filter(r => r.callerRole === 'coordinator');
            const unknownRows = rows.filter(r => r.callerRole === 'unknown');
            expect(coordinatorRows).toHaveLength(2);
            expect(coordinatorRows.every(r => r.sessionId === sessionId)).toBe(true);
            expect(unknownRows).toHaveLength(1);
            expect(unknownRows[0].sessionId).toBeNull();
        });

        it('defaults callerRole/sessionId to null when omitted (back-compat with pre-instrumentation callers)', () => {
            const db = MeshRuntimeStore.getInstance();
            const meshId = `mesh-caller-${randomUUID()}`;

            db.recordMeshToolCall({ meshId, tool: 'mesh_status' });

            const [row] = db.getRecentToolCalls(meshId, 1);
            expect(row.sessionId).toBeNull();
            expect(row.callerRole).toBeNull();
        });

        it('does not regress the sliding-window rate-limit guard now that extra columns are written', () => {
            const db = MeshRuntimeStore.getInstance();
            const meshId = `mesh-caller-${randomUUID()}`;

            let last;
            for (let i = 0; i < 6; i++) {
                last = db.recordMeshToolCall({
                    meshId,
                    tool: 'mesh_status',
                    sessionId: `sess-${i}`,
                    callerRole: 'coordinator',
                    windowMs: 10_000,
                    maxCalls: 5,
                });
            }
            expect(last!.rateLimitExceeded).toBe(true);
            expect(last!.callsInWindow).toBe(6);
            expect(last!.advisory).toContain('Rate limit');
        });

        it('ALTER TABLE migration adds caller_role to a pre-existing mesh_tool_call_log without one', () => {
            const meshId = `mesh-caller-legacy-${randomUUID()}`;
            {
                // Simulate a pre-instrumentation DB: CREATE the legacy 4-column table
                // directly so the migration path (not the fresh-CREATE path) is exercised.
                const Database = runtimeRequire('better-sqlite3') as any;
                const ledgerDir = join(testConfigDir, 'mesh-ledger');
                mkdirSync(ledgerDir, { recursive: true });
                const dbPath = join(ledgerDir, 'mesh-runtime.db');
                const legacyDb = new Database(dbPath);
                legacyDb.exec(`
                    CREATE TABLE mesh_tool_call_log (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        mesh_id TEXT NOT NULL,
                        tool TEXT NOT NULL,
                        session_id TEXT,
                        called_at INTEGER NOT NULL
                    );
                `);
                legacyDb.prepare('INSERT INTO mesh_tool_call_log (mesh_id, tool, session_id, called_at) VALUES (?, ?, ?, ?)')
                    .run(meshId, 'mesh_status', null, Date.now());
                legacyDb.close();
            }

            const db = MeshRuntimeStore.getInstance(); // init runs the migration
            const rows = db.getRecentToolCalls(meshId, 10);
            expect(rows).toHaveLength(1);
            // Pre-existing row predates the migration — unclassified, not "observed unknown".
            expect(rows[0].callerRole).toBeNull();

            db.recordMeshToolCall({ meshId, tool: 'mesh_status', sessionId: null, callerRole: 'unknown' });
            const rowsAfter = db.getRecentToolCalls(meshId, 10);
            expect(rowsAfter).toHaveLength(2);
            expect(rowsAfter[0].callerRole).toBe('unknown'); // most recent first
        });
    });

    // ── MESH-COMPLEXITY-AUDIT Part 8-1: stray root mesh-runtime.db hygiene ────────
    // A 0-byte mesh-runtime.db under the config root (NOT the canonical mesh-ledger
    // path) is a dead file an older build left behind. Store init removes it, but only
    // when it is provably that stray: empty and off the canonical path.
    describe('Part 8-1: stray root mesh-runtime.db cleanup', () => {
        afterEach(() => {
            __resetMeshRuntimeStoreForTests();
        });

        it('removes a 0-byte stray mesh-runtime.db at the config root on store init', () => {
            const { writeFileSync } = runtimeRequire('fs');
            const strayPath = join(testConfigDir, 'mesh-runtime.db');
            writeFileSync(strayPath, ''); // 0 bytes
            expect(existsSync(strayPath)).toBe(true);

            MeshRuntimeStore.getInstance(); // init triggers cleanup
            expect(existsSync(strayPath)).toBe(false);
        });

        it('leaves a NON-empty root mesh-runtime.db untouched (safety belt)', () => {
            const { writeFileSync } = runtimeRequire('fs');
            const strayPath = join(testConfigDir, 'mesh-runtime.db');
            writeFileSync(strayPath, 'not empty'); // non-zero → must not be deleted
            expect(existsSync(strayPath)).toBe(true);

            MeshRuntimeStore.getInstance();
            expect(existsSync(strayPath)).toBe(true);
        });

        it('never deletes the canonical mesh-ledger store file', () => {
            const db = MeshRuntimeStore.getInstance();
            db.insertQueueEntry({ id: `t-canon-${randomUUID()}`, meshId: 'mesh-canonical', message: 'm', status: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any);
            const canonicalPath = join(testConfigDir, 'mesh-ledger', 'mesh-runtime.db');
            expect(existsSync(canonicalPath)).toBe(true);
            // Re-resolve the path (which runs cleanup) by re-opening a fresh instance.
            __resetMeshRuntimeStoreForTests();
            MeshRuntimeStore.getInstance();
            expect(existsSync(canonicalPath)).toBe(true);
        });
    });
});
