import { createPublicKey, randomBytes, verify, type KeyObject } from 'node:crypto';
import { performance } from 'node:perf_hooks';

/** This association is owner asserted, never a historical native receipt. */
export const OPERATOR_RECOVERY_TARGET = Object.freeze({
  association: 'operator_asserted' as const,
  taskId: 'a1cdf3c0-f029-4d17-a8e9-db64e0a55501',
  meshId: 'mesh_271444af883843e9b36c67155b87b22f',
  attemptId: 'mesh_queue:mesh_271444af883843e9b36c67155b87b22f:a1cdf3c0-f029-4d17-a8e9-db64e0a55501:0',
  generation: 0, dispatchNonce: 1,
  deliveryId: 'dlv-7e259b34-b049-47ee-a466-2ca9c12bcff4',
  ownerDaemonId: 'daemon_mach_4462a75330c548be9c2e74dd9f7f6ffb',
  nodeId: 'node_d82de0cef9b042b6948986609e32142f',
  workerDaemonId: 'daemon_mach_6733c865d60f432dbeb119a6875ee303',
  sessionId: 'de321185-4ebc-40aa-8c6e-b4919e87fae3',
  providerSessionId: '60806c79-7d77-4614-9fa6-e628533478ba',
  namespace: '6a2ef3162182',
});
export const recoveryTargetBytes = JSON.stringify(OPERATOR_RECOVERY_TARGET);
export interface RecoveryOwnerGrant { readonly purpose: 'operator_recovery_v1' }
export interface RecoveryOwnerChallenge { readonly message: string }
export interface RecoveryOwnerEnrollment {
  /** Trusted boot dependency, provisioned outside delegated worker authority.
   * Do not load this from daemon config, IPC arguments or an MCP credential. */
  publicKey: string;
  enrollmentId: string;
  coordinatorBootId: string;
  authEpoch: string;
  verifyCurrent: () => boolean;
}

/** Signature possession authenticates the separately enrolled owner signer.
 * This verifier does not enroll keys or assert user presence on their behalf. */
export class RecoveryOwnerAdmission {
  private readonly key: KeyObject;
  private readonly enrollment: Readonly<RecoveryOwnerEnrollment>;
  private readonly pending = new Map<string, number>();
  private readonly grants = new WeakMap<object, number>();
  private lastNow = -Infinity;
  constructor(enrollment: RecoveryOwnerEnrollment, private readonly clock = () => performance.now()) {
    this.enrollment = Object.freeze({ ...enrollment });
    if (!enrollment.enrollmentId || !enrollment.coordinatorBootId || !enrollment.authEpoch ||
        typeof enrollment.verifyCurrent !== 'function') throw new Error('recovery_owner_enrollment_required');
    this.key = createPublicKey(enrollment.publicKey);
    if (this.key.asymmetricKeyType !== 'ed25519') throw new Error('recovery_owner_key_type');
  }
  private now(): number {
    const n = this.clock();
    if (!Number.isFinite(n) || n < this.lastNow || this.enrollment.verifyCurrent() !== true) {
      this.pending.clear();
      this.lastNow = Infinity; // A revocation or clock rollback cannot be undone.
      throw new Error('recovery_owner_revoked');
    }
    this.lastNow = n;
    return n;
  }
  challenge(): RecoveryOwnerChallenge {
    const now = this.now();
    for (const [message, deadline] of this.pending) if (deadline <= now) this.pending.delete(message);
    if (this.pending.size >= 16) throw new Error('recovery_owner_challenge_limit');
    const message = JSON.stringify(['operator_recovery_v1', recoveryTargetBytes,
      this.enrollment.enrollmentId, this.enrollment.coordinatorBootId, this.enrollment.authEpoch,
      randomBytes(32).toString('hex')]);
    this.pending.set(message, now + 30_000);
    return Object.freeze({ message });
  }
  authorize(message: string, signature: string): RecoveryOwnerGrant {
    const now = this.now();
    const deadline = this.pending.get(message);
    this.pending.delete(message); // Every verification attempt burns the challenge.
    if (deadline === undefined || now >= deadline || !/^[a-f0-9]{128}$/.test(signature) ||
        !verify(null, Buffer.from(message), this.key, Buffer.from(signature, 'hex'))) {
      throw new Error('recovery_owner_signature_rejected');
    }
    const grant = Object.freeze({ purpose: 'operator_recovery_v1' as const });
    this.grants.set(grant, deadline);
    return grant;
  }
  assertGrant(grant: unknown): asserts grant is RecoveryOwnerGrant {
    const now = this.now();
    const deadline = typeof grant === 'object' && grant !== null ? this.grants.get(grant) : undefined;
    if (deadline === undefined || now >= deadline) throw new Error('recovery_owner_grant_rejected');
  }
  consume(grant: unknown): void {
    this.assertGrant(grant);
    this.grants.delete(grant as object);
  }
}

export interface RecoveryHostBinding {
  namespace: string; endpoint: string; hostBootId: string; workerDaemonId: string;
}
export interface RecoveryPhysicalProof extends RecoveryHostBinding {
  protocol: 1;
  verdict: 'ABSENT' | 'LIVE' | 'UNKNOWN';
  reason: string;
  nonce: string;
  fenceDigest: string;
  sessionId: string;
  providerSessionId: string;
}
