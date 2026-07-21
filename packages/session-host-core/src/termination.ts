import type { SessionLifecycle, SessionTermination } from './types.js';

export interface ClassifyTerminationInput {
  exitCode: number | null;
  signal?: number | null;
  osPid?: number;
  previousLifecycle?: SessionLifecycle;
  lastOutputAt?: number;
  requestedStop?: SessionTermination['requestedStop'];
  terminatedAt: number;
}

/**
 * Classify a PTY termination from its raw (exitCode, signal) pair.
 *
 * Invariants:
 *  - A `null` exitCode is UNKNOWN, never a clean exit — it MUST NOT collapse to
 *    exit 0. This is the regression guard for the old `exitCode ?? 0` behavior.
 *  - A non-null, non-zero exitCode or any signal is a failure.
 *  - Only an explicit exit code of 0 (with no signal) is a clean stop.
 *
 * The returned lifecycle is `stopped` only for a clean exit 0; every other
 * case (nonzero, signalled, or unknown) is `failed` so that an unknown
 * termination stays distinguishable from a successful one.
 */
export function classifyTermination(input: ClassifyTerminationInput): SessionTermination {
  const { exitCode, terminatedAt } = input;
  const signal = input.signal ?? null;

  let reason: SessionTermination['reason'];
  let lifecycle: SessionTermination['lifecycle'];

  if (signal !== null && signal !== 0) {
    reason = 'signal';
    lifecycle = 'failed';
  } else if (exitCode === null) {
    reason = 'unknown';
    lifecycle = 'failed';
  } else if (exitCode === 0) {
    reason = 'exit';
    lifecycle = 'stopped';
  } else {
    reason = 'failed';
    lifecycle = 'failed';
  }

  const termination: SessionTermination = {
    exitCode,
    signal,
    reason,
    lifecycle,
    terminatedAt,
  };
  if (typeof input.osPid === 'number') termination.osPid = input.osPid;
  if (input.previousLifecycle) termination.previousLifecycle = input.previousLifecycle;
  if (typeof input.lastOutputAt === 'number') termination.lastOutputAt = input.lastOutputAt;
  if (input.requestedStop) termination.requestedStop = input.requestedStop;
  return termination;
}
