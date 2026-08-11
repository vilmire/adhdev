import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// The pending-event queue used to dual-write to SQLite AND a per-mesh JSONL file.
// The JSONL half is retired; SQLite is the sole store. A machine upgrading across
// that cut can still hold JSONL files with UNDELIVERED events that nothing would
// ever read again — and mesh-disk-retention's pruneExpiredLedgerJsonl deletes
// `*.jsonl` at 30 days WITHOUT draining. This suite covers the one-shot boot
// migration that salvages them.

const testTmpDir = join(tmpdir(), `adhdev-mesh-jsonlmig-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'mach_1b46842a15d3409d96ad33e767a916dd' }),
}));

import { migratePendingEventsJsonlToSqlite } from '../../src/mesh/mesh-events-pending-migration.js';
import { getPendingMeshCoordinatorEvents, drainPendingMeshCoordinatorEvents } from '../../src/mesh/mesh-events-pending.js';
import { getLedgerDir } from '../../src/mesh/mesh-ledger.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

function makeEvent(meshId: string, eventName: string, extra: Record<string, unknown> = {}) {
    return {
        event: eventName,
        meshId,
        nodeLabel: 'node-1',
        nodeId: 'node-1',
        metadataEvent: { nodeId: 'node-1', taskId: `task-${eventName}` },
        coordinatorMessage: `[System] ${eventName}`,
        queuedAt: Date.now() - 60_000,
        ...extra,
    };
}

function writeJsonlFile(meshId: string, lines: string[], coordinatorDaemonId?: string): string {
    const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const name = coordinatorDaemonId
        ? `${safe}-${coordinatorDaemonId.replace(/[^a-zA-Z0-9_-]/g, '_')}.pending-events.jsonl`
        : `${safe}.pending-events.jsonl`;
    const path = join(getLedgerDir(), name);
    writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
    return path;
}

describe('mesh-events-pending — one-shot legacy JSONL -> SQLite boot migration', () => {
    beforeEach(() => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        try { MeshRuntimeStore.resetForTests(); } catch { /* best-effort */ }
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('imports leftover events into SQLite and unlinks the file', () => {
        const meshId = `mesh-mig-${randomUUID().slice(0, 8)}`;
        const path = writeJsonlFile(meshId, [
            JSON.stringify(makeEvent(meshId, 'refine:completed')),
            JSON.stringify(makeEvent(meshId, 'mesh:dispatch_blocked')),
        ]);

        const result = migratePendingEventsJsonlToSqlite();

        expect(result.eventsImported).toBe(2);
        expect(result.filesRemoved).toBe(1);
        expect(result.filesRetained).toBe(0);
        // The file is gone — nothing left for pruneExpiredLedgerJsonl to silently delete.
        expect(existsSync(path)).toBe(false);

        // The events are genuinely in the SQLite store: they drain.
        const drained = drainPendingMeshCoordinatorEvents(meshId);
        expect(drained.map(e => e.event).sort()).toEqual(['mesh:dispatch_blocked', 'refine:completed']);
    });

    it('preserves the original queuedAt so age-based expiry keeps measuring true age', () => {
        const meshId = `mesh-mig-${randomUUID().slice(0, 8)}`;
        const queuedAt = Date.now() - 3_600_000; // an hour old
        writeJsonlFile(meshId, [JSON.stringify(makeEvent(meshId, 'node_online', { queuedAt }))]);

        migratePendingEventsJsonlToSqlite();

        const pending = getPendingMeshCoordinatorEvents(meshId);
        expect(pending).toHaveLength(1);
        expect(pending[0].queuedAt).toBe(queuedAt);
    });

    it('salvages readable events when the file contains corrupt lines', () => {
        const meshId = `mesh-mig-${randomUUID().slice(0, 8)}`;
        writeJsonlFile(meshId, [
            JSON.stringify(makeEvent(meshId, 'refine:completed')),
            '{"event":"truncated-mid-write', // crash/disk-full truncation
            'not json at all',
            JSON.stringify({ event: 'no-mesh-id' }), // structurally unusable
            JSON.stringify(makeEvent(meshId, 'node_online')),
        ]);

        const result = migratePendingEventsJsonlToSqlite();

        // A corrupt line must never block the readable ones.
        expect(result.eventsImported).toBe(2);
        expect(result.linesSkipped).toBe(3);
        expect(result.filesRemoved).toBe(1);

        const drained = drainPendingMeshCoordinatorEvents(meshId);
        expect(drained.map(e => e.event).sort()).toEqual(['node_online', 'refine:completed']);
    });

    it('removes an empty legacy file without importing anything', () => {
        const meshId = `mesh-mig-${randomUUID().slice(0, 8)}`;
        const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
        const path = join(getLedgerDir(), `${safe}.pending-events.jsonl`);
        writeFileSync(path, '', 'utf-8');

        const result = migratePendingEventsJsonlToSqlite();

        expect(result.filesScanned).toBe(1);
        expect(result.eventsImported).toBe(0);
        expect(result.filesRemoved).toBe(1);
        expect(existsSync(path)).toBe(false);
    });

    it('is a no-op when there are no legacy files', () => {
        const result = migratePendingEventsJsonlToSqlite();
        expect(result).toEqual({
            filesScanned: 0,
            eventsImported: 0,
            linesSkipped: 0,
            filesRemoved: 0,
            filesRetained: 0,
        });
    });

    it('migrates coordinator-scoped files and preserves their target daemon', () => {
        const meshId = `mesh-mig-${randomUUID().slice(0, 8)}`;
        const daemonId = 'standalone_mach_abc123';
        writeJsonlFile(
            meshId,
            [JSON.stringify(makeEvent(meshId, 'refine:completed', { targetCoordinatorDaemonId: daemonId }))],
            daemonId,
        );

        const result = migratePendingEventsJsonlToSqlite();
        expect(result.eventsImported).toBe(1);
        expect(result.filesRemoved).toBe(1);

        // The row landed in SQLite carrying its coordinator target, so the normal
        // scoped-drain routing applies to it exactly as it would to a natively
        // queued event. (Delivery itself is not asserted here: this legacy line is
        // an UNVERSIONED v1 event, which the pre-existing T6 v2-ENFORCE quarantine
        // holds back at drain time — that behaviour is independent of the store it
        // came from, and is covered by the v2-enforce suite.)
        const rows = MeshRuntimeStore.getInstance().peekPendingEvents(meshId);
        expect(rows).toHaveLength(1);
        expect(rows[0].event).toBe('refine:completed');
        expect((rows[0].payload as any).targetCoordinatorDaemonId).toBe(daemonId);
    });

    it('is idempotent — a second run does not double-import', () => {
        const meshId = `mesh-mig-${randomUUID().slice(0, 8)}`;
        const line = JSON.stringify(makeEvent(meshId, 'refine:completed'));
        writeJsonlFile(meshId, [line]);

        migratePendingEventsJsonlToSqlite();
        // Simulate a leftover copy reappearing (e.g. restored backup) and re-run.
        writeJsonlFile(meshId, [line]);
        const second = migratePendingEventsJsonlToSqlite();

        expect(second.filesScanned).toBe(1);
        // INSERT OR IGNORE against UNIQUE (mesh_id, fingerprint) collapses the re-import.
        const pending = getPendingMeshCoordinatorEvents(meshId);
        expect(pending.filter(e => e.event === 'refine:completed')).toHaveLength(1);
    });

    it('retains the file when the store rejects the import, so events are not lost', () => {
        const meshId = `mesh-mig-${randomUUID().slice(0, 8)}`;
        const path = writeJsonlFile(meshId, [JSON.stringify(makeEvent(meshId, 'refine:completed'))]);

        const store = MeshRuntimeStore.getInstance();
        const spy = vi.spyOn(store, 'insertPendingEvent').mockImplementation(() => {
            throw new Error('simulated store failure');
        });

        const result = migratePendingEventsJsonlToSqlite();

        expect(result.eventsImported).toBe(0);
        expect(result.filesRetained).toBe(1);
        expect(result.filesRemoved).toBe(0);
        // A retained file is recoverable; a deleted one is not.
        expect(existsSync(path)).toBe(true);
        expect(readFileSync(path, 'utf-8')).toContain('refine:completed');

        spy.mockRestore();
    });
});
