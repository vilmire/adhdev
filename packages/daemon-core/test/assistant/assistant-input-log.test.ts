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
        log.append('a', 'human');
        log.closeTurn('a');
        log.append('a', 'review');
        expect(log.isReviewTurnOpen('a')).toBe(true);
        expect(log.writeContext('a').origin).toBe('review');
        log.closeTurn('a');
        expect(log.isReviewTurnOpen('a')).toBe(false);
        expect(log.writeContext('a').origin).toBe('relay');
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
