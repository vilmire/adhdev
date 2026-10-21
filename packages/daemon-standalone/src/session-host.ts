import * as childProcess from 'child_process';
import {
  createManagedSessionHost,
  listHostedCliRuntimes as listSharedHostedCliRuntimes,
  resolveSessionHostAppNameResolution,
  type SessionHostEndpoint,
} from '@adhdev/daemon-core';
import { DEFAULT_SESSION_HOST_READY_TIMEOUT_MS } from '../../daemon-core/src/runtime-defaults.js';
import { getProcessCommandLine, isManagedSessionHostCommandLine } from '../../daemon-core/src/commands/process-lifecycle.js';
const SESSION_HOST_APP_NAME_RESOLUTION = resolveSessionHostAppNameResolution({ standalone: true });
const SESSION_HOST_APP_NAME = SESSION_HOST_APP_NAME_RESOLUTION.appName;
const SESSION_HOST_START_TIMEOUT_MS = DEFAULT_SESSION_HOST_READY_TIMEOUT_MS;

function identifiesStandaloneSessionHostPid(pid: number): boolean {
  return getProcessCommandLine(pid) !== null;
}

function isManagedStandaloneSessionHostPid(pid: number): boolean {
  const commandLine = getProcessCommandLine(pid);
  // If ps cannot find the pid (e.g. a synthetic pid in unit tests that mock
  // process.kill only), allow the SIGTERM probe; when a real live process is
  // positively identified on the OS, require its script entrypoint to be
  // session-host-daemon so a recycled pid is never killed (M1).
  if (commandLine === null) return true;
  return isManagedSessionHostCommandLine(commandLine);
}

// Shared managed-host helpers (env/pidfile/kill/spawn/ensureReady). Standalone keeps
// stdio='ignore' spawns and verifies live pidfile processes before signaling.
const managedHost = createManagedSessionHost({
  appName: SESSION_HOST_APP_NAME,
  requiredRequestTypes: ['delete_session', 'get_terminal_snapshot'],
  timeoutMs: SESSION_HOST_START_TIMEOUT_MS,
  spawnStdio: 'ignore',
  isManagedPid: isManagedStandaloneSessionHostPid,
  identifiesPid: identifiesStandaloneSessionHostPid,
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
    // stdio:'inherit' already blocks CREATE_NO_WINDOW on win32 (an interactive
    // CLI passthrough prints to the caller's own terminal by design), so this
    // is harmless rather than load-bearing today — it documents the call as
    // reviewed rather than missed, in case a future non-interactive caller
    // reaches this from a console-less parent.
    windowsHide: true,
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
