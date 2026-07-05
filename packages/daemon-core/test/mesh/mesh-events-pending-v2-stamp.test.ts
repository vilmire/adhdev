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
        const meshId = `mesh-v2-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        const noIdentity = makeTerminal(meshId);
        delete (noIdentity as any).targetCoordinatorDaemonId; // no coordinator identity to derive
        queuePendingMeshCoordinatorEvent(noIdentity);

        const [peeked] = getPendingMeshCoordinatorEvents(meshId, MACH) as PendingMeshCoordinatorEvent[];
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
