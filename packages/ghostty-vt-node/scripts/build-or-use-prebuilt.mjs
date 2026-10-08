import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, '..');
const outputDir = path.join(packageDir, 'build', 'Release');
const outputFile = path.join(outputDir, 'ghostty_vt_node.node');
const triplet = `${process.platform}-${process.arch}-node${process.versions.modules}`;
const sourceInputs = [
  path.join(packageDir, 'CMakeLists.txt'),
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

function installPrebuiltIfPresent(sourceMtime) {
  for (const candidate of candidatePrebuiltPaths()) {
    if (!fs.existsSync(candidate.file)) continue;
    if (!isUsablePrebuilt(candidate, sourceMtime)) {
      console.log(`[ghostty-vt-node] skipping prebuilt ${candidate.file}: sources were modified locally after it was built`);
      continue;
    }
    installPrebuilt(candidate.file);
    console.log(`[ghostty-vt-node] using prebuilt native binding from ${candidate.file}`);
    return true;
  }
  return false;
}

const sourceMtime = latestSourceMtime();
const outputMtime = safeMtime(outputFile);

// A local build output is something this machine compiled, so its mtime
// against the sources is meaningful: keep it while it is not older.
if (outputMtime >= sourceMtime && outputMtime > 0) {
  console.log(`[ghostty-vt-node] keeping existing local build at ${outputFile}`);
  process.exit(0);
}

if (installPrebuiltIfPresent(sourceMtime)) {
  process.exit(0);
}

if (process.env.ADHDEV_SKIP_GHOSTTY_VT_BUILD === '1') {
  console.log(`[ghostty-vt-node] skipping native build for ${triplet} (ADHDEV_SKIP_GHOSTTY_VT_BUILD=1)`);
  process.exit(0);
}

const isWindows = process.platform === 'win32';
const command = isWindows ? (process.env.ComSpec || 'cmd.exe') : 'npm';
const args = isWindows
  ? ['/d', '/s', '/c', 'npm exec -- cmake-js compile']
  : ['exec', '--', 'cmake-js', 'compile'];
console.log(`[ghostty-vt-node] compiling ${triplet} via ${command} ${args.join(' ')}`);
const result = spawnSync(command, args, {
  cwd: packageDir,
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`[ghostty-vt-node] failed to launch native build for ${triplet}:`, result.error);
}

// Mirror a successful local build into prebuilt/<triplet>/ so CI (or a developer)
// can produce a shippable prebuilt reproducibly: build once on the target
// platform, then commit prebuilt/<triplet>/. Set ADHDEV_GHOSTTY_VT_EMIT_PREBUILT=1
// to enable (off by default so ordinary `npm run build` does not churn the dir).
// The binding is Node-API (ABI-stable), so a single emitted triplet is enough for
// the running platform-arch; the runtime loader (index.js) falls back across ABIs.
if ((result.status ?? 1) === 0 && process.env.ADHDEV_GHOSTTY_VT_EMIT_PREBUILT === '1') {
  try {
    const prebuiltDir = path.join(packageDir, 'prebuilt', triplet);
    fs.mkdirSync(prebuiltDir, { recursive: true });
    for (const entry of fs.readdirSync(outputDir)) {
      // Ship the addon plus its co-located runtime libs (.dylib/.so/.dll),
      // skip intermediate build artifacts.
      if (/\.(node|dylib|so|so\.\d.*|dll)$/.test(entry)) {
        fs.copyFileSync(path.join(outputDir, entry), path.join(prebuiltDir, entry));
      }
    }
    console.log(`[ghostty-vt-node] emitted prebuilt for ${triplet} → ${prebuiltDir}`);
  } catch (emitError) {
    console.error(`[ghostty-vt-node] failed to emit prebuilt for ${triplet}:`, emitError);
  }
}

process.exit(result.status ?? 1);
