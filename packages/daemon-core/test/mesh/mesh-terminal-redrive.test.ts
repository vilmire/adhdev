// Stage 5a-2 — the terminal redrive consumer, against the REAL pending queue.
//
// The root gate (tests/seqscribe-terminal-redrive.test.mjs) proves the cursor
// name is GC-safe and that the injection carries the same fingerprint-bearing
// fields the outbox drain builds. That is a field-level comparison and cannot,
// by construction, prove the two actually COLLAPSE — the fingerprint is computed
// inside the pending queue, so only a real queue can answer that.
//
// This suite drives the real SQLite-backed pending queue:
//
//   · dual injection (redrive + outbox drain) of the same terminal is accepted
//     ONCE, for both the weak and the genuine case
//   · a rejected injection THROWS, so the durable cursor is held and the entry
//     is retried rather than silently marked delivered
//   · repeated redrive of the same entry (at-least-once redelivery) collapses
//
// ★ Why both a weak and a genuine case: the fingerprint keys terminals
// `…::weak` / `…::genuine`. A dedup test that only exercises one slot passes
// even if the weak derivation is wrong — the very defect Stage 5a-1 exists to
// prevent. Running both is what makes the slot boundary observable.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Same per-file isolated config dir convention as the sibling turn-ledger
// suites — a dedicated mesh-runtime.db keeps this suite's queue rows free of
// other suites' rows.
const testTmpDir = join(tmpdir(), `adhdev-terminal-redrive-test-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

// Partial mock: only the config DIR is redirected. The pending queue also calls
// loadConfig() (for machineId, via stampPendingEventV2), so the rest of the
// module must stay real — a bare object mock makes the queue throw before dedup
// is ever exercised.
vi.mock('../../src/config/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/config/config.js')>();
    return {
        ...actual,
        getConfigDir: () => {
            if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
            return testConfigDir;
        },
    };
});

import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { queuePendingMeshCoordinatorEvent } from '../../src/mesh/mesh-events-pending.js';
import {
    buildRedriveInjection,
    consumeRedriveEntry,
    getRedriveState,
    __resetTerminalRedriveForTests,
    type RedriveProjectedEntry,
} from '../../src/mesh/mesh-terminal-redrive.js';

const MESH = `mesh-${randomUUID().slice(0, 8)}`;
let taskSeq = 0;
function nextTaskId(): string {
    taskSeq += 1;
    return `task-${randomUUID().slice(0, 8)}-${taskSeq}`;
}

function projectedTerminal(taskId: string, opts?: { weak?: boolean; kind?: string }): RedriveProjectedEntry {
    return {
        id: `entry-${taskId}`,
        ledgerKind: opts?.kind ?? 'task_completed',
        nodeId: 'node-redrive',
        sessionId: 'sess-redrive',
        providerType: 'claude',
        taskId,
        payload: {
            taskId,
            event: 'agent:generating_completed',
            ...(opts?.weak ? { weak: true } : {}),
        },
    };
}

/**
 * Rows actually queued for a task — the real measure of "the coordinator is
 * notified once".
 *
 * ★ Not the boolean from queuePendingMeshCoordinatorEvent: a dedup COLLAPSE
 * returns `true` ("already delivered"), the same as a fresh insert, because the
 * drain's contract is "a redelivery that collapses onto the original is still
 * delivered". So the return value cannot distinguish collapse from duplication —
 * only the row count can.
 */
function queuedRowsFor(taskId: string): number {
    const store = MeshRuntimeStore.getInstance() as unknown as {
        db: { prepare: (sql: string) => { get: (...a: unknown[]) => unknown } };
    };
    // Count by FINGERPRINT — the key dedup actually collapses on. Both paths
    // must land on `<mesh>::<event>::<taskId>::<weak|genuine>`, so a count of 2
    // for one task means the two paths disagreed and the coordinator was told
    // twice; that is exactly the regression this suite exists to catch.
    const row = store.db
        .prepare("SELECT COUNT(*) AS n FROM mesh_pending_events WHERE mesh_id = ? AND fingerprint LIKE ?")
        .get(MESH, `%::${taskId}::%`) as { n: number };
    return row.n;
}

/** The injection drainMeshTurnOutbox performs, reproduced field-for-field. */
function outboxDrainInject(taskId: string, weak: boolean): boolean {
    return queuePendingMeshCoordinatorEvent({
        event: 'agent:generating_completed',
        meshId: MESH,
        nodeId: 'node-redrive',
        metadataEvent: {
            taskId,
            sessionId: 'sess-redrive',
            providerType: 'claude',
            ...(weak ? { evidenceLevel: 'insufficient' } : {}),
            source: 'turn_outbox_redelivery',
            outboxRedelivery: true,
        },
        queuedAt: Date.now(),
    } as any);
}

beforeEach(() => {
    __resetTerminalRedriveForTests();
});

afterEach(() => {
    MeshRuntimeStore.resetForTests();
    try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('terminal redrive — dual drive against the real pending queue (Stage 5a-2)', () => {
    for (const weak of [true, false]) {
        const slot = weak ? 'weak' : 'genuine';

        it(`accepts a ${slot} terminal once when the outbox drains first, then redrive`, () => {
            const taskId = nextTaskId();

            expect(outboxDrainInject(taskId, weak)).toBe(true);
            expect(queuedRowsFor(taskId)).toBe(1);

            // The redrive arrives second and must COLLAPSE onto the outbox's
            // delivery. consumeRedriveEntry treats a dedup collapse as delivered
            // (the queue returns true), so it must not throw.
            expect(() => consumeRedriveEntry(MESH, projectedTerminal(taskId, { weak })))
                .not.toThrow();

            expect(queuedRowsFor(taskId), `${slot}: the coordinator must be notified exactly once`)
                .toBe(1);
            const state = getRedriveState(MESH);
            expect(state?.consecutiveFailures).toBe(0);
        });

        it(`accepts a ${slot} terminal once when redrive fires first, then the outbox`, () => {
            const taskId = nextTaskId();

            expect(consumeRedriveEntry(MESH, projectedTerminal(taskId, { weak }))).toBe('injected');
            expect(queuedRowsFor(taskId)).toBe(1);

            // ★ The reverse order is the one that proves fingerprint EQUALITY
            // rather than mere acceptance: if the redrive computed a different
            // fingerprint (e.g. by recomputing weakness from evidenceLevel
            // instead of reading the projected `weak`), this outbox injection
            // would land on a DIFFERENT key and add a second row.
            outboxDrainInject(taskId, weak);
            expect(queuedRowsFor(taskId), `${slot}: the outbox injection must collapse onto the redrive's`)
                .toBe(1);
        });

        it(`collapses a repeated ${slot} redrive of the same entry (at-least-once redelivery)`, () => {
            const taskId = nextTaskId();
            const entry = projectedTerminal(taskId, { weak });

            expect(consumeRedriveEntry(MESH, entry)).toBe('injected');
            // onEntry redelivers after a restart or a failed callback; the second
            // pass must not throw (which would hold the cursor forever) and must
            // not produce a second coordinator notification.
            expect(() => consumeRedriveEntry(MESH, entry)).not.toThrow();
            expect(queuedRowsFor(taskId)).toBe(1);
        });
    }

    it('holds the cursor when the queue rejects the injection', () => {
        const taskId = nextTaskId();
        // Deliver once so the fingerprint is already present...
        expect(consumeRedriveEntry(MESH, projectedTerminal(taskId))).toBe('injected');

        // ...then force a rejection to prove the failure path throws rather than
        // reporting success. A non-throwing failure would advance the durable
        // cursor and silently drop the redelivery guarantee.
        // ★ The mock THROWS rather than returning false: persistPendingMeshCoordinatorEvent
        // ignores insertPendingEvent's return value and signals failure only by
        // catching a throw (mesh-events-pending.ts). A false-returning mock is
        // reported as a successful queue, so it would test nothing.
        const store = MeshRuntimeStore.getInstance();
        const spy = vi.spyOn(store, 'insertPendingEvent')
            .mockImplementation(() => { throw new Error('simulated persist failure'); });
        try {
            expect(() => consumeRedriveEntry(MESH, projectedTerminal(nextTaskId())))
                .toThrow();
            const state = getRedriveState(MESH);
            expect(state!.consecutiveFailures).toBeGreaterThan(0);
            expect(state!.lastFailureAt).not.toBeNull();
        } finally {
            spy.mockRestore();
        }
    });

    it('skips (does not retry) entries it must never re-arm', () => {
        // A skip advances the cursor: these are not transient failures, and
        // holding the cursor on one would stall every later terminal behind it.
        expect(consumeRedriveEntry(MESH, projectedTerminal(nextTaskId(), { kind: 'task_dispatched' })))
            .toBe('skipped');
        expect(consumeRedriveEntry(MESH, projectedTerminal(nextTaskId(), { kind: 'task_stalled' })))
            .toBe('skipped');

        const taskless = projectedTerminal(nextTaskId());
        taskless.taskId = null;
        delete (taskless.payload as Record<string, unknown>).taskId;
        expect(consumeRedriveEntry(MESH, taskless)).toBe('skipped');

        const state = getRedriveState(MESH);
        expect(state?.skipped).toBe(3);
        expect(state?.injected).toBe(0);
    });

    it('derives the weak discriminator from the projected `weak`, not from evidenceLevel', () => {
        // The Stage 5a-1 dependency, asserted at the injection layer: an entry
        // whose projected payload says weak must be stamped insufficient, and an
        // entry without it must not be — regardless of any other field.
        const weakInjection = buildRedriveInjection(MESH, projectedTerminal(nextTaskId(), { weak: true }));
        expect(weakInjection!.metadataEvent.evidenceLevel).toBe('insufficient');

        const genuineInjection = buildRedriveInjection(MESH, projectedTerminal(nextTaskId()));
        expect(genuineInjection!.metadataEvent).not.toHaveProperty('evidenceLevel');
    });
});
