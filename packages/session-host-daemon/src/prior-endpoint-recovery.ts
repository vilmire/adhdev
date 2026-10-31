import * as fs from 'fs';
import * as path from 'node:path';
import type { SessionHostEndpoint } from '@adhdev/session-host-core';
import type { HostInstanceLock } from './host-instance-lock.js';
import type { HostUpgradeLease } from './upgrade-lease.js';
import { assertOrphanUnixSocket } from './socket-probe.js';

interface PriorEndpointRecoveryContext {
  readonly endpoint: SessionHostEndpoint;
  readonly instanceConfigDir: string | null;
  readonly pidFilePath: string | null;
  readonly upgradeLease: HostUpgradeLease | null;
  getInstanceLock(): HostInstanceLock | null;
  assertNoAutomaticReplacementContext(): void;
  readProcessBirth(pid: number): string | null;
  isPidAlive(pid: number): boolean;
  readSocketOwnerPids(): number[] | null;
  setStartupFence(fence: () => void): void;
  startupFence(): void;
}

/** Prove the prior incarnation is gone before reclaiming its endpoint. */
export async function evictPriorEndpointOwners(context: PriorEndpointRecoveryContext): Promise<void> {
  context.assertNoAutomaticReplacementContext();
  if (context.endpoint.kind !== 'unix') return;
  const identity = (file: string): string => {
    try {
      const stat = fs.lstatSync(file, { bigint: true });
      return `${stat.dev}:${stat.ino}:${stat.mode}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw error;
    }
  };
  const configIdentity = context.instanceConfigDir ? identity(context.instanceConfigDir) : null;
  const endpointParent = fs.realpathSync(path.dirname(context.endpoint.path));
  const initialEndpoint = identity(context.endpoint.path);
  const readPid = (): string => {
    if (!context.pidFilePath) return 'missing';
    try {
      const raw = fs.readFileSync(context.pidFilePath, 'utf8').trim();
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0) {
        return 'corrupt'; // identifies no owner; handled like 'missing'
      }
      return raw;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw error;
    }
  };
  const initialPid = readPid();
  const hasPid = (value: string): boolean => value !== 'missing' && value !== 'corrupt';
  const initialBirth = hasPid(initialPid) ? context.readProcessBirth(Number(initialPid)) : null;
  const reclaimed = context.getInstanceLock()?.reclaimedPid;
  const reusedPid = !!reclaimed && reclaimed.pid === Number(initialPid) && reclaimed.birth === initialBirth;
  const assertReclaimedIncarnation = (): boolean => {
    if (!reusedPid || !reclaimed || context.readProcessBirth(reclaimed.pid) !== reclaimed.birth) return false;
    try { process.kill(reclaimed.pid, 0); return true; } catch { return false; }
  };
  const assertGeneration = (expectedEndpoint: string): void => {
    context.assertNoAutomaticReplacementContext();
    context.getInstanceLock()?.assertOwned();
    const currentPid = readPid();
    const [birth, alive] = hasPid(initialPid)
      ? [context.readProcessBirth(Number(initialPid)), context.isPidAlive(Number(initialPid))] : [null, false];
    if (currentPid !== initialPid || birth !== initialBirth || (alive && !assertReclaimedIncarnation())
        || (context.instanceConfigDir && identity(context.instanceConfigDir) !== configIdentity)
        || fs.realpathSync(path.dirname(context.endpoint.path)) !== endpointParent
        || identity(context.endpoint.path) !== expectedEndpoint || readPid() !== initialPid) {
      throw new Error('session_host_endpoint_changed_during_recovery');
    }
    context.assertNoAutomaticReplacementContext();
  };
  if (hasPid(initialPid) && context.isPidAlive(Number(initialPid)) && !assertReclaimedIncarnation()) {
    throw new Error('session_host_live_owner_replacement_unauthorized');
  }
  if (initialEndpoint !== 'missing') {
    if (context.upgradeLease) throw new Error('native_host_endpoint_owner_unproved');
    // No usable PID + existing endpoint is UNKNOWN unless it is a real socket node AND
    // connect yields ECONNREFUSED; a connect that succeeds or hangs means a live/wedged host.
    if (!hasPid(initialPid) || reusedPid) {
      await assertOrphanUnixSocket(context.endpoint.path);
      assertGeneration(initialEndpoint);
    }
    for (let check = 0; check < 2; check++) {
      const owners = context.readSocketOwnerPids();
      if (owners === null) throw new Error('session_host_prior_owner_socket_unverified');
      if (owners.length !== 0) throw new Error('session_host_endpoint_changed_during_recovery');
      assertGeneration(initialEndpoint);
    }
    fs.unlinkSync(context.endpoint.path);
  }
  // start() awaits this method; recheck the same generation after that seam
  // and immediately before helper/createServer/listen effects.
  context.setStartupFence(() => assertGeneration('missing'));
  context.startupFence();
}
