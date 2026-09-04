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
    QUARANTINE_FAILURE_THRESHOLD,
    QUARANTINE_COOLDOWN_MS,
    isMeshQuarantined,
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

/**
 * A SECOND, INDEPENDENT producer of the same terminal notification.
 *
 * ★ Stage 5c-2 renamed this from `outboxDrainInject`. It was written as a
 * field-for-field reproduction of `drainMeshTurnOutbox`'s injection, and 5c-1
 * deleted that drain — but the helper is kept, and kept UNCHANGED on the wire,
 * because what it proves outlived its namesake. The property under test is that
 * a terminal injected by some other path lands on the SAME fingerprint as the
 * redrive's and collapses. Nothing about that depends on which producer built it:
 * `source` and `outboxRedelivery` are not fingerprint inputs, so this payload is
 * still a faithful stand-in for any non-redrive producer (mesh-events-stale, the
 * stranded-dispatch reconciler, a legacy daemon still on the old build).
 *
 * ★ Rewriting it to emit `seqscribe_redelivery` would DESTROY the test: both
 * sides would then be the redrive's own shape and the assertion would degenerate
 * into "redrive collapses onto itself", which the repeated-redrive case already
 * covers. The cross-producer fingerprint equality would go unasserted.
 */
function foreignProducerInject(taskId: string, weak: boolean): boolean {
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

        it(`accepts a ${slot} terminal once when another producer injects first, then redrive`, () => {
            const taskId = nextTaskId();

            expect(foreignProducerInject(taskId, weak)).toBe(true);
            expect(queuedRowsFor(taskId)).toBe(1);

            // The redrive arrives second and must COLLAPSE onto the other
            // producer's delivery. consumeRedriveEntry treats a dedup collapse as
            // delivered (the queue returns true), so it must not throw.
            expect(() => consumeRedriveEntry(MESH, projectedTerminal(taskId, { weak })))
                .not.toThrow();

            expect(queuedRowsFor(taskId), `${slot}: the coordinator must be notified exactly once`)
                .toBe(1);
            const state = getRedriveState(MESH);
            expect(state?.consecutiveFailures).toBe(0);
        });

        it(`accepts a ${slot} terminal once when redrive fires first, then another producer`, () => {
            const taskId = nextTaskId();

            expect(consumeRedriveEntry(MESH, projectedTerminal(taskId, { weak }))).toBe('injected');
            expect(queuedRowsFor(taskId)).toBe(1);

            // ★ The reverse order is the one that proves fingerprint EQUALITY
            // rather than mere acceptance: if the redrive computed a different
            // fingerprint (e.g. by recomputing weakness from evidenceLevel
            // instead of reading the projected `weak`), the foreign producer's
            // injection would land on a DIFFERENT key and add a second row.
            foreignProducerInject(taskId, weak);
            expect(queuedRowsFor(taskId), `${slot}: the foreign producer's injection must collapse onto the redrive's`)
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

    describe('quarantine (Stage 5a-4) — against the real pending queue', () => {
        it('trips after QUARANTINE_FAILURE_THRESHOLD real consecutive failures, then stops throwing', () => {
            const store = MeshRuntimeStore.getInstance();
            const spy = vi.spyOn(store, 'insertPendingEvent')
                .mockImplementation(() => { throw new Error('simulated persist failure'); });
            try {
                for (let i = 0; i < QUARANTINE_FAILURE_THRESHOLD; i++) {
                    expect(() => consumeRedriveEntry(MESH, projectedTerminal(nextTaskId()))).toThrow();
                }
                expect(isMeshQuarantined(MESH)).toBe(true);

                // ★ Load-bearing for the §7.6 archive floor: the seqscribe
                // `onEntry` cursor advances ONLY when the callback resolves
                // (consume.ts). Once quarantined, `consumeRedriveEntry` must
                // NOT throw even though the queue is STILL failing underneath
                // — a throw here would mean quarantine never actually stops
                // pinning the archive floor, defeating the entire feature.
                let outcome: string | undefined;
                expect(() => {
                    outcome = consumeRedriveEntry(MESH, projectedTerminal(nextTaskId()));
                }).not.toThrow();
                expect(outcome).toBe('quarantined');
            } finally {
                spy.mockRestore();
            }
        });

        it('does not attempt the queue at all while quarantined (skip, not a silent retry)', () => {
            const store = MeshRuntimeStore.getInstance();
            const failingSpy = vi.spyOn(store, 'insertPendingEvent')
                .mockImplementation(() => { throw new Error('simulated persist failure'); });
            try {
                for (let i = 0; i < QUARANTINE_FAILURE_THRESHOLD; i++) {
                    expect(() => consumeRedriveEntry(MESH, projectedTerminal(nextTaskId()))).toThrow();
                }
            } finally {
                failingSpy.mockRestore();
            }
            expect(isMeshQuarantined(MESH)).toBe(true);

            // The queue is healthy again, but the mesh is still quarantined —
            // consumeRedriveEntry must skip WITHOUT calling insertPendingEvent,
            // proving quarantine short-circuits before the attempt rather than
            // catching a failure it never tried to avoid.
            const healthySpy = vi.spyOn(store, 'insertPendingEvent');
            try {
                const taskId = nextTaskId();
                expect(consumeRedriveEntry(MESH, projectedTerminal(taskId))).toBe('quarantined');
                expect(healthySpy).not.toHaveBeenCalled();
                expect(queuedRowsFor(taskId)).toBe(0);
            } finally {
                healthySpy.mockRestore();
            }
        });

        it('auto-resolves: half-open probe after cooldown succeeds and clears the streak', () => {
            const store = MeshRuntimeStore.getInstance();
            const spy = vi.spyOn(store, 'insertPendingEvent')
                .mockImplementation(() => { throw new Error('simulated persist failure'); });
            const t0 = Date.now();
            try {
                for (let i = 0; i < QUARANTINE_FAILURE_THRESHOLD; i++) {
                    expect(() => consumeRedriveEntry(MESH, projectedTerminal(nextTaskId()), t0)).toThrow();
                }
            } finally {
                spy.mockRestore();
            }
            expect(isMeshQuarantined(MESH, t0)).toBe(true);

            const afterCooldown = t0 + QUARANTINE_COOLDOWN_MS;
            expect(isMeshQuarantined(MESH, afterCooldown)).toBe(false);

            const taskId = nextTaskId();
            expect(consumeRedriveEntry(MESH, projectedTerminal(taskId), afterCooldown)).toBe('injected');
            expect(queuedRowsFor(taskId)).toBe(1);
            expect(getRedriveState(MESH)!.consecutiveFailures).toBe(0);
            expect(isMeshQuarantined(MESH, afterCooldown)).toBe(false);
        });
    });
});
