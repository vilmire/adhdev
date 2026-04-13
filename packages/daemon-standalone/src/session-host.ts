import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ensureSessionHostReady as ensureSharedSessionHostReady,
  listHostedCliRuntimes as listSharedHostedCliRuntimes,
  resolveSessionHostAppName,
  type SessionHostEndpoint,
} from '@adhdev/daemon-core';
const SESSION_HOST_APP_NAME = resolveSessionHostAppName({ standalone: true });
const SESSION_HOST_START_TIMEOUT_MS = 15_000;

export function getStandaloneSessionHostAppName(): string {
  return SESSION_HOST_APP_NAME;
}

function buildSessionHostEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value !== 'string') continue;
    env[key] = value;
  }

  for (const key of Object.keys(env)) {
    if (
      key === 'INIT_CWD'
      || key === 'npm_command'
      || key === 'npm_execpath'
      || key === 'npm_node_execpath'
      || key.startsWith('npm_')
      || key.startsWith('npm_config_')
      || key.startsWith('npm_package_')
      || key.startsWith('npm_lifecycle_')
      || key.startsWith('PNPM_')
      || key.startsWith('YARN_')
      || key.startsWith('BUN_')
    ) {
      delete env[key];
    }
  }

  if (!env.NO_COLOR) {
    if (!env.TERM || env.TERM === 'xterm-color') env.TERM = 'xterm-256color';
    if (!env.COLORTERM) env.COLORTERM = 'truecolor';
    if (process.platform === 'win32') {
      if (!env.FORCE_COLOR) env.FORCE_COLOR = '1';
      if (!env.CLICOLOR) env.CLICOLOR = '1';
    }
  }

  env.ADHDEV_SESSION_HOST_NAME = SESSION_HOST_APP_NAME;
  return env;
}

function resolveSessionHostEntry(): string {
  const localCandidates = [
    path.resolve(__dirname, '../vendor/session-host-daemon/index.js'),
    path.resolve(__dirname, '../../vendor/session-host-daemon/index.js'),
  ];
  for (const candidate of localCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return require.resolve('@adhdev/session-host-daemon');
}

function getSessionHostPidFile(): string {
  return path.join(os.homedir(), '.adhdev', `${SESSION_HOST_APP_NAME}-session-host.pid`);
}

function killPid(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
    return true;
  } catch {
    return false;
  }
}

export function stopSessionHost(): boolean {
  let stopped = false;
  const pidFile = getSessionHostPidFile();
  try {
    if (fs.existsSync(pidFile)) {
      const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (Number.isFinite(pid)) {
        stopped = killPid(pid) || stopped;
      }
    }
  } catch {
    // noop
  } finally {
    try {
      fs.unlinkSync(pidFile);
    } catch {
      // noop
    }
  }

  if (process.platform !== 'win32') {
    try {
      const raw = execFileSync('pgrep', ['-f', 'session-host-daemon'], { encoding: 'utf8' }).trim();
      for (const line of raw.split('\n')) {
        const pid = Number.parseInt(line.trim(), 10);
        if (Number.isFinite(pid)) {
          stopped = killPid(pid) || stopped;
        }
      }
    } catch {
      // noop
    }
  }

  return stopped;
}

async function runSessionHostCli(args: string[]): Promise<number> {
  const entry = resolveSessionHostEntry();
  const child = spawn(process.execPath, [entry, ...args], {
    stdio: 'inherit',
    env: buildSessionHostEnv(process.env),
  });
  return await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

export async function ensureSessionHostReady(): Promise<SessionHostEndpoint> {
  const spawnHost = () => {
    const entry = resolveSessionHostEntry();
    const child = spawn(process.execPath, [entry], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: buildSessionHostEnv(process.env),
    });
    child.unref();
  };

  try {
    return await ensureSharedSessionHostReady({
      appName: SESSION_HOST_APP_NAME,
      spawnHost,
      timeoutMs: SESSION_HOST_START_TIMEOUT_MS,
    });
  } catch (error) {
    stopSessionHost();
    return ensureSharedSessionHostReady({
      appName: SESSION_HOST_APP_NAME,
      spawnHost,
      timeoutMs: SESSION_HOST_START_TIMEOUT_MS,
    }).catch((retryError) => {
      const initialMessage = error instanceof Error ? error.message : String(error);
      const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
      throw new Error(`Session host failed to start after retry (${initialMessage}; retry: ${retryMessage})`);
    });
  }
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
