import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface HostUpgradeBinding {
  /** Trusted packaged helper; supplied hash must come from an immutable artifact pin. */
  helperPath: string;
  helperSha256: string;
  helperProtocol?: 1;
  helperFileIdentity?: string;
  stateDir: string;
}
interface LeaseState {
  schema: 1;
  endpoint: string;
  epoch: number;
  held: boolean;
  owner: string | null;
  tokenHash: string | null;
}
export interface HostLeaseRequest {
  bootId: string;
  epoch: number;
  owner: string;
  token: string;
}
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Host-owned durable idle admission fence, opt-in until packaging is supported. */
export class HostUpgradeLease {
  readonly bootId = randomUUID();
  private child: ChildProcessWithoutNullStreams | null = null;
  private state: LeaseState;
  private healthy = false;
  private poisoned = false;
  private readonly journal: string;
  constructor(private readonly binding: HostUpgradeBinding, private readonly endpoint: string) {
    if (process.platform !== 'darwin') throw new Error('native_host_upgrade_platform_unproved');
    this.journal = path.join(binding.stateDir, 'upgrade-lease.json');
    this.state = { schema: 1, endpoint, epoch: 0, held: false, owner: null, tokenHash: null };
  }
  async start(): Promise<void> {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) throw new Error('native_host_binding_already_started');
    fs.mkdirSync(this.binding.stateDir, { recursive: true, mode: 0o700 });
    const dir = fs.lstatSync(this.binding.stateDir);
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || (dir.mode & 0o077)) {
      throw new Error('native_host_state_directory_untrusted');
    }
    if (this.binding.helperFileIdentity && this.fileIdentity() !== this.binding.helperFileIdentity) throw new Error('native_host_helper_file_identity_changed');
    if (fs.realpathSync(this.binding.helperPath) !== this.binding.helperPath ||
        digest(fs.readFileSync(this.binding.helperPath)) !== this.binding.helperSha256) {
      throw new Error('native_host_helper_pin_mismatch');
    }
    if (this.binding.helperProtocol === 1 && String(execFileSync(this.binding.helperPath, ['--attest'], { stdio: 'pipe' })).trim() !== 'adhdev-host-guardian/1') throw new Error('native_host_helper_protocol_mismatch');
    if (this.binding.helperFileIdentity && this.fileIdentity() !== this.binding.helperFileIdentity) throw new Error('native_host_helper_file_identity_changed');
    const lockPath = path.join(this.binding.stateDir, 'instance.lock');
    const priorLock = fs.existsSync(lockPath);
    const child = spawn(this.binding.helperPath, [lockPath], { stdio: 'pipe' });
    this.child = child;
    child.on('exit', () => { this.healthy = false; });
    child.on('error', () => { this.healthy = false; });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.stdin.end(); reject(new Error('native_host_lock_timeout')); }, 3000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('native_host_instance_locked')); });
      child.stdout.once('data', data => {
        clearTimeout(timer);
        if (String(data) !== 'LOCKED\n') { child.stdin.end(); reject(new Error('native_host_lock_protocol')); return; }
        this.healthy = true; resolve();
      });
    });
    try {
      if (this.binding.helperFileIdentity && (this.fileIdentity() !== this.binding.helperFileIdentity || digest(fs.readFileSync(this.binding.helperPath)) !== this.binding.helperSha256)) throw new Error('native_host_helper_file_identity_changed');
      if (fs.existsSync(this.journal)) {
        const stat = fs.lstatSync(this.journal);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('native_host_lease_untrusted');
        const value = JSON.parse(fs.readFileSync(this.journal, 'utf8')) as LeaseState;
        if (value.schema !== 1 || value.endpoint !== this.endpoint || !Number.isSafeInteger(value.epoch) || value.epoch < 0 ||
            typeof value.held !== 'boolean' || (value.held ? typeof value.owner !== 'string' || typeof value.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.tokenHash) : value.owner !== null || value.tokenHash !== null)) throw new Error('native_host_lease_corrupt');
        this.state = value;
      } else {
        if (priorLock) throw new Error('native_host_lease_journal_missing');
        this.persist(this.state);
      }
    } catch (error) { await this.close(); throw error; }
  }
  private fileIdentity(): string {
    const s=fs.lstatSync(this.binding.helperPath);
    return JSON.stringify([s.dev,s.ino,s.uid,s.mode,s.size]);
  }
  private persist(value: LeaseState): void {
    const tmp = `${this.journal}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, this.journal);
      const dir = fs.openSync(this.binding.stateDir, 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      this.state = value;
    } catch (error) {
      // Rename may already have committed: forbid every operation until restart reloads it.
      this.poisoned = true;
      throw error;
    }
  }
  assertHealthy(): void {
    if (this.binding.helperFileIdentity && this.fileIdentity() !== this.binding.helperFileIdentity) throw new Error('native_host_helper_file_identity_changed');
    if (!this.healthy || this.child?.exitCode !== null || this.child?.signalCode !== null || this.poisoned) throw new Error('native_host_lock_or_storage_unavailable');
  }
  assertMutable(): void {
    this.assertHealthy();
    if (this.state.held) throw new Error('native_host_idle_lease_held');
  }
  proof() {
    this.assertHealthy();
    return { bootId: this.bootId, pid: process.pid, endpoint: this.endpoint, epoch: this.state.epoch, held: this.state.held, owner: this.state.owner };
  }
  private validate(request: HostLeaseRequest): void {
    this.assertHealthy();
    if (request.bootId !== this.bootId || request.epoch !== this.state.epoch || !Number.isSafeInteger(request.epoch) ||
        typeof request.owner !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(request.owner) || typeof request.token !== 'string' || !/^[a-f0-9]{64}$/.test(request.token)) throw new Error('native_host_lease_identity_mismatch');
  }
  acquire(request: HostLeaseRequest, idle: boolean) {
    this.validate(request);
    if (this.state.held) {
      if (this.state.owner !== request.owner || this.state.tokenHash !== digest(request.token)) throw new Error('native_host_lease_owned');
      return this.proof(); // Lost acquire ACK / authenticated reattach after host restart.
    }
    if (!idle) throw new Error('native_host_not_proven_idle');
    this.persist({ ...this.state, held: true, owner: request.owner, tokenHash: digest(request.token) });
    return this.proof();
  }
  release(request: HostLeaseRequest) {
    this.validate(request);
    if (!this.state.held || this.state.owner !== request.owner || this.state.tokenHash !== digest(request.token)) throw new Error('native_host_lease_owned');
    this.persist({ ...this.state, epoch: this.state.epoch + 1, held: false, owner: null, tokenHash: null });
    return this.proof();
  }
  async close(): Promise<void> {
    this.healthy = false;
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.stdin.end(); });
  }
}
