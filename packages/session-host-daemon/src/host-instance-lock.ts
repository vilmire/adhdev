import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Exclusive per-instance session-host lock.
 *
 * The unix socket path derives from `os.tmpdir()` and the endpoint/pidfile
 * checks are read-then-act, with the pidfile written only AFTER listen(). Two
 * hosts started in the same window (daemon boot racing an upgrade restart, or
 * processes whose TMPDIR differs) can therefore both see "no owner", bind
 * different sockets, and serve side by side. This lock is keyed by the
 * instance's pidfile path (config dir + app name) — the one identity every
 * start path shares — and is taken with an atomic mkdir before any endpoint
 * effect. It is held for the whole life of the host and is reclaimed only on
 * positive proof the holder is gone (ESRCH, or a live pid whose native start
 * time no longer matches the recorded one). Unknown liveness fails closed.
 * Same mkdir-lock + owner-record + reclaim-guard shape as
 * daemon-core launch-defaults/owned-lock.ts (not importable: dependency direction).
 */
export const HOST_LOCK_OWNERLESS_STALE_MS = 60_000;
const OWNER_FILE = 'owner.json';

interface LockOwner { pid: number; nonce: string; birth: string | null; acquiredAt: number }
export interface HostInstanceLockOptions {
  lockPath: string;
  isPidAlive?: (pid: number) => boolean;
  readBirth?: (pid: number) => string | null;
  now?: () => number;
}
export interface HostInstanceLock { readonly lockPath: string; release(): void }

export class HostInstanceLockedError extends Error {
  constructor(readonly lockPath: string, detail: string) {
    super(`session_host_instance_locked: ${detail} (${lockPath})`);
    this.name = 'HostInstanceLockedError';
  }
}

export function defaultReadBirth(pid: number): string | null {
  if (process.platform === 'win32') return null;
  try {
    return String(execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2_000, windowsHide: true,
    })).trim() || null;
  } catch { return null; }
}

function defaultIsPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

type Observed = { kind: 'owner'; owner: LockOwner } | { kind: 'ownerless'; mtimeMs: number } | { kind: 'gone' };

function observe(lock: string): Observed {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(lock, OWNER_FILE), 'utf8')) as Partial<LockOwner>;
    if (v && Number.isSafeInteger(v.pid) && (v.pid as number) > 0 && typeof v.nonce === 'string' && v.nonce) {
      return { kind: 'owner', owner: { pid: v.pid as number, nonce: v.nonce, acquiredAt: Number(v.acquiredAt) || 0,
        birth: typeof v.birth === 'string' && v.birth ? v.birth : null } };
    }
  } catch { /* absent or torn: fall back to directory age */ }
  try { return { kind: 'ownerless', mtimeMs: fs.statSync(lock).mtimeMs }; }
  catch { return { kind: 'gone' }; }
}

export function acquireHostInstanceLock(options: HostInstanceLockOptions): HostInstanceLock {
  const { lockPath } = options;
  const alive = options.isPidAlive ?? defaultIsPidAlive;
  const readBirth = options.readBirth ?? defaultReadBirth;
  const now = options.now ?? Date.now;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const provenGone = (o: Observed): boolean => {
    if (o.kind === 'gone') return true;
    if (o.kind === 'ownerless') return now() - o.mtimeMs >= HOST_LOCK_OWNERLESS_STALE_MS;
    if (o.owner.pid === process.pid) return false; // never reclaim from ourselves
    if (!alive(o.owner.pid)) return true;
    const current = o.owner.birth ? readBirth(o.owner.pid) : null;
    return !!(o.owner.birth && current && current !== o.owner.birth); // pid reuse
  };

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const seen = observe(lockPath);
      if (!provenGone(seen)) {
        const who = seen.kind === 'owner' ? `held by live pid ${seen.owner.pid}` : 'owner record not yet written';
        throw new HostInstanceLockedError(lockPath, who);
      }
      const guard = `${lockPath}.reclaim`;
      try { fs.mkdirSync(guard, { mode: 0o700 }); }
      catch { throw new HostInstanceLockedError(lockPath, 'reclaim already in progress'); }
      try {
        const again = observe(lockPath);
        const same = again.kind === 'gone' || (seen.kind === 'owner' && again.kind === 'owner' && seen.owner.nonce === again.owner.nonce)
          || (seen.kind === 'ownerless' && again.kind === 'ownerless');
        if (!same || !provenGone(again)) throw new HostInstanceLockedError(lockPath, 'lock changed during reclaim');
        try { fs.unlinkSync(path.join(lockPath, OWNER_FILE)); } catch { /* ownerless */ }
        try { fs.rmdirSync(lockPath); } catch { /* retry mkdir decides */ }
      } finally {
        try { fs.rmdirSync(guard); } catch { /* left for operator; acquisition names it */ }
      }
      continue;
    }
    const owner: LockOwner = { pid: process.pid, nonce: randomUUID(), birth: readBirth(process.pid), acquiredAt: now() };
    try { fs.writeFileSync(path.join(lockPath, OWNER_FILE), JSON.stringify(owner), { mode: 0o600 }); }
    catch (error) { try { fs.rmdirSync(lockPath); } catch { /* noop */ } throw error; }
    return {
      lockPath,
      release() {
        const current = observe(lockPath);
        if (current.kind !== 'owner' || current.owner.nonce !== owner.nonce) return;
        try { fs.unlinkSync(path.join(lockPath, OWNER_FILE)); } catch { /* noop */ }
        try { fs.rmdirSync(lockPath); } catch { /* noop */ }
      },
    };
  }
  throw new HostInstanceLockedError(lockPath, 'could not acquire after reclaim attempts');
}
