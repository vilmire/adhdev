import { describe, it, expect } from 'vitest';

import {
  INITIAL_CHAT_SOURCE_STATE,
  RECOVERING_MISS_PROMOTION_THRESHOLD,
  transitionChatSourceState,
  type ChatSourceObservation,
  type ChatSourceState,
} from '../../src/chat/source-machine.js';

function observe(state: ChatSourceState, observation: ChatSourceObservation, at = 1_000) {
  return transitionChatSourceState(state, observation, at, undefined);
}

function nativePresent(args: {
  keys: string[];
  peak?: number;
  coverage?: 'full' | 'tail' | 'current-turn' | 'partial';
  safeMapping?: boolean;
}): ChatSourceObservation {
  return {
    kind: 'native_present',
    contractVersion: '2.0',
    messages: args.keys.map((providerUnitKey, idx) => ({
      providerUnitKey,
      sequence: args.peak !== undefined ? args.peak - (args.keys.length - 1 - idx) : idx + 1,
    })),
    coverage: args.coverage ?? 'tail',
    safeMapping: args.safeMapping ?? true,
  };
}

function nativeUnavailable(
  reason: Extract<ChatSourceObservation, { kind: 'native_unavailable' }>['reason'] = 'read_error',
): ChatSourceObservation {
  return { kind: 'native_unavailable', reason };
}

describe('ChatSourceMachine — Booting', () => {
  it('promotes to NativeLocked on first valid full/tail native observation', () => {
    const r = observe(INITIAL_CHAT_SOURCE_STATE, nativePresent({ keys: ['a', 'b'], coverage: 'tail' }));
    expect(r.next.name).toBe('NativeLocked');
    expect(r.selected).toBe('native-history');
    expect(r.lockState.locked).toBe(true);
    expect(r.transition.event).toBe('NativeProgressed');
  });

  it('stays Recovering when first observation is partial — no premature lock', () => {
    const r = observe(INITIAL_CHAT_SOURCE_STATE, nativePresent({ keys: ['a'], coverage: 'partial' }));
    expect(r.next.name).toBe('Recovering');
    expect(r.selected).toBe('pty-parser');
    expect(r.lockState.locked).toBe(false);
  });

  it('goes directly to PtyOnly when first observation is native_unavailable', () => {
    const r = observe(INITIAL_CHAT_SOURCE_STATE, nativeUnavailable('provider_not_supported'));
    expect(r.next.name).toBe('PtyOnly');
    expect(r.selected).toBe('pty-parser');
    expect(r.transition.cause).toBe('native_unavailable_provider_unsupported');
  });

  it('treats unsafe mapping as regression even before locking', () => {
    const r = observe(INITIAL_CHAT_SOURCE_STATE, nativePresent({ keys: ['a'], safeMapping: false }));
    expect(r.next.name).toBe('PtyOnly');
    expect(r.transition.event).toBe('NativeRegressed');
    expect(r.transition.cause).toBe('native_regressed_unsafe_mapping');
  });
});

describe('ChatSourceMachine — NativeLocked lock semantics', () => {
  function lockedAt(keys: string[], peak: number): ChatSourceState {
    const r = observe(INITIAL_CHAT_SOURCE_STATE, nativePresent({ keys, peak }));
    expect(r.next.name).toBe('NativeLocked');
    return r.next;
  }

  it('holds lock on superset observation with same or higher peak', () => {
    const locked = lockedAt(['a', 'b'], 10);
    const r = transitionChatSourceState(
      locked,
      nativePresent({ keys: ['a', 'b', 'c'], peak: 12 }),
      2_000,
      1_000,
    );
    expect(r.next.name).toBe('NativeLocked');
    expect(r.selected).toBe('native-history');
    expect(r.lockState.locked).toBe(true);
    expect(r.lockState.lockedSince).toBe(1_000); // preserved across hold
  });

  it('regresses to PtyOnly when a committed key disappears', () => {
    const locked = lockedAt(['a', 'b'], 10);
    const r = transitionChatSourceState(
      locked,
      nativePresent({ keys: ['a'], peak: 11 }),
      2_000,
      1_000,
    );
    expect(r.next.name).toBe('PtyOnly');
    expect(r.transition.event).toBe('NativeRegressed');
    expect(r.transition.cause).toBe('native_regressed_shrunk');
  });

  it('regresses when peak moves backward even with superset keys', () => {
    const locked = lockedAt(['a', 'b'], 10);
    const r = transitionChatSourceState(
      locked,
      nativePresent({ keys: ['a', 'b', 'c'], peak: 9 }),
      2_000,
      1_000,
    );
    expect(r.next.name).toBe('PtyOnly');
    expect(r.transition.cause).toBe('native_regressed_shrunk');
  });

  it('regresses on unsafe mapping even when keys would otherwise hold', () => {
    const locked = lockedAt(['a', 'b'], 10);
    const r = transitionChatSourceState(
      locked,
      nativePresent({ keys: ['a', 'b'], peak: 10, safeMapping: false }),
      2_000,
      1_000,
    );
    expect(r.next.name).toBe('PtyOnly');
    expect(r.transition.cause).toBe('native_regressed_unsafe_mapping');
  });

  it('lock survives PTY arrival — the machine does not compare native vs PTY freshness', () => {
    // The whole point of the redesign: the v1 plipping was driven by PTY's
    // newer receivedAt making native look "stale". The new machine never
    // observes PTY directly. Only native events can unlock.
    const locked = lockedAt(['a', 'b'], 10);
    // 100 "hold" observations — equivalent to 100 turns of PTY arriving with
    // newer bytes than native — must not unlock.
    let state = locked;
    let lockedSince: number | undefined = 1_000;
    for (let i = 0; i < 100; i += 1) {
      const r = transitionChatSourceState(
        state,
        nativePresent({ keys: ['a', 'b'], peak: 10 }),
        2_000 + i,
        lockedSince,
      );
      expect(r.next.name).toBe('NativeLocked');
      state = r.next;
      lockedSince = r.lockState.lockedSince;
    }
    expect(state.name).toBe('NativeLocked');
  });
});

describe('ChatSourceMachine — Recovering and PtyOnly transitions', () => {
  function lockedThenLost(): ChatSourceState {
    const initial = observe(INITIAL_CHAT_SOURCE_STATE, nativePresent({ keys: ['a', 'b'], peak: 10 })).next;
    const lost = transitionChatSourceState(initial, nativeUnavailable('empty'), 2_000, 1_000);
    expect(lost.next.name).toBe('Recovering');
    return lost.next;
  }

  it('goes to Recovering on first native miss after lock', () => {
    const s = lockedThenLost();
    expect(s.name).toBe('Recovering');
    expect(s.nativeSequencePeak).toBe(10); // watermark preserved
    expect(s.recoveringMisses).toBe(1);
  });

  it('re-locks from Recovering when native progresses past previous peak', () => {
    const recovering = lockedThenLost();
    const r = transitionChatSourceState(
      recovering,
      nativePresent({ keys: ['a', 'b', 'c'], peak: 11 }),
      3_000,
      undefined,
    );
    expect(r.next.name).toBe('NativeLocked');
    expect(r.selected).toBe('native-history');
    expect(r.lockState.lockedSince).toBe(3_000);
  });

  it('stays Recovering when native returns but does not meet watermark', () => {
    const recovering = lockedThenLost();
    const r = transitionChatSourceState(
      recovering,
      nativePresent({ keys: ['a'], peak: 9 }),
      3_000,
      undefined,
    );
    // 'a' alone is not superset of {'a','b'} → does not re-lock; transition
    // is treated like an empty observation by the resolver path.
    expect(r.next.name).toBe('Recovering');
    expect(r.selected).toBe('pty-parser');
  });

  it('promotes Recovering → PtyOnly after threshold consecutive misses', () => {
    let state = lockedThenLost();
    for (let i = 1; i < RECOVERING_MISS_PROMOTION_THRESHOLD; i += 1) {
      const r = transitionChatSourceState(state, nativeUnavailable('empty'), 3_000 + i, undefined);
      state = r.next;
    }
    expect(state.name).toBe('PtyOnly');
  });

  it('PtyOnly stays sticky on native_unavailable', () => {
    const pty: ChatSourceState = {
      name: 'PtyOnly',
      nativeSequencePeak: 10,
      committedUnitKeys: new Set(['a', 'b']),
      recoveringMisses: 0,
    };
    const r = transitionChatSourceState(pty, nativeUnavailable('read_error'), 5_000, undefined);
    expect(r.next.name).toBe('PtyOnly');
    expect(r.transition.event).toBe('NoOp');
  });

  it('PtyOnly re-locks only when native meets the historical watermark with superset', () => {
    const pty: ChatSourceState = {
      name: 'PtyOnly',
      nativeSequencePeak: 10,
      committedUnitKeys: new Set(['a', 'b']),
      recoveringMisses: 0,
    };
    // Below watermark — stays PtyOnly.
    const below = transitionChatSourceState(pty, nativePresent({ keys: ['a', 'b'], peak: 9 }), 5_000, undefined);
    expect(below.next.name).toBe('PtyOnly');
    // Meets watermark + superset → re-lock.
    const re = transitionChatSourceState(pty, nativePresent({ keys: ['a', 'b', 'c'], peak: 12 }), 6_000, undefined);
    expect(re.next.name).toBe('NativeLocked');
    expect(re.selected).toBe('native-history');
  });
});

describe('ChatSourceMachine — regression bundles 6 v1 triggers into 3 events', () => {
  const cases: Array<[Extract<ChatSourceObservation, { kind: 'native_unavailable' }>['reason'], string]> = [
    ['provider_not_supported', 'native_unavailable_provider_unsupported'],
    ['read_error', 'native_unavailable_read_error'],
    ['empty', 'native_unavailable_empty'],
    ['not_native_source', 'native_unavailable_not_native_source'],
    ['coverage_unavailable', 'native_regressed_coverage_unavailable'],
  ];
  for (const [reason, expectedCause] of cases) {
    it(`maps ${reason} to ${expectedCause}`, () => {
      const r = observe(INITIAL_CHAT_SOURCE_STATE, nativeUnavailable(reason));
      expect(r.transition.cause).toBe(expectedCause);
    });
  }

  it('records native_regressed_coverage_partial when locked transcript becomes empty-partial', () => {
    const locked = observe(INITIAL_CHAT_SOURCE_STATE, nativePresent({ keys: ['a'], peak: 5 })).next;
    const r = transitionChatSourceState(
      locked,
      nativePresent({ keys: [], coverage: 'partial' }),
      2_000,
      1_000,
    );
    expect(r.transition.cause).toBe('native_regressed_coverage_partial');
  });
});
