/**
 * MISSIONLESS-DIRECT-DISPATCH-NO-ATTEMPT
 *
 * A `mesh_send_task` (direct dispatch) issued WITHOUT a mission_id once opened
 * no turn attempt and wrote no confirmed delivery, because both sat behind
 * recordDirectDispatchTask's `if (!missionId) return null` early-return — a gate
 * that existed only for mission ATTRIBUTION. Terminal state never converged and
 * redrive protection was lost.
 *
 * C-W8 (wiring-unification): the attempt is the TURN LEDGER's `mesh_direct`
 * attempt, opened by the caller (mcp-server `openDirectDispatchAttempt` →
 * `turn_observe` `dispatch_accepted`) — the legacy Stage-5 `openTurnAttempt`
 * inside recordDirectDispatchTask is retired, and the worker-MCP task token is
 * minted daemon-side when the ledger opens the attempt. These tests pin:
 *   - the row materialises missionless and carries the CALLER's attempt id;
 *   - (the confirmed delivery is the attempt's `delivered` evidence, pinned by the
 *     ledger suites — the legacy delivery row is retired);
 *   - the daemon-side `turn_observe` mints the worker token on attempt creation.
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
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { createMeshRuntimeTurnLedger } from '../../src/mesh/turn-ledger/runtime-ledger.js';
import { setActiveTurnLedgerForIpc, turnLedgerIpcHandlers } from '../../src/commands/low-family/turn-ledger-ipc.js';
import { __resetWorkerTaskTokensForTest, findWorkerTaskTokenForSession, liveWorkerTaskTokenCount } from '../../src/mesh/worker-mcp-isolation.js';
import { fakePublisher } from '../turn-ledger/ledger-harness.js';

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
            difficulty: 'medium',
            attemptId: `mesh_direct:${taskId}`,
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

    it("stamps the caller's ledger attempt id on the row (no legacy attempt is opened)", () => {
        const { taskId, entry } = dispatch();
        expect(entry!.attemptId).toBe(`mesh_direct:${taskId}`);
        expect(getQueue(MESH).find((t) => t.id === taskId)?.attemptId).toBe(`mesh_direct:${taskId}`);
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
        expect(entry!.attemptId).toBe(`mesh_direct:${taskId}`);

        updateSessionTaskStatus(MESH, SESSION, 'completed');
        expect(getQueue(MESH).find(t => t.id === taskId)?.status).toBe('completed');
    });
});

describe('turn_observe mints the worker token when the ledger opens a direct attempt (C-W8)', () => {
    beforeEach(() => {
        __resetMeshRuntimeStoreForTests();
        __resetWorkerTaskTokensForTest();
    });

    const observe = (taskId: string) => turnLedgerIpcHandlers.turn_observe({ deps: { statusInstanceId: 'dc' } } as any, {
        v: 1,
        evidence: {
            eventId: taskId, at: Date.now(), source: 'dispatch', sessionId: SESSION, taskId, observedBy: 'dc',
            kind: 'dispatch_accepted', scope: 'mesh_direct', messageId: taskId, meshId: MESH, nodeId: NODE,
        },
    });

    it('mints exactly once per applied mesh_direct dispatch_accepted, bound to the attempt', async () => {
        const ledger = createMeshRuntimeTurnLedger({ selfDaemonId: 'dc', publisher: fakePublisher() });
        setActiveTurnLedgerForIpc(ledger);
        try {
            const taskId = randomUUID();
            const first: any = await observe(taskId);
            expect(first.success).toBe(true);
            const token = findWorkerTaskTokenForSession(MESH, taskId, SESSION);
            expect(token?.attemptId).toBe(first.attemptRef.attemptId);
            // A replay (same eventId) is not an applied open — it mints nothing and
            // the first token stays the live one.
            await observe(taskId);
            expect(liveWorkerTaskTokenCount()).toBe(1);
            expect(findWorkerTaskTokenForSession(MESH, taskId, SESSION)?.token).toBe(token?.token);
        } finally {
            setActiveTurnLedgerForIpc(null);
        }
    });
});
