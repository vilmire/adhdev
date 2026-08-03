/**
 * MISSIONLESS-DIRECT-DISPATCH-NO-ATTEMPT
 *
 * A `mesh_send_task` (direct dispatch) issued WITHOUT a mission_id used to open no
 * turn attempt, because openTurnAttempt/recordTurnAck and createSessionDelivery both
 * sat behind recordDirectDispatchTask's `if (!missionId) return null` early-return —
 * a gate that existed only for mission ATTRIBUTION and which those two later
 * additions inherited by accident.
 *
 * The consequences were not cosmetic:
 *
 *   1. Terminal state never converged. With no attempt, a completion event reaching
 *      proposeTurnCompletion has nothing to resolve, so ensureLegacyTurnAttempt mints
 *      `legacy-<taskId>-<seq>` whose sessionId does not match the worker binding. The
 *      reducer then refuses the flip (stale_attempt / session_mismatch) and
 *      mesh-event-forwarding returns early, skipping updateSessionTaskStatus,
 *      updateDirectDispatchStatus and markSessionDeliveriesTerminal. The session sits
 *      at `generating` while the dashboard reports work in progress.
 *
 *   2. Redrive protection was lost. The confirmed-delivery record is what stops
 *      recoverStrandedAssignedDispatches from reclaiming an already-completed task,
 *      so an unlucky interleaving could re-run finished work.
 *
 * These tests pin the corrected contract. The discriminating assertions are the
 * attempt-id shape (a real UUID, never `legacy-`) and the resolvability of that
 * attempt by (taskId, sessionId) — reverting the fix makes exactly those fail.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import {
    recordDirectDispatchTask,
    updateSessionTaskStatus,
    getQueue,
    __clearMeshQueueForTests,
    __resetMeshRuntimeStoreForTests,
} from '../../src/mesh/mesh-work-queue.js';
import { resolveAttemptForTask } from '../../src/mesh/mesh-turn-ledger.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

const MESH = 'mesh_missionless_dispatch';
const NODE = 'node_worker';
const SESSION = 'sess_worker';

describe('missionless direct dispatch opens a real turn attempt', () => {
    beforeEach(() => {
        __resetMeshRuntimeStoreForTests();
        __clearMeshQueueForTests(MESH);
    });

    const dispatch = (missionId?: string) => {
        const taskId = randomUUID();
        const entry = recordDirectDispatchTask(MESH, 'do the thing', {
            id: taskId,
            ...(missionId ? { missionId } : {}),
            assignedNodeId: NODE,
            assignedSessionId: SESSION,
            dispatchedAt: new Date().toISOString(),
        });
        return { taskId, entry };
    };

    it('materialises the queue entry with no mission_id', () => {
        const { entry } = dispatch();
        expect(entry).not.toBeNull();
        expect(entry!.status).toBe('assigned');
        // Not attributed to any mission — that part of the old behavior is preserved.
        expect(entry!.missionId).toBeUndefined();
        expect(getQueue(MESH)).toHaveLength(1);
    });

    it('stamps a proper UUID attemptId, never a legacy- placeholder', () => {
        const { entry } = dispatch();

        // THE discriminator. Without the fix there is no attempt at all, and the
        // reducer later synthesises `legacy-<taskId>-<seq>` instead.
        expect(entry!.attemptId).toBeTruthy();
        expect(entry!.attemptId).not.toMatch(/^legacy-/);
        expect(entry!.attemptId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
    });

    it('opens the attempt bound to the dispatched session so the reducer can resolve it', () => {
        const { taskId, entry } = dispatch();

        // The session-binding mismatch is what made the reducer refuse the flip
        // (stale_attempt / session_mismatch). Resolving by the real session proves the
        // attempt is usable, not merely present.
        const resolved = resolveAttemptForTask(MESH, taskId, { sessionId: SESSION });
        expect(resolved).toBeTruthy();
        expect(resolved?.attemptId).toBe(entry!.attemptId);
        expect(resolved?.attemptId).not.toMatch(/^legacy-/);
    });

    it('records the confirmed delivery that blocks watchdog redrive', () => {
        const { taskId } = dispatch();
        // taskHasConfirmedDelivery is the exact gate recoverStrandedAssignedDispatches
        // consults before reclaiming an assigned row.
        expect(MeshRuntimeStore.getInstance().taskHasConfirmedDelivery(MESH, taskId)).toBe(true);
    });

    it('reaches a terminal status when the completion arrives', () => {
        const { taskId } = dispatch();

        // The downstream write that mesh-event-forwarding skipped entirely once the
        // reducer refused the flip. With a resolvable attempt this now lands.
        updateSessionTaskStatus(MESH, SESSION, 'completed');

        const row = getQueue(MESH).find(t => t.id === taskId);
        expect(row?.status).toBe('completed');
    });

    it('still works when a mission IS supplied (regression guard)', () => {
        const missionId = `mission_${randomUUID()}`;
        const { taskId, entry } = dispatch(missionId);

        expect(entry).not.toBeNull();
        expect(entry!.missionId).toBe(missionId);
        expect(entry!.attemptId).toBeTruthy();
        expect(entry!.attemptId).not.toMatch(/^legacy-/);
        expect(MeshRuntimeStore.getInstance().taskHasConfirmedDelivery(MESH, taskId)).toBe(true);

        updateSessionTaskStatus(MESH, SESSION, 'completed');
        expect(getQueue(MESH).find(t => t.id === taskId)?.status).toBe('completed');
    });
});
