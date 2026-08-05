import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Per-file isolated config dir → per-file mesh-runtime.db (same convention as
// mesh-turn-ledger.test.ts / mesh-turn-orphan-attempt.test.ts).
const testTmpDir = join(tmpdir(), `adhdev-turn-queue-terminal-test-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
}));

import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import {
    openTurnAttempt,
    recordTurnAck,
    recordTurnStage,
    reclaimQueueTerminatedTurnAttempts,
    SUPERSEDED_BY_QUEUE_TERMINAL_REASON,
} from '../../src/mesh/mesh-turn-ledger.js';

// STORE-CONTRAST-CLOSURE (RCA 2b3d260d) — an attempt is nonterminal while its
// task's mesh_queue row already reads completed/failed/cancelled: independent
// evidence "the work is actually done" that this sweep closes on. Measured on
// the live ledger: 14 of 735 nonterminal attempts match, only 2 of 721
// `delivered`-stage rows — a live turn is essentially never caught.
//
// Distinct from mesh-turn-orphan-attempt.test.ts's seq-supersession sweep:
// that one only ever closes a NON-current row (a newer attempt exists). This
// one routinely closes the SOLE/current attempt of a task — the queue
// evidence, not attempt_seq, is what proves it is safe.

const MESH = 'mesh_queue_terminal_test';

function store(): MeshRuntimeStore {
    return MeshRuntimeStore.getInstance();
}

function seedQueueRow(taskId: string, status: string): void {
    const nowIso = new Date().toISOString();
    store().insertQueueEntry({
        id: taskId,
        meshId: MESH,
        message: 'test task',
        status: status as never,
        createdAt: nowIso,
        updatedAt: nowIso,
    });
}

/** A single (current, sole) attempt at the given stage — no orphan sibling. */
function seedSoleAttempt(taskId: string, sessionId: string, stage: string): string {
    const { attempt } = openTurnAttempt({ meshId: MESH, taskId, dispatchNonce: 1, sessionId });
    recordTurnAck({ meshId: MESH, taskId, kind: 'delivered', attemptId: attempt.attemptId, sessionId });
    if (stage !== 'delivered') {
        recordTurnAck({ meshId: MESH, taskId, kind: 'consumed', attemptId: attempt.attemptId, sessionId });
        if (stage !== 'consumed') recordTurnStage({ meshId: MESH, taskId, stage: stage as never, attemptId: attempt.attemptId, sessionId });
    }
    return attempt.attemptId;
}

describe('store-contrast closure — attempts whose queue row already finished', () => {
    beforeEach(() => {
        __resetStore();
    });

    afterAll(() => {
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* noop */ }
    });

    function __resetStore(): void {
        try {
            const db = (store() as any).db;
            db.prepare('DELETE FROM mesh_turn_attempts').run();
            db.prepare('DELETE FROM mesh_turn_events').run();
            db.prepare('DELETE FROM mesh_queue').run();
        } catch { /* fresh db */ }
    }

    // ── Contract 1 — closes when the queue independently proved completion ──
    it('closes a nonterminal attempt as cancelled/superseded_by_queue_terminal when its queue row already completed', () => {
        const taskId = randomUUID();
        const attemptId = seedSoleAttempt(taskId, `sess_${randomUUID().slice(0, 8)}`, 'waiting_choice');
        seedQueueRow(taskId, 'cancelled'); // mirrors the confirmed live case (3dbb90a7)
        expect(store().getTurnAttempt(attemptId)?.terminalOutcome).toBeNull();

        const result = reclaimQueueTerminatedTurnAttempts(MESH);

        expect(result.closed).toBe(1);
        const closed = store().getTurnAttempt(attemptId);
        expect(closed?.terminalOutcome).toBe('cancelled');
        expect(closed?.terminalReason).toBe(SUPERSEDED_BY_QUEUE_TERMINAL_REASON);
        expect(closed?.terminalAt).toBeTruthy();
    });

    it('closes the SOLE (current) attempt of a task — unlike the seq-supersession sweep, current-ness is not a shield here', () => {
        const taskId = randomUUID();
        const attemptId = seedSoleAttempt(taskId, `sess_${randomUUID().slice(0, 8)}`, 'generating');
        seedQueueRow(taskId, 'completed');

        expect(reclaimQueueTerminatedTurnAttempts(MESH).closed).toBe(1);
        expect(store().getTurnAttempt(attemptId)?.terminalOutcome).toBe('cancelled');
    });

    it('reports a failed queue row and a cancelled queue row as closures too, not only completed', () => {
        for (const queueStatus of ['completed', 'failed', 'cancelled']) {
            const taskId = randomUUID();
            const attemptId = seedSoleAttempt(taskId, `sess_${randomUUID().slice(0, 8)}`, 'generating');
            seedQueueRow(taskId, queueStatus);
            expect(reclaimQueueTerminatedTurnAttempts(MESH).closed).toBe(1);
            expect(store().getTurnAttempt(attemptId)?.terminalOutcome).toBe('cancelled');
        }
    });

    // ── Contract 2 — ★safety boundary: no matching queue row → untouched ────
    it('never closes an attempt whose task has NO matching queue row (NULL — nothing to contrast against)', () => {
        const taskId = randomUUID();
        const attemptId = seedSoleAttempt(taskId, `sess_${randomUUID().slice(0, 8)}`, 'generating');
        // Deliberately no seedQueueRow(taskId, ...) call.

        const result = reclaimQueueTerminatedTurnAttempts(MESH);

        expect(result.closed).toBe(0);
        expect(store().getTurnAttempt(attemptId)?.terminalOutcome).toBeNull();
    });

    // ── Contract 3 — ★safety boundary: queue still active → untouched ───────
    it('never closes an attempt whose queue row is still pending', () => {
        const taskId = randomUUID();
        const attemptId = seedSoleAttempt(taskId, `sess_${randomUUID().slice(0, 8)}`, 'generating');
        seedQueueRow(taskId, 'pending');

        const result = reclaimQueueTerminatedTurnAttempts(MESH);

        expect(result.closed).toBe(0);
        expect(store().getTurnAttempt(attemptId)?.terminalOutcome).toBeNull();
    });

    it('never closes an attempt whose queue row is still assigned', () => {
        const taskId = randomUUID();
        const attemptId = seedSoleAttempt(taskId, `sess_${randomUUID().slice(0, 8)}`, 'waiting_approval');
        seedQueueRow(taskId, 'assigned');

        const result = reclaimQueueTerminatedTurnAttempts(MESH);

        expect(result.closed).toBe(0);
        expect(store().getTurnAttempt(attemptId)?.terminalOutcome).toBeNull();
    });

    // ── Contract 4 — an attempt already terminal is left alone / not double-counted ─
    it('does not touch an attempt that is already terminal', () => {
        const taskId = randomUUID();
        const sessionId = `sess_${randomUUID().slice(0, 8)}`;
        const attemptId = seedSoleAttempt(taskId, sessionId, 'generating');
        seedQueueRow(taskId, 'completed');
        // Close it through the normal path first.
        store().commitTurnAttemptTerminal(attemptId, 'completed', 'provider_event', new Date().toISOString());

        const result = reclaimQueueTerminatedTurnAttempts(MESH);

        expect(result.closed).toBe(0); // terminal_outcome IS NULL already false — excluded from the scan
        expect(store().getTurnAttempt(attemptId)?.terminalOutcome).toBe('completed'); // untouched, not overwritten
    });

    // ── Contract 5 — idempotency ──────────────────────────────────────────
    it('is idempotent — a second sweep closes nothing further', () => {
        const taskId = randomUUID();
        seedSoleAttempt(taskId, `sess_${randomUUID().slice(0, 8)}`, 'waiting_choice');
        seedQueueRow(taskId, 'cancelled');

        expect(reclaimQueueTerminatedTurnAttempts(MESH).closed).toBe(1);
        expect(reclaimQueueTerminatedTurnAttempts(MESH).closed).toBe(0);
    });

    it('establishes the contract at scale: several queue-terminated attempts across tasks are all closed, live ones are not', () => {
        const liveIds: string[] = [];
        for (let i = 0; i < 3; i += 1) {
            const taskId = randomUUID();
            liveIds.push(seedSoleAttempt(taskId, `sess_live_${i}`, 'generating'));
            seedQueueRow(taskId, 'assigned'); // still live — must survive
        }
        const closedTaskIds: string[] = [];
        for (let i = 0; i < 4; i += 1) {
            const taskId = randomUUID();
            seedSoleAttempt(taskId, `sess_done_${i}`, 'waiting_approval');
            seedQueueRow(taskId, i % 2 === 0 ? 'completed' : 'failed');
            closedTaskIds.push(taskId);
        }
        expect(store().listQueueTerminatedNonterminalTurnAttempts(MESH)).toHaveLength(4);

        const result = reclaimQueueTerminatedTurnAttempts(MESH);

        expect(result.closed).toBe(4);
        expect(store().listQueueTerminatedNonterminalTurnAttempts(MESH)).toHaveLength(0);
        for (const attemptId of liveIds) {
            expect(store().getTurnAttempt(attemptId)?.terminalOutcome).toBeNull();
        }
    });
});
