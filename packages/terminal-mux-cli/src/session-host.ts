import { spawn } from 'child_process';
import {
  getDefaultSessionHostEndpoint,
  resolveInstanceConfigDir,
  resolveSessionHostIpcKey,
  SessionHostClient,
} from '@adhdev/session-host-core';
import { SESSION_HOST_APP_NAME, STARTUP_POLL_MS, STARTUP_TIMEOUT_MS } from './constants.js';

// The mux CLI must target the SAME instance namespace as the daemon that
// launched it: the endpoint derives from the inherited ADHDEV_CONFIG_DIR
// (pinned by the session-host parent), and a spawned host gets the pinned
// identity back via env. Default instance → legacy un-suffixed endpoint.
function getInstanceSessionHostEndpoint() {
  return getDefaultSessionHostEndpoint(SESSION_HOST_APP_NAME, {
    ipcKey: resolveSessionHostIpcKey(resolveInstanceConfigDir(process.env)),
  });
}

async function canConnect(): Promise<boolean> {
  const client = new SessionHostClient({ endpoint: getInstanceSessionHostEndpoint() });
  try {
    await client.connect();
    await client.close();
    return true;
  } catch {
    return false;
  }
}

async function waitForSessionHostReady(timeoutMs = STARTUP_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect()) return;
    await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_MS));
  }
  throw new Error(`Session host did not become ready within ${timeoutMs}ms`);
}

function resolveSessionHostEntry(): string {
  return require.resolve('@adhdev/session-host-daemon');
}

export async function ensureSessionHostReady(): Promise<void> {
  if (await canConnect()) return;
  const entry = resolveSessionHostEntry();
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      ADHDEV_SESSION_HOST_NAME: SESSION_HOST_APP_NAME,
      ADHDEV_CONFIG_DIR: resolveInstanceConfigDir(process.env),
    },
  });
  child.unref();
  await waitForSessionHostReady();
}
