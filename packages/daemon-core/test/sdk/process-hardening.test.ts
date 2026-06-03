/**
 * Boot-time process hardening — covers prototype freeze + the
 * provider process shim wired in by daemon-lifecycle.
 *
 * The actual freeze is irreversible at the process level, so these tests
 * have to be careful: once one test in the suite calls
 * `applyProcessHardening()`, every subsequent test (and every other test
 * file in the run) sees frozen prototypes. We accept that — the test order
 * still verifies the post-condition.
 */

import { describe, expect, it, afterAll } from 'vitest';
import {
    applyProcessHardening,
    _resetProcessHardeningForTest,
    _isProcessHardened,
} from '../../src/boot/process-hardening.js';

describe('process-hardening — applyProcessHardening()', () => {
    it('freezes Object.prototype after running', () => {
        applyProcessHardening();
        expect(Object.isFrozen(Object.prototype)).toBe(true);
    });

    it('freezes the other key built-in prototypes', () => {
        applyProcessHardening();
        expect(Object.isFrozen(Array.prototype)).toBe(true);
        expect(Object.isFrozen(Function.prototype)).toBe(true);
        expect(Object.isFrozen(String.prototype)).toBe(true);
        expect(Object.isFrozen(Number.prototype)).toBe(true);
        expect(Object.isFrozen(Boolean.prototype)).toBe(true);
        expect(Object.isFrozen(Promise.prototype)).toBe(true);
    });

    it('blocks Object.prototype pollution in strict mode', () => {
        applyProcessHardening();
        // This file is ESM → strict mode by default. Writing to a frozen
        // prototype throws TypeError instead of silently failing.
        expect(() => {
            (Object.prototype as any).polluted = 1;
        }).toThrow(TypeError);
        // And no leak: nothing actually got attached.
        expect(({} as any).polluted).toBeUndefined();
    });

    it('blocks Array.prototype pollution in strict mode', () => {
        applyProcessHardening();
        expect(() => {
            (Array.prototype as any).pwned = function pwned() { return 'x'; };
        }).toThrow(TypeError);
        expect(([] as any).pwned).toBeUndefined();
    });

    it('is idempotent — running it twice does not throw and returns [] the second time', () => {
        applyProcessHardening();
        // First reset the internal flag so we can simulate "another caller
        // tries to harden after we already did". The prototypes stay frozen.
        _resetProcessHardeningForTest();
        const newlyFrozenSecond = applyProcessHardening();
        expect(newlyFrozenSecond).toEqual([]); // nothing new to freeze
        expect(_isProcessHardened()).toBe(true);
        // Calling again is still safe.
        expect(() => applyProcessHardening()).not.toThrow();
    });

    afterAll(() => {
        // Leave the hardened flag set — the prototypes are frozen for the
        // rest of the process anyway, so resetting would only mislead other
        // tests into thinking they're operating on a fresh process.
    });
});
