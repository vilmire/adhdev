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
// ADHDEV_BUILD_IF_STALE=0 forces every build (and is itself excluded from the key).
//
// CLI: node oss/scripts/build-if-stale.mjs <workspace-spec>...   (cwd = the npm
//      workspace root the specs are relative to)

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

function workspaceDepDirs(pkgDir) {
  let pkg;
  try { pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')); } catch { return []; }
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies });
  const dirs = [];
  for (const name of names.sort()) {
    if (name === 'seqscribe') dirs.push(path.join(OSS_ROOT, 'vendor', 'seqscribe'));
    else if (name.startsWith('@adhdev/')) {
      const dir = path.join(OSS_ROOT, 'packages', name.slice('@adhdev/'.length));
      if (existsSync(dir)) dirs.push(dir);
    }
  }
  return dirs;
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
export function computeBuildKey(pkgDir, env) {
  const hash = createHash('sha256');
  hash.update(`${SCHEMA}\0${path.relative(OSS_ROOT, pkgDir).split(path.sep).join('/')}\0`);
  hash.update(`${process.version}|${process.platform}|${process.arch}\0`);
  for (const name of Object.keys(env).filter((n) => KEY_ENV_RE.test(n) && n !== FORCE_ENV && !RUN_SCOPED_ENV.has(n)).sort()) {
    hash.update(`env:${name}=${env[name]}\0`);
  }
  hash.update(`head:${gitHead(pkgDir)}\0`);
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
  for (const dep of workspaceDepDirs(pkgDir)) {
    hash.update(`dep:${path.relative(OSS_ROOT, dep)}\0`);
    fileOr(hash, 'dep-package.json', path.join(dep, 'package.json'));
    hash.update(digestDist(path.join(dep, 'dist')));
  }
  return hash.digest('hex');
}

export function stampPathFor(pkgDir) {
  return path.join(STAMP_DIR, `${path.relative(OSS_ROOT, pkgDir).split(path.sep).join('__')}.json`);
}

/** Why `pkgDir` must be rebuilt under `env`, or null when the dist is fresh. */
export function staleReason(pkgDir, env) {
  if (env[FORCE_ENV] === '0') return `${FORCE_ENV}=0`;
  let stamp;
  try { stamp = JSON.parse(readFileSync(stampPathFor(pkgDir), 'utf8')); } catch { return 'no stamp'; }
  if (stamp?.key !== computeBuildKey(pkgDir, env)) return 'inputs or env changed';
  if (!existsSync(path.join(pkgDir, 'dist'))) return 'dist missing';
  if (stamp.outputDigest !== digestDist(path.join(pkgDir, 'dist'))) return 'dist changed since stamp';
  return null;
}

/**
 * Build each workspace spec (relative to `cwd`) unless it is fresh. Throws on
 * a failed build (and removes that package's stamp first).
 */
export function buildWorkspacesIfStale(specs, { cwd, env = process.env, npm = process.platform === 'win32' ? 'npm.cmd' : 'npm', log = console.log } = {}) {
  const results = [];
  for (const spec of specs) {
    const pkgDir = path.resolve(cwd, spec);
    const reason = staleReason(pkgDir, env);
    if (!reason) {
      log(`[build-if-stale] skip ${spec} (fresh: same inputs/env/HEAD, dist unchanged since its stamp)`);
      results.push({ spec, built: false });
      continue;
    }
    log(`[build-if-stale] build ${spec} (${reason})`);
    // Key BEFORE the build: a source edit racing the build must not be stamped fresh.
    const key = computeBuildKey(pkgDir, env);
    rmSync(stampPathFor(pkgDir), { force: true });
    // Node 24 on Windows refuses to spawn .cmd shims without a shell; args are fixed and space-free.
    execFileSync(npm, ['run', 'build', '-w', spec], { stdio: 'inherit', cwd, env, shell: process.platform === 'win32', windowsHide: true });
    mkdirSync(STAMP_DIR, { recursive: true });
    writeFileSync(stampPathFor(pkgDir), JSON.stringify({ key, outputDigest: digestDist(path.join(pkgDir, 'dist')), spec, at: new Date().toISOString() }, null, 2));
    results.push({ spec, built: true, reason });
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const specs = process.argv.slice(2);
  if (specs.length === 0) {
    console.error('usage: node oss/scripts/build-if-stale.mjs <workspace-spec>...');
    process.exit(2);
  }
  try {
    buildWorkspacesIfStale(specs, { cwd: process.cwd() });
  } catch (error) {
    console.error(`[build-if-stale] build failed: ${error?.message || error}`);
    process.exit(1);
  }
}
