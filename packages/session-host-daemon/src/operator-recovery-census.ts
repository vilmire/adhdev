import {
  OPERATOR_RECOVERY_TARGET as target, resolveSessionHostIpcKey, isRecoveryEndpoint,
  type RecoveryHostBinding, type RecoveryPhysicalProof,
} from '@adhdev/session-host-core';

/** Observations must be collected by a pinned local guardian, never parsed
 * from process-list UUID substrings, roster membership or operator input. */
export interface RecoveryGuardianCoverage {
  protocol: 1;
  namespace: string;
  hostBootId: string;
  fenceDigest: string;
  nonce: string;
  sessionId: string;
  providerSessionId: string;
  historicalLineage: 'complete' | 'unknown';
  descendants: 'absent' | 'live' | 'unknown';
  transcriptHandles: 'absent' | 'live' | 'unknown';
  launchAliases: 'closed' | 'unknown';
}
export interface RecoveryCensusSnapshot {
  binding: RecoveryHostBinding;
  /** Actual boot config, positively derived rather than a requested namespace. */
  instanceConfigDir: string;
  nonce: string;
  fenceDigest: string;
  restoreState: string;
  fullRestoreState: string;
  partialRestoreCount: number;
  storageCensus: 'complete' | 'unknown';
  targetRuntime: 'absent' | 'live' | 'unknown';
  inFlightLaunches: number;
  guardian: RecoveryGuardianCoverage | null;
}

/** guardian/1 implements flock only. Its lock is not a lineage census.
 * No source change can recover unrecorded prior-boot descendant identities. */
export function readLegacyGuardianCoverage(): null { return null; }

/** Local observation evaluator, not a transport authenticator. The caller must
 * obtain every field from the host/guardian in one serialized observation. */
export function evaluateRecoveryCensus(s: RecoveryCensusSnapshot): RecoveryPhysicalProof {
  const reply = (verdict: RecoveryPhysicalProof['verdict'], reason: string): RecoveryPhysicalProof => ({
    ...s.binding, protocol: 1, verdict, reason, nonce: s.nonce, fenceDigest: s.fenceDigest,
    sessionId: target.sessionId, providerSessionId: target.providerSessionId,
  });
  if (s.binding.namespace !== target.namespace ||
      resolveSessionHostIpcKey(s.instanceConfigDir) !== target.namespace ||
      s.binding.workerDaemonId !== target.workerDaemonId || !s.binding.hostBootId ||
      !isRecoveryEndpoint(s.binding.endpoint)) {
    return reply('UNKNOWN', 'native_instance_binding_unproved');
  }
  if (!/^[a-f0-9]{64}$/.test(s.nonce) || !/^[a-f0-9]{64}$/.test(s.fenceDigest)) return reply('UNKNOWN', 'challenge_or_fence_unproved');
  if (s.restoreState !== 'ready' || s.fullRestoreState !== 'ready' || s.partialRestoreCount !== 0 ||
      s.storageCensus !== 'complete' || s.inFlightLaunches !== 0) return reply('UNKNOWN', 'restore_or_launch_closure_unproved');
  if (s.targetRuntime === 'live') return reply('LIVE', 'target_runtime_present');
  if (s.targetRuntime !== 'absent') return reply('UNKNOWN', 'runtime_census_unproved');
  const g = s.guardian;
  if (!g || g.protocol !== 1 || g.namespace !== s.binding.namespace || g.hostBootId !== s.binding.hostBootId ||
      g.fenceDigest !== s.fenceDigest || g.nonce !== s.nonce || g.sessionId !== target.sessionId ||
      g.providerSessionId !== target.providerSessionId) return reply('UNKNOWN', 'native_guardian_coverage_missing');
  if (g.descendants === 'live' || g.transcriptHandles === 'live') return reply('LIVE', 'native_writer_present');
  if (g.historicalLineage !== 'complete' || g.descendants !== 'absent' || g.transcriptHandles !== 'absent' ||
      g.launchAliases !== 'closed') return reply('UNKNOWN', 'historical_native_coverage_unproved');
  return reply('ABSENT', 'native_dual_uuid_absence');
}
