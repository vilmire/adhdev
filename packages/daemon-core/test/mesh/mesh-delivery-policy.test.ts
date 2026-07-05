import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { vi } from 'vitest';

const testTmpDir = join(tmpdir(), `adhdev-mesh-delivery-policy-test-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
}));

import {
    resolveDeliveryDecision,
    createSessionDelivery,
    updateSessionDeliveryStatus,
    getActiveSessionDeliveries,
    __clearSessionDeliveriesForTests,
} from '../../src/mesh/mesh-delivery-policy.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

function resetStore() {
    MeshRuntimeStore.resetForTests();
}

describe('mesh-delivery-policy', () => {
    beforeEach(() => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
    });
    afterEach(() => {
        resetStore();
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* cleanup */ }
    });

    // ── resolveDeliveryDecision — pure function ──────────────────────────────

    describe('resolveDeliveryDecision', () => {
        it('returns immediate for idle session', () => {
            const result = resolveDeliveryDecision('idle');
            expect(result.decision).toBe('immediate');
            expect(result.reason).toContain('idle');
        });

        it('returns immediate for waiting_input session', () => {
            const result = resolveDeliveryDecision('waiting_input');
            expect(result.decision).toBe('immediate');
        });

        it('returns immediate for ready session', () => {
            const result = resolveDeliveryDecision('ready');
            expect(result.decision).toBe('immediate');
        });

        it('returns queued for generating session', () => {
            const result = resolveDeliveryDecision('generating');
            expect(result.decision).toBe('queued');
            expect(result.reason).toContain('generating');
        });

        it('returns queued for busy session', () => {
            const result = resolveDeliveryDecision('busy');
            expect(result.decision).toBe('queued');
        });

        it('returns queued for running session', () => {
            const result = resolveDeliveryDecision('running');
            expect(result.decision).toBe('queued');
        });

        it('returns queued for streaming session', () => {
            const result = resolveDeliveryDecision('streaming');
            expect(result.decision).toBe('queued');
        });

        it('returns queued for starting session', () => {
            const result = resolveDeliveryDecision('starting');
            expect(result.decision).toBe('queued');
        });

        it('returns queued for waiting_approval with non-approval kind', () => {
            const result = resolveDeliveryDecision('waiting_approval', { kind: 'task' });
            expect(result.decision).toBe('queued');
            expect(result.reason).toContain('waiting_approval');
        });

        it('returns immediate for waiting_approval with approval kind', () => {
            const result = resolveDeliveryDecision('waiting_approval', { kind: 'approval' });
            expect(result.decision).toBe('immediate');
            expect(result.reason).toContain('approval');
        });

        it('returns rejected for stopped session', () => {
            const result = resolveDeliveryDecision('stopped');
            expect(result.decision).toBe('rejected');
            expect(result.reason).toContain('stopped');
        });

        it('returns rejected for terminated session', () => {
            const result = resolveDeliveryDecision('terminated');
            expect(result.decision).toBe('rejected');
        });

        it('returns rejected for closed session', () => {
            const result = resolveDeliveryDecision('closed');
            expect(result.decision).toBe('rejected');
        });

        it('returns rejected for empty/undefined status (fail-closed)', () => {
            const result = resolveDeliveryDecision(undefined);
            expect(result.decision).toBe('rejected');
            expect(result.reason).toBe('unknown_session_status');
        });

        it('returns rejected for unknown status (fail-closed)', () => {
            const result = resolveDeliveryDecision('some_unknown_status_xyz');
            expect(result.decision).toBe('rejected');
            expect(result.reason).toBe('unrecognized_session_status');
        });

        it('allows busy injection when allowBusyInjection=true', () => {
            const result = resolveDeliveryDecision('generating', { allowBusyInjection: true });
            expect(result.decision).toBe('immediate');
            expect(result.reason).toContain('busy_injection_allowed');
        });

        it('result always has a message string', () => {
            for (const status of ['idle', 'generating', 'stopped', 'unknown']) {
                const result = resolveDeliveryDecision(status);
                expect(typeof result.message).toBe('string');
                expect(result.message.length).toBeGreaterThan(0);
            }
        });
    });

    // ── createSessionDelivery + getActiveSessionDeliveries ──────────────────

    describe('createSessionDelivery', () => {
        it('creates a delivery record and returns it with correct fields', () => {
            const meshId = `mesh-del-${randomUUID().slice(0, 8)}`;
            const delivery = createSessionDelivery({
                meshId,
                nodeId: 'node-1',
                sessionId: 'sess-1',
                providerType: 'claude-cli',
                taskId: randomUUID(),
                kind: 'task',
                message: 'test task message',
                status: 'queued',
            });
            expect(delivery.id).toBeTruthy();
            expect(delivery.meshId).toBe(meshId);
            expect(delivery.nodeId).toBe('node-1');
            expect(delivery.sessionId).toBe('sess-1');
            expect(delivery.status).toBe('queued');
            expect(delivery.kind).toBe('task');
            expect(delivery.message).toBe('test task message');
            expect(delivery.attemptCount).toBe(0);
        });

        it('delivery appears in getActiveSessionDeliveries', () => {
            const meshId = `mesh-del-active-${randomUUID().slice(0, 8)}`;
            createSessionDelivery({
                meshId,
                sessionId: 'sess-2',
                kind: 'task',
                message: 'queued message',
                status: 'queued',
            });
            const active = getActiveSessionDeliveries(meshId);
            expect(active.length).toBe(1);
            expect(active[0].sessionId).toBe('sess-2');
        });

        it('terminal status deliveries do not appear in getActiveSessionDeliveries', () => {
            const meshId = `mesh-del-terminal-${randomUUID().slice(0, 8)}`;
            const d = createSessionDelivery({
                meshId,
                sessionId: 'sess-3',
                kind: 'task',
                message: 'completed message',
                status: 'queued',
            });
            updateSessionDeliveryStatus(d.id, 'completed');
            const active = getActiveSessionDeliveries(meshId);
            expect(active.length).toBe(0);
        });

        it('can filter active deliveries by sessionId', () => {
            const meshId = `mesh-del-filter-${randomUUID().slice(0, 8)}`;
            createSessionDelivery({ meshId, sessionId: 'sess-a', kind: 'task', message: 'a', status: 'queued' });
            createSessionDelivery({ meshId, sessionId: 'sess-b', kind: 'task', message: 'b', status: 'queued' });

            const activeA = getActiveSessionDeliveries(meshId, 'sess-a');
            expect(activeA.length).toBe(1);
            expect(activeA[0].sessionId).toBe('sess-a');

            const activeB = getActiveSessionDeliveries(meshId, 'sess-b');
            expect(activeB.length).toBe(1);
            expect(activeB[0].sessionId).toBe('sess-b');
        });
    });

    // ── updateSessionDeliveryStatus ──────────────────────────────────────────

    describe('updateSessionDeliveryStatus', () => {
        it('transitions queued → delivering → delivered', () => {
            const meshId = `mesh-del-status-${randomUUID().slice(0, 8)}`;
            const d = createSessionDelivery({ meshId, sessionId: 'sess-x', kind: 'task', message: 'msg', status: 'queued' });
            updateSessionDeliveryStatus(d.id, 'delivering');
            let active = getActiveSessionDeliveries(meshId, 'sess-x');
            expect(active[0].status).toBe('delivering');
            updateSessionDeliveryStatus(d.id, 'delivered');
            // 'delivered' is a terminal-equivalent — not in active list
            active = getActiveSessionDeliveries(meshId, 'sess-x');
            expect(active.length).toBe(0);
        });

        it('increments attemptCount on failure with incrementAttempt', () => {
            const meshId = `mesh-del-attempt-${randomUUID().slice(0, 8)}`;
            const d = createSessionDelivery({ meshId, sessionId: 'sess-y', kind: 'task', message: 'msg', status: 'queued' });
            updateSessionDeliveryStatus(d.id, 'queued', { lastError: 'send failed', incrementAttempt: true });
            const active = getActiveSessionDeliveries(meshId, 'sess-y');
            expect(active[0].attemptCount).toBe(1);
            expect(active[0].lastError).toBe('send failed');
        });
    });

    // MESH-COMPLEXITY-AUDIT Part 8-2: the recordCompletionConflict /
    // getRecentCompletionConflicts diagnostic (mesh_completion_conflicts table)
    // was removed — write-only, no production reader, no no-loss role — so its
    // tests were removed with it. The fingerprint-dedup DECISION it observed is
    // covered by mesh-events-pending-completion-dedup.test.ts and unchanged.
});
