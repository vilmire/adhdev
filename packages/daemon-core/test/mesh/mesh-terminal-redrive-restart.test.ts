// Stage 5c-2 — the redrive leg's RESTART behaviour, against the real pending queue.
//
// ★ Why this file exists. Stage 5c-1 deleted the `turn ledger — durable outbox /
// restart delivery` describe block from mesh-turn-ledger.test.ts along with the
// `mesh_turn_outbox` table it asserted against. That block held two invariants
// that are NOT specific to the outbox — they are properties of "a completion is
// notified exactly once even though the process restarts", and the outbox was
// merely the implementation that carried them. 5c-1 marked both as owed here:
//
//   · exactly-once ACROSS A RESTART — the durable cursor resuming mid-topic must
//     not re-notify a terminal the coordinator already drained. (Was: "re-enqueue
//     after a crash replay is exactly-once, INSERT OR IGNORE".)
//   · observable permanent failure — see the sibling status-meta suite, which
//     owns the quarantine-reporting half.
//
// ★ What makes this DIFFERENT from mesh-terminal-redrive.test.ts, which already
// asserts that a repeated `consumeRedriveEntry` collapses. That suite replays
// against a pending row that is still SITTING in the queue, so the UNIQUE
// (mesh_id, fingerprint) index alone is enough to collapse it. The restart case
// is the one where that index CANNOT help: the coordinator drained the event, the
// row was pruned or hard-deleted, and the fingerprint slot is free again. What
// must catch the replay then is the DURABLE dedup record (`pending::<fingerprint>`,
// DUPNOTIF-DURABLE gap_b). A suite that only replays against a live row is green
// even with that record entirely broken — which is precisely the vacuous green the
// deleted outbox block was protecting against.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Same per-file isolated config dir convention as the sibling redrive suite.
const testTmpDir = join(tmpdir(), `adhdev-redrive-restart-test-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

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
import {
    drainPendingMeshCoordinatorEvents,
} from '../../src/mesh/mesh-events-pending.js';
import {
    consumeRedriveEntry,
    getRedriveState,
    __resetTerminalRedriveForTests,
    type RedriveProjectedEntry,
} from '../../src/mesh/mesh-terminal-redrive.js';

const MESH = `mesh-restart-${randomUUID().slice(0, 8)}`;

/**
 * Drain the way the coordinator actually sees a redrive injection.
 *
 * ★ No coordinator-id filter, deliberately. `buildRedriveInjection` does not set
 * `targetCoordinatorDaemonId` — a re-armed terminal is a broadcast, because the
 * redrive leg replays a projected ledger entry and has no notion of which
 * coordinator is currently attached. Passing a daemon id here would filter the
 * row out and every assertion below would read zero for the wrong reason,
 * turning the whole suite green-by-accident in the "already surfaced" direction
 * and red-by-accident in the "still surfaces" one.
 */
function drainAsCoordinator() {
    return drainPendingMeshCoordinatorEvents(MESH);
}

let taskSeq = 0;
function nextTaskId(): string {
    taskSeq += 1;
    return `task-${randomUUID().slice(0, 8)}-${taskSeq}`;
}

function projectedTerminal(taskId: string, opts?: { weak?: boolean }): RedriveProjectedEntry {
    return {
        id: `entry-${taskId}`,
        ledgerKind: 'task_completed',
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
 * Restart the daemon's view of the world.
 *
 * ★ Only the in-memory handle is dropped — the SQLite file under testConfigDir
 * survives, which is the whole point: what must carry the exactly-once guarantee
 * across a restart is the DURABLE state, not anything this process is holding.
 * The redrive module's per-mesh counters are process-local and are reset too, so
 * a post-restart assertion cannot accidentally read pre-restart bookkeeping.
 */
function simulateRestart(): void {
    MeshRuntimeStore.resetForTests();
    __resetTerminalRedriveForTests();
}

/**
 * The seqscribe durable cursor replays the last entry when the process dies
 * between the handler's side effect and the cursor commit (at-least-once — see
 * mesh-terminal-redrive-consumer.ts: the cursor advances only after the callback
 * RESOLVES). This is that replay: the same projected entry, delivered again to a
 * freshly booted consumer.
 */
function replayAfterRestart(entry: RedriveProjectedEntry): 'injected' | 'skipped' | 'quarantined' {
    simulateRestart();
    return consumeRedriveEntry(MESH, entry);
}

beforeEach(() => {
    __resetTerminalRedriveForTests();
});

afterEach(() => {
    MeshRuntimeStore.resetForTests();
    try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('terminal redrive — exactly-once across a restart (Stage 5c-2, replacing the deleted outbox restart block)', () => {
    for (const weak of [true, false]) {
        const slot = weak ? 'weak' : 'genuine';

        it(`does NOT re-notify a ${slot} terminal the coordinator already drained before the restart`, () => {
            const taskId = nextTaskId();
            const entry = projectedTerminal(taskId, { weak });

            // 1. The redrive arms the terminal and the coordinator consumes it.
            expect(consumeRedriveEntry(MESH, entry)).toBe('injected');
            expect(drainAsCoordinator()).toHaveLength(1);

            // 2. The drained row is then freed — this is what makes the case real
            //    rather than a repeat of the live-row collapse the sibling suite
            //    covers. Retention prunes drained rows, and the unresolved-delegate
            //    outbox hard-deletes by id; either way the UNIQUE (mesh_id,
            //    fingerprint) index no longer has anything to collide with.
            MeshRuntimeStore.getInstance()
                .prunePendingEvents({ drainedOlderThanMs: 0, undrainedOlderThanMs: 0 });

            // 3. The daemon restarts and the durable cursor replays the entry.
            //    ★ The ONLY thing that can stop a second [System] completion
            //    reaching the coordinator now is the durable dedup record.
            expect(() => replayAfterRestart(entry)).not.toThrow();

            expect(
                drainAsCoordinator(),
                `${slot}: a post-restart replay of an already-drained terminal must not surface again`,
            ).toHaveLength(0);
        });
    }

    it('keeps the weak/genuine slots distinct across a restart — a genuine terminal is not swallowed by an earlier weak one', () => {
        const taskId = nextTaskId();

        // A weak (false-idle) terminal is re-armed and drained, then its row freed.
        expect(consumeRedriveEntry(MESH, projectedTerminal(taskId, { weak: true }))).toBe('injected');
        expect(drainAsCoordinator()).toHaveLength(1);
        MeshRuntimeStore.getInstance()
            .prunePendingEvents({ drainedOlderThanMs: 0, undrainedOlderThanMs: 0 });

        simulateRestart();

        // ★ The Fix C weak-supersede contract, restated across a restart. The
        // durable record must be keyed tightly enough that the GENUINE terminal
        // for the same task still gets through — a dedup that collapsed on taskId
        // alone would pass every assertion in the block above while silently
        // losing every real completion that followed a false-idle one.
        expect(consumeRedriveEntry(MESH, projectedTerminal(taskId))).toBe('injected');
        expect(
            drainAsCoordinator(),
            'the genuine terminal must still surface after a restart that followed a weak one',
        ).toHaveLength(1);
    });

    it('a replay whose original was never drained still collapses (restart mid-flight, not post-delivery)', () => {
        const taskId = nextTaskId();
        const entry = projectedTerminal(taskId);

        // The process dies AFTER the injection but BEFORE the coordinator drained
        // it. The row is still pending, so the coordinator has been told exactly
        // once and must stay told exactly once.
        expect(consumeRedriveEntry(MESH, entry)).toBe('injected');

        expect(() => replayAfterRestart(entry)).not.toThrow();

        expect(
            drainAsCoordinator(),
            'the mid-flight replay must collapse onto the still-pending row, not queue a second',
        ).toHaveLength(1);
    });

    it('the cursor is HELD (throws) when a post-restart replay cannot be persisted', () => {
        const taskId = nextTaskId();
        const entry = projectedTerminal(taskId);
        expect(consumeRedriveEntry(MESH, entry)).toBe('injected');
        expect(drainAsCoordinator()).toHaveLength(1);

        simulateRestart();

        // ★ The failure direction of the same guarantee. If the post-restart
        // replay cannot reach the queue at all, the handler MUST throw so the
        // durable cursor stays put and the entry is retried. Swallowing here
        // would convert a failed redelivery into a delivered one — silently, and
        // permanently, since the cursor never comes back.
        const store = MeshRuntimeStore.getInstance();
        const spy = vi.spyOn(store, 'insertPendingEvent')
            .mockImplementation(() => { throw new Error('simulated persist failure'); });
        try {
            expect(() => consumeRedriveEntry(MESH, projectedTerminal(nextTaskId()))).toThrow();
            expect(getRedriveState(MESH)!.consecutiveFailures).toBeGreaterThan(0);
        } finally {
            spy.mockRestore();
        }
    });
});
