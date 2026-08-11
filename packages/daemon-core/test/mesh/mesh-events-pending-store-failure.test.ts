import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Replaces mesh-events-pending-jsonl-besteffort.test.ts (F4). That suite asserted the
// OPPOSITE contract: with a JSONL mirror behind it, a persist could report success
// even when one store failed, because the other still held the event.
//
// The mirror is retired and SQLite is the sole store, so the contract inverts: a store
// failure means the event is queued NOWHERE and must be reported as a real failure —
// loudly, and never silently swallowed. That matters most for mesh:dispatch_blocked,
// the compensating notification that tells a coordinator its task was not dispatched;
// dropping it silently is the exact failure it exists to prevent.

const testTmpDir = join(tmpdir(), `adhdev-mesh-storefail-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'mach_1b46842a15d3409d96ad33e767a916dd' }),
}));

import { queuePendingMeshCoordinatorEvent, getPendingMeshCoordinatorEvents } from '../../src/mesh/mesh-events-pending.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { LOG } from '../../src/logging/logger.js';

describe('mesh-events-pending — SQLite is the sole store: a persist failure is loud, not silent', () => {
    beforeEach(() => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        try { MeshRuntimeStore.resetForTests(); } catch { /* best-effort */ }
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    function makeEvent(meshId: string, eventName: string) {
        return {
            event: eventName,
            meshId,
            nodeLabel: 'node-1',
            nodeId: 'node-1',
            metadataEvent: { nodeId: 'node-1', taskId: 'task-1' },
            coordinatorMessage: `[System] ${eventName}`,
            queuedAt: Date.now(),
        } as any;
    }

    it('reports failure (not success) when the store insert throws', () => {
        const meshId = `mesh-storefail-${randomUUID().slice(0, 8)}`;
        const store = MeshRuntimeStore.getInstance();
        vi.spyOn(store, 'insertPendingEvent').mockImplementation(() => {
            throw new Error('ENOENT: simulated better-sqlite3 unavailable');
        });
        vi.spyOn(LOG, 'error').mockImplementation(() => undefined as any);

        const ok = queuePendingMeshCoordinatorEvent(makeEvent(meshId, 'node_online'));

        // There is no fallback store, so this MUST NOT report success.
        expect(ok).toBe(false);
    });

    it('logs the dropped dispatch_blocked at ERROR, naming the event and mesh', () => {
        const meshId = `mesh-storefail-${randomUUID().slice(0, 8)}`;
        const store = MeshRuntimeStore.getInstance();
        vi.spyOn(store, 'insertPendingEvent').mockImplementation(() => {
            throw new Error('disk I/O error');
        });
        const errorSpy = vi.spyOn(LOG, 'error').mockImplementation(() => undefined as any);

        const ok = queuePendingMeshCoordinatorEvent(makeEvent(meshId, 'mesh:dispatch_blocked'));

        expect(ok).toBe(false);
        // The loss must be attributable after the fact: component, event name, mesh id.
        const errorCall = errorSpy.mock.calls.find(([component]) => component === 'MeshEvents');
        expect(errorCall).toBeDefined();
        const message = String(errorCall?.[1] ?? '');
        expect(message).toContain('mesh:dispatch_blocked');
        expect(message).toContain(meshId);
        expect(message).toMatch(/NOT queued|will NOT be delivered/);
    });

    it('queues normally and is peekable when the store is healthy', () => {
        const meshId = `mesh-storefail-${randomUUID().slice(0, 8)}`;

        const ok = queuePendingMeshCoordinatorEvent(makeEvent(meshId, 'mesh:dispatch_blocked'));

        expect(ok).toBe(true);
        expect(getPendingMeshCoordinatorEvents(meshId).map(e => e.event)).toContain('mesh:dispatch_blocked');
    });
});
