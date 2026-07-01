import * as childProcess from 'child_process';
import {
  createManagedSessionHost,
  listHostedCliRuntimes as listSharedHostedCliRuntimes,
  resolveSessionHostAppNameResolution,
  type SessionHostEndpoint,
} from '@adhdev/daemon-core';
import { DEFAULT_SESSION_HOST_READY_TIMEOUT_MS } from '../../daemon-core/src/runtime-defaults.js';
const SESSION_HOST_APP_NAME_RESOLUTION = resolveSessionHostAppNameResolution({ standalone: true });
const SESSION_HOST_APP_NAME = SESSION_HOST_APP_NAME_RESOLUTION.appName;
const SESSION_HOST_START_TIMEOUT_MS = DEFAULT_SESSION_HOST_READY_TIMEOUT_MS;

// Shared managed-host helpers (env/pidfile/kill/spawn/ensureReady). Standalone keeps
// stdio='ignore' spawns and kills pidfile-tracked processes unconditionally, matching
// the prior local implementation exactly.
const managedHost = createManagedSessionHost({
  appName: SESSION_HOST_APP_NAME,
  requiredRequestTypes: ['delete_session', 'get_terminal_snapshot'],
  timeoutMs: SESSION_HOST_START_TIMEOUT_MS,
  spawnStdio: 'ignore',
});

export function getStandaloneSessionHostAppName(): string {
  return SESSION_HOST_APP_NAME;
}

export function getStandaloneSessionHostAppNameWarning(): string | undefined {
  return SESSION_HOST_APP_NAME_RESOLUTION.warning;
}

function resolveSessionHostEntry(): string {
  return managedHost.resolveEntry();
}

function buildSessionHostEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return managedHost.buildEnv(baseEnv);
}

export function stopManagedSessionHostProcess(): boolean {
  return managedHost.stopManagedSessionHostProcess();
}

export function stopSessionHost(): boolean {
  return stopManagedSessionHostProcess();
}

async function runSessionHostCli(args: string[]): Promise<number> {
  const entry = resolveSessionHostEntry();
  const child = childProcess.spawn(process.execPath, [entry, ...args], {
    stdio: 'inherit',
    env: buildSessionHostEnv(process.env),
  });
  return await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

export async function ensureSessionHostReady(): Promise<SessionHostEndpoint> {
  return managedHost.ensureReady();
}

export async function listHostedCliRuntimes(endpoint: SessionHostEndpoint) {
  return listSharedHostedCliRuntimes(endpoint);
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
