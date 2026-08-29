import { afterEach, describe, expect, it } from 'vitest';
import {
    TRANSCRIPT_MODE_ENV,
    __resetTranscriptModeWarningsForTests,
    resolveTranscriptMode,
} from '../../src/seqscribe/transcript-mode.js';

/**
 * §8 unit 2 — mode gate (design §5.1).
 *
 * ★ Deliberately asserts a DIFFERENT default than `resolveMeshDualWriteMode`:
 * transcript's absent/unrecognized value both resolve to `shadow`, never
 * `primary` — there is no consumer roster reading the replica yet (§8 units
 * 5-8), so `primary` would have nothing safe to mean.
 */
describe('resolveTranscriptMode (design §5.1)', () => {
    afterEach(() => {
        __resetTranscriptModeWarningsForTests();
    });

    it('defaults to shadow when unset', () => {
        expect(resolveTranscriptMode({})).toBe('shadow');
    });

    it('accepts off/shadow/primary explicitly', () => {
        expect(resolveTranscriptMode({ [TRANSCRIPT_MODE_ENV]: 'off' })).toBe('off');
        expect(resolveTranscriptMode({ [TRANSCRIPT_MODE_ENV]: 'shadow' })).toBe('shadow');
        expect(resolveTranscriptMode({ [TRANSCRIPT_MODE_ENV]: 'primary' })).toBe('primary');
    });

    it('is case-insensitive and trims whitespace', () => {
        expect(resolveTranscriptMode({ [TRANSCRIPT_MODE_ENV]: '  PRIMARY  ' })).toBe('primary');
    });

    it('unrecognized values fall back to shadow, not primary or off', () => {
        expect(resolveTranscriptMode({ [TRANSCRIPT_MODE_ENV]: 'yolo' })).toBe('shadow');
    });
});
