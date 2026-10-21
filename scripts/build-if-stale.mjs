#!/usr/bin/env node
// build-if-stale — skip a workspace `npm run build -w <spec>` when the previous
// build of EXACTLY the same inputs, under EXACTLY the same build-relevant env,
// is still the dist on disk.
//
// Why: one Refinery run used to rebuild daemon-core 5× and mesh-shared /
// session-host-core / terminal-mux-* 4× (bootstrap, typecheck, the daemon-core
// build gate, then the root AND oss vendor-drift gates — which rebuild the same
// 8-package chain back to back). The second vendor gate's chain is the clearest
// waste: same packages, same sources, same env, seconds apart.
//
// The rule is "when unsure, rebuild". A build is skipped only when ALL of:
//   1. a stamp exists for this package;
//   2. the stamp's KEY equals the key computed now. The key hashes
//        - every file under the package dir (except node_modules/dist/coverage
//          and *.tsbuildinfo) — content, not mtime;
//        - each workspace dependency's package.json and dist/ content (daemon-core
//          inlines mesh-shared + seqscribe dists; mcp-server inlines daemon-core's);
//        - oss package.json / package-lock.json / tsconfig.json, the root
//          package-lock.json when present, scripts/pinned-dep-base.mjs;
//        - the resolved tsup / esbuild / typescript versions;
//        - the pinned-dep resolution base (install layout — the 2026-09-20
//          repo-root-relative-paths incident);
//        - git HEAD of the package's repo (daemon-core stamps it into its dist);
//        - node version / platform / arch;
//        - EVERY env var named ADHDEV_* / NODE_* / TSUP_* / ESBUILD_* in the
//          build env. That includes ADHDEV_BUILD_CHANNEL (the 2026-09-24 incident:
//          a channel-stamped bundle diverged from committed vendor) and
//          ADHDEV_VENDOR_COMMIT_BUILD (vendor builds never reuse a typecheck build);
//   3. the dist/ on disk still hashes to the digest recorded right after that
//      build — so ANY other build in between (bootstrap, a raw `npm run build`,
//      a different env) invalidates the stamp unless it produced identical bytes.
//
// Stamps live in <oss>/node_modules/.cache/adhdev-build-freshness/ — never in
// dist/, which is npm-packed and vendored.
//
// Concurrency (review P1-3): the whole check → build → digest → publish runs
// under ONE exclusive lock (O_EXCL lockfile in the stamp dir). Owner liveness
// is a heartbeat — the holder re-touches the lockfile every few seconds while
// it works — never a pid check; a lock whose heartbeat is older than
// LOCK_STALE_MS is broken by an atomic rename-aside. Stamps are published
// atomically (tmp + rename). A build is stamped only if its input key and its
// output digest are unchanged across the build (nothing else touched the
// inputs or the dist mid-operation); otherwise no stamp is written.
//
// Dependency inputs (review P2-4): for every workspace dependency in the
// transitive closure, the key hashes its package.json plus everything it can
// publish — the `files` set, main/types/module/exports targets and dist/ —
// not only dist/ (ghostty-vt-node exposes a root index.js/index.d.ts).
//
// Stamped values (review P2-5): the key also includes the RESOLVED build stamp
// daemon-core's build-stamp.mjs would inject (commit, short commit, version,
// channel) — so anything that changes those values (GIT_CONFIG_* altering
// core.abbrev, a different HEAD, ...) changes the key without enumerating env.
//
// ADHDEV_BUILD_IF_STALE=0 forces every build (and is itself excluded from the key).
//
// CLI: node oss/scripts/build-if-stale.mjs <workspace-spec>...   (cwd = the npm
//      workspace root the specs are relative to)

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PINNED_SEQSCRIBE_DEPS, resolvePinnedDepBase } from './pinned-dep-base.mjs';

const OSS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAMP_DIR = path.join(OSS_ROOT, 'node_modules', '.cache', 'adhdev-build-freshness');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.turbo', '.vitest']);
const KEY_ENV_RE = /^(ADHDEV_|NODE_|TSUP_|ESBUILD_)/;
const FORCE_ENV = 'ADHDEV_BUILD_IF_STALE';
// Run bookkeeping the Refinery sets on every gate; provably not a build input.
const RUN_SCOPED_ENV = new Set(['ADHDEV_REFINE_RUN_ID', 'ADHDEV_REFINE_VITEST_MAX_WORKERS']);
const SCHEMA = 'adhdev-build-freshness/v1';

function hashTree(dir, hash, rel = '') {
  let entries;
  try {
    entries = readdirSync(path.join(dir, rel), { withFileTypes: true });
  } catch {
    hash.update(`missing:${rel}\0`);
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      hashTree(dir, hash, child);
    } else if (entry.isFile()) {
      if (entry.name.endsWith('.tsbuildinfo')) continue;
      hash.update(`f:${child}\0`);
      hash.update(readFileSync(path.join(dir, child)));
      hash.update('\0');
    } else if (entry.isSymbolicLink()) {
      hash.update(`l:${child}\0`);
    }
  }
}

/** Content digest of a dist/ tree (no directory is skipped inside it). */
export function digestDist(distDir) {
  const hash = createHash('sha256');
  const walk = (rel) => {
    let entries;
    try { entries = readdirSync(path.join(distDir, rel), { withFileTypes: true }); } catch { hash.update(`missing:${rel}`); return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) { hash.update(`f:${child}\0`); hash.update(readFileSync(path.join(distDir, child))); hash.update('\0'); }
    }
  };
  walk('');
  return hash.digest('hex');
}

function fileOr(hash, label, file) {
  hash.update(`${label}\0`);
  hash.update(existsSync(file) ? readFileSync(file) : 'missing');
  hash.update('\0');
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; }
}

function directWorkspaceDepDirs(pkgDir, ossRoot = OSS_ROOT) {
  const pkg = readJson(path.join(pkgDir, 'package.json'));
  if (!pkg) return [];
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies });
  const dirs = [];
  for (const name of names.sort()) {
    if (name === 'seqscribe') dirs.push(path.join(ossRoot, 'vendor', 'seqscribe'));
    else if (name.startsWith('@adhdev/')) {
      const dir = path.join(ossRoot, 'packages', name.slice('@adhdev/'.length));
      if (existsSync(dir)) dirs.push(dir);
    }
  }
  return dirs;
}

/** Transitive closure of workspace dependencies (sorted, without pkgDir itself). */
function workspaceDepClosure(pkgDir, ossRoot = OSS_ROOT) {
  const seen = new Set();
  const queue = [...directWorkspaceDepDirs(pkgDir, ossRoot)];
  while (queue.length) {
    const dir = queue.shift();
    if (seen.has(dir) || dir === pkgDir) continue;
    seen.add(dir);
    queue.push(...directWorkspaceDepDirs(dir, ossRoot));
  }
  return [...seen].sort();
}

function collectExportTargets(value, out) {
  if (typeof value === 'string') out.add(value);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectExportTargets(v, out);
}

/** Everything a dependency can expose to its consumer's build. */
function hashDependencySurface(depDir, hash) {
  const pkg = readJson(path.join(depDir, 'package.json')) ?? {};
  fileOr(hash, 'dep-package.json', path.join(depDir, 'package.json'));
  const entries = new Set(['dist']);
  if (Array.isArray(pkg.files)) for (const f of pkg.files) if (typeof f === 'string') entries.add(f);
  for (const field of ['main', 'module', 'types', 'typings', 'browser']) if (typeof pkg[field] === 'string') entries.add(pkg[field]);
  collectExportTargets(pkg.exports, entries);
  if (!Array.isArray(pkg.files)) {
    // No `files` allow-list: the whole package may be consumed — hash it all.
    hash.update('whole-package\0');
    hashTree(depDir, hash);
    return;
  }
  for (const entry of [...entries].map(e => e.replace(/^\.\//, '').replace(/\/+$/, '')).sort()) {
    if (!entry || entry.includes('*')) {
      // Globs are not expanded here: fall back to hashing the whole package.
      hash.update('whole-package\0');
      hashTree(depDir, hash);
      return;
    }
    const target = path.join(depDir, entry);
    hash.update(`entry:${entry}\0`);
    let stat;
    try { stat = statSync(target); } catch { hash.update('missing\0'); continue; }
    if (stat.isDirectory()) hash.update(digestDist(target));
    else fileOr(hash, entry, target);
  }
}

/** The values daemon-core's build-stamp.mjs would inject, minus the build time. */
async function resolvedBuildStamp(pkgDir) {
  try {
    const { daemonBuildDefine } = await import(pathToFileURL(path.join(OSS_ROOT, 'packages', 'daemon-core', 'build-stamp.mjs')).href);
    const pkg = readJson(path.join(pkgDir, 'package.json')) ?? {};
    const define = daemonBuildDefine({ cwd: pkgDir, version: pkg.version });
    delete define.__DAEMON_BUILD_AT__;
    return JSON.stringify(define, Object.keys(define).sort());
  } catch (error) {
    return `unavailable:${error?.message}`;
  }
}

function toolchain(pkgDir) {
  const req = createRequire(path.join(pkgDir, 'package.json'));
  return ['tsup', 'esbuild', 'typescript'].map((name) => {
    try {
      const file = req.resolve(`${name}/package.json`);
      return `${name}@${JSON.parse(readFileSync(file, 'utf8')).version}@${file}`;
    } catch {
      return `${name}@missing`;
    }
  }).join('|');
}

function gitHead(dir) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
  } catch {
    return 'unknown';
  }
}

/** The freshness key for building `pkgDir` under `env`. */
export async function computeBuildKey(pkgDir, env, { ossRoot = OSS_ROOT } = {}) {
  const hash = createHash('sha256');
  hash.update(`${SCHEMA}\0${path.relative(OSS_ROOT, pkgDir).split(path.sep).join('/')}\0`);
  hash.update(`${process.version}|${process.platform}|${process.arch}\0`);
  for (const name of Object.keys(env).filter((n) => KEY_ENV_RE.test(n) && n !== FORCE_ENV && !RUN_SCOPED_ENV.has(n)).sort()) {
    hash.update(`env:${name}=${env[name]}\0`);
  }
  hash.update(`head:${gitHead(pkgDir)}\0`);
  hash.update(`stamp:${await resolvedBuildStamp(pkgDir)}\0`);
  hash.update(`toolchain:${toolchain(pkgDir)}\0`);
  for (const spec of PINNED_SEQSCRIBE_DEPS) {
    let base;
    try { base = resolvePinnedDepBase(spec, { ossRoot: OSS_ROOT, repoRoot: path.resolve(OSS_ROOT, '..') })?.base ?? 'none'; } catch (error) { base = `error:${error?.message}`; }
    hash.update(`pin:${spec}=${base}\0`);
  }
  fileOr(hash, 'oss/package.json', path.join(OSS_ROOT, 'package.json'));
  fileOr(hash, 'oss/package-lock.json', path.join(OSS_ROOT, 'package-lock.json'));
  fileOr(hash, 'oss/tsconfig.json', path.join(OSS_ROOT, 'tsconfig.json'));
  fileOr(hash, 'oss/scripts/pinned-dep-base.mjs', path.join(OSS_ROOT, 'scripts', 'pinned-dep-base.mjs'));
  fileOr(hash, 'root/package-lock.json', path.join(OSS_ROOT, '..', 'package-lock.json'));
  hash.update('pkg\0');
  hashTree(pkgDir, hash);
  for (const dep of workspaceDepClosure(pkgDir, ossRoot)) {
    hash.update(`dep:${path.relative(ossRoot, dep)}\0`);
    hashDependencySurface(dep, hash);
  }
  return hash.digest('hex');
}

export function stampPathFor(pkgDir) {
  return path.join(STAMP_DIR, `${path.relative(OSS_ROOT, pkgDir).split(path.sep).join('__')}.json`);
}

/** Why `pkgDir` must be rebuilt under `env`, or null when the dist is fresh. */
export async function staleReason(pkgDir, env) {
  if (env[FORCE_ENV] === '0') return `${FORCE_ENV}=0`;
  let stamp;
  try { stamp = JSON.parse(readFileSync(stampPathFor(pkgDir), 'utf8')); } catch { return 'no stamp'; }
  if (stamp?.key !== (await computeBuildKey(pkgDir, env))) return 'inputs or env changed';
  if (!existsSync(path.join(pkgDir, 'dist'))) return 'dist missing';
  if (stamp.outputDigest !== digestDist(path.join(pkgDir, 'dist'))) return 'dist changed since stamp';
  return null;
}

const LOCK_PATH = path.join(STAMP_DIR, '.lock');
const LOCK_HEARTBEAT_MS = 2_000;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 30 * 60_000;

/**
 * Exclusive lock for the whole check → build → digest → publish sequence.
 * O_EXCL create; liveness = heartbeat mtime (never a pid). Returns release().
 */
export async function acquireBuildLock({ lockPath = LOCK_PATH, staleMs = LOCK_STALE_MS, heartbeatMs = LOCK_HEARTBEAT_MS, waitMs = LOCK_WAIT_MS, log = console.log } = {}) {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + waitMs;
  let announced = false;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      closeSync(fd);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let age = 0;
      try { age = Date.now() - statSync(lockPath).mtimeMs; } catch { continue; }
      if (age > staleMs) {
        // Break a dead holder's lock atomically: only one breaker wins the rename.
        const aside = `${lockPath}.stale.${process.pid}.${Date.now()}`;
        try { renameSync(lockPath, aside); rmSync(aside, { force: true }); log(`[build-if-stale] broke stale lock (heartbeat ${Math.round(age / 1000)}s old)`); } catch { /* someone else broke it */ }
        continue;
      }
      if (Date.now() > deadline) throw new Error(`build-if-stale: lock ${lockPath} still held after ${waitMs}ms`);
      if (!announced) { log('[build-if-stale] waiting for another build-if-stale run to finish'); announced = true; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  const timer = setInterval(() => { try { const now = new Date(); utimesSync(lockPath, now, now); } catch { /* lock broken under us */ } }, heartbeatMs);
  timer.unref?.();
  return () => { clearInterval(timer); rmSync(lockPath, { force: true }); };
}

function runBuild(npm, spec, cwd, env) {
  return new Promise((resolve, reject) => {
    // Node 24 on Windows refuses to spawn .cmd shims without a shell; args are fixed and space-free.
    const child = spawn(npm, ['run', 'build', '-w', spec], { stdio: 'inherit', cwd, env, shell: process.platform === 'win32', windowsHide: true });
    child.on('error', reject);
    child.on('close', (code, signal) => (code === 0 ? resolve() : reject(new Error(`npm run build -w ${spec} exited ${code ?? signal}`))));
  });
}

function publishStamp(pkgDir, stamp) {
  mkdirSync(STAMP_DIR, { recursive: true });
  const target = stampPathFor(pkgDir);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(stamp, null, 2));
  renameSync(tmp, target);
}

/**
 * Build each workspace spec (relative to `cwd`) unless it is fresh, holding the
 * build lock for the whole sequence. Throws on a failed build (that package's
 * stamp is removed first, so a failure never leaves a stale "fresh" stamp).
 */
export async function buildWorkspacesIfStale(specs, { cwd, env = process.env, npm = process.platform === 'win32' ? 'npm.cmd' : 'npm', log = console.log, lockPath } = {}) {
  const release = await acquireBuildLock({ log, ...(lockPath ? { lockPath } : {}) });
  try {
    const results = [];
    for (const spec of specs) {
      const pkgDir = path.resolve(cwd, spec);
      const reason = await staleReason(pkgDir, env);
      if (!reason) {
        log(`[build-if-stale] skip ${spec} (fresh: same inputs/env/stamp values, dist unchanged since its stamp)`);
        results.push({ spec, built: false });
        continue;
      }
      log(`[build-if-stale] build ${spec} (${reason})`);
      const keyBefore = await computeBuildKey(pkgDir, env);
      rmSync(stampPathFor(pkgDir), { force: true });
      await runBuild(npm, spec, cwd, env);
      const distDir = path.join(pkgDir, 'dist');
      const digestAfterBuild = digestDist(distDir);
      const keyAfter = await computeBuildKey(pkgDir, env);
      const digestSettled = digestDist(distDir);
      if (keyAfter !== keyBefore || digestSettled !== digestAfterBuild) {
        // Inputs or the dist moved while we built (an unlocked writer): the
        // output cannot be attributed to keyBefore. Build stays, no stamp.
        log(`[build-if-stale] NOT stamping ${spec}: ${keyAfter !== keyBefore ? 'inputs changed during the build' : 'dist changed after the build'}`);
        results.push({ spec, built: true, reason, stamped: false });
        continue;
      }
      publishStamp(pkgDir, { key: keyBefore, outputDigest: digestSettled, spec, at: new Date().toISOString() });
      results.push({ spec, built: true, reason, stamped: true });
    }
    return results;
  } finally {
    release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const specs = process.argv.slice(2);
  if (specs.length === 0) {
    console.error('usage: node oss/scripts/build-if-stale.mjs <workspace-spec>...');
    process.exit(2);
  }
  buildWorkspacesIfStale(specs, { cwd: process.cwd() }).catch((error) => {
    console.error(`[build-if-stale] build failed: ${error?.message || error}`);
    process.exit(1);
  });
}
