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

function refuseCleanupExpectedIdentity(
  record: SessionHostRecord | null | undefined,
  expected: SessionCleanupExpectedAssignment,
  currentHostBootId: string | null,
): string | null {
  if (!expected || expected.sessionId !== (record?.sessionId ?? '')
    || typeof expected.hostBootId !== 'string' || !expected.hostBootId
    || typeof expected.runtimeKey !== 'string' || !expected.runtimeKey
    || !Number.isSafeInteger(expected.startedAt) || expected.startedAt <= 0) {
    return 'cleanup_expected_malformed';
  }
  if (!currentHostBootId) return 'cleanup_host_boot_unknown';
  if (expected.hostBootId !== currentHostBootId) return 'cleanup_host_boot_mismatch';
  if (!record) return 'cleanup_session_not_running';
  if (record.runtimeKey !== expected.runtimeKey || record.startedAt !== expected.startedAt) {
    return 'cleanup_native_incarnation_mismatch';
  }
  return null;
}

function refuseCleanupExpectedAssignment(
  record: SessionHostRecord,
  expected: SessionCleanupExpectedAssignment,
  opts: { allowClearedBound?: boolean } = {},
): string | null {
  const active = record.meta?.meshActiveAssignment as Record<string, unknown> | undefined;
  // taskId null is the unbound intent; attempt/generation/nonce may still be present as
  // sticky fence fields on an idle worker and must not be treated as a live assignment.
  if (expected.taskId === null) {
    if (active && typeof active.taskId === 'string' && active.taskId) return 'cleanup_expected_unbound_now_bound';
    return null;
  }
  if (!active || typeof active.taskId !== 'string' || !active.taskId) {
    // After a proven stop the assignment may clear on the same incarnation — allow delete.
    return opts.allowClearedBound ? null : 'cleanup_expected_bound_now_unbound';
  }
  if (active.taskId !== expected.taskId || active.attemptId !== expected.attemptId
    || active.generation !== expected.generation || active.dispatchNonce !== expected.dispatchNonce) {
    return 'cleanup_assignment_mismatch';
  }
  return null;
}

/** Sanitized refusal codes only — never echo assignment contents. */
export function refuseCleanupExpectedStop(
  record: SessionHostRecord | null | undefined,
  expected: SessionCleanupExpectedAssignment,
  currentHostBootId: string | null,
  hasRuntime: boolean,
): string | null {
  const identity = refuseCleanupExpectedIdentity(record, expected, currentHostBootId);
  if (identity) return identity;
  if (!record || record.termination || !hasRuntime || record.lifecycle !== 'running') {
    return 'cleanup_session_not_running';
  }
  return refuseCleanupExpectedAssignment(record, expected);
}

/**
 * Delete CAS: same identity/assignment proof as stop. A replaced incarnation or a
 * newly bound writer must survive — never delete a record that no longer matches
 * the captured expected tuple. `force` is required to stop a still-live runtime
 * before deleting that exact incarnation.
 */
export function refuseCleanupExpectedDelete(
  record: SessionHostRecord | null | undefined,
  expected: SessionCleanupExpectedAssignment,
  currentHostBootId: string | null,
  hasRuntime: boolean,
  force: boolean,
): string | null {
  // Missing record after a proven stop is handled by the caller as idempotent delete.
  if (!record) return 'cleanup_session_not_running';
  const identity = refuseCleanupExpectedIdentity(record, expected, currentHostBootId);
  if (identity) return identity;
  if (hasRuntime) {
    if (!force) return 'cleanup_session_still_running';
    if (record.termination || record.lifecycle !== 'running') return 'cleanup_session_not_running';
    return refuseCleanupExpectedAssignment(record, expected);
  }
  // Stopped/failed record: protect unbound→bound and reassignment on the same incarnation.
  return refuseCleanupExpectedAssignment(record, expected, { allowClearedBound: true });
}
