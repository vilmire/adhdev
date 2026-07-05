import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Regression: the base-node completion-surface bug. A worker completion stamped with
// the coordinator's FULL config-form daemon id (`daemon_mach_X`) must still surface to
// a coordinator that resolves its own id in a DIFFERENT form (bare `mach_X` or
// `standalone_mach_X`). Before the fix the scope filter was an exact-string match, so a
// `daemon_mach_X`-scoped completion was silently skipped by a bare-`mach_X` coordinator
// and the coordinator was never auto-notified — while NULL-scoped (worktree) events
// always surfaced via the `IS NULL` branch, producing the base-vs-worktree asymmetry.

const testTmpDir = join(tmpdir(), `adhdev-mesh-daemonid-scope-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

const MACH = 'mach_1b46842a15d3409d96ad33e767a916dd';

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    // NULL-scoped (worktree) events carry no coordinator identity; the self-daemon
    // fallback in stampPendingEventV2 reads loadConfig().machineId to mint a v2
    // broadcast envelope so they still surface to any coordinator form on this machine.
    loadConfig: () => ({ machineId: MACH }),
}));

import {
    queuePendingMeshCoordinatorEvent,
    getPendingMeshCoordinatorEvents,
    drainPendingMeshCoordinatorEvents,
    __clearMeshPendingEventsForTests,
} from '../../src/mesh/mesh-events-pending.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
const FULL = `daemon_${MACH}`;
const STANDALONE = `standalone_${MACH}`;

function makeCompletion(meshId: string, targetCoordinatorDaemonId: string) {
    return {
        event: 'agent:generating_completed',
        meshId,
        nodeLabel: "Node 'node_bf91'",
        nodeId: 'node_bf91',
        metadataEvent: { nodeId: 'node_bf91', sessionId: randomUUID(), timestamp: Date.now() },
        coordinatorMessage: 'done',
        queuedAt: Date.now(),
        targetCoordinatorDaemonId,
    };
}

describe('mesh pending-event surface — daemon-id form normalization', () => {
    beforeEach(() => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
    });

    afterEach(() => {
        try { MeshRuntimeStore.resetForTests(); } catch { /* best-effort */ }
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('surfaces a FULL-form (`daemon_mach_X`) completion to a BARE-form (`mach_X`) coordinator', () => {
        const meshId = `mesh-scope-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        queuePendingMeshCoordinatorEvent(makeCompletion(meshId, FULL));

        // The coordinator only knows itself as the bare machine id — pre-fix this missed.
        const peeked = getPendingMeshCoordinatorEvents(meshId, MACH);
        expect(peeked.map(e => e.event)).toContain('agent:generating_completed');

        const drained = drainPendingMeshCoordinatorEvents(meshId, MACH);
        expect(drained.map(e => e.event)).toContain('agent:generating_completed');
    });

    it('surfaces a BARE-form completion to a FULL-form coordinator (symmetric)', () => {
        const meshId = `mesh-scope-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        queuePendingMeshCoordinatorEvent(makeCompletion(meshId, MACH));

        const drained = drainPendingMeshCoordinatorEvents(meshId, FULL);
        expect(drained.map(e => e.event)).toContain('agent:generating_completed');
    });

    it('surfaces a FULL-form completion to a STANDALONE-form coordinator', () => {
        const meshId = `mesh-scope-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        queuePendingMeshCoordinatorEvent(makeCompletion(meshId, FULL));

        const drained = drainPendingMeshCoordinatorEvents(meshId, STANDALONE);
        expect(drained.map(e => e.event)).toContain('agent:generating_completed');
    });

    it('still ISOLATES a completion scoped to a DIFFERENT coordinator (no cross-surface)', () => {
        const meshId = `mesh-scope-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        const otherMach = 'mach_ffffffffffffffffffffffffffffffff';
        queuePendingMeshCoordinatorEvent(makeCompletion(meshId, `daemon_${otherMach}`));

        // Our coordinator (any form of MACH) must NOT see another machine's event.
        expect(getPendingMeshCoordinatorEvents(meshId, MACH).length).toBe(0);
        expect(getPendingMeshCoordinatorEvents(meshId, FULL).length).toBe(0);
        expect(drainPendingMeshCoordinatorEvents(meshId, MACH).length).toBe(0);
    });

    it('still surfaces NULL-scoped (worktree) completions to any coordinator form', () => {
        const meshId = `mesh-scope-${randomUUID().slice(0, 8)}`;
        __clearMeshPendingEventsForTests(meshId);
        const nullScoped = makeCompletion(meshId, FULL);
        delete (nullScoped as any).targetCoordinatorDaemonId; // NULL scope (worktree-style)
        queuePendingMeshCoordinatorEvent(nullScoped);

        const drained = drainPendingMeshCoordinatorEvents(meshId, MACH);
        expect(drained.map(e => e.event)).toContain('agent:generating_completed');
    });
});
