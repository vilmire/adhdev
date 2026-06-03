#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const pidFile = path.join(repoRoot, '.adhdev-dev-pids.json');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const daemonCoreDistEntry = path.join(repoRoot, 'packages/daemon-core/dist/index.js');

// daemon-standalone imports `@adhdev/daemon-core` whose package.json points at
// dist/. tsx running the standalone src/ does NOT re-transpile daemon-core —
// it loads the prebuilt dist. So when daemon-core src changes, the daemon
// process keeps running the stale dist until rebuilt and restarted.
//
// To prevent silent staleness during dev:
//   1. Prebuild daemon-core synchronously before launching daemon (first run)
//   2. Run `npm run dev -w packages/daemon-core` (tsup --watch) so src edits
//      rebuild dist incrementally
//   3. Watch dist/index.js mtime; when it changes, restart the daemon child
//      so the new dist is loaded
const specs = [
  {
    name: 'core',
    color: '\x1b[35m',
    args: ['run', 'dev', '-w', 'packages/daemon-core'],
    port: null,
  },
  {
    name: 'daemon',
    color: '\x1b[34m',
    args: ['run', 'dev:daemon'],
    port: 3847,
    restartOnDistChange: true,
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

function startChild(spec) {
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
    // If this child is marked as restartable (e.g. daemon after dist rebuild)
    // and we triggered its termination, don't bring the whole runner down.
    if (child.__restarting) {
      child.__restarting = false;
      log(label(spec.name, spec.color, 'restarting after daemon-core rebuild...'));
      startChild(spec);
      return;
    }
    log('');
    log(describeFailure(spec, code, signal));
    await shutdown(code === 0 ? 1 : (code ?? 1));
  });
  return child;
}

function prebuildDaemonCore() {
  // tsx loads @adhdev/daemon-core from dist/. If dist is missing, the daemon
  // start will fail before the watcher can produce it. Build once synchronously
  // so the first daemon launch is guaranteed to find a current dist.
  log(label('core', '\x1b[35m', 'prebuilding daemon-core dist (first run)...'));
  const result = spawnSync(npmCmd, ['run', 'build', '-w', 'packages/daemon-core'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    log('ERROR: daemon-core prebuild failed. Cannot start daemon with stale dist.');
    process.exit(result.status ?? 1);
  }
}

async function computeDistHash() {
  try {
    const crypto = await import('node:crypto');
    const buf = fs.readFileSync(daemonCoreDistEntry);
    return crypto.createHash('sha1').update(buf).digest('hex');
  } catch { return null; }
}

function watchDaemonCoreDist() {
  if (!fs.existsSync(daemonCoreDistEntry)) return;
  let lastHash = null;
  let restartTimer = null;
  // Seed the hash so the very first burst (initial tsup write) doesn't
  // restart the freshly spawned daemon.
  computeDistHash().then(h => { lastHash = h; });

  fs.watch(path.dirname(daemonCoreDistEntry), { recursive: true }, () => {
    if (shuttingDown) return;
    if (restartTimer) clearTimeout(restartTimer);
    // Debounce: tsup writes multiple files; wait for the burst to settle.
    restartTimer = setTimeout(async () => {
      // Restart only when content actually changed. IDE auto-format / save
      // can re-touch the src and make tsup rewrite identical bytes, which
      // would otherwise kill any sessions the user is in the middle of.
      const hash = await computeDistHash();
      if (!hash) return;
      if (lastHash !== null && hash === lastHash) return;
      lastHash = hash;
      const daemonSpec = specs.find(s => s.restartOnDistChange);
      const child = daemonSpec && children.get(daemonSpec.name);
      if (!child || !child.pid || !processExists(child.pid)) return;
      log(label('core', '\x1b[35m', 'daemon-core dist changed — restarting daemon...'));
      child.__restarting = true;
      try { child.kill('SIGTERM'); } catch {}
    }, 400);
  });
}

async function main() {
  await cleanupPreviousRun();

  // ALWAYS prebuild daemon-core. The tsup --watch process below clears dist/
  // ("Cleaning output folder") before its first build emits anything; if the
  // daemon child started concurrently it would race that clean and crash on
  // missing dist/index.js. Prebuilding before spawning anything guarantees a
  // stable dist on disk when the daemon starts.
  prebuildDaemonCore();

  // Start the watcher (core) first. We don't strictly need to await its first
  // rebuild — prebuild already populated dist — but starting it before the
  // daemon means daemon-core src edits get picked up immediately.
  const coreSpec = specs.find(s => s.name === 'core');
  if (coreSpec) startChild(coreSpec);

  // Then start the other specs (daemon + web).
  for (const spec of specs) {
    if (spec.name === 'core') continue;
    startChild(spec);
  }

  watchDaemonCoreDist();

  log('');
  log(`ADHDev dev runner started on ${os.hostname()}.`);
  log('Expected ports: web 3000, standalone 3847.');
  log('daemon-core src edits → tsup --watch rebuilds dist → daemon auto-restarts.');
  log('Press Ctrl+C to stop all processes.');
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
