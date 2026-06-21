import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// A2: when the SQLite pending-event drain throws, the failure must be logged (not
// silently swallowed) — otherwise the JSONL copy is emptied while the SQLite rows
// survive undrained and get re-delivered to the coordinator on the next drain, with
// no diagnostic trail. The JSONL fallback must still drain so behaviour is preserved.

const testTmpDir = join(tmpdir(), `adhdev-mesh-drainlog-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
}));

import { drainPendingMeshCoordinatorEvents } from '../../src/mesh/mesh-events-pending.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { getLedgerDir } from '../../src/mesh/mesh-ledger.js';
import { LOG } from '../../src/logging/logger.js';

describe('mesh-events-pending — SQLite drain failure is logged', () => {
    beforeEach(() => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        try {
            MeshRuntimeStore.resetForTests();
        } catch { /* best-effort */ }
        try {
            rmSync(testTmpDir, { recursive: true, force: true });
        } catch { /* cleanup best-effort */ }
    });

    it('logs a warn and still drains the JSONL fallback when the SQLite drain throws', () => {
        const meshId = `mesh-drainfail-${randomUUID().slice(0, 8)}`;

        // Pre-write a JSONL pending event for this mesh (legacy fallback path).
        const ledgerDir = getLedgerDir();
        mkdirSync(ledgerDir, { recursive: true });
        const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
        const jsonlPath = join(ledgerDir, `${safe}.pending-events.jsonl`);
        const event = {
            event: 'node_online',
            meshId,
            nodeLabel: 'node-1',
            nodeId: 'node-1',
            metadataEvent: { nodeId: 'node-1' },
            queuedAt: Date.now(),
        };
        writeFileSync(jsonlPath, JSON.stringify(event) + '\n', 'utf-8');

        // Force the SQLite path to throw inside the drain try/catch.
        vi.spyOn(MeshRuntimeStore, 'getInstance').mockImplementation(() => {
            throw new Error('boom: store unavailable');
        });
        const warnSpy = vi.spyOn(LOG, 'warn').mockImplementation(() => undefined as any);

        const drained = drainPendingMeshCoordinatorEvents(meshId);

        // The failure is surfaced via LOG.warn under the MeshEvents component.
        expect(warnSpy.mock.calls.some(([component]) => component === 'MeshEvents')).toBe(true);
        // The JSONL fallback still drained the queued event (behaviour preserved).
        expect(drained.map(e => e.event)).toContain('node_online');
    });
});
