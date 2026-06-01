import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const testTmpDir = join(tmpdir(), `adhdev-beadsdb-test-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
}));

import { BeadsDB } from '../../src/mesh/beads-db.js';
import {
    insertDirectDispatch,
    getActiveDirectDispatches,
    updateDirectDispatchStatus,
    markStaleDirectDispatches,
    cleanupTerminalDirectDispatches,
    __resetBeadsDBForTests,
    enqueueTask,
    claimNextTask,
    getQueue,
    getMeshQueueStats,
    cancelTask,
    requeueTask,
    updateTaskStatus,
    __clearMeshQueueForTests,
} from '../../src/mesh/mesh-work-queue.js';

describe('beads-db', () => {
    beforeEach(() => {
        if (!existsSync(testConfigDir)) {
            mkdirSync(testConfigDir, { recursive: true });
        }
    });

    afterEach(() => {
        __resetBeadsDBForTests();
        try {
            rmSync(testTmpDir, { recursive: true, force: true });
        } catch { /* cleanup best-effort */ }
    });

    describe('completion fingerprints', () => {
        it('hasCompletionFingerprint returns false for unknown fingerprint', () => {
            const db = BeadsDB.getInstance();
            expect(db.hasCompletionFingerprint('unknown-fingerprint-xyz')).toBe(false);
        });

        it('recordCompletionFingerprint and hasCompletionFingerprint round-trip', () => {
            const db = BeadsDB.getInstance();
            const fp = `fp-valid-${randomUUID()}`;
            db.recordCompletionFingerprint(fp, 60_000); // 60s TTL — valid
            expect(db.hasCompletionFingerprint(fp)).toBe(true);

            // Expired fingerprint: ttlMs = -1000 means expires_at = now - 1000 (already in the past)
            const expiredFp = `fp-expired-${randomUUID()}`;
            db.recordCompletionFingerprint(expiredFp, -1000);
            // The SELECT filters WHERE expires_at > now, so expired entry returns false
            expect(db.hasCompletionFingerprint(expiredFp)).toBe(false);
        });

        it('fingerprintSweepCounter clears expired entries every 100 reads', () => {
            const db = BeadsDB.getInstance();
            const fp = `fp-sweep-${randomUUID()}`;

            // Record a fingerprint that is already expired (negative TTL)
            db.recordCompletionFingerprint(fp, -1000);

            // Call hasCompletionFingerprint 100 times.
            // Each call: returns false (expired) but the 100th call triggers sweepExpiredFingerprints().
            // The first 99 reads increment the counter but don't sweep.
            // The 100th read resets the counter to 0 and runs DELETE WHERE expires_at <= now.
            for (let i = 0; i < 100; i++) {
                expect(db.hasCompletionFingerprint(fp)).toBe(false);
            }

            // After the sweep, the expired row is gone. Verify by recording a fresh valid fingerprint
            // and checking a subsequent sweepExpiredFingerprints() doesn't touch it.
            const validFp = `fp-valid-after-sweep-${randomUUID()}`;
            db.recordCompletionFingerprint(validFp, 60_000);
            db.sweepExpiredFingerprints();
            expect(db.hasCompletionFingerprint(validFp)).toBe(true);
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
            const db = BeadsDB.getInstance();
            const all = db.getActiveDirectDispatches(meshId);
            expect(all).toHaveLength(0);
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

    describe('claimNextQueueTask — BeadsDB level', () => {
        afterEach(() => {
            __resetBeadsDBForTests();
        });

        it('claims the oldest pending task when no active assignment exists', () => {
            const meshId = `mesh-claim-oldest-${randomUUID().slice(0, 8)}`;
            const db = BeadsDB.getInstance();
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
            const db = BeadsDB.getInstance();
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
            const db = BeadsDB.getInstance();
            db.insertQueueEntry({ id: 'unconstrained-1', meshId, message: 'unconstrained', status: 'pending', createdAt: new Date(Date.now() - 1000).toISOString(), updatedAt: new Date(Date.now() - 1000).toISOString() });
            db.insertQueueEntry({ id: 'session-targeted-1', meshId, message: 'session targeted', status: 'pending', targetSessionId: 'sess-target', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

            const claimed = db.claimNextQueueTask(meshId, 'node1', 'sess-target');
            expect(claimed?.id).toBe('session-targeted-1');
            expect(claimed?.targetSessionId).toBe('sess-target');

            __clearMeshQueueForTests(meshId);
        });

        it('prioritizes node-targeted (no session) over unconstrained', () => {
            const meshId = `mesh-claim-node-prio-${randomUUID().slice(0, 8)}`;
            const db = BeadsDB.getInstance();
            db.insertQueueEntry({ id: 'unconstrained-2', meshId, message: 'unconstrained', status: 'pending', createdAt: new Date(Date.now() - 1000).toISOString(), updatedAt: new Date(Date.now() - 1000).toISOString() });
            db.insertQueueEntry({ id: 'node-targeted-1', meshId, message: 'node targeted', status: 'pending', targetNodeId: 'node-a', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

            const claimed = db.claimNextQueueTask(meshId, 'node-a', 'sess1');
            expect(claimed?.id).toBe('node-targeted-1');
            expect(claimed?.targetNodeId).toBe('node-a');

            __clearMeshQueueForTests(meshId);
        });

        it('returns null when queue is empty', () => {
            const meshId = `mesh-claim-empty-${randomUUID().slice(0, 8)}`;
            expect(BeadsDB.getInstance().claimNextQueueTask(meshId, 'node1', 'sess1')).toBeNull();
        });
    });

    describe('findQueueEntryById', () => {
        afterEach(() => {
            __resetBeadsDBForTests();
        });

        it('returns entry when found, null for nonexistent', () => {
            const meshId = `mesh-find-by-id-${randomUUID().slice(0, 8)}`;
            const db = BeadsDB.getInstance();
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
            __resetBeadsDBForTests();
        });

        it('returns the assigned entry for a session', () => {
            const meshId = `mesh-assigned-sess-${randomUUID().slice(0, 8)}`;
            const sessionId = `sess-${randomUUID().slice(0, 8)}`;
            const db = BeadsDB.getInstance();
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

        it('respects occurredAt filter — ignores entries updated after occurredAt cutoff', () => {
            const meshId = `mesh-assigned-cutoff-${randomUUID().slice(0, 8)}`;
            const sessionId = `sess-cutoff-${randomUUID().slice(0, 8)}`;
            const db = BeadsDB.getInstance();
            db.insertQueueEntry({ id: 'task-cutoff-1', meshId, message: 'cutoff task', status: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

            // Claim just now — updatedAt is current time
            db.claimNextQueueTask(meshId, 'node1', sessionId);

            // Requesting entries updated BEFORE 10 seconds ago — should return null
            // because the task was just claimed (updated_at = now, not 10 seconds ago)
            const farPastIso = new Date(Date.now() - 10_000).toISOString();
            const notFound = db.findAssignedBySession(meshId, sessionId, farPastIso);
            expect(notFound).toBeNull();

            // Without occurredAt — should return the assigned entry
            const found = db.findAssignedBySession(meshId, sessionId);
            expect(found).not.toBeNull();
            expect(found?.status).toBe('assigned');

            __clearMeshQueueForTests(meshId);
        });
    });

    describe('getQueueStatsByStatus', () => {
        afterEach(() => {
            __resetBeadsDBForTests();
        });

        it('returns accurate counts by status via SQL GROUP BY', () => {
            const meshId = `mesh-stats-${randomUUID().slice(0, 8)}`;
            const db = BeadsDB.getInstance();
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
            const stats = BeadsDB.getInstance().getQueueStatsByStatus('empty-mesh-xyz-never-used');
            expect(stats).toEqual([]);
        });
    });

    describe('getActiveAssignmentDetails', () => {
        afterEach(() => {
            __resetBeadsDBForTests();
        });

        it('returns node, session, and message for assigned tasks', () => {
            const meshId = `mesh-active-details-${randomUUID().slice(0, 8)}`;
            const db = BeadsDB.getInstance();
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
            __resetBeadsDBForTests();
        });

        it('insertQueueEntry persists and updateQueueEntry modifies in place', () => {
            const meshId = `mesh-roundtrip-${randomUUID().slice(0, 8)}`;
            const db = BeadsDB.getInstance();
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
});
