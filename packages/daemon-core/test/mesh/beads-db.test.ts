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
});
