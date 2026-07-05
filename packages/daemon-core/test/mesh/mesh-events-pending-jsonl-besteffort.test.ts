import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// F4: queuePendingMeshCoordinatorEvent dual-writes to SQLite (primary) and a JSONL
// legacy artifact. The JSONL append used to sit outside any inner try/catch, so a
// JSONL failure (disk full, permissions) AFTER a successful SQLite insert fell to the
// outer catch and returned false — reporting the whole persist as failed even though
// the primary store holds the event. The append must be best-effort once SQLite has it.

const testTmpDir = join(tmpdir(), `adhdev-mesh-jsonlbe-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    // The self-daemon fallback in stampPendingEventV2 reads loadConfig().machineId.
    loadConfig: () => ({ machineId: 'mach_1b46842a15d3409d96ad33e767a916dd' }),
}));

// Mock only fs.appendFileSync to throw; everything else (mkdirSync/existsSync/statSync
// used by the store dir setup and the JSONL trim) stays real, and better-sqlite3's
// native IO does not route through this JS module, so the SQLite write still succeeds.
vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        appendFileSync: vi.fn(() => {
            throw new Error('ENOSPC: simulated disk full (JSONL append)');
        }),
    };
});

import { queuePendingMeshCoordinatorEvent, drainPendingMeshCoordinatorEvents } from '../../src/mesh/mesh-events-pending.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { LOG } from '../../src/logging/logger.js';

describe('mesh-events-pending — JSONL append is best-effort once SQLite holds the event (F4)', () => {
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

    it('returns true and keeps the event in SQLite when the JSONL append throws', () => {
        const meshId = `mesh-jsonlbe-${randomUUID().slice(0, 8)}`;
        const warnSpy = vi.spyOn(LOG, 'warn').mockImplementation(() => undefined as any);

        const event = {
            event: 'node_online',
            meshId,
            nodeLabel: 'node-1',
            nodeId: 'node-1',
            metadataEvent: { nodeId: 'node-1' },
            queuedAt: Date.now(),
        } as any;

        // SQLite write succeeds; the (mocked) JSONL append throws.
        const ok = queuePendingMeshCoordinatorEvent(event);

        // The persist is reported as successful — the primary store has the event.
        expect(ok).toBe(true);
        // The JSONL failure is surfaced (not swallowed silently) via a MeshEvents warn.
        expect(warnSpy.mock.calls.some(([component]) => component === 'MeshEvents')).toBe(true);
        // Proof the event actually landed in SQLite despite the JSONL failure: it drains.
        const drained = drainPendingMeshCoordinatorEvents(meshId);
        expect(drained.map(e => e.event)).toContain('node_online');
    });
});
