import * as fs from 'fs';
import * as net from 'net';
import { execFileSync } from 'child_process';

export type UnixSocketProbeResult = 'refused' | 'absent' | 'connected' | 'timeout' | 'error';

/**
 * Connect-probe a unix socket path. Only 'refused' (ECONNREFUSED: socket file
 * with no listener) and 'absent' (ENOENT) prove nobody serves it; a successful
 * connect or a hang (backlog full / wedged accept loop) must be treated as a
 * live host by callers.
 */
export function probeUnixSocket(socketPath: string, timeoutMs = 1_500): Promise<UnixSocketProbeResult> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    let settled = false;
    const done = (result: UnixSocketProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done('timeout'), timeoutMs);
    socket.once('connect', () => done('connected'));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      done(error.code === 'ECONNREFUSED' ? 'refused' : error.code === 'ENOENT' ? 'absent' : 'error');
    });
  });
}

/** Throws unless `socketPath` is a real socket node with no listener (ECONNREFUSED). */
export async function assertOrphanUnixSocket(socketPath: string): Promise<void> {
  if (!fs.lstatSync(socketPath).isSocket() || await probeUnixSocket(socketPath) !== 'refused') {
    throw new Error('session_host_prior_owner_socket_unverified');
  }
}

/** Pids holding `socketPath` open via lsof; [] when none/absent/win32, null when unprovable. */
export function lsofSocketOwnerPids(socketPath: string): number[] | null {
  if (process.platform === 'win32' || !fs.existsSync(socketPath)) return [];
  const lsofBin = process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof';
  try {
    // IMPORTANT (C1): never pass `-U` without `-a` — lsof ORs selectors by default,
    // which would enumerate every unix-socket process on the machine. Passing only
    // the file path `-- <path>` restricts lsof to this exact socket file.
    const out = String(
      execFileSync(lsofBin, ['-n', '-t', '--', socketPath], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2_000,
        windowsHide: true,
      }),
    );
    const pids: number[] = [];
    for (const line of out.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!/^\d+$/.test(trimmed)) return null;
      const pid = Number.parseInt(trimmed, 10);
      if (!Number.isSafeInteger(pid) || pid <= 0) return null;
      pids.push(pid);
    }
    return pids;
  } catch (error: any) {
    if (error?.status === 1 && String(error?.stdout ?? '').trim() === '') return [];
    return null;
  }
}
