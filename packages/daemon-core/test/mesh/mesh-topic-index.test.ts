import { describe, expect, it } from 'vitest';
import {
    MeshTopicIndex,
    hasDispatchAfterTerminal,
    readFleetTaskActivity,
    readOwnTaskLifecycle,
    MESH_RECORD_APPEND_KIND,
} from '../../src/mesh/mesh-topic-index.js';
import { TurnStore } from '../../src/mesh/turn-ledger/store.js';
import { memDb, T0 } from '../turn-ledger/ledger-harness.js';

// mesh-topic-index — the durable SQL index of `mesh.<id>.events` (C3):
// idempotent on (writer, seq), every filter (writer first) applied in SQL
// before the tail, own lifecycle from the turn tables, fleet activity with
// turn.committed projected onto the terminal kinds.

function record(meshId: string, writer: string, seq: number, ledgerKind: string, at: number, extra: Record<string, unknown> = {}) {
    return {
        meshId, writer, seq, kind: MESH_RECORD_APPEND_KIND,
        payload: {
            id: `led-${writer}-${seq}`, timestamp: new Date(at).toISOString(), ledgerKind, nodeId: extra.nodeId ?? null,
            sessionId: extra.sessionId ?? null, providerType: null, taskId: extra.taskId ?? null,
            payload: { ...(extra.taskId ? { taskId: extra.taskId } : {}), ...(extra.outcome ? { outcome: extra.outcome } : {}) },
            v: 2, k: 'mesh.record', eventId: `led-${writer}-${seq}`, at,
        },
    };
}

describe('MeshTopicIndex', () => {
    it('is idempotent on (writer, seq): a redelivered / replayed entry adds no row', () => {
        const index = new MeshTopicIndex(memDb());
        const entry = record('m1', 'wA', 1, 'task_dispatched', T0, { taskId: 't1' });
        expect(index.ingest(entry)).toBe(true);
        expect(index.ingest(entry)).toBe(false);
        expect(index.counts('m1')).toEqual({ rows: 1, byWriter: { wA: 1 } });
    });

    it('applies the own-writer filter BEFORE the tail (other daemons’ noop traffic cannot crowd own rows out)', () => {
        const index = new MeshTopicIndex(memDb());
        index.ingest(record('m1', 'wA', 1, 'task_dispatched', T0, { taskId: 't1' }));
        // 50 later rows from another writer (the direct_fast_forward{noop} flood).
        for (let i = 1; i <= 50; i++) index.ingest(record('m1', 'wB', i, 'direct_fast_forward', T0 + i));
        const own = index.query('m1', { writer: { scope: 'own', writer: 'wA' }, tail: 10 });
        expect(own.map((r) => r.id)).toEqual(['led-wA-1']);
        const fleet = index.query('m1', { writer: { scope: 'fleet' }, tail: 10 });
        expect(fleet).toHaveLength(10);
        expect(fleet.every((r) => r.writer === 'wB')).toBe(true);
        // kind filter before tail too
        expect(index.query('m1', { writer: { scope: 'fleet' }, kinds: ['task_dispatched'], tail: 1 }).map((r) => r.id)).toEqual(['led-wA-1']);
    });

    it('indexes turn entries under their k and keeps meshes apart', () => {
        const index = new MeshTopicIndex(memDb());
        index.ingest({ meshId: 'm1', writer: 'wA', seq: 1, kind: 'turn.committed', payload: { v: 2, eventId: 'e1', at: T0, k: 'turn.committed', attemptId: 'a1', generation: 0, taskId: 't1', outcome: 'completed', strength: 'genuine', reason: 'turn_end' } });
        index.ingest(record('m2', 'wA', 1, 'task_dispatched', T0));
        const rows = index.query('m1', { writer: { scope: 'fleet' } });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ kind: 'turn.committed', taskId: 't1', payload: { outcome: 'completed' } });
    });

    it('fleet task activity projects turn.committed onto task_completed / task_failed', () => {
        const index = new MeshTopicIndex(memDb());
        index.ingest(record('m1', 'wB', 1, 'task_dispatched', T0, { taskId: 't2', nodeId: 'n2' }));
        index.ingest({ meshId: 'm1', writer: 'wB', seq: 2, kind: 'turn.committed', payload: { v: 2, eventId: 'e2', at: T0 + 5, k: 'turn.committed', attemptId: 'a2', generation: 0, taskId: 't2', outcome: 'failed', strength: 'genuine', reason: 'session_error' } });
        const activity = readFleetTaskActivity(index, 'm1', ['task_dispatched', 'task_completed', 'task_failed'], 50);
        expect(activity.map((r) => `${r.kind}:${r.taskId}`)).toEqual(['task_dispatched:t2', 'task_failed:t2']);
    });

    it('own task lifecycle = own task_dispatched records + committed attempts from the turn tables', () => {
        const db = memDb();
        const index = new MeshTopicIndex(db);
        const store = new TurnStore(db);
        index.ingest(record('m1', 'wA', 1, 'task_dispatched', T0, { taskId: 't1' }));
        index.ingest(record('m1', 'wB', 1, 'task_dispatched', T0, { taskId: 'tX' }));
        db.prepare(`INSERT INTO turn_attempts (attempt_id, scope, mesh_id, task_id, session_id, owner_daemon_id, state, accepted_at, terminal_outcome, terminal_reason, terminal_at, created_at, updated_at)
            VALUES ('a1', 'mesh_queue', 'm1', 't1', 's1', 'dc', 'completed', ?, 'completed', 'turn_end', ?, ?, ?)`).run(T0, T0 + 100, T0, T0 + 100);
        const views = readOwnTaskLifecycle(index, store, 'm1', { ownWriter: 'wA', tail: 100 });
        expect(views.map((v) => `${v.kind}:${v.payload.taskId}`)).toEqual(['task_dispatched:t1', 'task_completed:t1']);
    });

    it('hasDispatchAfterTerminal walks the total order', () => {
        const index = new MeshTopicIndex(memDb());
        index.ingest(record('m1', 'wA', 1, 'session_stopped', T0, { sessionId: 's1' }));
        index.ingest(record('m1', 'wA', 2, 'task_dispatched', T0 + 1, { sessionId: 's1' }));
        expect(hasDispatchAfterTerminal(index, 'm1', 's1', 'led-wA-1', ['session_stopped'])).toBe(true);
        expect(hasDispatchAfterTerminal(index, 'm1', 's1', 'led-wA-2', ['session_stopped'])).toBe(false);
    });
});
