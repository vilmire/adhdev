import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// T6 (B3c) — mesh protocol v2 ENFORCE mode. The env flag MESH_PROTOCOL_V2_ENFORCE
// flips the drain-side receive path from accept-and-warn to enforce:
//   (1) an unversioned (v1) event is QUARANTINED (held back, not broadcast) — there
//       is no v1 broadcast fallback under enforce, so unicast routing is the only
//       delivery path. It is ledger-recorded recoverable (loss-free).
//   (2) a malformed v2 envelope is QUARANTINED (held back, not passed through), and
//       ledger-recorded recoverable.
//   (3) a well-formed v2 unicast/broadcast event routes EXACTLY as in accept mode
//       (enforce narrows the failure path, never the healthy path).
//   (4) the enforce flag is read per-drain at call time — flipping the env OFF
//       instantly restores accept-and-warn (pure-env rollback, no restart).
//   (5) the non-destructive peek quarantines from its RETURNED set without a ledger
//       write (it never consumed the event).

const testTmpDir = join(tmpdir(), `adhdev-mesh-v2-enforce-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
}));

import {
    queuePendingMeshCoordinatorEvent,
    stampPendingEventV2,
    getPendingMeshCoordinatorEvents,
    drainPendingMeshCoordinatorEvents,
    getMeshV2DrainCounters,
    isMeshProtocolV2EnforceEnabled,
    __resetMeshV2DrainCountersForTests,
    __resetMeshV2WarnDedupForTests,
    __clearMeshPendingEventsForTests,
    type PendingMeshCoordinatorEvent,
} from '../../src/mesh/mesh-events-pending.js';
import { readLedgerEntries } from '../../src/mesh/mesh-ledger.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import type { CoordinatorIdentity } from '../../src/mesh/contracts.js';

const CORE = 'mach_1b46842a15d3409d96ad33e767a916dd';
const BARE = CORE;

function makeTerminal(meshId: string, over: Partial<PendingMeshCoordinatorEvent> = {}): PendingMeshCoordinatorEvent {
    return {
        event: 'agent:generating_completed',
        meshId,
        nodeLabel: "Node 'node_bf91'",
        nodeId: 'node_bf91',
        metadataEvent: { nodeId: 'node_bf91', sessionId: randomUUID(), taskId: randomUUID(), timestamp: Date.now() },
        coordinatorMessage: 'done',
        queuedAt: Date.now(),
        targetCoordinatorDaemonId: BARE,
        ...over,
    };
}

function ident(daemonId: string, over: Partial<CoordinatorIdentity> = {}): CoordinatorIdentity {
    return { daemonId, coordinatorRunId: daemonId, ...over };
}

function enforceOn() { process.env.MESH_PROTOCOL_V2_ENFORCE = '1'; }
function enforceOff() { delete process.env.MESH_PROTOCOL_V2_ENFORCE; }

describe('mesh pending-event — v2 ENFORCE mode (T6/B3c)', () => {
    beforeEach(() => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        __resetMeshV2DrainCountersForTests();
        __resetMeshV2WarnDedupForTests();
        enforceOff();
    });

    afterEach(() => {
        enforceOff();
        try { MeshRuntimeStore.resetForTests(); } catch { /* best-effort */ }
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    // ── flag parsing / default OFF ────────────────────────────────────────────────
    it('defaults enforce OFF and parses the truthy env vocabulary', () => {
        enforceOff();
        expect(isMeshProtocolV2EnforceEnabled()).toBe(false);
        for (const v of ['1', 'true', 'on', 'yes', 'TRUE', ' On ']) {
            process.env.MESH_PROTOCOL_V2_ENFORCE = v;
            expect(isMeshProtocolV2EnforceEnabled()).toBe(true);
        }
        for (const v of ['0', 'false', 'off', 'no', '']) {
            process.env.MESH_PROTOCOL_V2_ENFORCE = v;
            expect(isMeshProtocolV2EnforceEnabled()).toBe(false);
        }
    });

    // ── (1) enforce quarantines an unversioned (v1) event (no broadcast fallback) ──
    it('QUARANTINES an unversioned event under enforce (not broadcast) and ledger-records it recoverable', () => {
        const meshId = `mesh-enf-v1-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);

        const v1 = makeTerminal(meshId, { coordinatorMessage: 'v1 held' });
        delete (v1 as any).targetCoordinatorDaemonId;
        queuePendingMeshCoordinatorEvent(v1);

        enforceOn();
        const drained = drainPendingMeshCoordinatorEvents(meshId, BARE, {
            drainerIdentity: ident(BARE, { sessionId: 'any_session' }),
        }) as PendingMeshCoordinatorEvent[];

        // Held back — NOT delivered.
        expect(drained).toHaveLength(0);
        expect(getMeshV2DrainCounters().v1UnversionedQuarantined).toBe(1);
        expect(getMeshV2DrainCounters().v1BroadcastAccepted).toBe(0);

        // Loss-free: mirrored into the ledger as a recoverable event_held entry.
        const held = readLedgerEntries(meshId, { kind: ['event_held'] });
        const rec = held.find(e => (e.payload as any)?.reason === 'v2_enforce_unversioned_quarantined');
        expect(rec).toBeTruthy();
        expect((rec!.payload as any).recoverable).toBe(true);
        expect((rec!.payload as any).event).toBe('agent:generating_completed');
    });

    // ── (2) enforce quarantines a malformed v2 envelope (not pass-through) ─────────
    it('QUARANTINES a malformed v2 envelope under enforce (not passed through) and ledger-records it', () => {
        const meshId = `mesh-enf-bad-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);

        const broken = makeTerminal(meshId, { coordinatorMessage: 'broken held' });
        (broken as any).protocolVersion = '2.0';
        (broken as any).eventId = randomUUID();
        (broken as any).scope = 'unicast';
        (broken as any).dispatchedBy = ident(BARE);
        // no intendedFor → invalid unicast envelope
        queuePendingMeshCoordinatorEvent(broken);

        enforceOn();
        const drained = drainPendingMeshCoordinatorEvents(meshId, BARE, { drainerIdentity: ident(BARE) });

        expect(drained).toHaveLength(0);
        expect(getMeshV2DrainCounters().v2ValidationFailedQuarantined).toBe(1);
        expect(getMeshV2DrainCounters().v2ValidationFailedAccepted).toBe(0);

        const held = readLedgerEntries(meshId, { kind: ['event_held'] });
        const rec = held.find(e => (e.payload as any)?.reason === 'v2_enforce_validation_failed_quarantined');
        expect(rec).toBeTruthy();
        expect((rec!.payload as any).recoverable).toBe(true);
    });

    // ── (3) a healthy v2 unicast event delivers identically under enforce ──────────
    it('delivers a well-formed v2 unicast event under enforce exactly as in accept mode', () => {
        const meshId = `mesh-enf-ok-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);

        const sessA = `sess_${randomUUID().slice(0, 8)}`;
        queuePendingMeshCoordinatorEvent(makeTerminal(meshId, { targetCoordinatorSessionId: sessA, coordinatorMessage: 'for A' }));

        enforceOn();
        const drained = drainPendingMeshCoordinatorEvents(meshId, BARE, {
            drainerIdentity: ident(BARE, { sessionId: sessA }),
        }) as PendingMeshCoordinatorEvent[];

        expect(drained).toHaveLength(1);
        expect(drained[0].coordinatorMessage).toBe('for A');
        expect(getMeshV2DrainCounters().v2Delivered).toBe(1);
        // No quarantine on the healthy path.
        expect(getMeshV2DrainCounters().v1UnversionedQuarantined).toBe(0);
        expect(getMeshV2DrainCounters().v2ValidationFailedQuarantined).toBe(0);
        // No ledger event_held record on the healthy path.
        expect(readLedgerEntries(meshId, { kind: ['event_held'] })).toHaveLength(0);
    });

    // ── (4) flag OFF instantly restores accept-and-warn (pure-env rollback) ────────
    it('restores accept-and-warn when the flag is OFF (same daemon, no restart)', () => {
        const meshId = `mesh-enf-rollback-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);

        const v1 = makeTerminal(meshId, { coordinatorMessage: 'v1 accepted' });
        delete (v1 as any).targetCoordinatorDaemonId;
        queuePendingMeshCoordinatorEvent(v1);

        // Flag OFF (default) → accept mode: the v1 event is broadcast (delivered).
        enforceOff();
        const drained = drainPendingMeshCoordinatorEvents(meshId, BARE, {
            drainerIdentity: ident(BARE, { sessionId: 'any_session' }),
        }) as PendingMeshCoordinatorEvent[];

        expect(drained).toHaveLength(1);
        expect(drained[0].coordinatorMessage).toBe('v1 accepted');
        expect(getMeshV2DrainCounters().v1BroadcastAccepted).toBe(1);
        expect(getMeshV2DrainCounters().v1UnversionedQuarantined).toBe(0);
    });

    // ── (5) peek quarantines from its returned set WITHOUT a ledger write ──────────
    it('peek omits a quarantined event under enforce without consuming or ledger-recording it', () => {
        const meshId = `mesh-enf-peek-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);

        const v1 = makeTerminal(meshId, { coordinatorMessage: 'v1 peek' });
        delete (v1 as any).targetCoordinatorDaemonId;
        queuePendingMeshCoordinatorEvent(v1);

        enforceOn();
        const peeked = getPendingMeshCoordinatorEvents(meshId, BARE, {
            drainerIdentity: ident(BARE, { sessionId: 'any_session' }),
        });
        // Omitted from the returned set.
        expect(peeked).toHaveLength(0);
        // Peek is non-destructive: no counter inflation and NO ledger event_held write
        // (the peek never consumed the event, so there is nothing to recover).
        expect(getMeshV2DrainCounters().v1UnversionedQuarantined).toBe(0);
        expect(readLedgerEntries(meshId, { kind: ['event_held'] })).toHaveLength(0);

        // The event is still queued — a subsequent (accept-mode) drain still finds it.
        enforceOff();
        const drained = drainPendingMeshCoordinatorEvents(meshId, BARE, {
            drainerIdentity: ident(BARE, { sessionId: 'any_session' }),
        });
        expect(drained).toHaveLength(1);
    });
});
