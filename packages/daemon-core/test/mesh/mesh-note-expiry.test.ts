/**
 * `resolveNoteExpiry` — the single source for an operating note's lifetime.
 *
 * Why this exists: the dashboard needs the resolved deadline to display, while
 * the prompt injector needs only the boolean. Those were briefly two separate
 * implementations (one here, one in the list_mesh_notes handler) that agreed by
 * luck; these cases pin the policy so a second copy cannot drift back in.
 *
 * Rules, in precedence order:
 *  - pinned notes never expire and have no deadline
 *  - an explicit, parseable expiresAt wins over the category TTL
 *  - an unparseable expiresAt falls through to the TTL rather than dropping
 *  - a category with no TTL is durable
 *  - a note that cannot be aged is kept, never silently dropped
 */
import { describe, expect, it } from 'vitest';
import { isNoteExpired, resolveNoteExpiry, OPERATING_NOTE_CATEGORY_TTL_DAYS } from '../../src/mesh/mesh-ledger';

const NOW = Date.parse('2026-09-02T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const daysAhead = (d: number) => new Date(NOW + d * 86_400_000).toISOString();

describe('resolveNoteExpiry', () => {
    it('exempts pinned notes entirely, even past an explicit expiry', () => {
        const r = resolveNoteExpiry({ pinned: true, category: 'recovery_lesson', createdAt: daysAgo(400), expiresAt: daysAgo(1) }, NOW);
        expect(r).toEqual({ expired: false });
        expect(r.effectiveExpiresAt).toBeUndefined();
    });

    it('lets an explicit expiresAt win over the category TTL', () => {
        // recovery_lesson TTL is 14d and the note is 1d old, so the TTL alone
        // would keep it — the explicit past deadline must still expire it.
        const r = resolveNoteExpiry({ category: 'recovery_lesson', createdAt: daysAgo(1), expiresAt: daysAgo(1) }, NOW);
        expect(r.expired).toBe(true);
        expect(r.effectiveExpiresAt).toBe(new Date(Date.parse(daysAgo(1))).toISOString());
    });

    it('falls through to the category TTL when expiresAt is unparseable', () => {
        const r = resolveNoteExpiry({ category: 'pattern_to_avoid', createdAt: daysAgo(40), expiresAt: 'not-a-date' }, NOW);
        expect(r.expired).toBe(true); // pattern_to_avoid TTL is 30d
    });

    it('applies the category TTL and reports the resulting deadline', () => {
        const ttl = OPERATING_NOTE_CATEGORY_TTL_DAYS.recovery_lesson;
        const created = daysAgo(3);
        const r = resolveNoteExpiry({ category: 'recovery_lesson', createdAt: created }, NOW);
        expect(r.expired).toBe(false);
        expect(r.effectiveExpiresAt).toBe(new Date(Date.parse(created) + ttl * 86_400_000).toISOString());
    });

    it('treats a category with no TTL as durable — no deadline, never expired', () => {
        expect(resolveNoteExpiry({ category: 'provider_quirk', createdAt: daysAgo(400) }, NOW)).toEqual({ expired: false });
        expect(resolveNoteExpiry({ createdAt: daysAgo(400) }, NOW)).toEqual({ expired: false });
        expect(resolveNoteExpiry({ category: 'not_a_known_category', createdAt: daysAgo(400) }, NOW)).toEqual({ expired: false });
    });

    it('keeps a note it cannot age rather than dropping it', () => {
        expect(resolveNoteExpiry({ category: 'recovery_lesson', createdAt: 'garbage' }, NOW)).toEqual({ expired: false });
    });

    it('ages from the ledger timestamp when createdAt is absent', () => {
        const r = resolveNoteExpiry({ category: 'pattern_to_avoid', timestamp: daysAgo(40) }, NOW);
        expect(r.expired).toBe(true);
    });

    it('a future explicit expiry is not yet expired but still reports its deadline', () => {
        const r = resolveNoteExpiry({ category: 'provider_quirk', createdAt: daysAgo(1), expiresAt: daysAhead(2) }, NOW);
        expect(r.expired).toBe(false);
        expect(r.effectiveExpiresAt).toBe(new Date(Date.parse(daysAhead(2))).toISOString());
    });

    it('isNoteExpired stays consistent with the resolver it wraps', () => {
        const cases = [
            { pinned: true, category: 'recovery_lesson', createdAt: daysAgo(400) },
            { category: 'recovery_lesson', createdAt: daysAgo(3) },
            { category: 'pattern_to_avoid', createdAt: daysAgo(40) },
            { category: 'provider_quirk', createdAt: daysAgo(400) },
            { category: 'provider_quirk', createdAt: daysAgo(1), expiresAt: daysAgo(1) },
        ];
        for (const note of cases) {
            expect(isNoteExpired(note, NOW)).toBe(resolveNoteExpiry(note, NOW).expired);
        }
    });
});
