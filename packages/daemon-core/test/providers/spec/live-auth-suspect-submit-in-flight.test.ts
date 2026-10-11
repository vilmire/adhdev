/**
 * A live auth suspicion is not resolved while a prompt is still being written.
 *
 * Live 2026-10-11 (antigravity): a 4954-char task body sat in the composer for
 * ~45 s at `idle`. Its wording matched an auth pattern, so the suspicion was
 * raised and resolved against the task text roughly every 5 s.
 */
import { describe, it, expect } from 'vitest';
import { createLiveAuthState, resolveLiveAuthSuspect } from '../../../src/providers/spec/live-auth-advisory.js';

const ctx = { cliType: 'antigravity-cli', sessionLabel: 'sess-1', isCoordinator: false } as Parameters<typeof resolveLiveAuthSuspect>[1];
const failure = { failureKind: 'auth', errorReason: 'auth_required' } as NonNullable<ReturnType<typeof createLiveAuthState>['suspect']>['failure'];
const T0 = 1_800_000_000_000;

function suspected() {
    const state = createLiveAuthState();
    state.suspect = { failure, suspectedAtMs: T0 };
    return state;
}

describe('resolveLiveAuthSuspect — submit in flight', () => {
    it('leaves the suspicion pending and reads nothing while a submit is in flight', () => {
        const state = suspected();
        let screenReads = 0;
        const out = resolveLiveAuthSuspect(state, ctx, {
            midTurn: false, tail: '', now: T0 + 30_000, submitInFlight: true,
            readScreen: () => { screenReads += 1; return ''; },
        });
        expect(out).toEqual({});
        expect(state.suspect).not.toBeNull();
        expect(screenReads).toBe(0);
    });

    it('resolves it once the submit has finished', () => {
        const state = suspected();
        const out = resolveLiveAuthSuspect(state, ctx, {
            midTurn: false, tail: '', now: T0 + 30_000, submitInFlight: false,
            readScreen: () => 'an ordinary idle screen',
        });
        expect(out).toEqual({ clearTail: true });
        expect(state.suspect).toBeNull();
    });
});
