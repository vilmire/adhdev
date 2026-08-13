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
    consumeSessionDelivery,
    markSessionDeliveriesTerminal,
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
        it('transitions delivering → queued → delivered (QUEUED-IS-PROGRESS lifecycle)', () => {
            const meshId = `mesh-del-status-${randomUUID().slice(0, 8)}`;
            // Rows are INSERTED as 'delivering' (dispatch in flight); a busy session's
            // adapter buffers the prompt and the confirm reports 'queued' — a forward
            // step, not the FSM floor (it ranked 0 pre-fix and the write was dropped).
            const d = createSessionDelivery({ meshId, sessionId: 'sess-x', kind: 'task', message: 'msg', status: 'delivering' });
            updateSessionDeliveryStatus(d.id, 'queued');
            let active = getActiveSessionDeliveries(meshId, 'sess-x');
            expect(active[0].status).toBe('queued');
            updateSessionDeliveryStatus(d.id, 'delivered');
            // 'delivered' is a terminal-equivalent — not in active list
            active = getActiveSessionDeliveries(meshId, 'sess-x');
            expect(active.length).toBe(0);
        });

        it('queued → delivering is a rank regression and stays a no-op', () => {
            const meshId = `mesh-del-status-regress-${randomUUID().slice(0, 8)}`;
            const d = createSessionDelivery({ meshId, sessionId: 'sess-x', kind: 'task', message: 'msg', status: 'delivering' });
            updateSessionDeliveryStatus(d.id, 'queued');
            updateSessionDeliveryStatus(d.id, 'delivering'); // regress attempt — ignored
            const active = getActiveSessionDeliveries(meshId, 'sess-x');
            expect(active[0].status).toBe('queued');
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

    // ── DELIVERED-NOT-CONSUMED-REDRIVE: monotonic delivery FSM ───────────────
    // Regression for the delivered_not_consumed_redrive bug: a delivery stuck at
    // 'delivered' kept taskDeliveryConsumed() false forever, so an already-completed
    // worker's task was re-driven (same prompt re-injected). The FSM must reach 'acked'
    // in BOTH event orders and never regress.
    describe('monotonic delivery FSM (delivered_not_consumed_redrive regression)', () => {
        const store = () => MeshRuntimeStore.getInstance();

        it('NORMAL order: transport confirm (delivered) THEN generating_started (acked) — reaches acked, consumed=true', () => {
            const meshId = `mesh-fsm-normal-${randomUUID().slice(0, 8)}`;
            const taskId = `task-${randomUUID().slice(0, 8)}`;
            const sessionId = 'sess-normal';
            const d = createSessionDelivery({ meshId, sessionId, taskId, kind: 'task', message: 'm', status: 'delivering' });
            // 1) transport confirm lands first → 'delivered' (the common order).
            updateSessionDeliveryStatus(d.id, 'delivered');
            // Pre-fix: the ack path filtered getActiveSessionDeliveries, which EXCLUDES 'delivered',
            // so acked was never written and consumed stayed false forever. consumeSessionDelivery
            // includes 'delivered'.
            expect(store().taskDeliveryConsumed(meshId, taskId)).toBe(false);
            const advanced = consumeSessionDelivery(meshId, sessionId, 'acked', taskId);
            expect(advanced).toBe(1);
            expect(store().taskDeliveryConsumed(meshId, taskId)).toBe(true);
        });

        it('REVERSE order: generating_started (acked) THEN late transport confirm (delivered) — acked SURVIVES (no clobber)', () => {
            const meshId = `mesh-fsm-reverse-${randomUUID().slice(0, 8)}`;
            const taskId = `task-${randomUUID().slice(0, 8)}`;
            const sessionId = 'sess-reverse';
            const d = createSessionDelivery({ meshId, sessionId, taskId, kind: 'task', message: 'm', status: 'delivering' });
            // 1) generating_started wins the race → 'acked' before the confirm.
            expect(consumeSessionDelivery(meshId, sessionId, 'acked', taskId)).toBe(1);
            expect(store().taskDeliveryConsumed(meshId, taskId)).toBe(true);
            // 2) the LATE transport confirm fires and tries to write 'delivered' by PK. Pre-fix this
            // clobbered 'acked'→'delivered'; the monotonic guard makes it a no-op (2 < 3).
            updateSessionDeliveryStatus(d.id, 'delivered');
            expect(store().taskDeliveryConsumed(meshId, taskId)).toBe(true);
        });

        it('monotonic guard: a plain status write never regresses rank (acked→delivered / delivered→delivering are no-ops)', () => {
            const meshId = `mesh-fsm-guard-${randomUUID().slice(0, 8)}`;
            const d = createSessionDelivery({ meshId, sessionId: 'sess-g', taskId: 't-g', kind: 'task', message: 'm', status: 'delivering' });
            updateSessionDeliveryStatus(d.id, 'acked');
            updateSessionDeliveryStatus(d.id, 'delivered');   // regress attempt — ignored
            updateSessionDeliveryStatus(d.id, 'delivering');  // regress attempt — ignored
            // consumed keys on 'acked'/'completed'; if either regress had applied it would be false.
            expect(store().taskDeliveryConsumed(meshId, 't-g')).toBe(true);
        });

        it('monotonic guard: forward advance still applies (delivering→delivered→acked→completed)', () => {
            const meshId = `mesh-fsm-fwd-${randomUUID().slice(0, 8)}`;
            const d = createSessionDelivery({ meshId, sessionId: 'sess-f', taskId: 't-f', kind: 'task', message: 'm', status: 'delivering' });
            updateSessionDeliveryStatus(d.id, 'delivered');
            expect(store().taskDeliveryConsumed(meshId, 't-f')).toBe(false);
            updateSessionDeliveryStatus(d.id, 'acked');
            expect(store().taskDeliveryConsumed(meshId, 't-f')).toBe(true);
            updateSessionDeliveryStatus(d.id, 'completed');
            expect(store().taskDeliveryConsumed(meshId, 't-f')).toBe(true);
        });

        it('failure states are absorbing: a progress write never resurrects a failed delivery', () => {
            const meshId = `mesh-fsm-fail-${randomUUID().slice(0, 8)}`;
            const d = createSessionDelivery({ meshId, sessionId: 'sess-x', taskId: 't-x', kind: 'task', message: 'm', status: 'delivered' });
            updateSessionDeliveryStatus(d.id, 'failed', { lastError: 'dispatch error', incrementAttempt: true });
            // A stray late 'delivered'/'acked' must NOT revive the dead row.
            updateSessionDeliveryStatus(d.id, 'delivered');
            updateSessionDeliveryStatus(d.id, 'acked');
            expect(store().taskDeliveryConsumed(meshId, 't-x')).toBe(false);
            expect(store().taskHasConfirmedDelivery(meshId, 't-x')).toBe(false);
        });

        // QUEUED-IS-PROGRESS regression: the adapter-buffered confirm ({status:'queued'})
        // used to rank BELOW the initial 'delivering' insert (0 < 1), so the monotonic
        // guard dropped it and the row stuck at 'delivering' forever — taskHasConfirmedDelivery
        // never saw it and the redrive staleness heuristics read a permanent
        // "no confirmed delivery" for a prompt already buffered on the worker.
        it('QUEUED intermediate: an adapter-buffered confirm advances delivering→queued (no longer stuck at delivering)', () => {
            const meshId = `mesh-fsm-queued-${randomUUID().slice(0, 8)}`;
            const d = createSessionDelivery({ meshId, sessionId: 'sess-q', taskId: 't-q', kind: 'task', message: 'm', status: 'delivering' });
            updateSessionDeliveryStatus(d.id, 'queued');
            const row = store().getActiveSessionDeliveries(meshId).find(r => r.id === d.id);
            expect(row?.status).toBe('queued');
        });

        it('QUEUED → flush: the later advance queued→delivered→acked applies (the buffered prompt reaches the PTY / the turn starts)', () => {
            const meshId = `mesh-fsm-flush-${randomUUID().slice(0, 8)}`;
            const taskId = `t-flush-${randomUUID().slice(0, 8)}`;
            const sessionId = 'sess-flush';
            const d = createSessionDelivery({ meshId, sessionId, taskId, kind: 'task', message: 'm', status: 'delivering' });
            updateSessionDeliveryStatus(d.id, 'queued');      // adapter buffered the prompt
            updateSessionDeliveryStatus(d.id, 'delivered');   // adapter flushed it to the PTY
            expect(store().taskHasConfirmedDelivery(meshId, taskId)).toBe(true);
            // The worker's generating_started consumes the delivery straight from 'delivered'.
            expect(consumeSessionDelivery(meshId, sessionId, 'acked', taskId)).toBe(1);
            expect(store().taskDeliveryConsumed(meshId, taskId)).toBe(true);
        });

        it('QUEUED never demotes: delivered→queued is a rank regression and stays a no-op', () => {
            const meshId = `mesh-fsm-qguard-${randomUUID().slice(0, 8)}`;
            const d = createSessionDelivery({ meshId, sessionId: 'sess-qg', taskId: 't-qg', kind: 'task', message: 'm', status: 'delivering' });
            updateSessionDeliveryStatus(d.id, 'delivered');
            updateSessionDeliveryStatus(d.id, 'queued'); // regress attempt — ignored
            // 'delivered' rows leave the active list, so assert via the confirmed-delivery
            // predicate: it would read false had the demotion to 'queued' applied.
            expect(store().taskHasConfirmedDelivery(meshId, 't-qg')).toBe(true);
        });

        it('completion terminal marking includes a delivered row (markSessionDeliveriesTerminal → completed)', () => {
            const meshId = `mesh-fsm-term-${randomUUID().slice(0, 8)}`;
            const sessionId = 'sess-term';
            const d = createSessionDelivery({ meshId, sessionId, taskId: 't-term', kind: 'task', message: 'm', status: 'delivering' });
            updateSessionDeliveryStatus(d.id, 'delivered');
            // Pre-fix: markSessionDeliveriesTerminal routed through getActiveSessionDeliveries which
            // EXCLUDES 'delivered', so the delivered row was never marked terminal and stayed
            // 'delivered'. Now it advances 'delivered'→'completed'.
            markSessionDeliveriesTerminal(meshId, sessionId, 'completed');
            expect(store().taskDeliveryConsumed(meshId, 't-term')).toBe(true);
        });

        it('consume matches by (mesh, task) even when the session id carries whitespace skew', () => {
            const meshId = `mesh-fsm-skew-${randomUUID().slice(0, 8)}`;
            const d = createSessionDelivery({ meshId, sessionId: 'sess-skew', taskId: 't-skew', kind: 'task', message: 'm', status: 'delivered' });
            void d;
            // generating_started reinterprets the session id with a trailing space — sessionIdsEquivalent
            // trims both sides, so the (mesh, task) consume still lands on the right row.
            expect(consumeSessionDelivery(meshId, ' sess-skew ', 'acked', 't-skew')).toBe(1);
            expect(store().taskDeliveryConsumed(meshId, 't-skew')).toBe(true);
        });
    });

    // MESH-COMPLEXITY-AUDIT Part 8-2: the recordCompletionConflict /
    // getRecentCompletionConflicts diagnostic (mesh_completion_conflicts table)
    // was removed — write-only, no production reader, no no-loss role — so its
    // tests were removed with it. The fingerprint-dedup DECISION it observed is
    // covered by mesh-events-pending-completion-dedup.test.ts and unchanged.
});
