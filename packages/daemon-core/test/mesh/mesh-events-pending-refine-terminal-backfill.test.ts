import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// refineTerminalEventFromLedger reads through readLedgerEntriesByKind, whose underlying
// store side-writes a per-mesh JSONL/SQLite under getConfigDir(); redirect it to a temp dir.
const testTmpDir = join(tmpdir(), `adhdev-mesh-refine-backfill-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'mach_backfill_test' }),
}));

import {
    queuePendingMeshCoordinatorEvent,
    drainPendingMeshCoordinatorEvents,
    __clearMeshPendingEventsForTests,
} from '../../src/mesh/mesh-events-pending.js';
import { appendLedgerEntry, __clearMeshLedgerForTests } from '../../src/mesh/mesh-ledger.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

describe('mesh pending-event — refine terminal ledger backfill (LEDGER-KIND-TAIL-BLINDSPOT)', () => {
    let meshId = `refine-backfill-${randomUUID().slice(0, 8)}`;

    beforeEach(() => {
        meshId = `refine-backfill-${randomUUID().slice(0, 8)}`;
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
    });

    afterEach(() => {
        __clearMeshPendingEventsForTests(meshId);
        __clearMeshLedgerForTests(meshId);
        try { MeshRuntimeStore.resetForTests(); } catch { /* best-effort */ }
    });

    // ★An accepted refine job with no matching terminal PendingMeshCoordinatorEvent (e.g. the
    // daemon restarted before the terminal was queued) must have its terminal backfilled from
    // the ledger — this is what tells the coordinator its merge finished. Before the fix,
    // refineTerminalEventFromLedger read a bare `tail: 200` window; a bare tail window can be
    // crowded out by unrelated mesh traffic, silently dropping the backfill and leaving the
    // coordinator never notified — the mirror-image bug of the refine-notification-storm fix
    // landed the same day.
    it('★backfills a buried task_completed terminal for an accepted refine job beyond the 200-entry tail window', () => {
        queuePendingMeshCoordinatorEvent({
            event: 'refine:accepted',
            meshId,
            nodeLabel: 'node-buried',
            nodeId: 'node-buried',
            metadataEvent: {
                source: 'refine_mesh_node_async_job',
                jobId: 'job-buried-backfill',
                status: 'accepted',
            },
            queuedAt: Date.now(),
        });

        appendLedgerEntry(meshId, {
            kind: 'task_completed',
            nodeId: 'node-buried',
            payload: {
                source: 'refine_mesh_node_async_job',
                refineJob: { jobId: 'job-buried-backfill', status: 'completed', meshId, nodeId: 'node-buried' },
                async: true,
                success: true,
            },
        } as any);

        for (let i = 0; i < 260; i++) {
            appendLedgerEntry(meshId, {
                kind: 'session_launched',
                nodeId: 'node-other',
                payload: { source: 'unrelated_traffic', seq: i },
            } as any);
        }

        const drained = drainPendingMeshCoordinatorEvents(meshId, [], {});
        const terminal = drained.find(e => e.event === 'refine:completed');
        expect(terminal).toBeDefined();
        expect(terminal?.nodeId).toBe('node-buried');
    });

    it('does not backfill when the accepted job has no terminal in the ledger', () => {
        queuePendingMeshCoordinatorEvent({
            event: 'refine:accepted',
            meshId,
            nodeLabel: 'node-still-running',
            nodeId: 'node-still-running',
            metadataEvent: {
                source: 'refine_mesh_node_async_job',
                jobId: 'job-still-running',
                status: 'accepted',
            },
            queuedAt: Date.now(),
        });

        for (let i = 0; i < 260; i++) {
            appendLedgerEntry(meshId, {
                kind: 'session_launched',
                nodeId: 'node-other',
                payload: { source: 'unrelated_traffic', seq: i },
            } as any);
        }

        const drained = drainPendingMeshCoordinatorEvents(meshId, [], {});
        const terminal = drained.find(e => e.event === 'refine:completed' || e.event === 'refine:failed');
        expect(terminal).toBeUndefined();
    });
});
