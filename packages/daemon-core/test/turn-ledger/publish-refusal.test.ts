import { describe, expect, it } from 'vitest';
import { isMeshTopicEntry } from '@adhdev/mesh-shared';
import { blockerDigest } from '../../src/mesh/mesh-queue-hold-store.js';
import { dispatch, evd, fakePublisher, ledgerOn, memDb, pendingCount } from './ledger-harness.js';

describe('queue-hold event id', () => {
    it('stays within the topic identifier limit however many tasks block', () => {
        const ids = Array.from({ length: 40 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
        const id = `queue-hold:mesh_x:${ids[0]}:2026-11-01T00:00:00.000Z:owned_paths_conflict:${blockerDigest(ids)}`;
        expect(id.length).toBeLessThan(200);
        expect(blockerDigest(ids)).toBe(blockerDigest([...ids].reverse()));
        expect(blockerDigest(ids)).not.toBe(blockerDigest(ids.slice(1)));
    });
});

describe('permanent publish refusal', () => {
    function pendingNotifyRow() {
        const db = memDb();
        const publisher = fakePublisher();
        const ledger = ledgerOn(db, { publisher });
        expect(ledger.observe(dispatch({ scope: 'mesh_direct' })).rule).toBe('R1');
        ledger.observe(evd('delivered', { messageId: 'msg-1', outcome: 'delivered', via: 'local' }, { source: 'input_service' }));
        ledger.observe(evd('turn_started', { retro: false }));
        ledger.observe(evd('turn_end', { strength: 'genuine' }));
        return { db, publisher, ledger };
    }

    it('a content_guard refusal parks the row (publish_state none) instead of retrying every tick', async () => {
        const { db, publisher, ledger } = pendingNotifyRow();
        expect(pendingCount(db)).toBe(2);
        const orig = publisher.publish.bind(publisher);
        publisher.publish = async (meshId, entry, opts) => {
            if (entry.k === 'turn.notify') throw Object.assign(new Error('guard'), { code: 'content_guard' });
            return orig(meshId, entry, opts);
        };
        const first = await ledger.flushPublish();
        expect(first.pending).toBe(0);
        expect(pendingCount(db)).toBe(0);
        expect(await ledger.flushPublish()).toEqual({ published: 0, failed: 0, pending: 0 });
    });

    it('an already-stuck row whose entry eventId exceeds 256 chars is shortened and published', async () => {
        const { db, publisher, ledger } = pendingNotifyRow();
        const long = 'queue-hold:' + 'x'.repeat(400);
        const row = db.prepare(`SELECT event_id, payload_json FROM turn_events WHERE kind='notify'`).get() as { event_id: string; payload_json: string };
        const payload = JSON.parse(row.payload_json);
        payload.entry.eventId = long;
        db.prepare(`UPDATE turn_events SET payload_json=? WHERE event_id=?`).run(JSON.stringify(payload), row.event_id);
        await ledger.flushPublish();
        const notify = publisher.entries.find(e => e.entry.k === 'turn.notify')!;
        expect(notify.entry.eventId.length).toBeLessThanOrEqual(256);
        expect(isMeshTopicEntry(notify.entry)).toBe(true);
        expect(pendingCount(db)).toBe(0);
    });
});
