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
// Concurrency (re-review P1-3): there is NO cross-process lock and nothing is
// ever broken by time. Within a Refinery run build-if-stale is only invoked
// from serial phases (typecheck in p1b, the vendor gates in p3 — enforced by
// packages/daemon-cloud/test/refine-schedule-coverage.test.ts), and every
// refine runs in its own worktree with its own dist and stamp dir. As defence
// in depth against a concurrent manual run in the same worktree, each build
// claims its package with an O_EXCL marker holding a random owner token:
//   - a marker already present (another run, or a crashed one) → FAIL CLOSED:
//     the contender does not build into the claimed output at all (it would
//     let the owner digest and stamp the contender's bytes under the owner's
//     key) and exits non-zero naming the claim; the marker is left alone
//     (delete it by hand only when no build-if-stale run is active);
//   - before publishing, the token is re-read; a displaced owner publishes
//     nothing; release deletes the marker only if it still holds our token.
// Stamps are published atomically (tmp + rename), and a build is stamped only
// if its input key is identical before and after the build and the dist
// digest is stable. Correctness never depends on the marker: a stamp is
// trusted only while the dist on disk hashes to the stamped digest.
//
// Dependency inputs (review P2-4): for every workspace dependency in the
// transitive closure, the key hashes its package.json plus everything it can
// publish — the `files` set, main/types/module/exports targets and dist/ —
// not only dist/ (ghostty-vt-node exposes a root index.js/index.d.ts).
//
// Stamped values (review P2-5): the key also includes the RESOLVED build stamp
// daemon-core's build-stamp.mjs would inject (commit, short commit, version,
// channel), computed in a child process under the SAME env the build gets —
// so anything that changes those values (GIT_CONFIG_* altering core.abbrev, a
// different HEAD, the channel) changes the key without enumerating env.
//
// Selectors (round-4 P1): `npm run build -w <x>` accepts a workspace NAME or a
// path, so two spellings of one package (`@adhdev/mesh-shared` vs
// `oss/packages/mesh-shared`, a symlinked path, a case variant on a
// case-insensitive FS) would otherwise take different claims while npm writes
// the same dist. Only DIRECTORY selectors are accepted: each is realpath'ed
// (fs.realpathSync.native — resolves symlinks and canonicalizes case), must be
// an existing directory with a package.json, and must be one of the workspaces
// npm resolves for this cwd (realpaths of the root package.json `workspaces`
// globs). Names, globs, multiple selectors and non-workspace dirs are rejected
// BEFORE any claim or spawn. The canonical relative directory is what npm gets,
// and the claim, key and dist all derive from that one realpath.
//
// Recovery (stale claim): a crashed run leaves
// <oss>/node_modules/.cache/adhdev-build-freshness/<pkg>.json.building and the
// next run fails naming it. Remove that file ONLY after confirming that no
// build-if-stale run AND no npm / tsup / esbuild build for that package is
// still running (an orphaned build process can still be writing its dist;
// the owner's absence alone is not proof). There is deliberately no automatic
// recovery: nothing here breaks a claim by time or probes pids.
//
// ADHDEV_BUILD_IF_STALE=0 forces every build (and is itself excluded from the key).
//
// CLI: node oss/scripts/build-if-stale.mjs <workspace-spec>...   (cwd = the npm
//      workspace root the specs are relative to)

import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PINNED_SEQSCRIBE_DEPS, resolvePinnedDepBase } from './pinned-dep-base.mjs';

// Canonical (realpath) so every derived identity is computed from one spelling.
const OSS_ROOT = (() => { const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); try { return realpathSync.native(p); } catch { return p; } })();
const STAMP_DIR = path.join(OSS_ROOT, 'node_modules', '.cache', 'adhdev-build-freshness');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.turbo', '.vitest']);
// Whole-package dependency hashing keeps dist/: it is what the consumer imports.
const WHOLE_PACKAGE_SKIP_DIRS = new Set(['node_modules', '.git']);
const KEY_ENV_RE = /^(ADHDEV_|NODE_|TSUP_|ESBUILD_)/;
const FORCE_ENV = 'ADHDEV_BUILD_IF_STALE';
// Run bookkeeping the Refinery sets on every gate; provably not a build input.
const RUN_SCOPED_ENV = new Set(['ADHDEV_REFINE_RUN_ID', 'ADHDEV_REFINE_VITEST_MAX_WORKERS']);
const SCHEMA = 'adhdev-build-freshness/v1';

function hashTree(dir, hash, rel = '', skipDirs = SKIP_DIRS) {
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
      if (skipDirs.has(entry.name)) continue;
      hashTree(dir, hash, child, skipDirs);
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
    // No `files` allow-list: the whole package may be consumed — hash it all,
    // INCLUDING its published output (dist/, main, exports targets). The
    // source walker skips dist, so it is not reused here (re-review P2-5).
    hash.update('whole-package\0');
    hashTree(depDir, hash, '', WHOLE_PACKAGE_SKIP_DIRS);
    return;
  }
  for (const entry of [...entries].map(e => e.replace(/^\.\//, '').replace(/\/+$/, '')).sort()) {
    if (!entry || entry.includes('*')) {
      // Globs are not expanded here: fall back to hashing the whole package.
      hash.update('whole-package\0');
      hashTree(depDir, hash, '', WHOLE_PACKAGE_SKIP_DIRS);
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

/**
 * The values daemon-core's build-stamp.mjs would inject (minus the build time),
 * resolved in a child process under the SAME env the build will get — so git
 * config, HEAD and channel are read exactly as the build reads them.
 */
function resolvedBuildStamp(pkgDir, env) {
  const stampModule = pathToFileURL(path.join(OSS_ROOT, 'packages', 'daemon-core', 'build-stamp.mjs')).href;
  const pkg = readJson(path.join(pkgDir, 'package.json')) ?? {};
  const code = `import { daemonBuildDefine } from ${JSON.stringify(stampModule)};
const d = daemonBuildDefine({ cwd: process.cwd(), version: ${JSON.stringify(String(pkg.version ?? ''))} });
delete d.__DAEMON_BUILD_AT__;
process.stdout.write(JSON.stringify(d, Object.keys(d).sort()));`;
  try {
    return execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: pkgDir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 30_000 });
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

/** Canonical identity of a directory: symlinks resolved, case canonicalized. */
export function canonicalDir(dir) {
  try { return realpathSync.native(dir); } catch { return path.resolve(dir); }
}

function workspaceDirs(cwd) {
  const pkg = readJson(path.join(cwd, 'package.json'));
  const patterns = Array.isArray(pkg?.workspaces) ? pkg.workspaces : Array.isArray(pkg?.workspaces?.packages) ? pkg.workspaces.packages : [];
  const out = new Set();
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') continue;
    // Expand one path segment at a time; only a whole-segment `*` is supported
    // (all this repo uses). Anything fancier is skipped — conservative: its
    // packages are simply not accepted as selectors.
    let dirs = [cwd];
    let supported = true;
    for (const segment of pattern.replace(/\/+$/, '').split('/')) {
      if (segment === '*') {
        dirs = dirs.flatMap((d) => { try { return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(d, e.name)); } catch { return []; } });
      } else if (/[*?[\]{}!]/.test(segment)) {
        supported = false;
        break;
      } else {
        dirs = dirs.map((d) => path.join(d, segment));
      }
    }
    if (!supported) continue;
    for (const dir of dirs) if (existsSync(path.join(dir, 'package.json'))) out.add(canonicalDir(dir));
  }
  return out;
}

/**
 * Resolve ONE directory selector to its canonical workspace directory, or
 * throw. Returns { pkgDir: realpath, npmSpec: canonical path relative to cwd }.
 */
export function resolveWorkspaceSelector(spec, cwd) {
  const reject = (why) => new Error(`build-if-stale: unsupported selector ${JSON.stringify(spec)}: ${why}. Pass exactly one workspace DIRECTORY relative to ${cwd} (e.g. oss/packages/mesh-shared).`);
  if (typeof spec !== 'string' || !spec.trim()) throw reject('empty');
  if (/[*?[\]{}!,\s]/.test(spec)) throw reject('globs, lists and whitespace are not accepted');
  if (spec.startsWith('@') || !/[\\/]/.test(spec) && !existsSync(path.resolve(cwd, spec))) throw reject('workspace names are not accepted, only directories');
  const abs = path.resolve(cwd, spec);
  let real;
  try { real = realpathSync.native(abs); } catch { throw reject('no such directory'); }
  let stat;
  try { stat = statSync(real); } catch { throw reject('no such directory'); }
  if (!stat.isDirectory()) throw reject('not a directory');
  if (!existsSync(path.join(real, 'package.json'))) throw reject('no package.json');
  const cwdReal = canonicalDir(cwd);
  if (!workspaceDirs(cwdReal).has(real)) throw reject(`not one of the workspaces npm resolves for ${cwdReal}`);
  return { pkgDir: real, npmSpec: path.relative(cwdReal, real).split(path.sep).join('/') };
}

/** The freshness key for building `pkgDir` under `env`. */
export async function computeBuildKey(pkgDir, env, { ossRoot = OSS_ROOT } = {}) {
  pkgDir = canonicalDir(pkgDir);
  const hash = createHash('sha256');
  hash.update(`${SCHEMA}\0${path.relative(OSS_ROOT, pkgDir).split(path.sep).join('/')}\0`);
  hash.update(`${process.version}|${process.platform}|${process.arch}\0`);
  for (const name of Object.keys(env).filter((n) => KEY_ENV_RE.test(n) && n !== FORCE_ENV && !RUN_SCOPED_ENV.has(n)).sort()) {
    hash.update(`env:${name}=${env[name]}\0`);
  }
  hash.update(`head:${gitHead(pkgDir)}\0`);
  hash.update(`stamp:${resolvedBuildStamp(pkgDir, env)}\0`);
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
  pkgDir = canonicalDir(pkgDir);
  return path.join(STAMP_DIR, `${path.relative(OSS_ROOT, pkgDir).split(path.sep).join('__')}.json`);
}

/** Why `pkgDir` must be rebuilt under `env`, or null when the dist is fresh. */
export async function staleReason(pkgDir, env) {
  pkgDir = canonicalDir(pkgDir);
  if (env[FORCE_ENV] === '0') return `${FORCE_ENV}=0`;
  let stamp;
  try { stamp = JSON.parse(readFileSync(stampPathFor(pkgDir), 'utf8')); } catch { return 'no stamp'; }
  if (stamp?.key !== (await computeBuildKey(pkgDir, env))) return 'inputs or env changed';
  if (!existsSync(path.join(pkgDir, 'dist'))) return 'dist missing';
  if (stamp.outputDigest !== digestDist(path.join(pkgDir, 'dist'))) return 'dist changed since stamp';
  return null;
}

function claimPathFor(pkgDir) {
  return `${stampPathFor(pkgDir)}.building`;
}

/** O_EXCL claim with a random owner token; null when someone else holds it. */
export function claimPackage(pkgDir) {
  mkdirSync(STAMP_DIR, { recursive: true });
  const token = randomUUID();
  let fd;
  try { fd = openSync(claimPathFor(pkgDir), 'wx'); } catch (error) { if (error?.code === 'EEXIST') return null; throw error; }
  try { writeSync(fd, token); } finally { closeSync(fd); }
  return token;
}

function ownsClaim(pkgDir, token) {
  try { return readFileSync(claimPathFor(pkgDir), 'utf8') === token; } catch { return false; }
}

function releaseClaim(pkgDir, token) {
  // Only our own token is ever removed; a foreign or replaced claim stays.
  if (ownsClaim(pkgDir, token)) rmSync(claimPathFor(pkgDir), { force: true });
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
 * Build each workspace spec (relative to `cwd`) unless it is fresh. Throws on a
 * failed build (that package's stamp is removed first when we own the claim,
 * so a failure never leaves a stale "fresh" stamp).
 */
export async function buildWorkspacesIfStale(specs, { cwd, env = process.env, npm = process.platform === 'win32' ? 'npm.cmd' : 'npm', log = console.log } = {}) {
  // Validate EVERY selector before any claim or spawn (round-4 P1).
  if (!Array.isArray(specs)) throw new Error('build-if-stale: specs must be an array of workspace directories');
  const targets = specs.map((spec) => ({ spec, ...resolveWorkspaceSelector(spec, cwd) }));
  const seen = new Set();
  for (const t of targets) {
    if (seen.has(t.pkgDir)) throw new Error(`build-if-stale: selector ${JSON.stringify(t.spec)} names a package already selected in this call (${t.npmSpec})`);
    seen.add(t.pkgDir);
  }
  const npmCwd = canonicalDir(cwd);
  const results = [];
  for (const { spec, pkgDir, npmSpec } of targets) {
    const reason = await staleReason(pkgDir, env);
    if (!reason) {
      log(`[build-if-stale] skip ${spec} (fresh: same inputs/env/stamp values, dist unchanged since its stamp)`);
      results.push({ spec, built: false });
      continue;
    }
    const token = claimPackage(pkgDir);
    if (!token) {
      // FAIL CLOSED (round-3 P1): building into an output another run has
      // claimed would let that owner digest — and stamp — OUR bytes under ITS
      // key. So a contender never writes a claimed output: it stops here, and
      // the owner remains the only writer. No lock is ever broken by time.
      throw new Error(
        `build-if-stale: refusing to build ${spec}: its output is claimed by another build-if-stale run (${claimPathFor(pkgDir)}). ` +
        'Wait for that run to finish. Remove that file only after confirming that NO build-if-stale run and NO npm/tsup/esbuild build ' +
        'for this package is still running (an orphaned build can still be writing its dist), then retry.',
      );
    }
    try {
      log(`[build-if-stale] build ${spec} (${reason})`);
      const keyBefore = await computeBuildKey(pkgDir, env);
      rmSync(stampPathFor(pkgDir), { force: true });
      await runBuild(npm, npmSpec, npmCwd, env);
      const distDir = path.join(pkgDir, 'dist');
      const digestAfterBuild = digestDist(distDir);
      const keyAfter = await computeBuildKey(pkgDir, env);
      const digestSettled = digestDist(distDir);
      let refuse = null;
      if (keyAfter !== keyBefore) refuse = 'inputs changed during the build';
      else if (digestSettled !== digestAfterBuild) refuse = 'dist changed after the build';
      else if (!ownsClaim(pkgDir, token)) refuse = 'our claim was displaced during the build';
      if (refuse) {
        log(`[build-if-stale] NOT stamping ${spec}: ${refuse}`);
        results.push({ spec, built: true, reason, stamped: false });
        continue;
      }
      publishStamp(pkgDir, { key: keyBefore, outputDigest: digestSettled, spec, at: new Date().toISOString() });
      results.push({ spec, built: true, reason, stamped: true });
    } finally {
      releaseClaim(pkgDir, token);
    }
  }
  return results;
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
