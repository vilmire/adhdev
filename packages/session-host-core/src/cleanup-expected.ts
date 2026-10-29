/** Shared cleanup expected-assignment / host-boot helpers (daemon + host). */
import type { SessionCleanupExpectedAssignment, SessionHostRecord } from './types.js';

export function hostBootIdFromStartedAt(hostStartedAt: number): string {
  return `hs:${hostStartedAt}`;
}

export function resolveHostBootId(opts: { upgradeBootId?: string | null; hostStartedAt: number }): string | null {
  if (typeof opts.upgradeBootId === 'string' && opts.upgradeBootId) return opts.upgradeBootId;
  if (!Number.isFinite(opts.hostStartedAt) || opts.hostStartedAt <= 0) return null;
  return hostBootIdFromStartedAt(opts.hostStartedAt);
}

/** Sanitized refusal codes only — never echo assignment contents. */
export function refuseCleanupExpectedStop(
  record: SessionHostRecord | null | undefined,
  expected: SessionCleanupExpectedAssignment,
  currentHostBootId: string | null,
  hasRuntime: boolean,
): string | null {
  if (!expected || expected.sessionId !== (record?.sessionId ?? '')
    || typeof expected.hostBootId !== 'string' || !expected.hostBootId
    || typeof expected.runtimeKey !== 'string' || !expected.runtimeKey
    || !Number.isSafeInteger(expected.startedAt) || expected.startedAt <= 0) {
    return 'cleanup_expected_malformed';
  }
  if (!currentHostBootId) return 'cleanup_host_boot_unknown';
  if (expected.hostBootId !== currentHostBootId) return 'cleanup_host_boot_mismatch';
  if (!record || record.termination || !hasRuntime || record.lifecycle !== 'running') {
    return 'cleanup_session_not_running';
  }
  if (record.runtimeKey !== expected.runtimeKey || record.startedAt !== expected.startedAt) {
    return 'cleanup_native_incarnation_mismatch';
  }
  const active = record.meta?.meshActiveAssignment as Record<string, unknown> | undefined;
  // taskId null is the unbound intent; attempt/generation/nonce may still be present as
  // sticky fence fields on an idle worker and must not be treated as a live assignment.
  if (expected.taskId === null) {
    if (active && typeof active.taskId === 'string' && active.taskId) return 'cleanup_expected_unbound_now_bound';
    return null;
  }
  if (!active || typeof active.taskId !== 'string' || !active.taskId) return 'cleanup_expected_bound_now_unbound';
  if (active.taskId !== expected.taskId || active.attemptId !== expected.attemptId
    || active.generation !== expected.generation || active.dispatchNonce !== expected.dispatchNonce) {
    return 'cleanup_assignment_mismatch';
  }
  return null;
}
