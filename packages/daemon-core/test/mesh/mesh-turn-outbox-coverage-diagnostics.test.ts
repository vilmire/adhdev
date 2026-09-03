// Stage 5a-3 — redrive-vs-outbox coverage diagnostics, against the REAL
// turn-ledger outbox (drainTurnOutbox) and the real redrive counters
// (consumeRedriveEntry). This is the evidence the design's 5a→5b gate reads:
// "커버리지 100%(모든 터미널이 outbox 없이도 redrive로 주입됨을 계측으로
// 입증)" — docs/design/2026-08-29-seqscribe-outbox-migration.md §7.
//
// The root gate (tests/seqscribe-terminal-redrive.test.mjs) only proves the
// two injection paths build equivalent fingerprint fields; it does not run a
// real outbox delivery, so it cannot exercise `outboxByStatus.delivered`. This
// suite does, via the same `enqueueTerminalOutbox` + `drainTurnOutbox` route
// mesh-turn-outbox-diagnostics.test.ts uses.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const testTmpDir = join(tmpdir(), `adhdev-outbox-coverage-test-${randomUUID().slice(0, 8)}`);
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
    openTurnAttempt,
    enqueueTerminalOutbox,
    drainTurnOutbox,
    __resetTurnLedgerMetricsForTests,
} from '../../src/mesh/mesh-turn-ledger.js';
import {
    consumeRedriveEntry,
    __resetTerminalRedriveForTests,
    type RedriveProjectedEntry,
} from '../../src/mesh/mesh-terminal-redrive.js';
import { readRedriveCoverageDiagnostics } from '../../src/mesh/mesh-turn-outbox-coverage-diagnostics.js';

const MESH = `mesh-${randomUUID().slice(0, 8)}`;
let taskSeq = 0;
function nextTaskId(): string {
    taskSeq += 1;
    return `task-${randomUUID().slice(0, 8)}-${taskSeq}`;
}

function projectedTerminal(taskId: string): RedriveProjectedEntry {
    return {
        id: `entry-${taskId}`,
        ledgerKind: 'task_completed',
        nodeId: 'node-coverage',
        sessionId: 'sess-coverage',
        providerType: 'claude',
        taskId,
        payload: { taskId, event: 'agent:generating_completed' },
    };
}

async function deliverViaOutbox(taskId: string): Promise<void> {
    const { attempt } = openTurnAttempt({ meshId: MESH, taskId, dispatchNonce: 1, sessionId: 'sess-coverage' });
    enqueueTerminalOutbox({
        meshId: MESH,
        taskId,
        attemptId: attempt.attemptId,
        outcome: 'completed',
        payload: { event: 'agent:generating_completed', sessionId: 'sess-coverage' },
    });
    await drainTurnOutbox(async (row) => {
        // Same injection the real drainMeshTurnOutbox performs, without
        // importing mesh-event-suppression.ts (keeps this suite scoped to the
        // ledger + redrive + coverage modules under test).
        const { queuePendingMeshCoordinatorEvent } = await import('../../src/mesh/mesh-events-pending.js');
        const payload = row.payload as Record<string, unknown>;
        queuePendingMeshCoordinatorEvent({
            event: typeof payload.event === 'string' ? payload.event : 'agent:generating_completed',
            meshId: row.meshId,
            metadataEvent: {
                ...(row.taskId ? { taskId: row.taskId } : {}),
                source: 'turn_outbox_redelivery',
                outboxRedelivery: true,
            },
            queuedAt: Date.now(),
        } as any);
    });
}

beforeEach(() => {
    __resetTurnLedgerMetricsForTests();
    __resetTerminalRedriveForTests();
});

afterEach(() => {
    MeshRuntimeStore.resetForTests();
    try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('redrive coverage diagnostics (Stage 5, 5a-3)', () => {
    it('reports null coverage when the outbox has delivered nothing yet', () => {
        const diag = readRedriveCoverageDiagnostics();
        expect(diag.outboxDelivered).toBe(0);
        expect(diag.redriveInjected).toBe(0);
        expect(diag.coveragePercent).toBeNull();
    });

    it('reports 0% while the redrive leg stays off (flag-off is a real production shape)', async () => {
        const taskId = nextTaskId();
        await deliverViaOutbox(taskId);
        // No consumeRedriveEntry call — the flag-off default.

        const diag = readRedriveCoverageDiagnostics();
        expect(diag.outboxDelivered).toBe(1);
        expect(diag.redriveInjected).toBe(0);
        expect(diag.coveragePercent).toBe(0);
    });

    it('climbs to 100% when redrive independently reaches every outbox-delivered terminal', async () => {
        const taskA = nextTaskId();
        const taskB = nextTaskId();

        await deliverViaOutbox(taskA);
        consumeRedriveEntry(MESH, projectedTerminal(taskA));

        await deliverViaOutbox(taskB);
        consumeRedriveEntry(MESH, projectedTerminal(taskB));

        const diag = readRedriveCoverageDiagnostics();
        expect(diag.outboxDelivered).toBe(2);
        expect(diag.redriveInjected).toBe(2);
        expect(diag.coveragePercent).toBe(100);
    });

    /**
     * ★Red/green injection (gate checklist ①). If `getTotalRedriveInjected`
     * summed only ONE mesh's state (e.g. a hardcoded meshId instead of
     * iterating the state map), this reds: coverage would silently read 50%
     * instead of 100% with two meshes each fully covered.
     */
    it('sums redrive injections across every mesh, not just one', async () => {
        const otherMesh = `mesh-${randomUUID().slice(0, 8)}`;
        const taskA = nextTaskId();
        const taskB = nextTaskId();

        await deliverViaOutbox(taskA);
        consumeRedriveEntry(MESH, projectedTerminal(taskA));

        // Second mesh, same delivery/injection shape.
        const { attempt } = openTurnAttempt({ meshId: otherMesh, taskId: taskB, dispatchNonce: 1, sessionId: 'sess-coverage' });
        enqueueTerminalOutbox({
            meshId: otherMesh,
            taskId: taskB,
            attemptId: attempt.attemptId,
            outcome: 'completed',
            payload: { event: 'agent:generating_completed' },
        });
        await drainTurnOutbox(async (row) => {
            const { queuePendingMeshCoordinatorEvent } = await import('../../src/mesh/mesh-events-pending.js');
            queuePendingMeshCoordinatorEvent({
                event: 'agent:generating_completed',
                meshId: row.meshId,
                metadataEvent: { taskId: row.taskId, source: 'turn_outbox_redelivery', outboxRedelivery: true },
                queuedAt: Date.now(),
            } as any);
        }, { meshId: otherMesh });
        consumeRedriveEntry(otherMesh, {
            id: `entry-${taskB}`,
            ledgerKind: 'task_completed',
            taskId: taskB,
            payload: { taskId: taskB, event: 'agent:generating_completed' },
        });

        const diag = readRedriveCoverageDiagnostics();
        expect(diag.outboxDelivered).toBe(2);
        expect(diag.redriveInjected).toBe(2);
        expect(diag.coveragePercent).toBe(100);
    });

    it('clamps at 100% rather than exceeding it when redrive races ahead of the outbox count', async () => {
        // Redrive can legitimately inject before the outbox drains in the
        // same tick (dual drive has no ordering guarantee between the two
        // triggers). Coverage must not report e.g. 150% in that window.
        const taskA = nextTaskId();
        consumeRedriveEntry(MESH, projectedTerminal(taskA));
        consumeRedriveEntry(MESH, projectedTerminal(nextTaskId()));
        await deliverViaOutbox(taskA);

        const diag = readRedriveCoverageDiagnostics();
        expect(diag.outboxDelivered).toBe(1);
        expect(diag.redriveInjected).toBe(2);
        expect(diag.coveragePercent).toBe(100);
    });
});
