import { describe, expect, it } from 'vitest';
import { AssistantInputLog } from '../../src/assistant/assistant-input-log.js';

/**
 * Assistant input log (design 2026-10-07-assistant-layer.md §4.10.2 check 5):
 * the per-session delivered-input record store verbs classify write origin
 * from. Fail-closed is the property under test: anything short of "a human
 * input was the last thing delivered" stages.
 */

describe('writeContext — origin', () => {
    it('stages for a caller with no log, no session id, or an unknown session', () => {
        const log = new AssistantInputLog();
        for (const sid of [undefined, null, '', '  ', 'never-seen']) {
            const w = log.writeContext(sid);
            expect(w.origin).toBe('relay');
            expect(w.logged).toBe(false);
            expect(w.turnId).toBe('no-turn');
        }
        expect(log.writeContext(undefined).sessionId).toBe('unbound');
    });

    it('human last → human; relay after the human → relay; human again → human', () => {
        const log = new AssistantInputLog();
        log.append('a', 'human');
        expect(log.writeContext('a').origin).toBe('human');
        log.append('a', 'relay');
        expect(log.writeContext('a').origin).toBe('relay');
        log.append('a', 'human');
        expect(log.writeContext('a').origin).toBe('human');
    });

    it('every non-human source after the human stages', () => {
        for (const src of ['relay', 'progress', 'stall', 'restart_note', 'first_run'] as const) {
            const log = new AssistantInputLog();
            log.append('a', 'human');
            log.append('a', src);
            expect(log.writeContext('a').origin).toBe('relay');
        }
    });

    it('review applies only while the review turn is open', () => {
        const log = new AssistantInputLog();
        log.begin('a');
        log.append('a', 'human');
        log.closeTurn('a');
        log.append('a', 'review');
        expect(log.isReviewTurnOpen('a')).toBe(true);
        expect(log.writeContext('a').origin).toBe('review');
        log.closeTurn('a');
        expect(log.isReviewTurnOpen('a')).toBe(false);
        expect(log.writeContext('a').origin).toBe('relay');
    });

    // Research 2026-10-08 §5.1 — the four orders, through the log (review turns
    // opened by the review input, window since the previous review / session start).
    const replay = (seq: Array<'human' | 'relay' | 'review'>, opts: { begun?: boolean } = {}) => {
        const log = new AssistantInputLog();
        if (opts.begun !== false) log.begin('a');
        seq.forEach((src, i) => {
            log.append('a', src, src === 'review' ? { messageId: `review:${1000 + i}` } : {});
            log.closeTurn('a');
        });
        return log;
    };
    const lastReviewContext = (seq: Array<'human' | 'relay' | 'review'>, opts: { begun?: boolean } = {}) => {
        const log = replay(seq.slice(0, -1), opts);
        log.append('a', 'review', { messageId: 'review:9999' }); // open review turn
        return log.writeContext('a');
    };
    it('[human, relay, review] → review_tainted, with the review turn id', () => {
        expect(lastReviewContext(['human', 'relay', 'review'])).toMatchObject({ origin: 'review_tainted', reviewTurnId: 'review:9999' });
    });
    it('[human, human, review] → review', () => {
        expect(lastReviewContext(['human', 'human', 'review'])).toMatchObject({ origin: 'review', reviewTurnId: 'review:9999' });
    });
    it('[review(prev), human, review] → review', () => {
        expect(lastReviewContext(['review', 'human', 'review']).origin).toBe('review');
    });
    it('[relay, review(prev), human, review] → review', () => {
        expect(lastReviewContext(['relay', 'review', 'human', 'review']).origin).toBe('review');
    });
    it('a log that did not begin with the session (daemon restart re-bind) cannot vouch for the first window', () => {
        expect(lastReviewContext(['human', 'human', 'review'], { begun: false }).origin).toBe('review_tainted');
        expect(lastReviewContext(['human', 'review', 'human', 'review'], { begun: false }).origin).toBe('review');
    });
    it('a non-review write carries no review turn id; a closed review turn degrades to relay', () => {
        const log = new AssistantInputLog();
        log.begin('a');
        log.append('a', 'human');
        expect(log.writeContext('a').reviewTurnId).toBeUndefined();
        log.closeTurn('a');
        log.append('a', 'review');
        expect(log.writeContext('a')).toMatchObject({ origin: 'review', reviewTurnId: 'a:t2' });
        log.closeTurn('a');
        expect(log.writeContext('a')).toMatchObject({ origin: 'relay' });
        expect(log.writeContext('a').reviewTurnId).toBeUndefined();
    });

    it('truncation that drops the last human input stages', () => {
        const log = new AssistantInputLog(3, 8);
        log.append('a', 'human');
        log.append('a', 'relay');
        log.append('a', 'relay');
        expect(log.writeContext('a').origin).toBe('relay');
        log.append('a', 'relay'); // human falls off
        expect(log.sources('a')).toEqual(['relay', 'relay', 'relay']);
        expect(log.writeContext('a').origin).toBe('relay');
        expect(log.humanInputCount('a')).toBe(1);
    });
});

describe('turns', () => {
    it('opens a turn per input when the previous one closed, joins the open turn otherwise (steer)', () => {
        const log = new AssistantInputLog();
        expect(log.append('a', 'human')).toBe('t1');
        expect(log.append('a', 'human')).toBe('t1');
        log.closeTurn('a');
        expect(log.append('a', 'relay')).toBe('t2');
        expect(log.currentTurn('a')).toEqual({ turnId: 't2', openedBy: 'relay', open: true });
        expect(log.writeContext('a').turnId).toBe('t2');
    });

    it('a human steer into the review turn keeps the review window open but stages nothing as review', () => {
        const log = new AssistantInputLog();
        log.append('a', 'review');
        log.append('a', 'human');
        expect(log.isReviewTurnOpen('a')).toBe(true);
        expect(log.writeContext('a').origin).toBe('human');
    });

    it('reset forgets the session', () => {
        const log = new AssistantInputLog();
        log.append('a', 'human');
        log.reset('a');
        expect(log.has('a')).toBe(false);
        expect(log.writeContext('a').origin).toBe('relay');
    });
});

describe('bounds', () => {
    it('drops the least recently appended session past the session cap', () => {
        const log = new AssistantInputLog(64, 2);
        log.append('a', 'human');
        log.append('b', 'human');
        log.append('a', 'human');
        log.append('c', 'human');
        expect(log.has('b')).toBe(false);
        expect(log.has('a')).toBe(true);
        expect(log.has('c')).toBe(true);
    });

    it('rejects an empty session id on append', () => {
        expect(() => new AssistantInputLog().append(' ', 'human')).toThrow();
    });
});
