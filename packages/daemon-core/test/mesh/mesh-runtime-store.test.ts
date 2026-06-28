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
}));

import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import {
    insertDirectDispatch,
    getActiveDirectDispatches,
    updateDirectDispatchStatus,
    markStaleDirectDispatches,
    cleanupTerminalDirectDispatches,
    deleteDirectDispatchesByTaskId,
    __resetMeshRuntimeStoreForTests,
    enqueueTask,
    claimNextTask,
    getQueue,
    getMeshQueueStats,
    cancelTask,
    requeueTask,
    updateTaskStatus,
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

    describe('completion fingerprints', () => {
        it('migrates an existing beads.db file to mesh-runtime.db on first open', () => {
            const Database = runtimeRequire('better-sqlite3') as any;
            const ledgerDir = join(testConfigDir, 'mesh-ledger');
            mkdirSync(ledgerDir, { recursive: true });
            const legacyDbPath = join(ledgerDir, 'beads.db');
            const nextDbPath = join(ledgerDir, 'mesh-runtime.db');
            const fingerprint = `legacy-fp-${randomUUID()}`;

            const legacyDb = new Database(legacyDbPath);
            legacyDb.exec(`
                CREATE TABLE mesh_completion_fingerprints (
                    fingerprint TEXT PRIMARY KEY,
                    expires_at INTEGER NOT NULL
                );
            `);
            legacyDb.prepare('INSERT INTO mesh_completion_fingerprints (fingerprint, expires_at) VALUES (?, ?)')
                .run(fingerprint, Date.now() + 60_000);
            legacyDb.close();

            const db = MeshRuntimeStore.getInstance();
            expect(existsSync(legacyDbPath)).toBe(false);
            expect(existsSync(nextDbPath)).toBe(true);
            // The legacy row had no '::' in its fingerprint, so the isolation migration
            // backfills mesh_id to '' — query under that scope.
            expect(db.hasCompletionFingerprint('', fingerprint)).toBe(true);
        });

        it('hasCompletionFingerprint returns false for unknown fingerprint', () => {
            const db = MeshRuntimeStore.getInstance();
            expect(db.hasCompletionFingerprint('mesh-x', 'unknown-fingerprint-xyz')).toBe(false);
        });

        it('recordCompletionFingerprint and hasCompletionFingerprint round-trip', () => {
            const db = MeshRuntimeStore.getInstance();
            const fp = `fp-valid-${randomUUID()}`;
            db.recordCompletionFingerprint('mesh-rt', fp, 60_000); // 60s TTL — valid
            expect(db.hasCompletionFingerprint('mesh-rt', fp)).toBe(true);

            // Expired fingerprint: ttlMs = -1000 means expires_at = now - 1000 (already in the past)
            const expiredFp = `fp-expired-${randomUUID()}`;
            db.recordCompletionFingerprint('mesh-rt', expiredFp, -1000);
            // The SELECT filters WHERE expires_at > now, so expired entry returns false
            expect(db.hasCompletionFingerprint('mesh-rt', expiredFp)).toBe(false);
        });

        it('fingerprintSweepCounter clears expired entries every 100 reads', () => {
            const db = MeshRuntimeStore.getInstance();
            const fp = `fp-sweep-${randomUUID()}`;

            // Record a fingerprint that is already expired (negative TTL)
            db.recordCompletionFingerprint('mesh-sweep', fp, -1000);

            // Call hasCompletionFingerprint 100 times.
            // Each call: returns false (expired) but the 100th call triggers sweepExpiredFingerprints().
            // The first 99 reads increment the counter but don't sweep.
            // The 100th read resets the counter to 0 and runs DELETE WHERE expires_at <= now.
            for (let i = 0; i < 100; i++) {
                expect(db.hasCompletionFingerprint('mesh-sweep', fp)).toBe(false);
            }

            // After the sweep, the expired row is gone. Verify by recording a fresh valid fingerprint
            // and checking a subsequent sweepExpiredFingerprints() doesn't touch it.
            const validFp = `fp-valid-after-sweep-${randomUUID()}`;
            db.recordCompletionFingerprint('mesh-sweep', validFp, 60_000);
            db.sweepExpiredFingerprints();
            expect(db.hasCompletionFingerprint('mesh-sweep', validFp)).toBe(true);
        });
    });

    describe('insertDirectDispatch and getActiveDirectDispatches lifecycle', () => {
        it('insert → get → update to completed lifecycle', () => {
            const meshId = `mesh-lifecycle-${randomUUID().slice(0, 8)}`;
            const sessionId = `sess-${randomUUID()}`;

            insertDirectDispatch(meshId, {
                taskId: randomUUID(),
                nodeId: 'node-1',
                sessionId,
                message: 'do something',
                via: 'p2p',
                dispatchedAt: new Date().toISOString(),
            });

            // Should appear in active dispatches
            let active = getActiveDirectDispatches(meshId);
            expect(active).toHaveLength(1);
            expect(active[0].sessionId).toBe(sessionId);
            expect(active[0].status).toBe('dispatched');

            // Update to acked — still active (acked = session started generating)
            updateDirectDispatchStatus(meshId, sessionId, 'acked');
            active = getActiveDirectDispatches(meshId);
            expect(active).toHaveLength(1);
            expect(active[0].status).toBe('acked');

            // Update to completed — no longer active
            updateDirectDispatchStatus(meshId, sessionId, 'completed');
            active = getActiveDirectDispatches(meshId);
            expect(active).toHaveLength(0);
        });
    });

    describe('CANON-B: updateDirectDispatchStatus taskId-targeted status flips', () => {
        // A single session can host several sequential direct dispatches (re-dispatch / nudge).
        // mesh_direct_dispatches is keyed by task_id (PK), but flipping status by session_id
        // alone hits EVERY non-terminal row for the session — flipping a sibling's row and
        // stranding the task whose event actually fired. Targeting by taskId fixes that.
        it('flips only the matching task_id row when a taskId is given, leaving the sibling active', () => {
            const meshId = `mesh-canonb-${randomUUID().slice(0, 8)}`;
            const sessionId = `sess-shared-${randomUUID()}`;
            const taskA = `task-a-${randomUUID()}`;
            const taskB = `task-b-${randomUUID()}`;

            // Two dispatches to the SAME session: A dispatched earlier, B the re-dispatch.
            insertDirectDispatch(meshId, { taskId: taskA, sessionId, message: 'task-a', via: 'p2p', dispatchedAt: new Date(Date.now() - 1000).toISOString() });
            insertDirectDispatch(meshId, { taskId: taskB, sessionId, message: 'task-b', via: 'p2p', dispatchedAt: new Date().toISOString() });

            // B's generating_started acks ONLY B; A must stay 'dispatched'.
            updateDirectDispatchStatus(meshId, sessionId, 'acked', taskB);

            const db = MeshRuntimeStore.getInstance();
            const all = db.getActiveDirectDispatches(meshId);
            const rowA = all.find(d => d.taskId === taskA);
            const rowB = all.find(d => d.taskId === taskB);
            expect(rowA?.status).toBe('dispatched');
            expect(rowB?.status).toBe('acked');
        });

        it('completing one task_id leaves a sibling dispatch on the same session active (no collateral terminal)', () => {
            const meshId = `mesh-canonb-complete-${randomUUID().slice(0, 8)}`;
            const sessionId = `sess-shared-${randomUUID()}`;
            const taskA = `task-a-${randomUUID()}`;
            const taskB = `task-b-${randomUUID()}`;

            insertDirectDispatch(meshId, { taskId: taskA, sessionId, message: 'task-a', via: 'p2p', dispatchedAt: new Date(Date.now() - 1000).toISOString() });
            insertDirectDispatch(meshId, { taskId: taskB, sessionId, message: 'task-b', via: 'p2p', dispatchedAt: new Date().toISOString() });

            // A completes (echoing taskA). B is still a live dispatch and must remain active.
            updateDirectDispatchStatus(meshId, sessionId, 'completed', taskA);

            const active = getActiveDirectDispatches(meshId);
            expect(active.map(d => d.taskId)).toContain(taskB);
            expect(active.find(d => d.taskId === taskA)).toBeUndefined();
        });

        it('documents the bug-prone legacy path: a session-only flip (no taskId) terminates every active dispatch on the session', () => {
            const meshId = `mesh-canonb-legacy-${randomUUID().slice(0, 8)}`;
            const sessionId = `sess-shared-${randomUUID()}`;
            const taskA = `task-a-${randomUUID()}`;
            const taskB = `task-b-${randomUUID()}`;

            insertDirectDispatch(meshId, { taskId: taskA, sessionId, message: 'task-a', via: 'p2p', dispatchedAt: new Date(Date.now() - 1000).toISOString() });
            insertDirectDispatch(meshId, { taskId: taskB, sessionId, message: 'task-b', via: 'p2p', dispatchedAt: new Date().toISOString() });

            // Legacy/relayed event with no taskId — session_id fallback flips BOTH rows. This is
            // the hazard CANON-B avoids whenever the firing event carries a taskId.
            updateDirectDispatchStatus(meshId, sessionId, 'completed');

            expect(getActiveDirectDispatches(meshId)).toHaveLength(0);
        });
    });

    describe('markStaleDirectDispatches', () => {
        it('default threshold is 60 minutes: marks 61-min-old dispatched entries as stale', () => {
            const meshId = `mesh-stale-default-${randomUUID().slice(0, 8)}`;
            const oldSessionId = `sess-old-${randomUUID()}`;
            const recentSessionId = `sess-recent-${randomUUID()}`;

            // 61 minutes ago — should be marked stale with default 60-min threshold
            insertDirectDispatch(meshId, {
                taskId: randomUUID(),
                sessionId: oldSessionId,
                message: 'old task',
                via: 'p2p',
                dispatchedAt: new Date(Date.now() - 61 * 60 * 1000).toISOString(),
            });

            // Mark stale with default threshold (no second argument = 60 min)
            markStaleDirectDispatches(meshId);

            // The 61-min-old entry should be excluded from active dispatches (status = 'stale')
            const active = getActiveDirectDispatches(meshId);
            expect(active.find(d => d.sessionId === oldSessionId)).toBeUndefined();

            // 59 minutes ago — should NOT be marked stale with default 60-min threshold
            insertDirectDispatch(meshId, {
                taskId: randomUUID(),
                sessionId: recentSessionId,
                message: 'recent task',
                via: 'p2p',
                dispatchedAt: new Date(Date.now() - 59 * 60 * 1000).toISOString(),
            });

            markStaleDirectDispatches(meshId);

            const activeAfter = getActiveDirectDispatches(meshId);
            expect(activeAfter.find(d => d.sessionId === recentSessionId)).toBeDefined();
        });

        it('does NOT mark acked dispatches as stale', () => {
            const meshId = `mesh-stale-acked-${randomUUID().slice(0, 8)}`;
            const sessionId = `sess-acked-${randomUUID()}`;

            // Insert a very old dispatch (2 hours ago)
            insertDirectDispatch(meshId, {
                taskId: randomUUID(),
                sessionId,
                message: 'acked task',
                via: 'p2p',
                dispatchedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
            });

            // Update to acked (session started generating — not stale)
            updateDirectDispatchStatus(meshId, sessionId, 'acked');

            // markStaleDirectDispatches only targets status = 'dispatched', not 'acked'
            markStaleDirectDispatches(meshId);

            // The acked entry should still be in active dispatches
            const active = getActiveDirectDispatches(meshId);
            expect(active).toHaveLength(1);
            expect(active[0].sessionId).toBe(sessionId);
            expect(active[0].status).toBe('acked');
        });
    });

    describe('cleanupTerminalDirectDispatches', () => {
        it('removes old completed and failed entries', () => {
            const meshId = `mesh-cleanup-${randomUUID().slice(0, 8)}`;
            const completedSessionId = `sess-completed-${randomUUID()}`;
            const failedSessionId = `sess-failed-${randomUUID()}`;

            insertDirectDispatch(meshId, {
                taskId: randomUUID(),
                sessionId: completedSessionId,
                message: 'completed task',
                via: 'p2p',
                dispatchedAt: new Date().toISOString(),
            });
            insertDirectDispatch(meshId, {
                taskId: randomUUID(),
                sessionId: failedSessionId,
                message: 'failed task',
                via: 'p2p',
                dispatchedAt: new Date().toISOString(),
            });

            updateDirectDispatchStatus(meshId, completedSessionId, 'completed');
            updateDirectDispatchStatus(meshId, failedSessionId, 'failed');

            // olderThanMs = 0 means any terminal entry updated before now-0ms = now,
            // so all terminal entries are eligible for cleanup
            cleanupTerminalDirectDispatches(0);

            // Active dispatches only shows non-terminal entries
            const active = getActiveDirectDispatches(meshId);
            expect(active).toHaveLength(0);

            // Confirm via direct DB access that rows are gone
            const db = MeshRuntimeStore.getInstance();
            const all = db.getActiveDirectDispatches(meshId);
            expect(all).toHaveLength(0);
        });
    });

    describe('deleteDirectDispatchesByTaskId', () => {
        it('deletes only the named taskIds and leaves the rest, returning the deleted count', () => {
            const meshId = `mesh-prune-${randomUUID().slice(0, 8)}`;
            const t1 = randomUUID();
            const t2 = randomUUID();
            const t3 = randomUUID();
            insertDirectDispatch(meshId, { taskId: t1, sessionId: `s-${t1}`, message: 'orphan-1', via: 'p2p', dispatchedAt: new Date().toISOString() });
            insertDirectDispatch(meshId, { taskId: t2, sessionId: `s-${t2}`, message: 'orphan-2', via: 'p2p', dispatchedAt: new Date().toISOString() });
            insertDirectDispatch(meshId, { taskId: t3, sessionId: `s-${t3}`, message: 'keep-me', via: 'p2p', dispatchedAt: new Date().toISOString() });

            const deleted = deleteDirectDispatchesByTaskId(meshId, [t1, t2]);
            expect(deleted).toBe(2);

            const active = getActiveDirectDispatches(meshId);
            const remaining = active.map(d => d.taskId);
            expect(remaining).toEqual([t3]);
        });

        it('is a no-op for an empty taskId list', () => {
            const meshId = `mesh-prune-empty-${randomUUID().slice(0, 8)}`;
            const t1 = randomUUID();
            insertDirectDispatch(meshId, { taskId: t1, sessionId: `s-${t1}`, message: 'keep', via: 'p2p', dispatchedAt: new Date().toISOString() });

            expect(deleteDirectDispatchesByTaskId(meshId, [])).toBe(0);
            expect(getActiveDirectDispatches(meshId)).toHaveLength(1);
        });

        it('does not delete rows belonging to a different mesh', () => {
            const meshA = `mesh-a-${randomUUID().slice(0, 8)}`;
            const meshB = `mesh-b-${randomUUID().slice(0, 8)}`;
            const shared = randomUUID();
            insertDirectDispatch(meshA, { taskId: shared, sessionId: `s-${shared}`, message: 'a', via: 'p2p', dispatchedAt: new Date().toISOString() });
            insertDirectDispatch(meshB, { taskId: randomUUID(), sessionId: `s-${randomUUID()}`, message: 'b', via: 'p2p', dispatchedAt: new Date().toISOString() });

            // Deleting meshA's taskId scoped to meshB must affect nothing.
            expect(deleteDirectDispatchesByTaskId(meshB, [shared])).toBe(0);
            expect(getActiveDirectDispatches(meshA)).toHaveLength(1);
            expect(getActiveDirectDispatches(meshB)).toHaveLength(1);
        });
    });

    describe('multiple dispatches per mesh', () => {
        it('getActiveDirectDispatches returns all non-terminal entries for a mesh', () => {
            const meshId = `mesh-multi-${randomUUID().slice(0, 8)}`;
            const s1 = `sess-a-${randomUUID()}`;
            const s2 = `sess-b-${randomUUID()}`;
            const s3 = `sess-c-${randomUUID()}`;

            insertDirectDispatch(meshId, { taskId: randomUUID(), sessionId: s1, message: 'task-1', via: 'p2p', dispatchedAt: new Date().toISOString() });
            insertDirectDispatch(meshId, { taskId: randomUUID(), sessionId: s2, message: 'task-2', via: 'p2p', dispatchedAt: new Date().toISOString() });
            insertDirectDispatch(meshId, { taskId: randomUUID(), sessionId: s3, message: 'task-3', via: 'p2p', dispatchedAt: new Date().toISOString() });

            updateDirectDispatchStatus(meshId, s3, 'completed');

            const active = getActiveDirectDispatches(meshId);
            expect(active).toHaveLength(2);
            const sessionIds = active.map(d => d.sessionId);
            expect(sessionIds).toContain(s1);
            expect(sessionIds).toContain(s2);
            expect(sessionIds).not.toContain(s3);
        });

        it('dispatches for different meshes do not interfere', () => {
            const meshA = `mesh-a-${randomUUID().slice(0, 8)}`;
            const meshB = `mesh-b-${randomUUID().slice(0, 8)}`;
            const sA = `sess-a-${randomUUID()}`;
            const sB = `sess-b-${randomUUID()}`;

            insertDirectDispatch(meshA, { taskId: randomUUID(), sessionId: sA, message: 'task-a', via: 'p2p', dispatchedAt: new Date().toISOString() });
            insertDirectDispatch(meshB, { taskId: randomUUID(), sessionId: sB, message: 'task-b', via: 'p2p', dispatchedAt: new Date().toISOString() });

            const activeA = getActiveDirectDispatches(meshA);
            const activeB = getActiveDirectDispatches(meshB);

            expect(activeA).toHaveLength(1);
            expect(activeA[0].sessionId).toBe(sA);

            expect(activeB).toHaveLength(1);
            expect(activeB[0].sessionId).toBe(sB);
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

        it('blocks claiming once the (node, provider) active count reaches maxParallel', () => {
            const meshId = `mesh-prov-cap-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            insertReadonly(db, meshId, 'ro-1', 3000);
            insertReadonly(db, meshId, 'ro-2', 2000);
            insertReadonly(db, meshId, 'ro-3', 1000);

            const opts = { providerType: 'claude-cli', providerMaxParallel: 2 };
            const c1 = db.claimNextQueueTask(meshId, 'node1', 'sess1', [], opts);
            const c2 = db.claimNextQueueTask(meshId, 'node1', 'sess2', [], opts);
            // Third claim on the same (node, provider) is over the cap → blocked,
            // even though a pending read-only task exists and the node is not "busy"
            // under the read-only concurrent rule.
            const c3 = db.claimNextQueueTask(meshId, 'node1', 'sess3', [], opts);

            expect(c1?.id).toBe('ro-1');
            expect(c1?.assignedProviderType).toBe('claude-cli');
            expect(c2?.id).toBe('ro-2');
            expect(c3).toBeNull();

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
            updateTaskStatus(meshId, 'ro-1', 'completed');
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

    // ── Phase A0: Direct Dispatch / Delivery Baseline Tests ─────────────────
    // These tests fix the existing happy-path behavior and confirm key invariants
    // for stale-direct-work separation and duplicate completion dedup.

    describe('Phase A0: direct dispatch delivery baseline', () => {
        afterEach(() => {
            __resetMeshRuntimeStoreForTests();
        });

        it('A0.1 — idle direct dispatch reaches dispatched → acked → completed', () => {
            const meshId = `mesh-a0-happy-${randomUUID().slice(0, 8)}`;
            const sessionId = `sess-a0-${randomUUID().slice(0, 8)}`;

            insertDirectDispatch(meshId, {
                taskId: randomUUID(),
                sessionId,
                message: 'task for idle session',
                via: 'local_direct',
                dispatchedAt: new Date().toISOString(),
                dispatchedToIdleSession: true,
            });

            let active = getActiveDirectDispatches(meshId);
            expect(active).toHaveLength(1);
            expect(active[0].status).toBe('dispatched');
            expect(active[0].dispatchedToIdleSession).toBe(true);

            updateDirectDispatchStatus(meshId, sessionId, 'acked');
            active = getActiveDirectDispatches(meshId);
            expect(active[0].status).toBe('acked');

            updateDirectDispatchStatus(meshId, sessionId, 'completed');
            active = getActiveDirectDispatches(meshId);
            expect(active).toHaveLength(0);
        });

        it('A0.2 — stale direct dispatch (61 min old) is marked stale and excluded from active', () => {
            const meshId = `mesh-a0-stale-${randomUUID().slice(0, 8)}`;
            const staleId = `sess-stale-${randomUUID().slice(0, 8)}`;
            const freshId = `sess-fresh-${randomUUID().slice(0, 8)}`;

            insertDirectDispatch(meshId, {
                taskId: randomUUID(),
                sessionId: staleId,
                message: 'old task',
                via: 'local_direct',
                dispatchedAt: new Date(Date.now() - 61 * 60 * 1000).toISOString(),
            });
            insertDirectDispatch(meshId, {
                taskId: randomUUID(),
                sessionId: freshId,
                message: 'fresh task',
                via: 'local_direct',
                dispatchedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
            });

            markStaleDirectDispatches(meshId);

            const active = getActiveDirectDispatches(meshId);
            // Stale entry should be excluded from active (status = 'stale')
            expect(active.find(d => d.sessionId === staleId)).toBeUndefined();
            // Fresh entry should still be active
            expect(active.find(d => d.sessionId === freshId)).toBeDefined();
        });

        it('A0.3 — stale direct dispatch does NOT mix into active queue count', () => {
            const meshId = `mesh-a0-count-${randomUUID().slice(0, 8)}`;
            const staleId = `sess-stale-count-${randomUUID().slice(0, 8)}`;

            insertDirectDispatch(meshId, {
                taskId: randomUUID(),
                sessionId: staleId,
                message: 'stale work',
                via: 'local_direct',
                dispatchedAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
            });

            markStaleDirectDispatches(meshId);

            // Stale dispatch should not appear in active dispatches
            const active = getActiveDirectDispatches(meshId);
            expect(active).toHaveLength(0);
        });

        it('A0.4 — duplicate completion for same session does not create second active entry', () => {
            const meshId = `mesh-a0-dedup-${randomUUID().slice(0, 8)}`;
            const sessionId = `sess-dedup-${randomUUID().slice(0, 8)}`;

            insertDirectDispatch(meshId, {
                taskId: randomUUID(),
                sessionId,
                message: 'dedup task',
                via: 'local_direct',
                dispatchedAt: new Date().toISOString(),
            });

            // First completion
            updateDirectDispatchStatus(meshId, sessionId, 'completed');
            // Second completion attempt (same session) — must not re-activate
            updateDirectDispatchStatus(meshId, sessionId, 'completed');

            const active = getActiveDirectDispatches(meshId);
            expect(active).toHaveLength(0);
        });
    });

    // ── Phase A1: session_delivery table tests ───────────────────────────────

    describe('Phase A1: mesh_session_delivery table', () => {
        afterEach(() => {
            __resetMeshRuntimeStoreForTests();
        });

        it('insertSessionDelivery persists and getActiveSessionDeliveries returns it', () => {
            const meshId = `mesh-sdel-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            const id = randomUUID();
            const now = new Date().toISOString();
            db.insertSessionDelivery({
                id,
                meshId,
                nodeId: 'node-1',
                sessionId: 'sess-1',
                providerType: 'claude-cli',
                taskId: randomUUID(),
                kind: 'task',
                priority: 1,
                message: 'delivery message',
                status: 'queued',
                createdAt: now,
                updatedAt: now,
            });

            const active = db.getActiveSessionDeliveries(meshId);
            expect(active).toHaveLength(1);
            expect(active[0].id).toBe(id);
            expect(active[0].status).toBe('queued');
            expect(active[0].sessionId).toBe('sess-1');
        });

        it('updateSessionDeliveryStatus transitions to terminal and removes from active list', () => {
            const meshId = `mesh-sdel-update-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            const id = randomUUID();
            const now = new Date().toISOString();
            db.insertSessionDelivery({ id, meshId, kind: 'task', message: 'msg', status: 'queued', createdAt: now, updatedAt: now });

            db.updateSessionDeliveryStatus(id, 'completed');

            const active = db.getActiveSessionDeliveries(meshId);
            expect(active).toHaveLength(0);
        });

        it('expired deliveries do not appear in active list', () => {
            const meshId = `mesh-sdel-expire-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            const id = randomUUID();
            const now = new Date().toISOString();
            const alreadyExpired = new Date(Date.now() - 1000).toISOString();
            db.insertSessionDelivery({ id, meshId, kind: 'task', message: 'expired', status: 'queued', expiresAt: alreadyExpired, createdAt: now, updatedAt: now });

            const active = db.getActiveSessionDeliveries(meshId);
            expect(active.find(d => d.id === id)).toBeUndefined();
        });

        it('delivery for different mesh does not appear in other mesh active list', () => {
            const meshA = `mesh-sdel-a-${randomUUID().slice(0, 8)}`;
            const meshB = `mesh-sdel-b-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            const now = new Date().toISOString();
            db.insertSessionDelivery({ id: randomUUID(), meshId: meshA, kind: 'task', message: 'a', status: 'queued', createdAt: now, updatedAt: now });
            db.insertSessionDelivery({ id: randomUUID(), meshId: meshB, kind: 'task', message: 'b', status: 'queued', createdAt: now, updatedAt: now });

            expect(db.getActiveSessionDeliveries(meshA)).toHaveLength(1);
            expect(db.getActiveSessionDeliveries(meshB)).toHaveLength(1);
        });
    });

    // ── Phase A6: completion conflict table tests ────────────────────────────

    describe('Phase A6: mesh_completion_conflicts table', () => {
        afterEach(() => {
            __resetMeshRuntimeStoreForTests();
        });

        it('recordCompletionConflict inserts and getRecentCompletionConflicts retrieves it', () => {
            const meshId = `mesh-conflict-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            const id = randomUUID();
            const fp = `fp-${randomUUID()}`;
            db.recordCompletionConflict({
                id,
                meshId,
                fingerprint: fp,
                conflictingTaskId: 'task-c',
                conflictingSessionId: 'sess-c',
                originalTaskId: 'task-o',
                originalSessionId: 'sess-o',
                event: 'agent:generating_completed',
                createdAt: new Date().toISOString(),
            });

            const conflicts = db.getRecentCompletionConflicts(meshId);
            expect(conflicts).toHaveLength(1);
            expect(conflicts[0].fingerprint).toBe(fp);
            expect(conflicts[0].conflictingTaskId).toBe('task-c');
        });

        it('returns empty array when no conflicts for mesh', () => {
            const meshId = `mesh-no-conflict-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            expect(db.getRecentCompletionConflicts(meshId)).toEqual([]);
        });

        it('duplicate same-id insert is silently ignored (INSERT OR IGNORE)', () => {
            const meshId = `mesh-conflict-dedup-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            const id = randomUUID();
            const fp = `fp-${randomUUID()}`;
            db.recordCompletionConflict({ id, meshId, fingerprint: fp, event: 'agent:generating_completed', createdAt: new Date().toISOString() });
            db.recordCompletionConflict({ id, meshId, fingerprint: fp, event: 'agent:generating_completed', createdAt: new Date().toISOString() });

            const conflicts = db.getRecentCompletionConflicts(meshId);
            expect(conflicts).toHaveLength(1);
        });
    });

    // ── Phase E1: queue retry cap ────────────────────────────────────────────

    describe('Phase E1: queue retry cap', () => {
        afterEach(() => {
            __resetMeshRuntimeStoreForTests();
            __clearMeshQueueForTests();
        });

        it('E1.1 — requeueTask fails task when requeueCount reaches maxRetries (default 1)', () => {
            const meshId = `mesh-e1-cap-${randomUUID().slice(0, 8)}`;
            const task = enqueueTask(meshId, 'test task');
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
            const task = enqueueTask(meshId, 'test task');
            claimNextTask(meshId, 'node-1', 'sess-1');

            // maxRetries=2: first requeue should succeed (0 → 1 < 2)
            const result = requeueTask(meshId, task.id, { maxRetries: 2 });
            expect(result).not.toBeNull();
            expect(result!.status).toBe('pending');
            expect(result!.requeueCount).toBe(1);
        });

        it('E1.3 — force=true bypasses retry cap', () => {
            const meshId = `mesh-e1-force-${randomUUID().slice(0, 8)}`;
            const task = enqueueTask(meshId, 'test task');
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
            const task = enqueueTask(meshId, 'test task');
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

    // ── Phase G3: Pending Events SQLite ──────────────────────────────────────

    describe('Phase G3: mesh_pending_events table', () => {
        afterEach(() => {
            __resetMeshRuntimeStoreForTests();
        });

        it('G3.1 — insertPendingEvent persists and drainPendingEvents returns it', () => {
            const meshId = `mesh-g3-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            db.insertPendingEvent({
                id: randomUUID(),
                meshId,
                event: 'agent:generating_completed',
                payload: { nodeLabel: 'Node X' },
                queuedAt: Date.now(),
            });
            expect(db.pendingEventCount(meshId)).toBe(1);
            const drained = db.drainPendingEvents(meshId);
            expect(drained).toHaveLength(1);
            expect(drained[0].event).toBe('agent:generating_completed');
            expect(db.pendingEventCount(meshId)).toBe(0); // drained
        });

        it('G3.2 — fingerprint dedup prevents duplicate inserts', () => {
            const meshId = `mesh-g3-fp-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            const fingerprint = `fp::${randomUUID()}`;
            db.insertPendingEvent({ id: randomUUID(), meshId, event: 'agent:stopped', payload: {}, fingerprint, queuedAt: Date.now() });
            const second = db.insertPendingEvent({ id: randomUUID(), meshId, event: 'agent:stopped', payload: {}, fingerprint, queuedAt: Date.now() });
            expect(second).toBe(false); // duplicate rejected
            expect(db.pendingEventCount(meshId)).toBe(1);
        });

        it('G3.3 — hasPendingEventFingerprint returns true after insert', () => {
            const meshId = `mesh-g3-has-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            const fp = `fp::${randomUUID()}`;
            expect(db.hasPendingEventFingerprint(meshId, fp)).toBe(false);
            db.insertPendingEvent({ id: randomUUID(), meshId, event: 'agent:stopped', payload: {}, fingerprint: fp, queuedAt: Date.now() });
            expect(db.hasPendingEventFingerprint(meshId, fp)).toBe(true);
        });

        it('G3.4 — drain with coordinatorDaemonId filters correctly', () => {
            const meshId = `mesh-g3-scope-${randomUUID().slice(0, 8)}`;
            const db = MeshRuntimeStore.getInstance();
            db.insertPendingEvent({ id: randomUUID(), meshId, coordinatorDaemonId: 'coord-A', event: 'agent:ready', payload: {}, queuedAt: Date.now() });
            db.insertPendingEvent({ id: randomUUID(), meshId, coordinatorDaemonId: null, event: 'agent:stopped', payload: {}, queuedAt: Date.now() });
            const drainedForA = db.drainPendingEvents(meshId, 'coord-A');
            // Both: scoped to coord-A + unscoped
            expect(drainedForA).toHaveLength(2);
            expect(db.pendingEventCount(meshId)).toBe(0);
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
            db.recordCompletionFingerprint('mesh-wal', `fp-f3-${randomUUID()}`, 60_000); // calls maybeCheckpointWal
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

        it('mesh_completion_fingerprints: a completion in mesh A does NOT suppress dedup in mesh B', () => {
            const db = MeshRuntimeStore.getInstance();
            // Same fingerprint body recorded under mesh A only.
            const fp = `${MESH_A}::agent:generating_completed::sess-x::claude-cli::ps-1::9000::`;
            db.recordCompletionFingerprint(MESH_A, fp, 60_000);

            // Mesh A sees it (its own dedup gate fires)...
            expect(db.hasCompletionFingerprint(MESH_A, fp)).toBe(true);
            // ...but mesh B must NOT: a cross-mesh suppression would drop mesh B's real
            // completion notification (a completion-loss class bug).
            expect(db.hasCompletionFingerprint(MESH_B, fp)).toBe(false);
        });

        it('legacy fingerprints (no mesh_id) backfill mesh_id from the \'::\'-prefixed fingerprint string', () => {
            const Database = runtimeRequire('better-sqlite3') as any;
            const ledgerDir = join(testConfigDir, 'mesh-ledger');
            mkdirSync(ledgerDir, { recursive: true });
            const dbPath = join(ledgerDir, 'mesh-runtime.db');
            const fp = `${MESH_A}::agent:ready::sess-legacy::claude-cli::::8000::`;

            // Pre-isolation schema: mesh_completion_fingerprints WITHOUT mesh_id.
            const legacy = new Database(dbPath);
            legacy.exec(`
                CREATE TABLE mesh_completion_fingerprints (
                    fingerprint TEXT PRIMARY KEY,
                    expires_at INTEGER NOT NULL
                );
            `);
            legacy.prepare('INSERT INTO mesh_completion_fingerprints (fingerprint, expires_at) VALUES (?, ?)')
                .run(fp, Date.now() + 60_000);
            legacy.close();

            // Opening the store runs migrateMeshIsolationColumns → ADD COLUMN + backfill.
            const db = MeshRuntimeStore.getInstance();
            // Backfilled mesh_id == the fingerprint's first '::' segment == MESH_A.
            expect(db.hasCompletionFingerprint(MESH_A, fp)).toBe(true);
            // And it is NOT visible to a different mesh.
            expect(db.hasCompletionFingerprint(MESH_B, fp)).toBe(false);
        });
    });

    // R2 / NOTIF-DROP: a mission-attributed DIRECT dispatch (mesh_send_task) must record
    // a confirmed delivery so the assigned-stranded watchdog does not reclaim a task the
    // worker already completed and drop its completion notification. Live PROBE-B repro:
    // the second direct dispatch to a reused session was reclaimed "never confirmed
    // delivered → pending" after 5 min, dropping agent:generating_completed.
    describe('direct dispatch confirmed delivery (NOTIF-DROP / R2)', () => {
        const MESH = 'mesh_direct_delivery';
        const MISSION = 'mission_xyz';

        beforeEach(() => {
            __resetMeshRuntimeStoreForTests();
            __clearMeshQueueForTests(MESH);
        });

        it('recordDirectDispatchTask materialises a confirmed delivery → taskHasConfirmedDelivery is true', () => {
            const taskId = randomUUID();
            const entry = recordDirectDispatchTask(MESH, 'echo probe', {
                id: taskId,
                missionId: MISSION,
                assignedNodeId: 'node_w',
                assignedSessionId: 'sess_w',
                dispatchedAt: new Date().toISOString(),
            });
            expect(entry).not.toBeNull();
            expect(entry?.status).toBe('assigned');
            // The watchdog gate: a confirmed delivery row keyed by this taskId must exist,
            // otherwise recoverStrandedAssignedDispatches reclaims the completed task.
            const store = MeshRuntimeStore.getInstance();
            expect(store.taskHasConfirmedDelivery(MESH, taskId)).toBe(true);
        });

        it('does not record a delivery when the dispatch is not materialised (no missionId)', () => {
            const taskId = randomUUID();
            const entry = recordDirectDispatchTask(MESH, 'echo probe', {
                id: taskId,
                missionId: '',
                assignedNodeId: 'node_w',
                assignedSessionId: 'sess_w',
            });
            expect(entry).toBeNull();
            const store = MeshRuntimeStore.getInstance();
            expect(store.taskHasConfirmedDelivery(MESH, taskId)).toBe(false);
        });
    });
});
