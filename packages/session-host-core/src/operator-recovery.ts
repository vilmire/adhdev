import { createPublicKey, randomBytes, verify, type KeyObject } from 'node:crypto';
import { isAbsolute, basename } from 'node:path';
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
/** Shared final admission guard for saved IDs, new aliases and provider argv.
 * This is a permanent exact-target denial, independent of journal availability. */
export function assertRecoveryLaunchIdentity(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const identities = new Set(['sessionId', 'runtimeId', 'runtimeSessionId', 'providerSessionId',
    'presetSessionKey', 'resumeSessionId', 'key']);
  const nested = new Set(['options', 'meta', 'settings', 'settingsOverride', 'restartBinding', 'sessionBinding', 'launchCommand']);
  for (const [key, field] of Object.entries(value)) {
    if (identities.has(key) || ['args', 'cliArgs', 'cliArgsWithBrain'].includes(key)) {
      const bytes = JSON.stringify(field)?.toLowerCase();
      if (bytes?.includes(OPERATOR_RECOVERY_TARGET.sessionId) || bytes?.includes(OPERATOR_RECOVERY_TARGET.providerSessionId)) {
        throw new Error('operator_recovery_fenced');
      }
    } else if (nested.has(key)) assertRecoveryLaunchIdentity(field);
  }
}
export type RecoveryOwnerOperation = 'anchor_recover' | 'fence_install' | 'witness_enroll';
export interface RecoveryOwnerGrant { readonly purpose: 'operator_recovery_v1'; readonly operation: RecoveryOwnerOperation }
export function isRecoveryEndpoint(endpoint: string): boolean {
  return isAbsolute(endpoint) && basename(endpoint) === `adhdev-preview-session-host-${OPERATOR_RECOVERY_TARGET.namespace}.sock`;
}
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
  private readonly pending = new Map<string, { deadline: number; operation: RecoveryOwnerOperation }>();
  private readonly grants = new WeakMap<object, { deadline: number; operation: RecoveryOwnerOperation }>();
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
  challenge(operation: RecoveryOwnerOperation = 'anchor_recover'): RecoveryOwnerChallenge {
    if (!['anchor_recover', 'fence_install', 'witness_enroll'].includes(operation)) throw new Error('recovery_owner_operation_rejected');
    const now = this.now();
    for (const [message, entry] of this.pending) if (entry.deadline <= now) this.pending.delete(message);
    if (this.pending.size >= 16) throw new Error('recovery_owner_challenge_limit');
    const message = JSON.stringify(['operator_recovery_v1', operation, recoveryTargetBytes,
      this.enrollment.enrollmentId, this.enrollment.coordinatorBootId, this.enrollment.authEpoch,
      randomBytes(32).toString('hex')]);
    this.pending.set(message, { deadline: now + 30_000, operation });
    return Object.freeze({ message });
  }
  authorize(message: string, signature: string): RecoveryOwnerGrant {
    const now = this.now();
    const entry = this.pending.get(message);
    this.pending.delete(message); // Every verification attempt burns the challenge.
    if (!entry || now >= entry.deadline || !/^[a-f0-9]{128}$/.test(signature) ||
        !verify(null, Buffer.from(message), this.key, Buffer.from(signature, 'hex'))) {
      throw new Error('recovery_owner_signature_rejected');
    }
    const grant = Object.freeze({ purpose: 'operator_recovery_v1' as const, operation: entry.operation });
    this.grants.set(grant, entry);
    return grant;
  }
  assertGrant(grant: unknown): asserts grant is RecoveryOwnerGrant {
    const now = this.now();
    const entry = typeof grant === 'object' && grant !== null ? this.grants.get(grant) : undefined;
    if (!entry || now >= entry.deadline) throw new Error('recovery_owner_grant_rejected');
  }
  /** Burn synchronously before any work or await. The private continuation
   * rechecks the ORIGINAL deadline and revocation; it cannot mint a new grant. */
  reserve(grant: unknown, operation: RecoveryOwnerOperation): () => void {
    this.assertGrant(grant);
    const entry = this.grants.get(grant as object)!;
    this.grants.delete(grant as object);
    if (entry.operation !== operation) throw new Error('recovery_owner_operation_rejected');
    return () => {
      if (this.now() >= entry.deadline) throw new Error('recovery_owner_grant_rejected');
    };
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
