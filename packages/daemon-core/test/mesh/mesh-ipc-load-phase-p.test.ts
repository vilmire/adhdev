import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Phase P (IPC / event-loop load fixes, 2026-09-23 audit): auto-prune idle exit, ledger
// projection / tail / summary reads, column-only queue reads, off-path WAL checkpoints.
const testTmpDir = join(tmpdir(), `adhdev-ipc-load-phase-p-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));

import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { WalCheckpointScheduler } from '../../src/mesh/mesh-runtime-store-wal.js';
import {
    insertDirectDispatch,
    getActiveDirectDispatches,
    updateDirectDispatchStatus,
    listDirectDispatchesForAutoPrune,
    getQueueHeads,
    getQueueEntryById,
    __replaceMeshQueueForTests,
    __resetMeshRuntimeStoreForTests,
    type MeshWorkQueueEntry,
} from '../../src/mesh/mesh-work-queue.js';
import {
    appendLedgerEntry,
    readLedgerEntries,
    readLedgerEntriesByKind,
    readActiveWorkLedgerEntries,
    readRefineJobLedgerEntries,
    getLedgerSummary,
    invalidateAllLedgerCaches,
    __clearMeshLedgerForTests,
    type MeshLedgerKind,
} from '../../src/mesh/mesh-ledger.js';
import { buildMeshActiveWork } from '../../src/mesh/mesh-active-work.js';
import { buildMeshAsyncRefineJobs } from '../../src/mesh/mesh-refine-status.js';
// autoPruneStaleDirectDispatches (the reconcile PHASE 5 auto-prune) was deleted in C4 (C-W4).

const DAY_MS = 24 * 60 * 60_000;

function withClock<T>(atMs: number, fn: () => T): T {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(atMs);
    try { return fn(); } finally { vi.useRealTimers(); }
}

function queueEntry(meshId: string, overrides: Partial<MeshWorkQueueEntry>): MeshWorkQueueEntry {
    const now = new Date().toISOString();
    return {
        id: randomUUID(),
        meshId,
        message: 'task body',
        status: 'pending',
        createdAt: now,
        updatedAt: now,
        ...overrides,
    } as MeshWorkQueueEntry;
}

describe('Phase P — IPC / event-loop load fixes', () => {
    let meshId: string;

    beforeEach(() => {
        meshId = `mesh-phase-p-${randomUUID().slice(0, 8)}`;
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
    });

    afterEach(() => {
        vi.useRealTimers();
        try { __clearMeshLedgerForTests(meshId); } catch { /* store may already be reset */ }
        __resetMeshRuntimeStoreForTests();
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    describe('audit #1 — auto-prune can idle', () => {
        it('keeps rows that had a lifecycle update inside the age gate (fresh acked, old-dispatched-but-recently-acked)', () => {
            const fresh = `task-fresh-${randomUUID().slice(0, 8)}`;
            const reacked = `task-reacked-${randomUUID().slice(0, 8)}`;
            insertDirectDispatch(meshId, { taskId: fresh, sessionId: 'sess-a', message: 'm', via: 'local_direct', dispatchedAt: new Date().toISOString() });
            updateDirectDispatchStatus(meshId, 'sess-a', 'acked', fresh);
            withClock(Date.now() - 3 * DAY_MS, () => {
                insertDirectDispatch(meshId, { taskId: reacked, sessionId: 'sess-b', message: 'm', via: 'local_direct', dispatchedAt: new Date().toISOString() });
            });
            updateDirectDispatchStatus(meshId, 'sess-b', 'acked', reacked); // updated_at = now

            const live = listDirectDispatchesForAutoPrune(meshId, DAY_MS);
            expect(live.map(d => d.taskId).sort()).toEqual([fresh, reacked].sort());
        });

        it('a stale-marked row still accepts a late completion', () => {
            const taskId = `task-late-${randomUUID().slice(0, 8)}`;
            withClock(Date.now() - 2 * DAY_MS, () => {
                insertDirectDispatch(meshId, { taskId, sessionId: 'sess-late', message: 'm', via: 'local_direct', dispatchedAt: new Date().toISOString() });
            });
            listDirectDispatchesForAutoPrune(meshId, DAY_MS);
            updateDirectDispatchStatus(meshId, 'sess-late', 'completed', taskId);
            const row = MeshRuntimeStore.getInstance().db
                .prepare('SELECT status FROM mesh_direct_dispatches WHERE task_id = ?').get(taskId) as { status: string };
            expect(row.status).toBe('completed');
        });
    });

    describe('audit #2 — projection reads feed buildMeshActiveWork / buildMeshAsyncRefineJobs unchanged', () => {
        const ACTIVE_KINDS: MeshLedgerKind[] = [
            'task_dispatched', 'task_completed', 'task_failed', 'task_stalled',
            'task_approval_needed', 'task_approval_resolved', 'task_question_pending', 'session_stopped',
        ];

        function seedActiveWorkLedger(): void {
            const big = 'x'.repeat(20_000); // stands in for the completion bodies the projection skips
            const dispatch = (taskId: string, sessionId: string, extra: Record<string, unknown> = {}) => appendLedgerEntry(meshId, {
                kind: 'task_dispatched', nodeId: 'daemon_mach_a', sessionId,
                payload: { taskId, source: 'direct', via: 'local_direct', message: `do ${taskId}`, taskTitle: `title ${taskId}`, taskMode: 'code_change', providerType: 'claude-cli', ...extra },
            } as any);
            dispatch('t-done', 's1');
            appendLedgerEntry(meshId, { kind: 'task_completed', nodeId: 'daemon_mach_a', sessionId: 's1', payload: { taskId: 't-done', finalSummary: big, evidenceLevel: 'sufficient' } } as any);
            dispatch('t-weak', 's2', { dispatchedToIdleSession: true });
            appendLedgerEntry(meshId, { kind: 'task_completed', nodeId: 'daemon_mach_a', sessionId: 's2', payload: { taskId: 't-weak', finalSummary: big, completionDiagnostic: { finalAssistantPresent: false, blockReason: 'missing_final_assistant' } } } as any);
            dispatch('t-approval', 's3');
            appendLedgerEntry(meshId, { kind: 'task_approval_needed', nodeId: 'daemon_mach_a', sessionId: 's3', payload: { taskId: 't-approval', modal: big } } as any);
            dispatch('t-resolved', 's4');
            appendLedgerEntry(meshId, { kind: 'task_approval_needed', nodeId: 'daemon_mach_a', sessionId: 's4', payload: { taskId: 't-resolved' } } as any);
            appendLedgerEntry(meshId, { kind: 'task_approval_resolved', nodeId: 'daemon_mach_a', sessionId: 's4', payload: { taskId: 't-resolved' } } as any);
            dispatch('t-failed', 's5');
            appendLedgerEntry(meshId, { kind: 'task_failed', nodeId: 'daemon_mach_a', sessionId: 's5', payload: { taskId: 't-failed', error: big, reviewRecommended: true } } as any);
            appendLedgerEntry(meshId, { kind: 'session_stopped', nodeId: 'daemon_mach_a', sessionId: 's6', payload: { reason: 'exit' } } as any);
            dispatch('t-orphan', 's7', { source: undefined, via: 'p2p_direct' });
            appendLedgerEntry(meshId, { kind: 'task_dispatched', nodeId: 'daemon_mach_a', sessionId: 's8', payload: { taskId: 't-queue', source: 'queue', via: 'local_direct', message: 'queued' } } as any);
            appendLedgerEntry(meshId, { kind: 'session_launched', nodeId: 'daemon_mach_a', payload: { unrelated: big } } as any);
        }

        it('active-work projection yields identical buildMeshActiveWork output (with and without live nodes)', () => {
            seedActiveWorkLedger();
            invalidateAllLedgerCaches();
            const full = readLedgerEntriesByKind(meshId, ACTIVE_KINDS);
            invalidateAllLedgerCaches();
            const projected = readActiveWorkLedgerEntries(meshId, ACTIVE_KINDS);

            expect(projected.map(e => e.id)).toEqual(full.map(e => e.id));
            // The projection really drops the bodies.
            expect(JSON.stringify(projected).length).toBeLessThan(JSON.stringify(full).length / 10);

            const now = Date.now() + 60_000;
            const liveNodes = [{ id: 'daemon_mach_a', daemonId: 'daemon_mach_a', sessions: [{ id: 's3', status: 'generating' }, { id: 's7', status: 'idle' }] }];
            for (const nodes of [[], liveNodes]) {
                for (const includeTerminalDirect of [false, true]) {
                    const a = buildMeshActiveWork({ meshId, queue: [], ledgerEntries: full, nodes, now, includeTerminalDirect });
                    const b = buildMeshActiveWork({ meshId, queue: [], ledgerEntries: projected, nodes, now, includeTerminalDirect });
                    expect(b).toEqual(a);
                }
            }
            // Sanity: the fixture exercises the payload-dependent branches.
            const built = buildMeshActiveWork({ meshId, queue: [], ledgerEntries: projected, nodes: [], now, includeTerminalDirect: true });
            const records = [...built.activeWork, ...built.staleDirectWork, ...built.terminalDirectWork];
            expect(records.find(r => r.taskId === 't-approval')?.status).toBe('awaiting_approval');
            expect(records.find(r => r.taskId === 't-resolved')?.status).toBe('idle');
            expect(records.find(r => r.taskId === 't-done')?.taskTitle).toBe('title t-done');
            expect(records.find(r => r.taskId === 't-failed')?.status).toBe('failed');
            expect(records.some(r => r.taskId === 't-orphan')).toBe(true);
            expect(records.some(r => r.taskId === 't-queue')).toBe(false);
        });

        it('refine-job projection yields identical buildMeshAsyncRefineJobs output', () => {
            const refineJob = (jobId: string, status: string) => ({ jobId, status, meshId, nodeId: 'node-w', workspace: '/w', startedAt: new Date().toISOString(), interactionId: `i-${jobId}` });
            appendLedgerEntry(meshId, { kind: 'task_dispatched', nodeId: 'node-w', payload: { source: 'refine_mesh_node_async_job', refineJob: refineJob('job-1', 'accepted') } } as any);
            appendLedgerEntry(meshId, { kind: 'task_completed', nodeId: 'node-w', payload: { source: 'refine_mesh_node_async_job', refineJob: refineJob('job-1', 'completed'), result: { branch: 'feat/x', into: 'main', log: 'y'.repeat(20_000) } } } as any);
            appendLedgerEntry(meshId, { kind: 'task_dispatched', nodeId: 'node-w', payload: { source: 'refine_mesh_node_async_job', refineJob: refineJob('job-2', 'accepted'), retryOfJobId: 'job-1' } } as any);
            appendLedgerEntry(meshId, { kind: 'task_failed', nodeId: 'node-w', payload: { source: 'refine_mesh_node_async_job', refineJob: refineJob('job-2', 'failed'), finalBranchConvergenceState: { branch: 'feat/y', baseBranch: 'main' } } } as any);
            appendLedgerEntry(meshId, { kind: 'task_completed', nodeId: 'node-w', payload: { taskId: 'unrelated', finalSummary: 'z'.repeat(20_000) } } as any);

            invalidateAllLedgerCaches();
            const full = readLedgerEntries(meshId, { kind: ['task_dispatched', 'task_completed', 'task_failed'] });
            invalidateAllLedgerCaches();
            const projected = readRefineJobLedgerEntries(meshId);
            const a = buildMeshAsyncRefineJobs({ meshId, ledgerEntries: full });
            expect(a).toHaveLength(2);
            expect(buildMeshAsyncRefineJobs({ meshId, ledgerEntries: projected })).toEqual(a);
        });

        it('the multi-kind projection query seeks the (mesh_id, kind, timestamp) index', () => {
            const db = MeshRuntimeStore.getInstance().db;
            const plan = db.prepare(
                `EXPLAIN QUERY PLAN SELECT rowid, id FROM mesh_event_ledger WHERE mesh_id = ? AND kind IN (?, ?, ?)`
            ).all(meshId, 'task_dispatched', 'task_completed', 'task_failed') as Array<{ detail: string }>;
            expect(plan.map(r => r.detail).join(' ')).toContain('idx_mesh_event_ledger_mesh_kind');
        });
    });

    describe('audit #3 — unfiltered tail and summary do not load the ledger', () => {
        function seed(n: number): void {
            for (let i = 0; i < n; i++) {
                const kind = (['task_dispatched', 'session_launched', 'task_completed', 'checkpoint_created'] as const)[i % 4];
                appendLedgerEntry(meshId, { kind, nodeId: i % 2 ? 'daemon_mach_a' : 'daemon_mach_b', payload: { seq: i, taskId: `t-${i}` } } as any);
            }
            appendLedgerEntry(meshId, { kind: 'task_failed', payload: { taskId: 't-f1', error: 'boom' } } as any);
            appendLedgerEntry(meshId, { kind: 'task_failed', payload: { taskId: 't-f2', intentional: true, reason: 'operator_cleanup' } } as any);
            appendLedgerEntry(meshId, { kind: 'task_stalled', payload: { taskId: 't-s1' } } as any);
            appendLedgerEntry(meshId, { kind: 'task_stalled', payload: { taskId: 't-s2', intentional: true, source: 'mesh_remove_node' } } as any);
        }

        it('tail reads through SQL match the full-scan slice (bare, kind-filtered, since) and node filters still apply in JS', () => {
            seed(40);
            const cases = [
                { tail: 5 },
                { tail: 3, kind: ['task_dispatched', 'task_failed'] as MeshLedgerKind[] },
                { tail: 1000 },
                { tail: 4, node: 'daemon_mach_a' },
            ];
            for (const opts of cases) {
                invalidateAllLedgerCaches();
                const pushed = readLedgerEntries(meshId, opts);
                readLedgerEntries(meshId); // warm the full cache → in-memory reference path
                const reference = readLedgerEntries(meshId, opts);
                expect(pushed).toEqual(reference);
            }
            invalidateAllLedgerCaches();
            expect(readLedgerEntries(meshId, { tail: 4, node: 'daemon_mach_a' })).toHaveLength(4);
        });

        it('SQL summary equals the in-memory summary (cleanup stops excluded, recent failures windowed)', () => {
            seed(25);
            invalidateAllLedgerCaches();
            const fromSql = getLedgerSummary(meshId);
            readLedgerEntries(meshId);
            const fromMemory = getLedgerSummary(meshId);
            expect(fromSql).toEqual(fromMemory);
            expect(fromSql).toMatchObject({ taskFailed: 1, taskStalled: 1, recentFailures: 1 });
        });

        it('an empty mesh summarizes to zero with no lastActivityAt', () => {
            invalidateAllLedgerCaches();
            expect(getLedgerSummary(meshId)).toMatchObject({ totalEntries: 0, lastActivityAt: null, recentFailures: 0 });
        });
    });

    describe('audit #9 / #10 / row 8 — queue reads without payload parses', () => {
        it('findAssignedBySession parses only the returned row', () => {
            const entries: MeshWorkQueueEntry[] = [];
            for (let i = 0; i < 20; i++) {
                entries.push(queueEntry(meshId, { status: 'assigned', assignedNodeId: 'n', assignedSessionId: `sess-${i}`, dispatchTimestamp: new Date().toISOString(), message: 'm'.repeat(5_000) } as any));
            }
            __replaceMeshQueueForTests(meshId, entries);
            const store = MeshRuntimeStore.getInstance();
            const parse = vi.spyOn(JSON, 'parse');
            const found = store.findAssignedBySession(meshId, ' sess-7 '); // trimmed equivalence
            const parses = parse.mock.calls.length;
            parse.mockRestore();
            expect(found?.id).toBe(entries[7].id);
            expect(parses).toBe(1);
        });

        it('findAssignedBySession keeps the taskId, multi-row and clock-skew rules', () => {
            const older = queueEntry(meshId, { status: 'assigned', assignedSessionId: 'sess-x', dispatchTimestamp: '2026-09-01T00:00:00.000Z' } as any);
            const newer = queueEntry(meshId, { status: 'assigned', assignedSessionId: 'sess-x', dispatchTimestamp: '2026-09-02T00:00:00.000Z' } as any);
            const other = queueEntry(meshId, { status: 'assigned', assignedSessionId: 'sess-y', dispatchTimestamp: '2026-09-03T00:00:00.000Z' } as any);
            __replaceMeshQueueForTests(meshId, [older, newer, other]);
            const store = MeshRuntimeStore.getInstance();
            expect(store.findAssignedBySession(meshId, 'sess-x')?.id).toBe(newer.id);
            expect(store.findAssignedBySession(meshId, 'sess-x', '2026-09-01T12:00:00.000Z')?.id).toBe(older.id);
            expect(store.findAssignedBySession(meshId, 'sess-x', '2026-08-01T00:00:00.000Z')?.id).toBe(newer.id); // skew fallback
            expect(store.findAssignedBySession(meshId, 'sess-x', undefined, older.id)?.id).toBe(older.id);
            expect(store.findAssignedBySession(meshId, 'sess-x', undefined, other.id)?.id).toBe(newer.id); // foreign taskId falls through
            expect(store.findAssignedBySession(meshId, 'sess-none')).toBeNull();
        });

        it('getQueueHeads / getQueueEntryById answer without parsing the queue', () => {
            const rows = [
                queueEntry(meshId, { status: 'pending', createdAt: '2026-09-01T00:00:00.000Z' }),
                queueEntry(meshId, { status: 'assigned', assignedNodeId: 'node-1', assignedSessionId: 'sess-1', createdAt: '2026-09-02T00:00:00.000Z' } as any),
                queueEntry(meshId, { status: 'completed', createdAt: '2026-09-03T00:00:00.000Z' }),
            ];
            __replaceMeshQueueForTests(meshId, rows);
            const parse = vi.spyOn(JSON, 'parse');
            const heads = getQueueHeads(meshId);
            const assigned = getQueueHeads(meshId, { status: ['assigned'] });
            const parses = parse.mock.calls.length;
            parse.mockRestore();
            expect(parses).toBe(0);
            expect(heads.map(h => [h.id, h.status])).toEqual(rows.map(r => [r.id, r.status]));
            expect(assigned).toEqual([{ id: rows[1].id, status: 'assigned', assignedNodeId: 'node-1', assignedSessionId: 'sess-1' }]);
            expect(getQueueEntryById(meshId, rows[2].id)?.status).toBe('completed');
            expect(getQueueEntryById(meshId, 'missing')).toBeNull();
        });

        it('pruneTerminalQueueEntries keeps cross-mesh dependency anchors and uses the status/updated_at index', () => {
            const otherMesh = `${meshId}-other`;
            const old = new Date(Date.now() - 40 * DAY_MS).toISOString();
            const anchor = queueEntry(meshId, { status: 'completed', updatedAt: old });
            const plainOld = queueEntry(meshId, { status: 'failed', updatedAt: old });
            const recent = queueEntry(meshId, { status: 'cancelled' });
            const dependent = queueEntry(otherMesh, { status: 'pending', dependsOn: [anchor.id, 42] } as any);
            __replaceMeshQueueForTests(meshId, [anchor, plainOld, recent]);
            __replaceMeshQueueForTests(otherMesh, [dependent]);
            const store = MeshRuntimeStore.getInstance();
            // A malformed live payload must not abort the sweep.
            store.db.prepare(`INSERT INTO mesh_queue (id, mesh_id, status, created_at, updated_at, payload) VALUES (?, ?, 'assigned', ?, ?, '{not json')`)
                .run(randomUUID(), otherMesh, old, old);

            expect(store.pruneTerminalQueueEntries(30 * DAY_MS)).toBe(1);
            expect(getQueueEntryById(meshId, plainOld.id)).toBeNull();
            expect(getQueueEntryById(meshId, anchor.id)).not.toBeNull();
            expect(getQueueEntryById(meshId, recent.id)).not.toBeNull();

            const plan = store.db.prepare(
                `EXPLAIN QUERY PLAN SELECT id FROM mesh_queue WHERE status IN ('completed', 'cancelled', 'failed') AND updated_at < ?`
            ).all(old) as Array<{ detail: string }>;
            expect(plan.map(r => r.detail).join(' ')).toContain('idx_mesh_queue_status_updated');
            store.db.prepare('DELETE FROM mesh_queue WHERE mesh_id = ?').run(otherMesh);
        });
    });

    describe('audit row 7 — WAL checkpoint runs on a timer, never inside a write', () => {
        it('writes never checkpoint synchronously', () => {
            const store = MeshRuntimeStore.getInstance() as any;
            const pragma = vi.spyOn(store.db, 'pragma');
            for (let i = 0; i < 600; i++) store.recordCompletionFingerprint(meshId, `fp-${i}`, 60_000);
            expect(pragma.mock.calls.filter(c => String(c[0]).includes('wal_checkpoint'))).toEqual([]);
            pragma.mockRestore();
        });

        it('PASSIVE while writes continue, TRUNCATE (non-blocking) once idle and over threshold, retry when busy', () => {
            vi.useFakeTimers();
            const walPath = join(testTmpDir, 'fake.db-wal');
            mkdirSync(testTmpDir, { recursive: true });
            writeFileSync(walPath, Buffer.alloc(10));
            let truncateBusy = 1;
            const pragma = vi.fn((sql: string) => (sql === 'wal_checkpoint(TRUNCATE)' ? [{ busy: truncateBusy, log: 0, checkpointed: 0 }] : undefined));
            const scheduler = new WalCheckpointScheduler({ pragma } as any, walPath, { intervalMs: 1_000, maxBytes: 100, idleMs: 3_000, busyTimeoutMs: 5_000 });
            try {
                scheduler.noteWrite();
                expect(pragma).not.toHaveBeenCalled(); // the write itself does nothing

                vi.advanceTimersByTime(1_000);
                expect(pragma.mock.calls.map(c => c[0])).toEqual(['wal_checkpoint(PASSIVE)']);

                // Over threshold but still busy writing → PASSIVE only.
                writeFileSync(walPath, Buffer.alloc(200));
                pragma.mockClear();
                scheduler.noteWrite();
                vi.advanceTimersByTime(1_000);
                expect(pragma.mock.calls.map(c => c[0])).toEqual(['wal_checkpoint(PASSIVE)']);

                // Idle long enough → TRUNCATE with busy_timeout 0, restored afterwards; a busy
                // result stays pending and is retried on a later tick with no new writes.
                // Ticks at +1 s (not idle yet: nothing) and +2 s (3 s since the last write).
                pragma.mockClear();
                vi.advanceTimersByTime(2_000);
                expect(pragma.mock.calls.map(c => c[0])).toEqual(['busy_timeout = 0', 'wal_checkpoint(TRUNCATE)', 'busy_timeout = 5000']);
                truncateBusy = 0;
                pragma.mockClear();
                vi.advanceTimersByTime(1_000);
                expect(pragma.mock.calls.map(c => c[0])).toEqual(['busy_timeout = 0', 'wal_checkpoint(TRUNCATE)', 'busy_timeout = 5000']);

                // Done: no writes, nothing pending → the timer does nothing.
                pragma.mockClear();
                vi.advanceTimersByTime(5_000);
                expect(pragma).not.toHaveBeenCalled();
            } finally {
                scheduler.stop();
            }
        });
    });
});
