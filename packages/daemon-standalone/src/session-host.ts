import { spawn } from 'child_process';
import {
  SessionHostClient,
  getDefaultSessionHostEndpoint,
  type SessionHostEndpoint,
  type SessionHostRecord,
} from '@adhdev/session-host-core';
import type { HostedCliRuntimeDescriptor } from '@adhdev/daemon-core';

const STARTUP_TIMEOUT_MS = 8000;
const STARTUP_POLL_MS = 200;
const SESSION_HOST_APP_NAME = process.env.ADHDEV_SESSION_HOST_NAME || 'adhdev';

async function canConnect(endpoint: SessionHostEndpoint): Promise<boolean> {
  const client = new SessionHostClient({ endpoint });
  try {
    await client.connect();
    await client.close();
    return true;
  } catch {
    return false;
  }
}

async function waitForReady(endpoint: SessionHostEndpoint, timeoutMs = STARTUP_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(endpoint)) return;
    await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_MS));
  }
  throw new Error(`Session host did not become ready within ${timeoutMs}ms`);
}

function resolveSessionHostEntry(): string {
  return require.resolve('@adhdev/session-host-daemon');
}

async function runSessionHostCli(args: string[]): Promise<number> {
  const entry = resolveSessionHostEntry();
  const child = spawn(process.execPath, [entry, ...args], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ADHDEV_SESSION_HOST_NAME: SESSION_HOST_APP_NAME,
    },
  });
  return await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

export async function ensureSessionHostReady(): Promise<SessionHostEndpoint> {
  const endpoint = getDefaultSessionHostEndpoint(SESSION_HOST_APP_NAME);
  if (await canConnect(endpoint)) return endpoint;

  const entry = resolveSessionHostEntry();
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  await waitForReady(endpoint);
  return endpoint;
}

export async function listHostedCliRuntimes(endpoint: SessionHostEndpoint): Promise<HostedCliRuntimeDescriptor[]> {
  const client = new SessionHostClient({ endpoint });
  try {
    const response = await client.request<SessionHostRecord[]>({
      type: 'list_sessions',
      payload: {},
    });
    if (!response.success || !response.result) {
      return [];
    }
    return response.result
      .filter((record) => record.category === 'cli' && ['running', 'interrupted'].includes(record.lifecycle))
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .map((record) => ({
        runtimeId: record.sessionId,
        runtimeKey: record.runtimeKey,
        displayName: record.displayName,
        workspaceLabel: record.workspaceLabel,
        lifecycle: record.lifecycle,
        recoveryState: typeof record.meta?.runtimeRecoveryState === 'string' ? String(record.meta.runtimeRecoveryState) : null,
        cliType: record.providerType,
        workspace: record.workspace,
        cliArgs: Array.isArray(record.meta?.cliArgs) ? (record.meta.cliArgs as string[]) : [],
      }));
  } finally {
    await client.close().catch(() => {});
  }
}

export async function proxySessionHostList(showAll = false): Promise<number> {
  await ensureSessionHostReady();
  return runSessionHostCli(['list', ...(showAll ? ['--all'] : [])]);
}

export async function proxySessionHostAttach(
  target: string,
  options: { readOnly?: boolean; takeover?: boolean } = {},
): Promise<number> {
  await ensureSessionHostReady();
  const args = ['attach', target];
  if (options.readOnly) args.push('--read-only');
  if (options.takeover) args.push('--takeover');
  return runSessionHostCli(args);
}
