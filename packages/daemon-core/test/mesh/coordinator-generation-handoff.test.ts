import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// COORD-GENERATION-HANDOFF / NOTIF-LOSS — two coordinator-death defects measured live
// on 2026-09-11, when a coordinator session died twice in one morning and a worker's
// completion notification was lost both times.
//
// Defect 2 (original not preserved): the `strict_route_expired` ledger writer was the
// ONE `event_held` feeder that recorded `recoverable: true` WITHOUT embedding the
// original event as `payload.heldEvent`. mesh_requeue_held_events reconstructs solely
// from that field, so every strict-route expiry came back
// `unrecoverable: no restorable original event` — breaking the tool's documented
// "Lossless: the full original event is restored" contract. Measured: held entry
// ec6cace0 carried a worker's agent:generating_completed and could never be recovered.
//
// Defect 3 (dead target wedges the route): an event addressed to a coordinator session
// that is CONFIRMED dead (a `session_stopped` tombstone) kept riding the 60s TTL hold
// and was then expired — even though a successor coordinator was live the whole time.
// Measured twice: target 270c7cf7 (dead 4 min, successor live since 10:26) and target
// 6b290e86 (dead 13 min, successor live).
//
// ★The dedup invariant these tests pin: reattribution must NOT create a second copy.
// buildPendingEventFingerprint never reads targetCoordinatorSessionId, so the released
// event keeps the SAME fingerprint and stays the SAME row — which is what keeps all
// three dedup layers (pre-insert probe, UNIQUE(mesh_id, fingerprint), durable DUPN)
// matching it. `releases in place (one row, not two)` below is the regression guard.

const testTmpDir = join(tmpdir(), `adhdev-coord-handoff-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    getDaemonDataDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'mach_1b46842a15d3409d96ad33e767a916dd' }),
    getMachineId: () => 'mach_1b46842a15d3409d96ad33e767a916dd',
    getMachineNickname: () => null,
}));

import { holdOrExpireStrictUnmatchedEvent } from '../../src/mesh/mesh-reconcile-coordinator-drain.js';
import {
    queuePendingMeshCoordinatorEvent,
    drainPendingMeshCoordinatorEvents,
    getPendingMeshCoordinatorEvents,
    requeueHeldMeshCoordinatorEvents,
    type PendingMeshCoordinatorEvent,
} from '../../src/mesh/mesh-events-pending.js';
import { appendLedgerEntry, readLedgerEntries } from '../../src/mesh/mesh-ledger.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

const DAEMON_ID = 'mach_1b46842a15d3409d96ad33e767a916dd';

/** A worker completion addressed to a specific coordinator session — the lost class. */
function makeCompletion(
    meshId: string,
    targetCoordinatorSessionId: string,
    opts: { queuedAt?: number; taskId?: string } = {},
): PendingMeshCoordinatorEvent {
    return {
        event: 'agent:generating_completed',
        meshId,
        nodeId: 'node_e05a4e57',
        nodeLabel: 'worker-1',
        targetCoordinatorSessionId,
        targetCoordinatorDaemonId: DAEMON_ID,
        metadataEvent: {
            nodeId: 'node_e05a4e57',
            taskId: opts.taskId ?? 'task-completion-1',
            finalSummary: 'worker finished',
        },
        coordinatorMessage: '[System] worker finished',
        queuedAt: opts.queuedAt ?? Date.now(),
    } as PendingMeshCoordinatorEvent;
}

/** Write the `session_stopped` tombstone that marks a coordinator confirmed dead. */
function tombstoneCoordinator(meshId: string, sessionId: string): void {
    appendLedgerEntry(meshId, {
        kind: 'session_stopped',
        sessionId,
        payload: {
            intentional: false,
            reason: 'external_signal',
            source: 'session_host_tombstone',
            exitCode: 143,
            signal: 15,
            signalName: 'SIGTERM',
            coordinatorSession: true,
        },
    });
}

function freshMeshId(): string {
    return `mesh_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/** Drain the event so it is `drained=1` — the state both hold paths operate on. */
function drainOnce(meshId: string): PendingMeshCoordinatorEvent[] {
    return drainPendingMeshCoordinatorEvents(meshId, DAEMON_ID);
}

describe('strict_route_expired preserves the original event (defect 2)', () => {
    beforeEach(() => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
    });
    // NOTE: the store is a process-wide singleton — closing it here would break every
    // later test in the file. Each test uses a FRESH meshId instead, so rows never
    // collide and no teardown is needed.

    it('embeds heldEvent so a requeue can restore it losslessly', () => {
        const meshId = freshMeshId();
        // Aged past STRICT_SESSION_MATCH_TTL_MS (60s) so the expiry branch is taken,
        // and the target is merely absent (NOT tombstoned) so defect 3's reattribution
        // does not pre-empt the path under test.
        const event = makeCompletion(meshId, 'sess_dead_coordinator', { queuedAt: Date.now() - 120_000 });
        expect(queuePendingMeshCoordinatorEvent(event)).toBe(true);
        drainOnce(meshId);

        holdOrExpireStrictUnmatchedEvent(event, 'sess_dead_coordinator', meshId);

        const held = readLedgerEntries(meshId).filter(e => e.kind === 'event_held');
        expect(held.length).toBe(1);
        expect(held[0].payload.reason).toBe('strict_route_expired');
        expect(held[0].payload.recoverable).toBe(true);

        // The defect: `recoverable: true` with no machine-recovery copy behind it.
        const heldEvent = held[0].payload.heldEvent as PendingMeshCoordinatorEvent | undefined;
        expect(heldEvent, 'strict_route_expired must carry the original event').toBeTruthy();
        expect(heldEvent!.event).toBe('agent:generating_completed');
        expect(heldEvent!.meshId).toBe(meshId);
        // The worker's output is the irreplaceable part — that is why it is recovered.
        expect((heldEvent!.metadataEvent as Record<string, unknown>).taskId).toBe('task-completion-1');

        // Round-trip: the contract is not "a field is present" but "the tool recovers it".
        const result = requeueHeldMeshCoordinatorEvents(meshId, { reason: 'strict_route_expired' });
        expect(result.matched).toBe(1);
        expect(result.unrecoverable, 'no entry may report unrecoverable').toBe(0);
        expect(result.requeued).toBe(1);
        expect(result.entries[0].outcome).toBe('requeued');

        // The recovered event is the SAME event, carrying the worker output that was
        // the whole point of recovering it.
        const recovered = held[0].payload.heldEvent as PendingMeshCoordinatorEvent;
        expect(recovered.nodeId).toBe('node_e05a4e57');
        expect((recovered.metadataEvent as Record<string, unknown>).finalSummary).toBe('worker finished');
        // And a second pass is idempotent — the recovery is marked, not repeatable.
        const second = requeueHeldMeshCoordinatorEvents(meshId, { reason: 'strict_route_expired' });
        expect(second.alreadyRequeued).toBe(1);
        expect(second.requeued).toBe(0);
    });
});

describe('a tombstoned coordinator releases its events (defect 3)', () => {
    beforeEach(() => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
    });
    // NOTE: the store is a process-wide singleton — closing it here would break every
    // later test in the file. Each test uses a FRESH meshId instead, so rows never
    // collide and no teardown is needed.

    it('clears the dead session stamp instead of expiring the event', () => {
        const meshId = freshMeshId();
        const deadSession = 'sess_6b290e86';
        // Aged well past the TTL: pre-fix this is unconditionally expired and dropped.
        const event = makeCompletion(meshId, deadSession, { queuedAt: Date.now() - 300_000 });
        expect(queuePendingMeshCoordinatorEvent(event)).toBe(true);
        // Hold/expire operates on the DRAINED event, which carries the v2 envelope the
        // queue stamped on insert. Passing the hand-built original instead would strip
        // that envelope and the re-queued row would be v2-enforce quarantined — a test
        // artifact, not product behaviour.
        const [drained] = drainOnce(meshId);
        expect(drained, 'the event must drain before it can be held').toBeTruthy();
        tombstoneCoordinator(meshId, deadSession);

        holdOrExpireStrictUnmatchedEvent(drained, deadSession, meshId);

        // Not expired: a confirmed-dead target must not consume the event.
        const expired = readLedgerEntries(meshId)
            .filter(e => e.kind === 'event_held' && e.payload.reason === 'strict_route_expired');
        expect(expired.length, 'a tombstoned target must not expire the event').toBe(0);

        // Released: back in the queue, and no longer addressed to the dead session, so
        // the ordinary session-less rule (daemon-level delivery) now applies to it.
        const pending = getPendingMeshCoordinatorEvents(meshId, [DAEMON_ID]);
        const released = pending.find(e => e.event === 'agent:generating_completed');
        expect(released, 'the event must remain queued').toBeTruthy();
        expect(
            released!.targetCoordinatorSessionId,
            'the dead session stamp must be cleared in the STORED payload, else the next drain re-reads it and loops',
        ).toBeFalsy();
    });

    it('releases in place (one row, not two) so dedup still collapses it', () => {
        // ★The invariant guard. Reattribution must reuse the existing row: a second copy
        // would be delivered twice, which is the exact misroute strict routing prevents.
        const meshId = freshMeshId();
        const deadSession = 'sess_270c7cf7';
        const event = makeCompletion(meshId, deadSession, { queuedAt: Date.now() - 300_000 });
        queuePendingMeshCoordinatorEvent(event);
        const [drained] = drainOnce(meshId); // carries the v2 envelope — see note above
        tombstoneCoordinator(meshId, deadSession);

        holdOrExpireStrictUnmatchedEvent(drained, deadSession, meshId);

        const pending = getPendingMeshCoordinatorEvents(meshId, [DAEMON_ID]);
        const copies = pending.filter(e => e.event === 'agent:generating_completed');
        expect(copies.length, 'exactly one row — a second copy would double-deliver').toBe(1);
        // queuedAt preserved: the row kept its identity and true age rather than being
        // re-enqueued fresh (which would also reset any age-based bound).
        expect(copies[0].queuedAt).toBe(event.queuedAt);

        // Layer 1 of the 3-layer dedup: a re-queue of the same event is suppressed
        // rather than landing a duplicate alongside the released row.
        expect(queuePendingMeshCoordinatorEvent(makeCompletion(meshId, deadSession, {
            queuedAt: event.queuedAt,
        }))).toBe(true);
        const after = getPendingMeshCoordinatorEvents(meshId, [DAEMON_ID])
            .filter(e => e.event === 'agent:generating_completed');
        expect(after.length, 'dedup must still collapse onto the single released row').toBe(1);
    });

    it('still uses the TTL hold when the target is merely absent (not tombstoned)', () => {
        // Regression guard on the conservative half: absence alone (modal-parked, brief
        // restart, not-yet-restored) must NOT trigger release — only a confirmed death
        // does. Without this, the fix would strip session routing from every transient
        // miss and reintroduce the sibling-misroute class.
        const meshId = freshMeshId();
        const event = makeCompletion(meshId, 'sess_parked_but_alive', { queuedAt: Date.now() });
        queuePendingMeshCoordinatorEvent(event);
        drainOnce(meshId);

        holdOrExpireStrictUnmatchedEvent(event, 'sess_parked_but_alive', meshId);

        const pending = getPendingMeshCoordinatorEvents(meshId, [DAEMON_ID]);
        const held = pending.find(e => e.event === 'agent:generating_completed');
        expect(held, 'a live-but-absent target keeps the event held').toBeTruthy();
        expect(
            held!.targetCoordinatorSessionId,
            'strict routing must be preserved for a target that may still return',
        ).toBe('sess_parked_but_alive');
    });
});
