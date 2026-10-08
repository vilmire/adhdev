/**
 * SQLite relay store (design 2026-10-07-assistant-layer.md §4.6): same
 * behaviour as the in-memory store behind the same port, rows survive a
 * reopen (the daemon-restart backlog, §4.8), and no text column exists.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ensureAssistantRelaySchema } from '../../src/mesh/mesh-runtime-store-schema.js';
import {
    ASSISTANT_METRIC_COLUMNS,
    AssistantMetricsStore,
    SqliteAssistantRelayStore,
    metricDay,
} from '../../src/assistant/assistant-relay-sqlite-store.js';
import {
    InMemoryAssistantRelayStore,
    RELAY_DELIVERED_RETENTION_MS,
    THREAD_CLOSED_RETENTION_MS,
    type AssistantRelayStore,
} from '../../src/assistant/assistant-relay-store.js';

const DAY = 24 * 60 * 60_000;
const T0 = Date.parse('2026-10-07T12:00:00Z');

function openDb(path = ':memory:') {
    const db = new Database(path);
    ensureAssistantRelaySchema(db);
    return db;
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function exercise(store: AssistantRelayStore) {
    store.openThread('m1', T0);
    store.openThread('m1', T0 + 5);
    const open1 = store.openThreads();
    expect(open1).toEqual([{ meshId: 'm1', openedAt: T0, lastSendAt: T0 + 5, closedAt: null }]);
    expect(store.isThreadOpen('m1')).toBe(true);
    store.closeThread('m1', T0 + 10);
    expect(store.isThreadOpen('m1')).toBe(false);
    store.openThread('m1', T0 + 20); // reopen starts over
    expect(store.openThreads()[0]).toEqual({ meshId: 'm1', openedAt: T0 + 20, lastSendAt: T0 + 20, closedAt: null });

    const row = { attemptId: 'plain:c:2', meshId: 'm1', coordinatorSessionId: 'c', committedAt: T0 + 2, kind: 'relay' as const, outcome: 'completed' };
    expect(store.recordCommitted(row)).toBe(true);
    expect(store.recordCommitted(row)).toBe(false); // dedupe by attemptId
    expect(store.recordCommitted({ ...row, attemptId: 'plain:c:1', committedAt: T0 + 1 })).toBe(true);
    expect(store.listUndelivered().map((r) => r.attemptId)).toEqual(['plain:c:1', 'plain:c:2']);
    store.markDelivered(['plain:c:1'], T0 + 30);
    store.markDelivered(['plain:c:1'], T0 + 99); // first delivery time wins
    expect(store.listUndelivered().map((r) => r.attemptId)).toEqual(['plain:c:2']);

    store.closeThread('m1', T0 + 40);
    store.prune(T0 + 30 + RELAY_DELIVERED_RETENTION_MS + 1);
    // delivered row pruned; undelivered row kept; closed thread kept until 30 d
    expect(store.recordCommitted({ ...row, attemptId: 'plain:c:1' })).toBe(true);
    store.prune(T0 + 40 + THREAD_CLOSED_RETENTION_MS + 1);
    expect(store.openThreads()).toEqual([]);
}

describe('SqliteAssistantRelayStore', () => {
    it('behaves like the in-memory store behind the same port', () => {
        exercise(new InMemoryAssistantRelayStore());
        exercise(new SqliteAssistantRelayStore(openDb()));
    });

    it('keeps threads and undelivered rows across a reopen (restart backlog)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'assistant-relay-db-'));
        dirs.push(dir);
        const file = join(dir, 'mesh-runtime.db');
        const db1 = openDb(file);
        const s1 = new SqliteAssistantRelayStore(db1);
        s1.openThread('m1', T0);
        s1.recordCommitted({ attemptId: 'plain:c:1', meshId: 'm1', coordinatorSessionId: 'c', committedAt: T0, kind: 'relay', outcome: 'failed' });
        db1.close();
        const s2 = new SqliteAssistantRelayStore(openDb(file));
        expect(s2.isThreadOpen('m1')).toBe(true);
        expect(s2.listUndelivered()).toEqual([
            { attemptId: 'plain:c:1', meshId: 'm1', coordinatorSessionId: 'c', committedAt: T0, deliveredAt: null, kind: 'relay', outcome: 'failed' },
        ]);
    });

    it('schema is idempotent and holds no text/body column', () => {
        const db = openDb();
        ensureAssistantRelaySchema(db);
        for (const table of ['assistant_threads', 'assistant_relays', 'assistant_metric_daily', 'assistant_review_credit']) {
            const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
            expect(cols.some((c) => /body|text|message|content|summary/i.test(c))).toBe(false);
        }
    });
});

describe('AssistantMetricsStore', () => {
    it('bumps per (day, mesh) counters, keeps global rows apart, prunes after 90 days', () => {
        const m = new AssistantMetricsStore(openDb());
        m.bump('relays', 'm1', T0);
        m.bump('relays', 'm1', T0 + 1000, 2);
        m.bump('skill_attaches', 'm1', T0);
        m.bump('memory_writes', '', T0);
        m.bump('relays', 'm1', T0 - 100 * DAY);
        const rows = m.rows(metricDay(T0));
        expect(rows).toHaveLength(2);
        const mesh = rows.find((r) => r.meshId === 'm1')!;
        expect(mesh.relays).toBe(3);
        expect(mesh.skill_attaches).toBe(1);
        expect(rows.find((r) => r.meshId === '')!.memory_writes).toBe(1);
        expect(m.prune(T0)).toBe(1);
        expect(m.rows()).toHaveLength(2);
        expect(ASSISTANT_METRIC_COLUMNS).toContain('review_turns_with_writes');
        expect(() => m.bump('nope' as never, 'm1', T0)).toThrow(/unknown metric column/);
    });

    // M7 (research 2026-10-08 Q7): a review turn counts once, when its first
    // write is applied (clean window) or approved by the owner (staged).
    it('creditReviewWrite counts applied / approved writes and each review turn once', () => {
        const m = new AssistantMetricsStore(openDb());
        m.creditReviewWrite('review:1', 'applied', T0);
        m.creditReviewWrite('review:1', 'applied', T0 + 1);
        m.creditReviewWrite('review:2', 'approved', T0 + 2);
        m.creditReviewWrite('review:1', 'approved', T0 + DAY); // later approval of the same review
        m.creditReviewWrite('', 'applied', T0);
        const today = m.rows(metricDay(T0)).find((r) => r.day === metricDay(T0) && r.meshId === '')!;
        expect(today).toMatchObject({ review_writes_applied: 2, review_writes_approved: 1, review_turns_with_writes: 2 });
        const next = m.rows().find((r) => r.day === metricDay(T0 + DAY))!;
        expect(next).toMatchObject({ review_writes_approved: 1, review_turns_with_writes: 0 });
    });

    it('adds the M7 columns to a table created before them', () => {
        const db = new Database(':memory:');
        db.exec(`CREATE TABLE assistant_metric_daily (day TEXT NOT NULL, mesh_id TEXT NOT NULL DEFAULT '', review_turns_with_writes INTEGER NOT NULL DEFAULT 0, assistant_sends INTEGER NOT NULL DEFAULT 0, human_sends INTEGER NOT NULL DEFAULT 0, relays INTEGER NOT NULL DEFAULT 0, project_reads INTEGER NOT NULL DEFAULT 0, memory_writes INTEGER NOT NULL DEFAULT 0, memory_discards INTEGER NOT NULL DEFAULT 0, skill_views INTEGER NOT NULL DEFAULT 0, skill_attaches INTEGER NOT NULL DEFAULT 0, skill_writes INTEGER NOT NULL DEFAULT 0, review_turns INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, mesh_id))`);
        ensureAssistantRelaySchema(db);
        ensureAssistantRelaySchema(db);
        const m = new AssistantMetricsStore(db);
        m.creditReviewWrite('review:1', 'approved', T0);
        expect(m.rows()[0]).toMatchObject({ review_writes_approved: 1, review_turns_with_writes: 1 });
    });
});
