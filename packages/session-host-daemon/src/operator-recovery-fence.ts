import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  OPERATOR_RECOVERY_TARGET as target, recoveryTargetBytes,
  type CreateSessionPayload, type RecoveryHostBinding, type RecoveryOwnerAdmission,
} from '@adhdev/session-host-core';

const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const containsTarget = (payload: unknown) => {
  const text = JSON.stringify(payload);
  return text.includes(target.sessionId) || text.includes(target.providerSessionId);
};
interface FenceRecord { protocol: 1; target: string; installedHostBootId: string; namespace: string }

/** Permanent denial. No release API. The compiled dual UUID denial survives
 * journal deletion/rollback; a witness is still required for positive proof.
 * Only the host holding native instance exclusion may install the journal. */
export class OperatorRecoveryFence {
  private readonly file: string;
  private observedDigest: string | null = null;
  private inFlight = 0;
  private poisoned = false;
  constructor(private readonly root: string) {
    this.file = path.join(root, 'operator-recovery-v1.json');
  }
  assertLaunchAllowed(payload: CreateSessionPayload): void {
    if (containsTarget(payload)) throw new Error('operator_recovery_fenced');
    // Target denial is unconditional, even on hosts not yet enrolled. Corrupt
    // recovery state must not silently be interpreted as an absent fence.
    if (this.observedDigest) this.witness();
  }
  enterLaunch(payload: CreateSessionPayload): () => void {
    this.assertLaunchAllowed(payload);
    this.inFlight++;
    let released = false;
    return () => { if (!released) { released = true; this.inFlight--; } };
  }
  install(owner: RecoveryOwnerAdmission, grant: unknown, binding: RecoveryHostBinding,
    assertNativeExclusion: () => void, targetRuntimePresent: () => boolean): string {
    owner.assertGrant(grant);
    assertNativeExclusion();
    if (this.inFlight !== 0 || targetRuntimePresent()) throw new Error('operator_recovery_launch_in_flight');
    if (binding.namespace !== target.namespace || binding.workerDaemonId !== target.workerDaemonId ||
        !binding.hostBootId || !binding.endpoint.endsWith(`adhdev-preview-session-host-${target.namespace}.sock`)) {
      throw new Error('operator_recovery_host_binding');
    }
    const state: FenceRecord = { protocol: 1, target: recoveryTargetBytes,
      installedHostBootId: binding.hostBootId, namespace: binding.namespace };
    const bytes = JSON.stringify(state);
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const directory = fs.lstatSync(this.root);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() ||
        (directory.mode & 0o077)) throw new Error('operator_recovery_storage_untrusted');
    // A retry must acquire a new owner grant. Never overwrite a prior record.
    owner.consume(grant);
    try {
      const fd = fs.openSync(this.file, 'wx', 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const dir = fs.openSync(this.root, 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      this.observedDigest = digest(bytes);
      return this.observedDigest;
    } catch (error) { this.poisoned = true; throw error; }
  }
  witness(expectedDigest?: string): { digest: string; installedHostBootId: string } {
    if (this.poisoned || this.inFlight) throw new Error('operator_recovery_fence_unknown');
    const stat = fs.lstatSync(this.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077)) throw new Error('operator_recovery_storage_untrusted');
    const bytes = fs.readFileSync(this.file, 'utf8');
    const hash = digest(bytes);
    const state = JSON.parse(bytes) as FenceRecord;
    // Across boots require the coordinator's independently retained witness.
    const pinned = expectedDigest ?? this.observedDigest;
    if (!pinned || hash !== pinned || state.protocol !== 1 || state.target !== recoveryTargetBytes ||
        state.namespace !== target.namespace || !state.installedHostBootId) throw new Error('operator_recovery_fence_rollback');
    this.observedDigest = hash;
    return { digest: hash, installedHostBootId: state.installedHostBootId };
  }
}
