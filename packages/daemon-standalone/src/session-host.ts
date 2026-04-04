import { spawn } from 'child_process';
import * as path from 'path';
import {
  ensureSessionHostReady as ensureSharedSessionHostReady,
  listHostedCliRuntimes as listSharedHostedCliRuntimes,
  type SessionHostEndpoint,
} from '@adhdev/daemon-core';
const SESSION_HOST_APP_NAME = process.env.ADHDEV_SESSION_HOST_NAME || 'adhdev';

function buildSessionHostEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value !== 'string') continue;
    env[key] = value;
  }

  for (const key of Object.keys(env)) {
    if (
      key === 'INIT_CWD'
      || key === 'NO_COLOR'
      || key === 'FORCE_COLOR'
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

  env.ADHDEV_SESSION_HOST_NAME = SESSION_HOST_APP_NAME;
  return env;
}

function resolveSessionHostEntry(): string {
  const localCandidates = [
    path.resolve(__dirname, '../vendor/session-host-daemon/index.js'),
    path.resolve(__dirname, '../../vendor/session-host-daemon/index.js'),
  ];
  for (const candidate of localCandidates) {
    if (require('fs').existsSync(candidate)) {
      return candidate;
    }
  }
  return require.resolve('@adhdev/session-host-daemon');
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
  return ensureSharedSessionHostReady({
    appName: SESSION_HOST_APP_NAME,
    spawnHost: () => {
      const entry = resolveSessionHostEntry();
      const child = spawn(process.execPath, [entry], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: buildSessionHostEnv(process.env),
      });
      child.unref();
    },
  });
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
