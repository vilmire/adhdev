import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';

// B2a — mesh protocol v2 emit stamping. queuePendingMeshCoordinatorEvent stamps the
// v2 envelope (protocolVersion / eventId / scope / dispatchedBy / intendedFor) at emit
// time, persisting it to BOTH the SQLite payload+columns and the JSONL file. The stamp
// is a strict superset of the v1 event shape, so a v1 reader (drain/peek, which return
// PendingMeshCoordinatorEvent) reads a v2 row unchanged. Events with no coordinator
// identity stay v1 (unstamped). This suite locks all of that plus store-column
// back-compat (a pre-v2 DB missing the columns must migrate + read as v1).

const testTmpDir = join(tmpdir(), `adhdev-mesh-v2-stamp-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');
const runtimeRequire = createRequire(import.meta.url);

const SELF_MACH = 'mach_self0000000000000000000000000000';

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    // The self-daemon fallback in stampPendingEventV2 reads loadConfig().machineId when
    // an event carries no coordinator identity, so the emit path can still mint a v2
    // broadcast envelope (instead of leaving the event unversioned → enforce-quarantined).
    loadConfig: () => ({ machineId: SELF_MACH }),
}));

import {
    queuePendingMeshCoordinatorEvent,
    stampPendingEventV2,
    getPendingMeshCoordinatorEvents,
    drainPendingMeshCoordinatorEvents,
    __clearMeshPendingEventsForTests,
    type PendingMeshCoordinatorEvent,
} from '../../src/mesh/mesh-events-pending.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { getLedgerDir } from '../../src/mesh/mesh-ledger.js';

const MACH = 'mach_1b46842a15d3409d96ad33e767a916dd';
const OTHER_MACH = 'mach_ffffffffffffffffffffffffffffffff';

function makeTerminal(meshId: string, over: Partial<PendingMeshCoordinatorEvent> = {}): PendingMeshCoordinatorEvent {
    return {
        event: 'agent:generating_completed',
        meshId,
        nodeLabel: "Node 'node_bf91'",
        nodeId: 'node_bf91',
        metadataEvent: { nodeId: 'node_bf91', sessionId: randomUUID(), timestamp: Date.now() },
        coordinatorMessage: 'done',
        queuedAt: Date.now(),
        targetCoordinatorDaemonId: MACH,
        ...over,
    };
}

/** Open the live runtime DB directly to inspect the v2 columns (which the v1
 *  reader path deliberately doesn't surface). */
function openDb(): any {
    const Database = runtimeRequire('better-sqlite3') as any;
    return new Database(join(getLedgerDir(), 'mesh-runtime.db'));
}

describe('mesh pending-event — v2 emit stamping (B2a)', () => {
    beforeEach(() => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
    });

    afterEach(() => {
        try { MeshRuntimeStore.resetForTests(); } catch { /* best-effort */ }
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('stamps protocolVersion/eventId/scope/dispatchedBy on a terminal event, routing it unicast', () => {
        const meshId = `mesh-v2-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        queuePendingMeshCoordinatorEvent(makeTerminal(meshId));

        const [peeked] = getPendingMeshCoordinatorEvents(meshId, MACH) as PendingMeshCoordinatorEvent[];
        expect(peeked).toBeTruthy();
        expect(peeked.protocolVersion).toBe('2.0');
        expect(typeof peeked.eventId).toBe('string');
        expect(peeked.eventId!.length).toBeGreaterThan(0);
        // Terminal task event → unicast, addressed back to the originating coordinator.
        expect(peeked.scope).toBe('unicast');
        expect(peeked.dispatchedBy?.daemonId).toBe(MACH);
        expect(peeked.intendedFor?.daemonId).toBe(MACH);
        // Session id from the target is folded into the identity when present.
        expect(peeked.dispatchedBy?.sessionId).toBeUndefined();
    });

    it('carries targetCoordinatorSessionId into the stamped identity', () => {
        const meshId = `mesh-v2-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        const sessionId = `sess_${randomUUID().slice(0, 8)}`;
        queuePendingMeshCoordinatorEvent(makeTerminal(meshId, { targetCoordinatorSessionId: sessionId }));

        const [peeked] = getPendingMeshCoordinatorEvents(meshId, MACH) as PendingMeshCoordinatorEvent[];
        expect(peeked.dispatchedBy?.sessionId).toBe(sessionId);
        expect(peeked.intendedFor?.sessionId).toBe(sessionId);
    });

    it('defaults a node-lifecycle event to broadcast scope (no unicast target required)', () => {
        const meshId = `mesh-v2-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        queuePendingMeshCoordinatorEvent(makeTerminal(meshId, {
            event: 'node_joined',
            coordinatorMessage: 'node joined',
        }));

        const [peeked] = getPendingMeshCoordinatorEvents(meshId, MACH) as PendingMeshCoordinatorEvent[];
        expect(peeked.protocolVersion).toBe('2.0');
        expect(peeked.scope).toBe('broadcast');
        expect(peeked.intendedFor).toBeUndefined();
    });

    it('stamps a v2 BROADCAST envelope via the self-daemon fallback when no coordinator identity is present', () => {
        // A/C root fix: an event with no targetCoordinatorDaemonId (direct-dispatch /
        // refine notification) used to stay UNVERSIONED (v1) and, under v2 enforce
        // (default ON), get QUARANTINED — the completion/notification never reached the
        // coordinator. It now falls back to THIS daemon's own id as the dispatcher and
        // downgrades the (unicast-defaulting) terminal event to a BROADCAST so it is
        // still deliverable to whatever coordinator drains on this machine.
        //
        // MAGI-REPLICA-COMPLETION-EVENT-LEAK: the STAMP is still a broadcast (the
        // self-fallback has no owner session to address), but the DRAIN now filters a
        // terminal broadcast by dispatchedBy — so it is delivered only to a coordinator
        // on the SAME machine (the dispatching self daemon), not fanned out to every
        // coordinator on every machine. Peek from the self machine to see it.
        const meshId = `mesh-v2-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        const noIdentity = makeTerminal(meshId);
        delete (noIdentity as any).targetCoordinatorDaemonId; // no coordinator identity to derive
        queuePendingMeshCoordinatorEvent(noIdentity);

        const [peeked] = getPendingMeshCoordinatorEvents(meshId, SELF_MACH) as PendingMeshCoordinatorEvent[];
        expect(peeked).toBeTruthy();
        // No longer v1: a v2 envelope is minted from the self-daemon id.
        expect(peeked.protocolVersion).toBe('2.0');
        expect(typeof peeked.eventId).toBe('string');
        expect(peeked.eventId!.length).toBeGreaterThan(0);
        // Broadcast (not self-unicast) so a sibling session's drainer never skips it.
        expect(peeked.scope).toBe('broadcast');
        expect(peeked.intendedFor).toBeUndefined();
        // Dispatcher is this daemon's own id (loadConfig().machineId).
        expect(peeked.dispatchedBy?.daemonId).toBe(SELF_MACH);
    });

    it('does NOT fan a self-fallback terminal broadcast out to a coordinator on a DIFFERENT machine (MAGI-REPLICA-COMPLETION-EVENT-LEAK)', () => {
        // The leak: a replica completion with no owner anchor was broadcast and reached
        // EVERY coordinator, including ones on other machines that never dispatched it.
        // The drain-side dispatchedBy filter now routes it away from a foreign-machine
        // drainer.
        const meshId = `mesh-v2-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        const noIdentity = makeTerminal(meshId);
        delete (noIdentity as any).targetCoordinatorDaemonId;
        queuePendingMeshCoordinatorEvent(noIdentity);

        // A coordinator on OTHER_MACH drains — dispatchedBy is SELF_MACH, so it is skipped.
        const foreign = getPendingMeshCoordinatorEvents(meshId, OTHER_MACH) as PendingMeshCoordinatorEvent[];
        expect(foreign).toHaveLength(0);
    });

    it('persists the v2 envelope into the SQLite columns (queryable idempotency key)', () => {
        const meshId = `mesh-v2-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        queuePendingMeshCoordinatorEvent(makeTerminal(meshId));
        // Force the write out of WAL is unnecessary — same-connection reads see it, but we
        // open a second connection; better-sqlite3 in WAL still sees committed rows.
        const db = openDb();
        try {
            const row = db.prepare(
                'SELECT protocol_version, event_id, scope, dispatched_by, intended_for FROM mesh_pending_events WHERE mesh_id = ?'
            ).get(meshId) as any;
            expect(row.protocol_version).toBe('2.0');
            expect(typeof row.event_id).toBe('string');
            expect(row.scope).toBe('unicast');
            expect(JSON.parse(row.dispatched_by).daemonId).toBe(MACH);
            expect(JSON.parse(row.intended_for).daemonId).toBe(MACH);
        } finally {
            db.close();
        }
    });

    it('a v1 reader (drain) reads a v2-stamped row without breaking, preserving v1 fields', () => {
        const meshId = `mesh-v2-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        queuePendingMeshCoordinatorEvent(makeTerminal(meshId));

        const drained = drainPendingMeshCoordinatorEvents(meshId, MACH) as PendingMeshCoordinatorEvent[];
        expect(drained).toHaveLength(1);
        const e = drained[0];
        // v1 fields intact
        expect(e.event).toBe('agent:generating_completed');
        expect(e.meshId).toBe(meshId);
        expect(e.coordinatorMessage).toBe('done');
        expect(e.targetCoordinatorDaemonId).toBe(MACH);
        // v2 fields ride along (a v1 reader simply ignores them)
        expect(e.protocolVersion).toBe('2.0');
        expect(typeof e.eventId).toBe('string');
    });

    it('preserves eventId across a re-queue (idempotency key is stable)', () => {
        const meshId = `mesh-v2-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        const stamped = stampPendingEventV2(makeTerminal(meshId));
        const firstEventId = stamped.eventId;
        expect(firstEventId).toBeTruthy();

        // Re-stamping an already-stamped event must NOT mint a new eventId.
        const reStamped = stampPendingEventV2(stamped);
        expect(reStamped.eventId).toBe(firstEventId);
    });

    it('does not cross-surface a unicast event scoped to a DIFFERENT coordinator', () => {
        const meshId = `mesh-v2-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        queuePendingMeshCoordinatorEvent(makeTerminal(meshId, { targetCoordinatorDaemonId: OTHER_MACH }));

        // The drain scope filter (targetCoordinatorDaemonId) still isolates by daemon.
        expect(drainPendingMeshCoordinatorEvents(meshId, MACH).length).toBe(0);
    });
});

// COORD-EVENT-MISROUTE — anchor preservation (regression-0). The fix preserves the
// DISPATCHING coordinator's daemon+session anchor end-to-end (enqueue-fallback session
// stamp, task_dispatched ledger coordinatorDaemonId, synth ledger recovery, drainer
// session identity) so a terminal completion routes back to the coordinator that issued
// the task instead of broadcasting to any coordinator. These lock the two regression-0
// invariants the fix must preserve:
//   (a) a single-coordinator broadcast completion (no anchor to address) is STILL delivered;
//   (b) with two coordinator SESSIONS on one daemon, a completion carrying the dispatching
//       coordinator's session anchor routes ONLY to that session's drain — never the sibling.
describe('mesh pending-event — COORD-EVENT-MISROUTE anchor preservation (regression-0)', () => {
    const SESSION_A = `sess_${'a'.repeat(20)}`;
    const SESSION_B = `sess_${'b'.repeat(20)}`;

    beforeEach(() => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
    });

    afterEach(() => {
        try { MeshRuntimeStore.resetForTests(); } catch { /* best-effort */ }
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    // (regression-0 a) A completion with NO addressable coordinator (the self-fallback
    // broadcast path — emit-time anchor genuinely absent) must NOT be held/suppressed by the
    // fix: broadcast is the only path that reaches a legitimate same-machine coordinator, and
    // ★the RCA explicitly forbids turning selfFallback broadcast into a hold/expire. A single
    // coordinator draining on this daemon still receives it, WITH or WITHOUT a session identity
    // on its drain.
    it('(a) a single-coordinator broadcast completion is still delivered — session-less AND session-scoped drain', () => {
        const meshId = `mesh-coord-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        const noAnchor = makeTerminal(meshId);
        delete (noAnchor as any).targetCoordinatorDaemonId; // emit-time: no coordinator to address
        queuePendingMeshCoordinatorEvent(noAnchor);

        // Peek confirms the self-fallback minted a BROADCAST (not a self-unicast that a
        // session drain would skip).
        const [peeked] = getPendingMeshCoordinatorEvents(meshId, SELF_MACH) as PendingMeshCoordinatorEvent[];
        expect(peeked.scope).toBe('broadcast');

        // A session-scoped drain (the fix threads the coordinator's own sessionId as
        // drainerIdentity) still receives the broadcast — shouldDeliverPendingEventToCoordinator
        // returns true for broadcast regardless of the drainer's session.
        const drained = drainPendingMeshCoordinatorEvents(
            meshId,
            SELF_MACH,
            { drainerIdentity: { daemonId: SELF_MACH, coordinatorRunId: SELF_MACH, sessionId: SESSION_A } },
        ) as PendingMeshCoordinatorEvent[];
        expect(drained).toHaveLength(1);
        expect(drained[0].event).toBe('agent:generating_completed');
    });

    // (regression-0 b) With the dispatching coordinator's daemon+session anchor PRESERVED, the
    // completion is stamped unicast/intendedFor=that session. A sibling coordinator SESSION on
    // the SAME daemon, viewing its inbox with its OWN session identity, must NOT surface it; the
    // dispatching session does. This is the multi-coordinator misroute the fix closes. Isolation
    // is asserted at the NON-DESTRUCTIVE peek layer (routeV2EventsForDrainer applies the same
    // identityDeliversTo filter there) — the destructive drain marks rows by DAEMON scope and
    // defers per-session fan-out to the reconcile-loop inject (targetCoordinatorSessionId match +
    // holdOrExpireStrictUnmatchedEvent), so a peek is the faithful single-module surface for the
    // session filter without a store round-trip.
    it('(b) two coordinator sessions on one daemon: a session-anchored completion surfaces only to the dispatching session', () => {
        const meshId = `mesh-coord-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        // Anchor preserved: daemon = MACH (dispatching coordinator daemon), session = SESSION_A.
        queuePendingMeshCoordinatorEvent(makeTerminal(meshId, {
            targetCoordinatorDaemonId: MACH,
            targetCoordinatorSessionId: SESSION_A,
        }));

        // Daemon-level peek: the preserved anchor keeps it UNICAST addressed to the dispatching
        // session — the core RCA invariant (anchor present → unicast, not broadcast-to-any).
        const [daemonPeek] = getPendingMeshCoordinatorEvents(meshId, MACH) as PendingMeshCoordinatorEvent[];
        expect(daemonPeek.scope).toBe('unicast');
        expect(daemonPeek.intendedFor?.daemonId).toBe(MACH);
        expect(daemonPeek.intendedFor?.sessionId).toBe(SESSION_A);

        // Sibling coordinator SESSION_B (same daemon) peeks with its own session identity →
        // identityDeliversTo compares sessions (both sides session-specific) → excluded.
        const siblingPeek = getPendingMeshCoordinatorEvents(
            meshId,
            MACH,
            { drainerIdentity: { daemonId: MACH, coordinatorRunId: MACH, sessionId: SESSION_B } },
        ) as PendingMeshCoordinatorEvent[];
        expect(siblingPeek).toHaveLength(0);

        // The dispatching coordinator SESSION_A peeks with its own identity → surfaced.
        const ownerPeek = getPendingMeshCoordinatorEvents(
            meshId,
            MACH,
            { drainerIdentity: { daemonId: MACH, coordinatorRunId: MACH, sessionId: SESSION_A } },
        ) as PendingMeshCoordinatorEvent[];
        expect(ownerPeek).toHaveLength(1);
        expect(ownerPeek[0].event).toBe('agent:generating_completed');

        // And the owner's destructive drain (its own identity) delivers it.
        const ownerDrain = drainPendingMeshCoordinatorEvents(
            meshId,
            MACH,
            { drainerIdentity: { daemonId: MACH, coordinatorRunId: MACH, sessionId: SESSION_A } },
        ) as PendingMeshCoordinatorEvent[];
        expect(ownerDrain).toHaveLength(1);
    });

    // Regression guard for the LOST-ANCHOR failure mode the fix repairs: had the synth stamped
    // the WORKER's self-daemon (OTHER_MACH) instead of the dispatching coordinator (MACH), the
    // event would be addressed to a daemon the coordinator's drain does not match → the drain
    // scope filter drops it here (0), and cross-machine it would have selfFallback-broadcast to
    // any coordinator. This asserts the daemon scope isolation the anchor recovery relies on.
    it('(b-neg) a completion mis-anchored to the WORKER daemon is not drained by the coordinator daemon', () => {
        const meshId = `mesh-coord-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        // Simulate the pre-fix corruption: anchor = OTHER_MACH (worker self-daemon), not MACH.
        queuePendingMeshCoordinatorEvent(makeTerminal(meshId, { targetCoordinatorDaemonId: OTHER_MACH }));
        // The coordinator daemon MACH does not drain it (daemon scope isolates). The fix's
        // ledger-recovery ensures the anchor is MACH so the coordinator DOES drain it (covered by
        // (b)); this locks that a mis-anchored event does not silently land on the wrong daemon.
        expect(drainPendingMeshCoordinatorEvents(meshId, MACH).length).toBe(0);
    });
});

describe('mesh pending-event — v2 column migration on a pre-v2 DB', () => {
    beforeEach(() => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
    });

    afterEach(() => {
        try { MeshRuntimeStore.resetForTests(); } catch { /* best-effort */ }
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('adds the v2 columns to a legacy mesh_pending_events table and reads legacy rows as v1', () => {
        const Database = runtimeRequire('better-sqlite3') as any;
        const ledgerDir = getLedgerDir(); // creates the dir
        mkdirSync(ledgerDir, { recursive: true });
        const dbPath = join(ledgerDir, 'mesh-runtime.db');

        // Build a legacy DB whose mesh_pending_events lacks the v2 columns, with one row.
        const legacyMeshId = `mesh-legacy-${randomUUID().slice(0, 8)}`;
        const legacyDb = new Database(dbPath);
        legacyDb.exec(`
            CREATE TABLE mesh_pending_events (
                id TEXT PRIMARY KEY,
                mesh_id TEXT NOT NULL,
                coordinator_daemon_id TEXT,
                event TEXT NOT NULL,
                payload TEXT NOT NULL DEFAULT '{}',
                fingerprint TEXT,
                queued_at INTEGER NOT NULL,
                drained INTEGER NOT NULL DEFAULT 0,
                drained_at INTEGER
            );
        `);
        const legacyEvent = {
            event: 'agent:generating_completed',
            meshId: legacyMeshId,
            nodeLabel: 'legacy node',
            metadataEvent: {},
            queuedAt: Date.now(),
        };
        legacyDb.prepare(
            'INSERT INTO mesh_pending_events (id, mesh_id, coordinator_daemon_id, event, payload, fingerprint, queued_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(randomUUID(), legacyMeshId, null, 'agent:generating_completed', JSON.stringify(legacyEvent), null, legacyEvent.queuedAt);
        legacyDb.close();

        // Opening the store runs the idempotent migration (ALTER ADD COLUMN ...).
        const store = MeshRuntimeStore.getInstance();
        const cols = new Set(
            (store as any).db.prepare('PRAGMA table_info(mesh_pending_events)').all().map((r: any) => r.name)
        );
        for (const c of ['protocol_version', 'event_id', 'scope', 'dispatched_by', 'intended_for']) {
            expect(cols.has(c)).toBe(true);
        }

        // The legacy row reads back as a v1 event (no protocolVersion) via the normal peek.
        const [peeked] = getPendingMeshCoordinatorEvents(legacyMeshId) as PendingMeshCoordinatorEvent[];
        expect(peeked).toBeTruthy();
        expect(peeked.event).toBe('agent:generating_completed');
        expect(peeked.protocolVersion).toBeUndefined();

        // A NEW event queued into the migrated DB stamps and persists v2 columns.
        const freshMeshId = `mesh-fresh-${randomUUID().slice(0, 8)}`;
        queuePendingMeshCoordinatorEvent(makeTerminal(freshMeshId));
        const row = (store as any).db.prepare(
            'SELECT protocol_version FROM mesh_pending_events WHERE mesh_id = ?'
        ).get(freshMeshId) as any;
        expect(row.protocol_version).toBe('2.0');
    });
});
