import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  OPERATOR_RECOVERY_TARGET as target, recoveryTargetBytes,
  assertRecoveryLaunchIdentity, isRecoveryEndpoint,
  type CreateSessionPayload, type RecoveryHostBinding, type RecoveryOwnerAdmission,
} from '@adhdev/session-host-core';

const digest = (s: string) => createHash('sha256').update(s).digest('hex');
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
    // Inspect existing bytes now, without promoting them to an independent
    // across-boot witness. Corruption poisons proof only, never other sessions.
    try { this.readRecord(); } catch (e: any) { if (e.code !== 'ENOENT') this.poisoned = true; }
  }
  assertLaunchAllowed(payload: CreateSessionPayload): void {
    assertRecoveryLaunchIdentity(payload);
    // Journal health gates recovery proof, not unrelated session admission.
  }
  enterLaunch(payload: CreateSessionPayload): () => void {
    this.assertLaunchAllowed(payload);
    this.inFlight++;
    let released = false;
    return () => { if (!released) { released = true; this.inFlight--; } };
  }
  install(owner: RecoveryOwnerAdmission, grant: unknown, binding: RecoveryHostBinding,
    assertNativeExclusion: () => void, targetRuntimePresent: () => boolean): string {
    const assertOwner = owner.reserve(grant, 'fence_install');
    assertNativeExclusion();
    if (this.inFlight !== 0 || targetRuntimePresent()) throw new Error('operator_recovery_launch_in_flight');
    if (binding.namespace !== target.namespace || binding.workerDaemonId !== target.workerDaemonId ||
        !binding.hostBootId || !isRecoveryEndpoint(binding.endpoint)) {
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
    assertOwner();
    try {
      const fd = fs.openSync(this.file, 'wx', 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const dir = fs.openSync(this.root, 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      this.observedDigest = digest(bytes);
      return this.observedDigest;
    } catch (error) { this.poisoned = true; throw error; }
  }
  private readRecord(): { hash: string; state: FenceRecord } {
    const root = fs.lstatSync(this.root);
    if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.getuid?.() || (root.mode & 0o077)) throw new Error('operator_recovery_storage_untrusted');
    const fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (stat.size > 4096 || !stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
        throw new Error('operator_recovery_storage_untrusted');
      }
      const bytes = fs.readFileSync(fd, 'utf8');
      const state = JSON.parse(bytes) as FenceRecord;
      if (state.protocol !== 1 || state.target !== recoveryTargetBytes || state.namespace !== target.namespace ||
          (typeof state.installedHostBootId !== 'string' || !state.installedHostBootId)) throw new Error('operator_recovery_fence_rollback');
      return { hash: digest(bytes), state };
    } finally { fs.closeSync(fd); }
  }
  witness(expectedDigest?: string): { digest: string; installedHostBootId: string } {
    if (this.poisoned || this.inFlight) throw new Error('operator_recovery_fence_unknown');
    const { hash, state } = this.readRecord();
    // Across boots require the coordinator's independently retained witness.
    const pinned = expectedDigest ?? this.observedDigest;
    if (!pinned || hash !== pinned || state.protocol !== 1 || state.target !== recoveryTargetBytes ||
        state.namespace !== target.namespace || (typeof state.installedHostBootId !== 'string' || !state.installedHostBootId)) throw new Error('operator_recovery_fence_rollback');
    this.observedDigest = hash;
    return { digest: hash, installedHostBootId: state.installedHostBootId };
  }
}
