/**
 * MEM-3 bound on the interaction-context map (moved from the cloud daemon):
 * one row per target session, bounded by a TTL plus a cardinality backstop,
 * and the row just written is never evicted by its own sweep.
 */
import { describe, expect, it } from 'vitest';
import {
    INTERACTION_CONTEXT_MAX_ENTRIES,
    INTERACTION_CONTEXT_TTL_MS,
    InteractionContextMap,
} from '../../src/commands/interaction-context.js';

describe('InteractionContextMap', () => {
    it('uses the cloud MEM-3 bounds by default (1h TTL, 2000 rows)', () => {
        expect(INTERACTION_CONTEXT_TTL_MS).toBe(60 * 60 * 1000);
        expect(INTERACTION_CONTEXT_MAX_ENTRIES).toBe(2000);
    });

    it('records the interaction id per target session and returns it', () => {
        const map = new InteractionContextMap();
        expect(map.record({ _interactionId: 'int-1', targetSessionId: 'sess-1' })).toBe('int-1');
        expect(map.get('sess-1')).toBe('int-1');
        expect(map.record({ _interactionId: 'int-2', targetSessionId: 'sess-1' })).toBe('int-2');
        expect(map.get('sess-1')).toBe('int-2');
    });

    it('does not record without a target session', () => {
        const map = new InteractionContextMap();
        expect(map.record({ _interactionId: 'int-1' })).toBe('int-1');
        expect(map.size).toBe(0);
        expect(map.get(undefined)).toBeUndefined();
    });

    it('bounds cardinality and never evicts the newest row', () => {
        let now = 1_000_000;
        const max = 50;
        const map = new InteractionContextMap({ ttlMs: 60 * 60 * 1000, maxEntries: max }, () => now);
        for (let i = 0; i < max + 20; i++) {
            now += 1;
            map.record({ _interactionId: `int_${i}`, targetSessionId: `sess_${i}` });
        }
        expect(map.size).toBe(max);
        expect(map.get(`sess_${max + 19}`)).toBe(`int_${max + 19}`);
        expect(map.get('sess_0')).toBeUndefined();
    });

    it('expires rows past the TTL on the next write, keeping rows inside it', () => {
        let now = 1_000_000;
        const ttlMs = 10_000;
        const map = new InteractionContextMap({ ttlMs, maxEntries: 100 }, () => now);
        map.record({ _interactionId: 'int-old', targetSessionId: 'sess-old' });
        now += 5_000;
        map.record({ _interactionId: 'int-live', targetSessionId: 'sess-live' });
        now += ttlMs - 1_000;
        map.record({ _interactionId: 'int-new', targetSessionId: 'sess-new' });

        expect(map.get('sess-old')).toBeUndefined();
        expect(map.get('sess-live')).toBe('int-live');
        expect(map.get('sess-new')).toBe('int-new');
    });
});
