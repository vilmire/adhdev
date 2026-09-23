import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Override home dir to use a temp directory for ledger storage
const testTmpDir = join(tmpdir(), `adhdev-local-records-test-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

// We need to mock getConfigDir before importing the module
import { vi } from 'vitest';

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) {
            mkdirSync(testConfigDir, { recursive: true });
        }
        return testConfigDir;
    },
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));

import { MAX_LEDGER_SLICE_LIMIT, isIntentionalCleanupStopEntry } from '../../src/mesh/mesh-ledger.js';
import { readLocalRecords, readLocalRecordSlice, getLocalRecordSummary, readTurnTerminalViews, readRefineJobRecords, pruneLocalRecords } from '../../src/mesh/mesh-local-records.js';
import { meshRecord } from '../../src/mesh/mesh-record.js';
import { seedMeshAttempt } from '../helpers/turn-attempt-seed.js';
import { getLedgerDir } from '../../src/mesh/mesh-ledger-paths.js';
import { seedLocalRecord } from '../helpers/local-records.js';
import type { MeshLedgerEntry } from '../../src/mesh/mesh-ledger.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

describe('mesh-local-records (C-W9a: meshRecord local leg + readers)', () => {
    const testMeshId = `test-mesh-${randomUUID().slice(0, 8)}`;

    beforeEach(() => {
        if (!existsSync(testConfigDir)) {
            mkdirSync(testConfigDir, { recursive: true });
        }
    });

    afterEach(() => {
        // Reset SQLite store so tests don't bleed into each other via the G2 ledger table.
        MeshRuntimeStore.resetForTests();
        try {
            rmSync(testTmpDir, { recursive: true, force: true });
        } catch { /* cleanup best-effort */ }
    });

    describe('seedLocalRecord', () => {
        it('writes one local record and returns it in the reader shape', () => {
            const entry = seedLocalRecord(testMeshId, {
                kind: 'task_dispatched',
                nodeId: 'node_1',
                sessionId: 'session_1',
                payload: { message: 'test task' },
            });

            expect(entry.id).toBeTruthy();
            expect(entry.meshId).toBe(testMeshId);
            expect(entry.kind).toBe('task_dispatched');
            expect(entry.nodeId).toBe('node_1');
            expect(entry.sessionId).toBe('session_1');
            expect(entry.timestamp).toBeTruthy();
            expect(new Date(entry.timestamp).getTime()).toBeGreaterThan(0);
        });

        it('keeps append order across kinds', () => {
            seedLocalRecord(testMeshId, { kind: 'task_dispatched', payload: { message: 'task 1' } });
            seedLocalRecord(testMeshId, { kind: 'task_completed', payload: { result: 'success' } });
            seedLocalRecord(testMeshId, { kind: 'task_failed', payload: { error: 'timeout' } });

            const entries = readLocalRecords(testMeshId);
            expect(entries).toHaveLength(3);
            expect(entries[0].kind).toBe('task_dispatched');
            expect(entries[1].kind).toBe('task_completed');
            expect(entries[2].kind).toBe('task_failed');
        });

        it('generates unique IDs for each entry', () => {
            const e1 = seedLocalRecord(testMeshId, { kind: 'task_dispatched', payload: {} });
            const e2 = seedLocalRecord(testMeshId, { kind: 'task_dispatched', payload: {} });
            expect(e1.id).not.toBe(e2.id);
        });

        it('preserves optional fields when provided', () => {
            const entry = seedLocalRecord(testMeshId, {
                kind: 'session_launched',
                nodeId: 'node_a',
                sessionId: 'sess_123',
                providerType: 'hermes-cli',
                payload: { providerSessionId: 'prov_456' },
            });

            expect(entry.providerType).toBe('hermes-cli');

            const entries = readLocalRecords(testMeshId);
            expect(entries[0].providerType).toBe('hermes-cli');
            expect(entries[0].payload.providerSessionId).toBe('prov_456');
        });
    });

    describe('readLocalRecords', () => {
        it('returns empty array for non-existent mesh', () => {
            const entries = readLocalRecords('non-existent-mesh');
            expect(entries).toEqual([]);
        });

        it('applies tail filter', () => {
            for (let i = 0; i < 10; i++) {
                seedLocalRecord(testMeshId, { kind: 'task_dispatched', payload: { index: i } });
            }

            const entries = readLocalRecords(testMeshId, { tail: 3 });
            expect(entries).toHaveLength(3);
            expect(entries[0].payload.index).toBe(7);
            expect(entries[2].payload.index).toBe(9);
        });

        it('applies kind filter', () => {
            seedLocalRecord(testMeshId, { kind: 'task_dispatched', payload: {} });
            seedLocalRecord(testMeshId, { kind: 'task_completed', payload: {} });
            seedLocalRecord(testMeshId, { kind: 'task_failed', payload: {} });
            seedLocalRecord(testMeshId, { kind: 'task_dispatched', payload: {} });

            const dispatched = readLocalRecords(testMeshId, { kind: ['task_dispatched'] });
            expect(dispatched).toHaveLength(2);
            expect(dispatched.every(e => e.kind === 'task_dispatched')).toBe(true);

            const failures = readLocalRecords(testMeshId, { kind: ['task_failed'] });
            expect(failures).toHaveLength(1);
        });

        it('applies node filter by daemon-id equivalence', () => {
            seedLocalRecord(testMeshId, { kind: 'task_dispatched', nodeId: 'mach_alpha', payload: { i: 0 } });
            seedLocalRecord(testMeshId, { kind: 'task_dispatched', nodeId: 'mach_beta', payload: { i: 1 } });
            seedLocalRecord(testMeshId, { kind: 'task_completed', nodeId: 'mach_alpha', payload: { i: 2 } });
            // Entry with no nodeId must never match a node filter.
            seedLocalRecord(testMeshId, { kind: 'coordinator_started', payload: { i: 3 } });

            const alpha = readLocalRecords(testMeshId, { node: 'mach_alpha' });
            expect(alpha).toHaveLength(2);
            expect(alpha.every(e => e.nodeId === 'mach_alpha')).toBe(true);

            // Identity-form-agnostic: the daemon_mach_ prefix form resolves to the same node.
            const alphaPrefixed = readLocalRecords(testMeshId, { node: 'daemon_mach_alpha' });
            expect(alphaPrefixed).toHaveLength(2);

            const beta = readLocalRecords(testMeshId, { node: 'mach_beta' });
            expect(beta).toHaveLength(1);
            expect(beta[0].payload.i).toBe(1);
        });

        it('composes node + kind filters (AND)', () => {
            seedLocalRecord(testMeshId, { kind: 'task_dispatched', nodeId: 'mach_alpha', payload: {} });
            seedLocalRecord(testMeshId, { kind: 'task_failed', nodeId: 'mach_alpha', payload: {} });
            seedLocalRecord(testMeshId, { kind: 'task_failed', nodeId: 'mach_beta', payload: {} });

            const alphaFailures = readLocalRecords(testMeshId, { node: 'mach_alpha', kind: ['task_failed'] });
            expect(alphaFailures).toHaveLength(1);
            expect(alphaFailures[0].nodeId).toBe('mach_alpha');
            expect(alphaFailures[0].kind).toBe('task_failed');
        });

        it('applies since filter', async () => {
            seedLocalRecord(testMeshId, { kind: 'task_dispatched', payload: {} });

            // Wait a bit to ensure different timestamps
            await new Promise(resolve => setTimeout(resolve, 10));
            const sinceDate = new Date().toISOString();

            seedLocalRecord(testMeshId, { kind: 'task_completed', payload: {} });

            const entries = readLocalRecords(testMeshId, { since: sinceDate });
            expect(entries).toHaveLength(1);
            expect(entries[0].kind).toBe('task_completed');
        });

        it('combines tail and kind filters', () => {
            for (let i = 0; i < 5; i++) {
                seedLocalRecord(testMeshId, { kind: 'task_dispatched', payload: { index: i } });
                seedLocalRecord(testMeshId, { kind: 'task_completed', payload: { index: i } });
            }

            const entries = readLocalRecords(testMeshId, { kind: ['task_dispatched'], tail: 2 });
            expect(entries).toHaveLength(2);
            expect(entries[0].payload.index).toBe(3);
            expect(entries[1].payload.index).toBe(4);
        });
    });

    describe('readLocalRecordSlice', () => {
        it('returns bounded cursor-addressable slices', () => {
            const entries: MeshLedgerEntry[] = [];
            for (let i = 0; i < 5; i++) {
                entries.push(seedLocalRecord(testMeshId, { kind: 'task_dispatched', payload: { index: i } }));
            }

            const first = readLocalRecordSlice(testMeshId, { limit: 2 });
            expect(first.protocol).toBe('adhdev.mesh.ledger.slice.v1');
            expect(first.entries).toHaveLength(2);
            expect(first.entries[0].payload.index).toBe(0);
            expect(first.cursor.afterId).toBeNull();
            expect(first.cursor.nextAfterId).toBe(entries[1].id);
            expect(first.cursor.hasMore).toBe(true);
            expect(first.sourceOfTruth).toMatchObject({ kind: 'local_sqlite', table: 'mesh_local_records' });
            expect(first.sourceOfTruth.bounded).toBe(true);

            const second = readLocalRecordSlice(testMeshId, { afterId: first.cursor.nextAfterId ?? undefined, limit: 2 });
            expect(second.entries).toHaveLength(2);
            expect(second.entries[0].payload.index).toBe(2);
            expect(second.cursor.afterId).toBe(entries[1].id);
            expect(second.cursor.nextAfterId).toBe(entries[3].id);
            expect(second.cursor.hasMore).toBe(true);
        });

        it('clamps slice limit to the protocol maximum', () => {
            for (let i = 0; i < MAX_LEDGER_SLICE_LIMIT + 5; i++) {
                seedLocalRecord(testMeshId, { kind: 'task_dispatched', payload: { index: i } });
            }

            const slice = readLocalRecordSlice(testMeshId, { limit: MAX_LEDGER_SLICE_LIMIT + 100 });
            expect(slice.entries).toHaveLength(MAX_LEDGER_SLICE_LIMIT);
            expect(slice.cursor.limit).toBe(MAX_LEDGER_SLICE_LIMIT);
            expect(slice.cursor.hasMore).toBe(true);
        });
    });

    describe('getLocalRecordSummary', () => {
        it('returns zero summary for empty mesh', () => {
            const summary = getLocalRecordSummary('empty-mesh');
            expect(summary.totalEntries).toBe(0);
            expect(summary.taskDispatched).toBe(0);
            expect(summary.taskCompleted).toBe(0);
            expect(summary.taskFailed).toBe(0);
            expect(summary.lastActivityAt).toBeNull();
        });

        it('correctly counts by kind', () => {
            seedLocalRecord(testMeshId, { kind: 'task_dispatched', payload: {} });
            seedLocalRecord(testMeshId, { kind: 'task_dispatched', payload: {} });
            seedLocalRecord(testMeshId, { kind: 'task_completed', payload: {} });
            seedLocalRecord(testMeshId, { kind: 'task_failed', payload: {} });
            seedLocalRecord(testMeshId, { kind: 'task_stalled', payload: {} });
            seedLocalRecord(testMeshId, { kind: 'session_launched', payload: {} });
            seedLocalRecord(testMeshId, { kind: 'checkpoint_created', payload: {} });

            const summary = getLocalRecordSummary(testMeshId);
            expect(summary.totalEntries).toBe(7);
            expect(summary.taskDispatched).toBe(2);
            expect(summary.taskCompleted).toBe(1);
            expect(summary.taskFailed).toBe(1);
            expect(summary.taskStalled).toBe(1);
            expect(summary.sessionLaunched).toBe(1);
            expect(summary.checkpointCreated).toBe(1);
            expect(summary.lastActivityAt).toBeTruthy();
        });

        it('counts recent failures within 30 minute window', () => {
            // Recent failure — should be counted
            seedLocalRecord(testMeshId, { kind: 'task_failed', payload: {} });

            const summary = getLocalRecordSummary(testMeshId);
            expect(summary.recentFailures).toBe(1);
            expect(summary.taskFailed).toBe(1);
        });
    });

    describe('getLedgerDir', () => {
        it('creates the ledger directory', () => {
            const dir = getLedgerDir();
            expect(existsSync(dir)).toBe(true);
            expect(dir).toContain('mesh-ledger');
        });
    });

    describe('readLocalRecordSlice summary matches getLocalRecordSummary for same mesh', () => {
        it('readLocalRecordSlice summary matches getLocalRecordSummary for same mesh', () => {
            const meshId = `slice-summary-${randomUUID().slice(0, 8)}`;
            seedLocalRecord(meshId, { kind: 'task_dispatched', payload: {} });
            seedLocalRecord(meshId, { kind: 'task_dispatched', payload: {} });
            seedLocalRecord(meshId, { kind: 'task_completed', payload: {} });
            seedLocalRecord(meshId, { kind: 'task_completed', payload: {} });
            seedLocalRecord(meshId, { kind: 'task_failed', payload: {} });

            const slice = readLocalRecordSlice(meshId);
            const summary = getLocalRecordSummary(meshId);

            expect(slice.summary.totalEntries).toBe(summary.totalEntries);
            expect(slice.summary.taskDispatched).toBe(summary.taskDispatched);
            expect(slice.summary.taskCompleted).toBe(summary.taskCompleted);
            expect(slice.summary.taskFailed).toBe(summary.taskFailed);
            expect(slice.summary.meshId).toBe(meshId);
        });
    });
    describe('meshRecord — the one write API (topic projection + local leg)', () => {
        it('writes a local row only with { local }, and keeps a different local payload when given one', () => {
            meshRecord(testMeshId, 'direct_fast_forward', { payload: { outcome: 'noop' } });
            expect(readLocalRecords(testMeshId)).toEqual([]);

            const res = meshRecord(testMeshId, 'magi_synthesis', { payload: { consensusGroupId: 'g1' } },
                { local: { payload: { consensusGroupId: 'g1', synthesis: { verdict: 'agree', notes: ['free text is fine locally'] } } } });
            expect(res.storedLocally).toBe(true);
            const [row] = readLocalRecords(testMeshId);
            expect(row.id).toBe(res.eventId);
            expect(row.timestamp).toBe(res.timestamp);
            expect((row.payload as any).synthesis.notes[0]).toBe('free text is fine locally');
        });

        it('derives taskId from payload.taskId for lifecycle kinds only', () => {
            meshRecord(testMeshId, 'dispatch_failed', { payload: { taskId: 't-life' } }, { local: true });
            meshRecord(testMeshId, 'magi_dispatched', { payload: { taskId: 't-not-lifecycle' } }, { local: true });
            const rows = readLocalRecords(testMeshId);
            expect(rows.find((r) => r.kind === 'dispatch_failed')?.taskId).toBe('t-life');
            expect(rows.find((r) => r.kind === 'magi_dispatched')?.taskId).toBeUndefined();
            expect(MeshRuntimeStore.getInstance().localRecordStore().query(testMeshId, { taskId: 't-life' })).toHaveLength(1);
        });

        it('refuses a blank kind and never throws', () => {
            const res = meshRecord(testMeshId, '  ', { payload: {} }, { local: true });
            expect(res.storedLocally).toBe(false);
            expect(readLocalRecords(testMeshId)).toEqual([]);
        });
    });

    describe('turn outcomes answer task_completed / task_failed (turn_attempts)', () => {
        it('merges committed attempts as terminal views; weak → evidenceLevel weak; cancel is not a failure', () => {
            const now = Date.now();
            seedMeshAttempt({ meshId: testMeshId, taskId: 't-ok', sessionId: 's1', stage: 'completed', nowMs: now - 3000 });
            seedMeshAttempt({ meshId: testMeshId, taskId: 't-bad', sessionId: 's2', stage: 'failed', nowMs: now - 2000, terminalReason: 'session_error' });
            seedMeshAttempt({ meshId: testMeshId, taskId: 't-cxl', sessionId: 's3', stage: 'cancelled', nowMs: now - 1000 });
            // A refine-style local terminal for another task is kept as-is.
            seedLocalRecord(testMeshId, { kind: 'task_failed', payload: { taskId: 't-local', error: 'boom' } });

            const failed = readLocalRecords(testMeshId, { kind: ['task_failed'] });
            expect(failed.map((e) => e.taskId)).toEqual(['t-bad', 't-cxl', 't-local']);
            expect(failed[0].payload).toMatchObject({ source: 'turn_ledger', outcome: 'failed', reason: 'session_error', error: 'session_error' });
            expect(isIntentionalCleanupStopEntry(failed[1])).toBe(true);

            const completed = readLocalRecords(testMeshId, { kind: ['task_completed'] });
            expect(completed.map((e) => e.taskId)).toEqual(['t-ok']);

            const summary = getLocalRecordSummary(testMeshId);
            expect(summary.taskCompleted).toBe(1);
            expect(summary.taskFailed).toBe(2); // t-bad + t-local; the cancel is excluded
            expect(summary.recentFailures).toBe(2);

            // turnTerminals:false reads local records only.
            expect(readLocalRecords(testMeshId, { kind: ['task_failed'], turnTerminals: false }).map((e) => e.taskId)).toEqual(['t-local']);
        });

        it('a local terminal record for the same task and kind wins over the turn view (no duplicate)', () => {
            seedMeshAttempt({ meshId: testMeshId, taskId: 't-dup', sessionId: 's9', stage: 'failed' });
            seedLocalRecord(testMeshId, { kind: 'task_failed', payload: { taskId: 't-dup', undeliverable: true } });
            const failed = readLocalRecords(testMeshId, { kind: ['task_failed'] });
            expect(failed).toHaveLength(1);
            expect((failed[0].payload as any).undeliverable).toBe(true);
        });

        it('a kind-filtered tail is filled from failures, not crowded out by completions', () => {
            const now = Date.now();
            seedMeshAttempt({ meshId: testMeshId, taskId: 't-f', sessionId: 'sf', stage: 'failed', nowMs: now - 10_000 });
            for (let i = 0; i < 6; i++) seedMeshAttempt({ meshId: testMeshId, taskId: `t-c${i}`, sessionId: `sc${i}`, stage: 'completed', nowMs: now - 1000 + i });
            expect(readLocalRecords(testMeshId, { kind: ['task_failed'], tail: 1 }).map((e) => e.taskId)).toEqual(['t-f']);
            expect(readTurnTerminalViews(testMeshId, { kinds: ['task_failed'], tail: 1 }).map((e) => e.taskId)).toEqual(['t-f']);
        });
    });

    describe('projection heads + retention', () => {
        it('heads carry only the projected payload paths (nested paths rebuilt)', () => {
            seedLocalRecord(testMeshId, { kind: 'task_dispatched', payload: { taskId: 't1', source: 'refine_mesh_node_async_job', refineJob: { jobId: 'j1' }, result: { branch: 'b', big: 'x'.repeat(1000) } } });
            const [head] = readRefineJobRecords(testMeshId);
            expect(head.payload).toEqual({ taskId: 't1', source: 'refine_mesh_node_async_job', refineJob: { jobId: 'j1' }, result: { branch: 'b' } });
        });

        it('pruneLocalRecords deletes rows past the window across meshes and keeps the rest', () => {
            const now = Date.now();
            meshRecord(testMeshId, 'task_dispatched', { at: now - 31 * 86_400_000, payload: {} }, { local: true });
            meshRecord('other-mesh', 'task_dispatched', { at: now - 40 * 86_400_000, payload: {} }, { local: true });
            meshRecord(testMeshId, 'task_dispatched', { at: now - 1000, payload: { keep: true } }, { local: true });
            expect(pruneLocalRecords(30 * 86_400_000, now)).toBe(2);
            expect(readLocalRecords(testMeshId).map((e) => (e.payload as any).keep)).toEqual([true]);
        });
    });
});
