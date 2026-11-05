import { describe, expect, it } from 'vitest';
import { memDb, ledgerOn, fakePublisher } from './ledger-harness.js';

describe('undelivered notice scan', () => {
    it('reads through the recent notice index and finds only undelivered notices', () => {
        const db = memDb();
        const ledger = ledgerOn(db, { publisher: fakePublisher() });
        const insert = db.prepare(`INSERT INTO turn_events (event_id, attempt_id, generation, kind, dedupe_key, mesh_id, source, session_id, payload_json, verdict, publish_state, src_writer, published_seq, at_ms, recorded_at)
            VALUES (?, 'a1', 0, ?, ?, 'm1', 'scheduler', 's1', '{}', 'applied', 'published', 'w1', ?, 100, ?)`);
        expect(ledger.store.hasUndeliveredNotify('m1', 0)).toBe(false);
        insert.run('n1', 'notify', 'n1', 1, 100);
        expect(ledger.store.hasUndeliveredNotify('m1', 0)).toBe(true);
        expect(ledger.store.hasUndeliveredNotify('m1', 200)).toBe(false);
        expect(ledger.store.hasUndeliveredNotify('other', 0)).toBe(false);
        insert.run('delivered:m1:w1:1', 'delivered', 'd1', 2, 100);
        expect(ledger.store.hasUndeliveredNotify('m1', 0)).toBe(false);
        expect(ledger.store.listUndeliveredNotifies('m1', { sinceMs: 0 })).toEqual([]);
        const plan = (db.prepare(`EXPLAIN QUERY PLAN SELECT n.* FROM turn_events n INDEXED BY ix_turn_events_recent_notify WHERE n.kind = 'notify' AND n.mesh_id = 'm1' AND n.publish_state = 'published' AND n.recorded_at >= 0`).all() as Array<{ detail: string }>).map(r => r.detail).join(' ');
        expect(plan).toContain('ix_turn_events_recent_notify');
    });
});
