import * as fs from 'fs';
import * as net from 'net';

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
