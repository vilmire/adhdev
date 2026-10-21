import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { emitPrebuilt } from './prebuilt-manifest.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, '..');
const outputDir = path.join(packageDir, 'build', 'Release');
const outputFile = path.join(outputDir, 'ghostty_vt_node.node');
const triplet = `${process.platform}-${process.arch}-node${process.versions.modules}`;
const sourceInputs = [
  path.join(packageDir, 'CMakeLists.txt'),
  path.join(packageDir, 'toolchain.json'),
  path.join(packageDir, 'src', 'addon.cc'),
  path.join(packageDir, 'src', 'ghostty_bridge.c'),
  path.join(packageDir, 'src', 'ghostty_bridge.h'),
];

function safeMtime(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function latestSourceMtime() {
  return sourceInputs.reduce((latest, filePath) => Math.max(latest, safeMtime(filePath)), 0);
}

const PREBUILT_ROOT = path.join(packageDir, 'prebuilt');
const ADDON_FILE = 'ghostty_vt_node.node';
// The addon plus its co-located runtime libs (.dylib/.so/.dll) — the addon
// resolves libghostty-vt next to itself, so it must travel with it.
const RUNTIME_FILE_PATTERN = /\.(node|dylib|so|so\.\d.*|dll)$/;

// The addon is a pure Node-API binding, so every same `platform-arch`
// prebuilt is loadable regardless of the `nodeNNN` ABI in its directory name
// (see index.js, which falls back the same way at runtime). Exact ABI first,
// then the other same-platform-arch directories, newest ABI first. Accepting
// only the exact triplet sent e.g. a Node 22 (ABI 127) fresh clone — where
// only `*-node137` is committed — into a cmake/zig source compile.
function samePlatformArchTriplets() {
  const prefix = `${process.platform}-${process.arch}-node`;
  let names = [];
  try {
    names = fs.readdirSync(PREBUILT_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix) && entry.name !== triplet)
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const abi = (name) => Number.parseInt(name.slice(prefix.length), 10) || 0;
  return names.sort((a, b) => abi(b) - abi(a));
}

function candidatePrebuiltPaths() {
  const candidates = [];
  const explicitDir = process.env.ADHDEV_GHOSTTY_VT_PREBUILT_DIR?.trim();
  if (explicitDir) {
    candidates.push({ file: path.join(explicitDir, triplet, ADDON_FILE), explicit: true });
    candidates.push({ file: path.join(explicitDir, ADDON_FILE), explicit: true });
  }
  for (const name of [triplet, ...samePlatformArchTriplets()]) {
    candidates.push({ file: path.join(PREBUILT_ROOT, name, ADDON_FILE), explicit: false });
  }
  return candidates;
}

function git(args) {
  const result = spawnSync('git', ['-C', packageDir, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status === null) return null;
  return { status: result.status, stdout: result.stdout || '' };
}

// Staleness of a candidate prebuilt relative to the sources it was built from.
//
// The mtime guard only means something for files this machine PRODUCED (a
// local compile, or a prebuilt emitted from one): their mtimes order
// genuinely. A git-tracked prebuilt's mtime is just checkout order — in a
// fresh clone a valid prebuilt often looks "older" than addon.cc and was
// skipped, and the build then died for lack of cmake. For a tracked prebuilt
// the question that matters is whether the SOURCES were edited locally since
// the committed state; only then is the committed binary out of date.
let sourcesLocallyModifiedMemo;
function sourcesLocallyModified() {
  if (sourcesLocallyModifiedMemo !== undefined) return sourcesLocallyModifiedMemo;
  const rels = sourceInputs.map((filePath) => path.relative(packageDir, filePath));
  const status = git(['status', '--porcelain', '--', ...rels]);
  sourcesLocallyModifiedMemo = !!status && status.status === 0 && status.stdout.trim().length > 0;
  return sourcesLocallyModifiedMemo;
}

function isGitTracked(filePath) {
  const result = git(['ls-files', '--error-unmatch', '--', path.relative(packageDir, filePath)]);
  return !!result && result.status === 0;
}

function isUsablePrebuilt(candidate, sourceMtime) {
  // An explicit override dir is the operator's choice — trust it.
  if (candidate.explicit) return true;
  if (isGitTracked(candidate.file)) return !sourcesLocallyModified();
  // Not tracked: either a locally emitted prebuilt (mtime is meaningful) or an
  // npm-installed package with no git at all, where the shipped sources and
  // prebuilts are pristine together. Without git metadata there is nothing
  // local to be stale against, so only a working tree applies the guard.
  const insideWorkTree = git(['rev-parse', '--is-inside-work-tree']);
  if (!insideWorkTree || insideWorkTree.status !== 0) return true;
  return safeMtime(candidate.file) >= sourceMtime;
}

function installPrebuilt(candidateFile) {
  fs.mkdirSync(outputDir, { recursive: true });
  const sourceDir = path.dirname(candidateFile);
  for (const entry of fs.readdirSync(sourceDir)) {
    if (RUNTIME_FILE_PATTERN.test(entry)) fs.copyFileSync(path.join(sourceDir, entry), path.join(outputDir, entry));
  }
  if (!fs.existsSync(outputFile)) fs.copyFileSync(candidateFile, outputFile);
}

// ADHDEV_GHOSTTY_VT_FORCE_COMPILE=1 always compiles from source: no existing
// build output, no prebuilt. The native CI build uses it — in a fresh checkout
// the sources are never "locally modified", so without it the tracked
// prebuilt is copied and a binary that predates the current sources ships.
// `--plan` prints the decision and exits without touching anything.
const forceCompile = process.env.ADHDEV_GHOSTTY_VT_FORCE_COMPILE === '1';
const planOnly = process.argv.includes('--plan');

function decide() {
  if (forceCompile) return { action: 'compile', mode: 'rebuild', reason: 'ADHDEV_GHOSTTY_VT_FORCE_COMPILE=1' };
  const sourceMtime = latestSourceMtime();
  const outputMtime = safeMtime(outputFile);
  // A local build output is something this machine compiled, so its mtime
  // against the sources is meaningful: keep it while it is not older.
  if (outputMtime >= sourceMtime && outputMtime > 0) return { action: 'keep-local', file: outputFile };
  for (const candidate of candidatePrebuiltPaths()) {
    if (!fs.existsSync(candidate.file)) continue;
    if (!isUsablePrebuilt(candidate, sourceMtime)) {
      console.log(`[ghostty-vt-node] skipping prebuilt ${candidate.file}: sources were modified locally after it was built`);
      continue;
    }
    return { action: 'use-prebuilt', file: candidate.file };
  }
  if (process.env.ADHDEV_SKIP_GHOSTTY_VT_BUILD === '1') return { action: 'skip', reason: 'ADHDEV_SKIP_GHOSTTY_VT_BUILD=1' };
  return { action: 'compile', reason: 'no usable local build or prebuilt' };
}

const decision = decide();
if (planOnly) {
  console.log(`[ghostty-vt-node] plan: ${decision.action}${decision.mode ? ` (cmake-js ${decision.mode})` : ''}${decision.file ? ` ${decision.file}` : ''}${decision.reason ? ` (${decision.reason})` : ''}`);
  process.exit(0);
}

if (decision.action === 'keep-local') {
  console.log(`[ghostty-vt-node] keeping existing local build at ${outputFile}`);
  process.exit(0);
}

if (decision.action === 'use-prebuilt') {
  installPrebuilt(decision.file);
  console.log(`[ghostty-vt-node] using prebuilt native binding from ${decision.file}`);
  process.exit(0);
}

if (decision.action === 'skip') {
  console.log(`[ghostty-vt-node] skipping native build for ${triplet} (ADHDEV_SKIP_GHOSTTY_VT_BUILD=1)`);
  process.exit(0);
}

// A forced compile is a CLEAN rebuild (fresh configure, fresh FetchContent
// clone, zig-out regenerated): an incremental `compile` would reuse whatever
// the previous build directory holds. Other compiles stay incremental.
const cmakeJsCommand = forceCompile ? 'rebuild' : 'compile';
const isWindows = process.platform === 'win32';
const command = isWindows ? (process.env.ComSpec || 'cmd.exe') : 'npm';
const args = isWindows
  ? ['/d', '/s', '/c', `npm exec -- cmake-js ${cmakeJsCommand}`]
  : ['exec', '--', 'cmake-js', cmakeJsCommand];
console.log(`[ghostty-vt-node] compiling ${triplet} (${decision.reason}) via ${command} ${args.join(' ')}`);
const result = spawnSync(command, args, {
  cwd: packageDir,
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`[ghostty-vt-node] failed to launch native build for ${triplet}:`, result.error);
}

// Mirror a successful local build into the committed prebuilt for this
// platform-arch (prebuilt/<platform>-<arch>-node137, whatever Node runs the
// build — the binding is Node-API, so the ABI in the name is only an address)
// and stamp its manifest.json from the compiled binary. Set
// ADHDEV_GHOSTTY_VT_EMIT_PREBUILT=1 to enable (off by default so ordinary
// `npm run build` does not churn the dir). Combine with
// ADHDEV_GHOSTTY_VT_FORCE_COMPILE=1 to rebuild a prebuilt from source.
if ((result.status ?? 1) === 0 && process.env.ADHDEV_GHOSTTY_VT_EMIT_PREBUILT === '1') {
  try {
    const { target, manifest } = emitPrebuilt(outputDir);
    console.log(`[ghostty-vt-node] emitted prebuilt → ${target} (source digest ${manifest.sourceDigest})`);
  } catch (emitError) {
    console.error(`[ghostty-vt-node] failed to emit prebuilt for ${triplet}:`, emitError);
    process.exit(1);
  }
}

process.exit(result.status ?? 1);
