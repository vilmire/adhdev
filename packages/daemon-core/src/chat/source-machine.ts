/**
 * Chat source state machine.
 *
 * Replaces the ad-hoc anchor + freshness + 6-trigger ladder that
 * chat-commands.ts:1500-1800 grew over time. The machine has four states and
 * three events; every other signal collapses to one of those three.
 *
 *   States                Meaning
 *   ─────────────────────────────────────────────────────────────────
 *   Booting               No native attempt evaluated yet. PTY is the source
 *                         because we have nothing else; this is not a
 *                         "fallback", just the starting condition.
 *   NativeLocked          Native transcript is the source. The lock holds even
 *                         when PTY receives newer bytes — only NativeRegressed
 *                         or NativeUnavailable can break it.
 *   PtyOnly               Native is genuinely not usable (unavailable /
 *                         regressed / never observed). PTY is the source.
 *   Recovering            We were NativeLocked, native disappeared, but we
 *                         have not yet seen enough PTY-only turns to commit
 *                         to PtyOnly. Behaves like PtyOnly for the current
 *                         read but a single NativeProgressed re-locks.
 *
 *   Events                Meaning
 *   ─────────────────────────────────────────────────────────────────
 *   NativeProgressed      Native transcript has fresh, safely-mapped messages
 *                         whose newest sequence is >= the last observed peak.
 *   NativeRegressed       Native messages dropped, mapping became unsafe, or
 *                         the transcript shrank. Strong unlock signal.
 *   NativeUnavailable     Native transcript could not be fetched at all
 *                         (read error, provider not supported, schema invalid).
 *                         Soft unlock — Recovering tolerates a transient miss.
 *
 * Why this replaces the v1 design:
 *   - The v1 freshness check (`isNativeHistoryFreshEnough`) compared native's
 *     newest receivedAt to the PTY buffer's. PTY arrived every turn, so
 *     native looked stale by default and only the 30-minute anchor TTL kept
 *     things stable. When the anchor expired the source flipped, which is
 *     the "plipping" the user reported. The new machine does not compare
 *     PTY freshness against native at all; the only thing that unlocks a
 *     NativeLocked state is evidence that native itself moved backwards or
 *     vanished.
 *   - The 6 trigger strings (`native_history_partial`, `native_history_stale`,
 *     `native_history_not_safely_mapped`, `native_history_empty`,
 *     `native_history_error:*`, `native_history_unavailable:*`) collapse to
 *     three events. Each transition records the original trigger as `cause`
 *     for observability, so we lose nothing diagnostic.
 *   - There is no anchor store. The "lock" is a state, not a piece of
 *     mutable data living on the adapter. Callers pass the previous state in
 *     and get the next state out.
 */

import type {
  ChatContractVersion,
} from '../providers/transcript-v2.js';
import {
  CHAT_CONTRACT_VERSION_V1,
  CHAT_CONTRACT_VERSION_V2,
} from '../providers/transcript-v2.js';

// ─── States and events ──────────────────────────────────────────────────

export type ChatSourceStateName =
  | 'Booting'
  | 'NativeLocked'
  | 'PtyOnly'
  | 'Recovering';

export type ChatSourceSelected = 'native-history' | 'pty-parser';

export type ChatSourceEventKind =
  | 'NativeProgressed'
  | 'NativeRegressed'
  | 'NativeUnavailable';

/**
 * Cause codes mirror the legacy 6-trigger vocabulary so existing log
 * pipelines and dashboards can group transitions the same way they do
 * today. They are diagnostic, not control-flow.
 */
export type ChatSourceTransitionCause =
  | 'initial'
  | 'native_progressed'
  | 'native_regressed_shrunk'
  | 'native_regressed_unsafe_mapping'
  | 'native_regressed_coverage_partial'
  | 'native_regressed_coverage_unavailable'
  | 'native_unavailable_read_error'
  | 'native_unavailable_provider_unsupported'
  | 'native_unavailable_empty'
  | 'native_unavailable_not_native_source';

export interface ChatSourceState {
  readonly name: ChatSourceStateName;
  /**
   * Highest sequence number ever observed from native. Used as the watermark
   * NativeProgressed has to reach (or exceed) before re-locking from
   * Recovering. Undefined while we have never seen native.
   */
  readonly nativeSequencePeak: number | undefined;
  /**
   * Highest providerUnitKey set we have committed to. Future progressed events
   * must be a superset (no removals) for the lock to hold; if any prior
   * unit key vanishes we issue NativeRegressed instead. Empty when we have
   * never locked.
   */
  readonly committedUnitKeys: ReadonlySet<string>;
  /**
   * Number of consecutive non-progressed observations while in Recovering.
   * Threshold-based promotion to PtyOnly so transient misses do not commit
   * us to PtyOnly prematurely. Always 0 outside Recovering.
   */
  readonly recoveringMisses: number;
}

export const INITIAL_CHAT_SOURCE_STATE: ChatSourceState = Object.freeze({
  name: 'Booting',
  nativeSequencePeak: undefined,
  committedUnitKeys: Object.freeze(new Set<string>()),
  recoveringMisses: 0,
});

/**
 * Promote from Recovering to PtyOnly after this many consecutive misses.
 * One transient miss should not flip the source for a user who was just
 * reading from native; three in a row signals native is genuinely gone.
 */
export const RECOVERING_MISS_PROMOTION_THRESHOLD = 3;

// ─── Inputs ─────────────────────────────────────────────────────────────

/**
 * Per-message identity slice the machine needs. Producers normalise their
 * native transcript output into this shape (v2 producers already do so via
 * transcript-v2.ts; v1 producers go through a thin adapter — see
 * source-resolver.ts).
 */
export interface ResolverNativeMessageIdentity {
  providerUnitKey: string;
  sequence: number;
}

/**
 * Observation the resolver hands to the machine for a single readChat call.
 * Three mutually exclusive shapes — represented as a discriminated union so
 * the type system enforces honesty about what happened.
 */
export type ChatSourceObservation =
  | {
      kind: 'native_present';
      contractVersion: ChatContractVersion;
      messages: ReadonlyArray<ResolverNativeMessageIdentity>;
      /** Producer-declared coverage. Drives Progressed vs Regressed when the
       *  transcript is non-empty but only partial. */
      coverage: 'full' | 'tail' | 'current-turn' | 'partial';
      /** True when the daemon can prove these native messages belong to the
       *  intended workspace+session. False is treated as regression. */
      safeMapping: boolean;
    }
  | {
      kind: 'native_unavailable';
      reason:
        | 'provider_not_supported'
        | 'read_error'
        | 'empty'
        | 'not_native_source'
        | 'coverage_unavailable';
    };

// ─── Decision output ────────────────────────────────────────────────────

export interface ChatSourceTransition {
  readonly fromState: ChatSourceStateName;
  readonly toState: ChatSourceStateName;
  readonly event: ChatSourceEventKind | 'NoOp';
  readonly cause: ChatSourceTransitionCause;
  /** Wall-clock ms at the moment of resolution. Producer time, not ordering. */
  readonly at: number;
}

export interface ChatSourceLockState {
  readonly locked: boolean;
  /**
   * ms since epoch when the current lock began. Undefined when not locked or
   * not yet observed. Producers may use this for "anchored Xs ago" UI but
   * the machine itself never expires a lock based on it — only events do.
   */
  readonly lockedSince?: number;
}

export interface ChatSourceDecision {
  readonly selected: ChatSourceSelected;
  readonly nextState: ChatSourceState;
  readonly transition: ChatSourceTransition;
  readonly lockState: ChatSourceLockState;
}

// ─── Pure transition function ───────────────────────────────────────────

/**
 * Pure transition function. Given a previous state and a single observation,
 * returns the next state, the resulting transition record, and the selected
 * source. No side effects. No mutation of `prev`.
 *
 * Lock semantics:
 *   - Booting + native_present(safeMapping, not partial-only) → NativeLocked
 *   - NativeLocked + native_present(superset of committed keys, safe) → stays NativeLocked
 *   - NativeLocked + native_present(missing committed keys OR unsafe OR partial-shrunk) → PtyOnly
 *   - NativeLocked + native_unavailable → Recovering (lock holds for the source decision but watermark survives)
 *   - Recovering + native_present(progressed past peak) → NativeLocked
 *   - Recovering + native_unavailable (RECOVERING_MISS_PROMOTION_THRESHOLD times) → PtyOnly
 *   - PtyOnly is sticky: only an explicit progressed observation that meets
 *     the original superset rule moves us back to NativeLocked. This is the
 *     intended behaviour — once we have concluded native is dead, we do not
 *     re-lock on a single transient revival.
 */
export function transitionChatSourceState(
  prev: ChatSourceState,
  observation: ChatSourceObservation,
  at: number,
  lockedSince: number | undefined,
): {
  next: ChatSourceState;
  transition: ChatSourceTransition;
  selected: ChatSourceSelected;
  lockState: ChatSourceLockState;
} {
  const fromState = prev.name;

  if (observation.kind === 'native_unavailable') {
    return handleNativeUnavailable(prev, observation.reason, at, lockedSince);
  }

  return handleNativePresent(prev, observation, at, lockedSince, fromState);
}

function handleNativeUnavailable(
  prev: ChatSourceState,
  reason: Extract<ChatSourceObservation, { kind: 'native_unavailable' }>['reason'],
  at: number,
  lockedSince: number | undefined,
): ReturnType<typeof transitionChatSourceState> {
  const cause = reasonToUnavailableCause(reason);
  const fromState = prev.name;

  // Booting never had native; go straight to PtyOnly.
  if (prev.name === 'Booting') {
    const next: ChatSourceState = {
      name: 'PtyOnly',
      nativeSequencePeak: undefined,
      committedUnitKeys: prev.committedUnitKeys,
      recoveringMisses: 0,
    };
    return {
      next,
      selected: 'pty-parser',
      transition: { fromState, toState: 'PtyOnly', event: 'NativeUnavailable', cause, at },
      lockState: { locked: false },
    };
  }

  // PtyOnly stays PtyOnly.
  if (prev.name === 'PtyOnly') {
    return {
      next: prev,
      selected: 'pty-parser',
      transition: { fromState, toState: 'PtyOnly', event: 'NoOp', cause, at },
      lockState: { locked: false },
    };
  }

  // NativeLocked → Recovering on first miss. Source decision still favours
  // PTY for the current read because we have no native data to show, but
  // the watermark survives so the next progressed observation can re-lock
  // without resetting peak history.
  if (prev.name === 'NativeLocked') {
    const next: ChatSourceState = {
      name: 'Recovering',
      nativeSequencePeak: prev.nativeSequencePeak,
      committedUnitKeys: prev.committedUnitKeys,
      recoveringMisses: 1,
    };
    return {
      next,
      selected: 'pty-parser',
      transition: { fromState, toState: 'Recovering', event: 'NativeUnavailable', cause, at },
      lockState: { locked: false },
    };
  }

  // Recovering: count the miss; promote to PtyOnly at threshold.
  const misses = prev.recoveringMisses + 1;
  if (misses >= RECOVERING_MISS_PROMOTION_THRESHOLD) {
    const next: ChatSourceState = {
      name: 'PtyOnly',
      nativeSequencePeak: prev.nativeSequencePeak,
      committedUnitKeys: prev.committedUnitKeys,
      recoveringMisses: 0,
    };
    return {
      next,
      selected: 'pty-parser',
      transition: { fromState, toState: 'PtyOnly', event: 'NativeUnavailable', cause, at },
      lockState: { locked: false },
    };
  }
  const next: ChatSourceState = {
    name: 'Recovering',
    nativeSequencePeak: prev.nativeSequencePeak,
    committedUnitKeys: prev.committedUnitKeys,
    recoveringMisses: misses,
  };
  return {
    next,
    selected: 'pty-parser',
    transition: { fromState, toState: 'Recovering', event: 'NoOp', cause, at },
    lockState: { locked: false },
  };
}

function handleNativePresent(
  prev: ChatSourceState,
  observation: Extract<ChatSourceObservation, { kind: 'native_present' }>,
  at: number,
  lockedSince: number | undefined,
  fromState: ChatSourceStateName,
): ReturnType<typeof transitionChatSourceState> {
  // Unsafe mapping is always a regression — we cannot trust the messages.
  if (!observation.safeMapping) {
    return regressTo(prev, fromState, 'native_regressed_unsafe_mapping', at);
  }

  // Partial coverage is regression only if we previously had something better.
  // Booting with partial-only is still progress (some data > no data) but we
  // do not lock — Recovering captures that "we have something but cannot
  // commit to it yet".
  if (observation.coverage === 'partial' && observation.messages.length === 0) {
    return regressTo(prev, fromState, 'native_regressed_coverage_partial', at);
  }

  if (observation.messages.length === 0) {
    return handleNativeUnavailable(prev, 'empty', at, lockedSince);
  }

  const incomingUnitKeys = collectUnitKeys(observation.messages);
  const incomingPeak = maxSequence(observation.messages);

  // From Booting: lock if we have full or tail coverage; otherwise go to
  // Recovering so the next observation can either confirm or release.
  if (prev.name === 'Booting') {
    if (observation.coverage === 'partial') {
      const next: ChatSourceState = {
        name: 'Recovering',
        nativeSequencePeak: incomingPeak,
        committedUnitKeys: incomingUnitKeys,
        recoveringMisses: 0,
      };
      return {
        next,
        selected: 'pty-parser',
        transition: { fromState, toState: 'Recovering', event: 'NativeProgressed', cause: 'native_progressed', at },
        lockState: { locked: false },
      };
    }
    const next: ChatSourceState = {
      name: 'NativeLocked',
      nativeSequencePeak: incomingPeak,
      committedUnitKeys: incomingUnitKeys,
      recoveringMisses: 0,
    };
    return {
      next,
      selected: 'native-history',
      transition: { fromState, toState: 'NativeLocked', event: 'NativeProgressed', cause: 'native_progressed', at },
      lockState: { locked: true, lockedSince: at },
    };
  }

  // From NativeLocked: hold the lock as long as the new key set is a
  // superset of the committed one (no removals, additions OK) and the
  // peak did not move backward. Anything else is regression.
  if (prev.name === 'NativeLocked') {
    if (!isSupersetOf(incomingUnitKeys, prev.committedUnitKeys)) {
      return regressTo(prev, fromState, 'native_regressed_shrunk', at);
    }
    if (prev.nativeSequencePeak !== undefined && incomingPeak < prev.nativeSequencePeak) {
      return regressTo(prev, fromState, 'native_regressed_shrunk', at);
    }
    const next: ChatSourceState = {
      name: 'NativeLocked',
      nativeSequencePeak: Math.max(prev.nativeSequencePeak ?? incomingPeak, incomingPeak),
      committedUnitKeys: incomingUnitKeys,
      recoveringMisses: 0,
    };
    return {
      next,
      selected: 'native-history',
      transition: { fromState, toState: 'NativeLocked', event: 'NoOp', cause: 'native_progressed', at },
      lockState: { locked: true, lockedSince: lockedSince ?? at },
    };
  }

  // From Recovering: progressed past peak (or matching peak with superset)
  // re-locks. Anything weaker stays Recovering and counts as a miss.
  if (prev.name === 'Recovering') {
    const meetsWatermark = prev.nativeSequencePeak === undefined
      || incomingPeak >= prev.nativeSequencePeak;
    if (meetsWatermark && isSupersetOf(incomingUnitKeys, prev.committedUnitKeys)
        && observation.coverage !== 'partial') {
      const next: ChatSourceState = {
        name: 'NativeLocked',
        nativeSequencePeak: Math.max(prev.nativeSequencePeak ?? incomingPeak, incomingPeak),
        committedUnitKeys: incomingUnitKeys,
        recoveringMisses: 0,
      };
      return {
        next,
        selected: 'native-history',
        transition: { fromState, toState: 'NativeLocked', event: 'NativeProgressed', cause: 'native_progressed', at },
        lockState: { locked: true, lockedSince: at },
      };
    }
    return handleNativeUnavailable(prev, 'empty', at, lockedSince);
  }

  // From PtyOnly: sticky. Only an exact match of the original superset rule
  // re-locks; anything else stays PtyOnly. This is the only state where
  // re-locking from native_present requires meeting the old watermark
  // without first going through Recovering.
  if (prev.nativeSequencePeak === undefined || incomingPeak >= prev.nativeSequencePeak) {
    if (isSupersetOf(incomingUnitKeys, prev.committedUnitKeys)
        && observation.coverage !== 'partial') {
      const next: ChatSourceState = {
        name: 'NativeLocked',
        nativeSequencePeak: Math.max(prev.nativeSequencePeak ?? incomingPeak, incomingPeak),
        committedUnitKeys: incomingUnitKeys,
        recoveringMisses: 0,
      };
      return {
        next,
        selected: 'native-history',
        transition: { fromState, toState: 'NativeLocked', event: 'NativeProgressed', cause: 'native_progressed', at },
        lockState: { locked: true, lockedSince: at },
      };
    }
  }
  return {
    next: prev,
    selected: 'pty-parser',
    transition: { fromState, toState: 'PtyOnly', event: 'NoOp', cause: 'native_progressed', at },
    lockState: { locked: false },
  };
}

function regressTo(
  prev: ChatSourceState,
  fromState: ChatSourceStateName,
  cause: ChatSourceTransitionCause,
  at: number,
): ReturnType<typeof transitionChatSourceState> {
  const next: ChatSourceState = {
    name: 'PtyOnly',
    nativeSequencePeak: prev.nativeSequencePeak,
    committedUnitKeys: prev.committedUnitKeys,
    recoveringMisses: 0,
  };
  return {
    next,
    selected: 'pty-parser',
    transition: { fromState, toState: 'PtyOnly', event: 'NativeRegressed', cause, at },
    lockState: { locked: false },
  };
}

function reasonToUnavailableCause(
  reason: Extract<ChatSourceObservation, { kind: 'native_unavailable' }>['reason'],
): ChatSourceTransitionCause {
  switch (reason) {
    case 'provider_not_supported': return 'native_unavailable_provider_unsupported';
    case 'read_error': return 'native_unavailable_read_error';
    case 'empty': return 'native_unavailable_empty';
    case 'not_native_source': return 'native_unavailable_not_native_source';
    case 'coverage_unavailable': return 'native_regressed_coverage_unavailable';
  }
}

function collectUnitKeys(messages: ReadonlyArray<ResolverNativeMessageIdentity>): Set<string> {
  const set = new Set<string>();
  for (const m of messages) set.add(m.providerUnitKey);
  return set;
}

function maxSequence(messages: ReadonlyArray<ResolverNativeMessageIdentity>): number {
  let max = -Infinity;
  for (const m of messages) {
    if (m.sequence > max) max = m.sequence;
  }
  return max === -Infinity ? 0 : max;
}

function isSupersetOf(candidate: ReadonlySet<string>, required: ReadonlySet<string>): boolean {
  if (required.size === 0) return true;
  for (const key of required) {
    if (!candidate.has(key)) return false;
  }
  return true;
}

// ─── Convenience re-exports for callers that need version constants ────

export { CHAT_CONTRACT_VERSION_V1, CHAT_CONTRACT_VERSION_V2 };
