/**
 * (G1) Projection carry counters — the runtime half of the projection guard.
 *
 * `check:message-projection-parity` proves each hop still MENTIONS every
 * carried field. These counters answer the question the source gate cannot:
 * whether anything is actually flowing. The tests below pin the distinctions
 * that make the numbers readable — particularly that a legitimately absent
 * `toolBlockRef` is not a drop, and that one message through the full carry
 * path is counted once rather than twice.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    recordProjectionCarry,
    projectionCarryCounters,
    resetProjectionCarryCounters,
} from '../../src/shared/projection-carry-counters.js';
import {
    carryMessageRefs,
    carryBubbleIdentity,
} from '../../src/providers/cli-provider-history-dedup.js';

const REF = { sourceMtimeMs: 1, recordIndex: 2, blockIndex: 3 };

describe('projection carry counters', () => {
    beforeEach(() => resetProjectionCarryCounters());

    it('counts a fully-identified message as observed with nothing missing', () => {
        recordProjectionCarry(
            { sequence: 7, _turnKey: 't1', bubbleState: 'final', bubbleId: 'b1' },
            true,
        );
        expect(projectionCarryCounters()).toMatchObject({
            observed: 1,
            missingSequence: 0,
            missingTurnKey: 0,
            missingBubbleState: 0,
            missingBubbleIdentity: 0,
            droppedToolBlockRef: 0,
        });
    });

    it('counts each absent identity field independently', () => {
        recordProjectionCarry({ sequence: 3 }, true);
        const c = projectionCarryCounters();
        expect(c.missingTurnKey).toBe(1);
        expect(c.missingBubbleState).toBe(1);
        // `sequence` alone is enough identity, so the composite stays clean.
        expect(c.missingSequence).toBe(0);
        expect(c.missingBubbleIdentity).toBe(0);
    });

    it('flags missingBubbleIdentity only when no per-bubble identity survives', () => {
        // turnKey is TURN-grained, so it is NOT identity — a message carrying
        // only a turnKey is exactly the React-key collision case.
        recordProjectionCarry({ _turnKey: 'turn-1' }, true);
        expect(projectionCarryCounters().missingBubbleIdentity).toBe(1);

        resetProjectionCarryCounters();
        recordProjectionCarry({ _turnKey: 'turn-1', providerUnitKey: 'u1' }, true);
        expect(projectionCarryCounters().missingBubbleIdentity).toBe(0);
    });

    it('treats a non-finite sequence as missing, matching the helper it mirrors', () => {
        // `carryBubbleIdentity` refuses to carry NaN, so counting it as present
        // would report health the projection does not have.
        recordProjectionCarry({ sequence: Number.NaN }, true);
        const c = projectionCarryCounters();
        expect(c.missingSequence).toBe(1);
        expect(c.missingBubbleIdentity).toBe(1);
    });

    it('counts a dropped toolBlockRef only when one was present but not carried', () => {
        recordProjectionCarry({ sequence: 1, toolBlockRef: REF }, false);
        expect(projectionCarryCounters().droppedToolBlockRef).toBe(1);

        resetProjectionCarryCounters();
        // Most messages legitimately have no ref — absence is not a drop.
        recordProjectionCarry({ sequence: 1 }, false);
        expect(projectionCarryCounters().droppedToolBlockRef).toBe(0);
    });

    it('counts a null/undefined message as missing everything rather than throwing', () => {
        recordProjectionCarry(undefined, false);
        expect(projectionCarryCounters()).toMatchObject({
            observed: 1,
            missingSequence: 1,
            missingTurnKey: 1,
            missingBubbleState: 1,
            missingBubbleIdentity: 1,
        });
    });

    it('returns a copy, so a held snapshot does not mutate under the caller', () => {
        const before = projectionCarryCounters();
        recordProjectionCarry({ sequence: 1 }, true);
        expect(before.observed).toBe(0);
        expect(projectionCarryCounters().observed).toBe(1);
    });
});

describe('carry helpers feed the counters exactly once per message', () => {
    beforeEach(() => resetProjectionCarryCounters());

    it('counts one message once through carryMessageRefs, not twice', () => {
        // carryMessageRefs delegates into carryBubbleIdentity; without the
        // suppression flag this would report 2 observed for 1 message and every
        // ratio computed from these counters would be half its true value.
        carryMessageRefs({ sequence: 5, _turnKey: 't', bubbleState: 'final', toolBlockRef: REF });
        expect(projectionCarryCounters().observed).toBe(1);
    });

    it('counts the identity-only hop too', () => {
        carryBubbleIdentity({ sequence: 5 });
        expect(projectionCarryCounters().observed).toBe(1);
    });

    it('does not report a drop when the identity-only hop skips a ref by design', () => {
        // The on-disk writer must NOT persist an mtime-sealed ref. That is a
        // deliberate non-carry, so it must not inflate droppedToolBlockRef.
        carryBubbleIdentity({ sequence: 5, toolBlockRef: REF } as never);
        expect(projectionCarryCounters().droppedToolBlockRef).toBe(0);
    });

    it('still carries the fields it measures — instrumentation is not a rewrite', () => {
        const out = carryMessageRefs({
            sequence: 9, _turnKey: 't9', bubbleState: 'final',
            providerUnitKey: 'u9', bubbleId: 'b9', toolBlockRef: REF,
        });
        expect(out).toMatchObject({
            sequence: 9, _turnKey: 't9', bubbleState: 'final',
            providerUnitKey: 'u9', bubbleId: 'b9', toolBlockRef: REF,
        });
    });

    it('leaves counting enabled after a carry, so later messages are still measured', () => {
        carryMessageRefs({ sequence: 1 });
        carryBubbleIdentity({ sequence: 2 });
        expect(projectionCarryCounters().observed).toBe(2);
    });
});
