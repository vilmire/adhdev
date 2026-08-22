import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// The drain path reads the ledger + the SQLite queue through stores rooted at
// getConfigDir(); redirect it to a temp dir (same pattern as the refine-backfill suite).
const testTmpDir = join(tmpdir(), `adhdev-mesh-stale-terminal-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'mach_stale_terminal_test' }),
}));

import {
    queuePendingMeshCoordinatorEvent,
    drainPendingMeshCoordinatorEvents,
    __clearMeshPendingEventsForTests,
} from '../../src/mesh/mesh-events-pending.js';
import { __clearMeshLedgerForTests } from '../../src/mesh/mesh-ledger.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

// ---------------------------------------------------------------------------
// STALE-TASK-TERMINAL drain gate.
//
// Measured defect (2026-08-22, live preview daemon): task 081317f3 committed terminal
// `cancelled` at 13:14:12.806 and a `mesh:dispatch_blocked` event naming that same task
// was surfaced to the coordinator 767ms later. The drain path re-validated nothing about
// the task's state, so the coordinator was told a task it had already cancelled was
// blocked and needed action.
//
// The gate drops droppable NON-TERMINAL alerts for a task whose row is already terminal.
// The over-correction hazard is the more dangerous one — blocking a real completion loses
// the worker's only result copy — so the preservation cases below are as load-bearing as
// the drop case and must stay green.
// ---------------------------------------------------------------------------

function seedTask(meshId: string, taskId: string, status: string): void {
    const now = new Date().toISOString();
    MeshRuntimeStore.getInstance().insertQueueEntry({
        id: taskId,
        meshId,
        message: 'seeded task',
        status,
        createdAt: now,
        updatedAt: now,
    } as any);
}

describe('mesh pending-event — stale terminal-task alert gate (STALE-TASK-TERMINAL)', () => {
    let meshId = `stale-terminal-${randomUUID().slice(0, 8)}`;

    beforeEach(() => {
        meshId = `stale-terminal-${randomUUID().slice(0, 8)}`;
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
    });

    afterEach(() => {
        __clearMeshPendingEventsForTests(meshId);
        __clearMeshLedgerForTests(meshId);
        try { MeshRuntimeStore.resetForTests(); } catch { /* best-effort */ }
    });

    // ── DROP CASE (the defect) ──────────────────────────────────────────────
    for (const status of ['cancelled', 'completed', 'failed']) {
        it(`★drops a mesh:dispatch_blocked alert whose task row is already ${status}`, () => {
            const taskId = randomUUID();
            seedTask(meshId, taskId, status);
            queuePendingMeshCoordinatorEvent({
                event: 'mesh:dispatch_blocked',
                meshId,
                nodeLabel: 'node-stale',
                nodeId: 'node-stale',
                metadataEvent: { taskId },
                coordinatorMessage: 'blocked: target_node_id_unmatched',
                queuedAt: Date.now(),
            });

            const drained = drainPendingMeshCoordinatorEvents(meshId, [], {});
            expect(drained.find(e => e.event === 'mesh:dispatch_blocked')).toBeUndefined();
        });
    }

    it('★drops a monitor:no_progress stall alert whose task row is already terminal', () => {
        const taskId = randomUUID();
        seedTask(meshId, taskId, 'cancelled');
        queuePendingMeshCoordinatorEvent({
            event: 'monitor:no_progress',
            meshId,
            nodeLabel: 'node-stale',
            nodeId: 'node-stale',
            metadataEvent: { taskId },
            coordinatorMessage: 'no progress observed',
            queuedAt: Date.now(),
        });

        const drained = drainPendingMeshCoordinatorEvents(meshId, [], {});
        expect(drained.find(e => e.event === 'monitor:no_progress')).toBeUndefined();
    });

    // ── OVER-CORRECTION GUARDS (must stay green) ────────────────────────────
    // A terminal event is the coordinator's ONLY copy of the worker's result. If the gate
    // ever widens to swallow one of these, the completion is lost permanently — a strictly
    // worse failure than the stale alert the gate exists to remove.
    for (const event of ['agent:generating_completed', 'agent:stopped', 'refine:completed', 'refine:failed']) {
        it(`★★never drops the terminal event ${event}, even when its task row is terminal`, () => {
            const taskId = randomUUID();
            seedTask(meshId, taskId, 'completed');
            queuePendingMeshCoordinatorEvent({
                event,
                meshId,
                nodeLabel: 'node-done',
                nodeId: 'node-done',
                metadataEvent: { taskId, finalSummary: 'the worker result that must survive' },
                coordinatorMessage: `[System] ${event}`,
                queuedAt: Date.now(),
            });

            const drained = drainPendingMeshCoordinatorEvents(meshId, [], {});
            const survived = drained.find(e => e.event === event);
            expect(survived).toBeDefined();
            expect((survived?.metadataEvent as any)?.finalSummary).toBe('the worker result that must survive');
        });
    }

    // An approval/question nudge may reflect a worker blocked RIGHT NOW. The
    // already-resolved subset is handled upstream by isApprovalNudgeResolved with
    // delivery-safe semantics; this gate must not pre-empt it.
    for (const event of ['agent:waiting_approval', 'agent:waiting_choice']) {
        it(`★★never drops the approval-class nudge ${event}`, () => {
            const taskId = randomUUID();
            seedTask(meshId, taskId, 'cancelled');
            queuePendingMeshCoordinatorEvent({
                event,
                meshId,
                nodeLabel: 'node-blocked',
                nodeId: 'node-blocked',
                metadataEvent: { taskId },
                coordinatorMessage: `[System] ${event}`,
                queuedAt: Date.now(),
            });

            const drained = drainPendingMeshCoordinatorEvents(meshId, [], {});
            expect(drained.find(e => e.event === event)).toBeDefined();
        });
    }

    it('★delivers a droppable alert whose task row is still ACTIVE (pending/assigned)', () => {
        const pendingTaskId = randomUUID();
        const assignedTaskId = randomUUID();
        seedTask(meshId, pendingTaskId, 'pending');
        seedTask(meshId, assignedTaskId, 'assigned');
        for (const taskId of [pendingTaskId, assignedTaskId]) {
            queuePendingMeshCoordinatorEvent({
                event: 'mesh:dispatch_blocked',
                meshId,
                nodeLabel: `node-${taskId.slice(0, 4)}`,
                nodeId: `node-${taskId.slice(0, 4)}`,
                metadataEvent: { taskId },
                coordinatorMessage: 'blocked: still actionable',
                queuedAt: Date.now(),
            });
        }

        const drained = drainPendingMeshCoordinatorEvents(meshId, [], {});
        expect(drained.filter(e => e.event === 'mesh:dispatch_blocked')).toHaveLength(2);
    });

    // "Terminal is sticky" is what licenses gating on status alone with no timestamp
    // comparison. An event queued BEFORE the terminal is equally stale by surface time,
    // and — critically — the gate must not depend on queuedAt ordering to work.
    it('★drops a droppable alert queued LONG BEFORE the task went terminal (no timestamp dependence)', () => {
        const taskId = randomUUID();
        seedTask(meshId, taskId, 'cancelled');
        queuePendingMeshCoordinatorEvent({
            event: 'mesh:dispatch_blocked',
            meshId,
            nodeLabel: 'node-old',
            nodeId: 'node-old',
            metadataEvent: { taskId },
            coordinatorMessage: 'blocked long ago',
            queuedAt: Date.now() - 4 * 60 * 60 * 1000, // 4h old
        });

        const drained = drainPendingMeshCoordinatorEvents(meshId, [], {});
        expect(drained.find(e => e.event === 'mesh:dispatch_blocked')).toBeUndefined();
    });

    // Unknown must be treated as live: when the gate cannot prove staleness it delivers.
    it('★delivers a droppable alert carrying NO taskId (unattributable → deliver)', () => {
        queuePendingMeshCoordinatorEvent({
            event: 'mesh:dispatch_blocked',
            meshId,
            nodeLabel: 'node-anon',
            nodeId: 'node-anon',
            metadataEvent: {},
            coordinatorMessage: 'blocked, no task attribution',
            queuedAt: Date.now(),
        });

        const drained = drainPendingMeshCoordinatorEvents(meshId, [], {});
        expect(drained.find(e => e.event === 'mesh:dispatch_blocked')).toBeDefined();
    });

    it('★delivers a droppable alert whose task row does not exist (pruned → deliver)', () => {
        queuePendingMeshCoordinatorEvent({
            event: 'monitor:no_progress',
            meshId,
            nodeLabel: 'node-missing',
            nodeId: 'node-missing',
            metadataEvent: { taskId: randomUUID() }, // never seeded
            coordinatorMessage: 'no progress observed',
            queuedAt: Date.now(),
        });

        const drained = drainPendingMeshCoordinatorEvents(meshId, [], {});
        expect(drained.find(e => e.event === 'monitor:no_progress')).toBeDefined();
    });

    // The measured live sequence, end to end: a terminal completion and a stale blocked
    // alert drain together. The completion must survive; only the stale alert is removed.
    it('★★mixed batch: the stale alert is dropped while the sibling completion survives', () => {
        const cancelledTaskId = randomUUID();
        const doneTaskId = randomUUID();
        seedTask(meshId, cancelledTaskId, 'cancelled');
        seedTask(meshId, doneTaskId, 'completed');
        queuePendingMeshCoordinatorEvent({
            event: 'mesh:dispatch_blocked',
            meshId,
            nodeLabel: 'node-stale',
            nodeId: 'node-stale',
            metadataEvent: { taskId: cancelledTaskId },
            coordinatorMessage: 'blocked (stale)',
            queuedAt: Date.now(),
        });
        queuePendingMeshCoordinatorEvent({
            event: 'agent:generating_completed',
            meshId,
            nodeLabel: 'node-done',
            nodeId: 'node-done',
            metadataEvent: { taskId: doneTaskId, finalSummary: 'real result' },
            coordinatorMessage: '[System] completed',
            queuedAt: Date.now(),
        });

        const drained = drainPendingMeshCoordinatorEvents(meshId, [], {});
        expect(drained.find(e => e.event === 'mesh:dispatch_blocked')).toBeUndefined();
        expect(drained.find(e => e.event === 'agent:generating_completed')).toBeDefined();
    });
});
