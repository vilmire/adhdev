import { RecoveryOwnerAdmission, resolveSessionHostIpcKey, assertRecoveryLaunchIdentity,
  type SessionHostEndpoint, type SessionHostRegistry, type SessionHostRequest, type SessionHostResponse } from '@adhdev/session-host-core';
import type { HostUpgradeLease } from './upgrade-lease.js';
import type { OperatorRecoveryFence } from './operator-recovery-fence.js';
import type { SessionHostStorage } from './storage.js';
import { evaluateRecoveryCensus, readLegacyGuardianCoverage } from './operator-recovery-census.js';
interface HostView {
  upgradeLease: HostUpgradeLease | null; instanceConfigDir: string | null; endpoint: SessionHostEndpoint;
  workerDaemonId: string; restorePending: boolean; fullRestoreState: string; partialRestoreCount: number;
  mutatingRequests: number; registry: SessionHostRegistry; runtimes: ReadonlyMap<string, unknown>;
  storage: SessionHostStorage; recoveryFence: OperatorRecoveryFence;
}
/** Host-owned implementation; its view is supplied by the native server, not
 * decoded from a request, callback proof, diagnostic payload or operator input. */
export class OperatorRecoveryControl {
  private readonly owner: RecoveryOwnerAdmission | null;
  constructor(private readonly view: () => HostView, publicKey?: string) {
    const lease = view().upgradeLease;
    this.owner = publicKey && lease ? new RecoveryOwnerAdmission({
      publicKey, enrollmentId: 'native-parent-boot-pipe', coordinatorBootId: lease.bootId, authEpoch: lease.bootId,
      verifyCurrent: () => { try { lease.assertHealthy(); return true; } catch { return false; } },
    }) : null;
  }
  handle(request: SessionHostRequest): SessionHostResponse {
    switch (request.type) {
        case 'prepare_operator_recovery_fence_v1':
          if (!this.owner) throw new Error('operator_recovery_native_owner_unavailable');
          return { success: true, result: this.owner.challenge() };
        case 'install_operator_recovery_fence_v1': {
          if (!this.owner) throw new Error('operator_recovery_native_owner_unavailable');
          const grant = this.owner.authorize(request.payload.message, request.payload.signature);
          return { success: true, result: { fenceDigest: this.installOperatorRecoveryFence(this.owner, grant) } };
        }
        case 'attest_operator_recovery_v1':
          return { success: true, result: this.collectRecoveryCensus(request.payload.nonce, request.payload.fenceDigest) };
        case 'get_operator_recovery_coverage_v1': {
          if (!/^[a-f0-9]{64}$/.test(request.payload?.nonce)) throw new Error('operator_recovery_nonce_required');
          let coverage: { protocol: 1 | 2; verdict: 'UNKNOWN'; reason: string } = {
            protocol: 1, verdict: 'UNKNOWN', reason: 'native_guardian_coverage_missing',
          };
          try { const lease = this.view().upgradeLease; if (lease) coverage = lease.recoveryCoverage(); }
          catch { /* Unsupported, wedged or unverified native helper never proves absence. */ }
          return { success: true, result: { ...coverage, nonce: request.payload.nonce } };
        }
      default: throw new Error('unsupported_operator_recovery_request');
    }
  }
  /** Used only by the local authenticated owner command. Native exclusion is
   * checked here, not supplied as a caller's boolean or observation callback. */
  installOperatorRecoveryFence(owner: RecoveryOwnerAdmission, grant: unknown): string {
    const v = this.view();
    if (!v.upgradeLease || !v.instanceConfigDir) throw new Error('operator_recovery_native_binding_required');
    if (v.restorePending || v.fullRestoreState !== 'ready' || v.partialRestoreCount !== 0 || !v.storage.recoveryInventory().complete) throw new Error('operator_recovery_full_restore_required');
    const native = v.upgradeLease.proof();
    const binding = { namespace: resolveSessionHostIpcKey(v.instanceConfigDir), endpoint: v.endpoint.path,
      hostBootId: native.bootId, workerDaemonId: v.workerDaemonId };
    return v.recoveryFence.install(owner, grant, binding, () => v.upgradeLease!.assertMutable(),
      () => v.registry.listSessions().some(r => {
        try { assertRecoveryLaunchIdentity(r); return false; }
        catch { return v.runtimes.has(r.sessionId) || ['running','starting','stopping'].includes(r.lifecycle); }
      }));
  }

  /** Synchronous observation on the same serialized host loop as final spawn.
   * The native guardian currently has no historical attribution, so this real
   * collector cannot produce ABSENT even if all current inventories are empty. */
  collectRecoveryCensus(nonce: string, expectedFenceDigest: string) {
    const v = this.view();
    if (!/^[a-f0-9]{64}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(expectedFenceDigest)) throw new Error('operator_recovery_challenge_required');
    const inventory = v.storage.recoveryInventory();
    // Collect the pinned native process/birth/FD observation when supported.
    // It remains UNKNOWN because no historical attribution roots exist.
    try { v.upgradeLease?.recoveryCoverage(); } catch { /* Native uncertainty cannot become ABSENT. */ }
    let hostBootId = '';
    let fenceDigest = '';
    try {
      v.upgradeLease?.assertHealthy();
      hostBootId = v.upgradeLease?.proof().bootId || '';
      fenceDigest = v.recoveryFence.witness(expectedFenceDigest).digest;
    } catch { /* Missing native exclusion or durable fence remains unproved. */ }
    let live = false;
    let uncertain = !inventory.complete;
    for (const r of [...v.registry.listSessions(), ...inventory.states.map(s => s.record)]) {
      try { assertRecoveryLaunchIdentity(r); }
      catch {
        if (v.runtimes.has(r.sessionId) || ['running','starting','stopping'].includes(r.lifecycle)) live = true;
        else if (!['failed','stopped','interrupted'].includes(r.lifecycle)) uncertain = true;
      }
    }
    const namespace = v.instanceConfigDir ? resolveSessionHostIpcKey(v.instanceConfigDir) : '';
    return evaluateRecoveryCensus({
      binding: { namespace, endpoint: v.endpoint.path, hostBootId, workerDaemonId: v.workerDaemonId },
      instanceConfigDir: v.instanceConfigDir || '/', nonce, fenceDigest,
      restoreState: v.restorePending ? 'pending' : v.fullRestoreState,
      fullRestoreState: v.fullRestoreState, partialRestoreCount: v.partialRestoreCount,
      storageCensus: inventory.complete ? 'complete' : 'unknown',
      targetRuntime: live ? 'live' : uncertain ? 'unknown' : 'absent',
      inFlightLaunches: v.mutatingRequests, guardian: readLegacyGuardianCoverage(),
    });
  }

}
