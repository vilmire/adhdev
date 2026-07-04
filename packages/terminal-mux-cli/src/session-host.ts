import { spawn } from 'child_process';
import { getDefaultSessionHostEndpoint, SessionHostClient } from '@adhdev/session-host-core';
import { SESSION_HOST_APP_NAME, STARTUP_POLL_MS, STARTUP_TIMEOUT_MS } from './constants.js';

async function canConnect(): Promise<boolean> {
  const client = new SessionHostClient({ endpoint: getDefaultSessionHostEndpoint(SESSION_HOST_APP_NAME) });
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
    },
  });
  child.unref();
  await waitForSessionHostReady();
}
