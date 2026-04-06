#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const pidFile = path.join(repoRoot, '.adhdev-dev-pids.json');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const specs = [
  {
    name: 'daemon',
    color: '\x1b[34m',
    args: ['run', 'dev:daemon'],
    port: 3847,
  },
  {
    name: 'web',
    color: '\x1b[32m',
    args: ['run', 'dev:web'],
    port: 3000,
  },
];

const children = new Map();
let shuttingDown = false;

function log(line = '') {
  process.stdout.write(`${line}\n`);
}

function label(name, color, text) {
  const reset = '\x1b[0m';
  return `${color}[${name}]${reset} ${text}`;
}

function writePidFile() {
  const payload = {
    pid: process.pid,
    children: Array.from(children.entries()).map(([name, child]) => ({
      name,
      pid: child.pid ?? null,
    })),
  };
  fs.writeFileSync(pidFile, JSON.stringify(payload, null, 2));
}

function removePidFile() {
  try {
    fs.unlinkSync(pidFile);
  } catch {}
}

function processExists(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function terminatePid(pid) {
  if (!processExists(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {}
  for (let i = 0; i < 20; i += 1) {
    if (!processExists(pid)) return;
    await delay(100);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
}

async function cleanupPreviousRun() {
  if (!fs.existsSync(pidFile)) return;
  try {
    const data = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    const pids = Array.isArray(data?.children)
      ? data.children.map((entry) => entry?.pid).filter(Boolean)
      : [];
    if (pids.length > 0) {
      log('Cleaning up previous dev processes...');
    }
    for (const pid of pids) {
      await terminatePid(pid);
    }
  } catch (error) {
    log(`Warning: failed to clean previous dev processes: ${error instanceof Error ? error.message : String(error)}`);
  }
  removePidFile();
}

function forwardStream(spec, stream) {
  const rl = readline.createInterface({ input: stream });
  rl.on('line', (line) => {
    log(label(spec.name, spec.color, line));
  });
}

function describeFailure(spec, code, signal) {
  if (spec.name === 'daemon') {
    return `Standalone daemon failed. Port ${spec.port} may already be in use; stop the existing process and retry.`;
  }
  if (spec.name === 'web') {
    return `Vite failed. Port ${spec.port} may already be in use; stop the existing process and retry.`;
  }
  return `${spec.name} exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}.`;
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  removePidFile();
  const running = Array.from(children.values());
  for (const child of running) {
    if (child.pid && processExists(child.pid)) {
      try {
        child.kill('SIGTERM');
      } catch {}
    }
  }
  await delay(250);
  for (const child of running) {
    if (child.pid && processExists(child.pid)) {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
  }
  process.exit(exitCode);
}

async function main() {
  await cleanupPreviousRun();

  for (const spec of specs) {
    const child = spawn(npmCmd, spec.args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    children.set(spec.name, child);
    writePidFile();
    forwardStream(spec, child.stdout);
    forwardStream(spec, child.stderr);
    child.on('exit', async (code, signal) => {
      if (shuttingDown) return;
      log('');
      log(describeFailure(spec, code, signal));
      await shutdown(code === 0 ? 1 : (code ?? 1));
    });
  }

  log('');
  log(`ADHDev dev runner started on ${os.hostname()}.`);
  log('Expected ports: web 3000, standalone 3847.');
  log('Press Ctrl+C to stop both processes.');
}

process.on('SIGINT', async () => {
  await shutdown(0);
});

process.on('SIGTERM', async () => {
  await shutdown(0);
});

main().catch(async (error) => {
  log(error instanceof Error ? error.stack || error.message : String(error));
  await shutdown(1);
});
