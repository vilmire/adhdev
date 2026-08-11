import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// A2: when the SQLite pending-event drain throws, the failure must be logged, not
// silently swallowed.
//
// The original rationale was split-brain: the JSONL copy got emptied while the SQLite
// rows survived undrained and were re-delivered on the next drain. With the JSONL
// mirror retired that failure mode is structurally impossible — nothing drains at all
// when the store is down. The logging requirement remains, with the consequence
// inverted: delivery is STOPPED (no fallback), not degraded, so the operator must be
// told. The warn stays log-once because an unavailable better-sqlite3 throws on every
// mesh, every reconcile tick (~4s), and a flood buries the diagnosis.

const testTmpDir = join(tmpdir(), `adhdev-mesh-drainlog-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
}));

import { drainPendingMeshCoordinatorEvents, __resetSqlitePendingDrainWarnForTests } from '../../src/mesh/mesh-events-pending.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { LOG } from '../../src/logging/logger.js';

describe('mesh-events-pending — SQLite drain failure is logged', () => {
    beforeEach(() => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        // The SQLite-drain-failure WARN is one-shot (module-level guard) to stop the
        // per-cycle log flood; reset it so this test always exercises the first-warn path.
        __resetSqlitePendingDrainWarnForTests();
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

    function failTheDrain() {
        const store = MeshRuntimeStore.getInstance();
        vi.spyOn(store, 'pendingEventCount').mockImplementation(() => {
            throw new Error('simulated better-sqlite3 unavailable');
        });
    }

    it('logs a warn and drains nothing when the SQLite drain throws', () => {
        const meshId = `mesh-drainfail-${randomUUID().slice(0, 8)}`;
        const warnSpy = vi.spyOn(LOG, 'warn').mockImplementation(() => undefined as any);
        failTheDrain();

        const drained = drainPendingMeshCoordinatorEvents(meshId);

        // No fallback store: nothing is delivered. Crucially, nothing is CONSUMED
        // either — the rows stay undrained and the next tick retries them.
        expect(drained).toEqual([]);

        const warn = warnSpy.mock.calls.find(([component]) => component === 'MeshEvents');
        expect(warn).toBeDefined();
        const message = String(warn?.[1] ?? '');
        expect(message).toContain(meshId);
        // The message must state the real consequence, not imply a working fallback.
        expect(message).toMatch(/NO events can be delivered|no fallback/i);
    });

    it('warns only ONCE across repeated failing drains (log-once flood guard)', () => {
        const meshId = `mesh-drainfail-${randomUUID().slice(0, 8)}`;
        const warnSpy = vi.spyOn(LOG, 'warn').mockImplementation(() => undefined as any);
        const debugSpy = vi.spyOn(LOG, 'debug').mockImplementation(() => undefined as any);
        failTheDrain();

        for (let i = 0; i < 3; i++) {
            expect(drainPendingMeshCoordinatorEvents(meshId)).toEqual([]);
        }

        const warns = warnSpy.mock.calls.filter(([component]) => component === 'MeshEvents');
        expect(warns).toHaveLength(1);
        // Subsequent occurrences stay visible at debug rather than vanishing.
        const debugs = debugSpy.mock.calls.filter(([component]) => component === 'MeshEvents');
        expect(debugs.length).toBeGreaterThanOrEqual(2);
    });
});
