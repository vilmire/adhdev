#!/usr/bin/env node
// Per-platform prebuilt manifests for transfer_fs_node.node.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PACKAGE_DIR, computeBindingDigest, expectedApiLevel } from './binding-digest.mjs';
import { ADDON_FILE, checkRuntimeSet, parseTriplet } from './native-format.mjs';
import { PREBUILT_ROOT, RUNTIME_FILE_PATTERN } from './host-path-scan.mjs';

export { PREBUILT_ROOT };
export const MANIFEST_FILE = 'manifest.json';
export const MANIFEST_SCHEMA = 1;
export const SHIPPED_TRIPLETS = ['darwin-arm64-node137', 'linux-x64-node137', 'win32-x64-node137'];

const requireNative = createRequire(import.meta.url);
const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

export function shippedTripletFor(platform = process.platform, arch = process.arch) {
  return SHIPPED_TRIPLETS.find((name) => name.startsWith(`${platform}-${arch}-`)) ?? null;
}

function runtimeFiles(dir) {
  return readdirSync(dir).filter((name) => RUNTIME_FILE_PATTERN.test(name)).sort();
}

export function writeManifest(dir, opts = {}) {
  const parsed = parseTriplet(basename(dir));
  const platform = opts.platform ?? parsed?.platform ?? process.platform;
  const arch = opts.arch ?? parsed?.arch ?? process.arch;
  let info;
  if (platform === process.platform && arch === process.arch) {
    const addon = requireNative(resolve(dir, ADDON_FILE));
    info = addon.getBindingInfo();
  } else {
    info = {
      apiLevel: expectedApiLevel(),
      sourceDigest: computeBindingDigest(),
      napiVersion: 8,
      cCompiler: opts.cCompiler ?? 'zig cc 0.15.2',
      buildType: 'Release',
      releaseEligible: true,
    };
  }
  const files = {};
  for (const name of runtimeFiles(dir)) {
    const file = join(dir, name);
    files[name] = { sha256: sha256File(file), size: statSync(file).size };
  }
  const manifest = {
    schema: MANIFEST_SCHEMA,
    platform,
    arch,
    apiLevel: info.apiLevel,
    sourceDigest: info.sourceDigest,
    napiVersion: info.napiVersion,
    builtWithNode: process.version,
    release: info.releaseEligible === true,
    provenance: {
      cCompiler: info.cCompiler ?? null,
      buildType: info.buildType ?? 'Release',
    },
    files,
  };
  writeFileSync(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function emitPrebuilt(fromDir = join(PACKAGE_DIR, 'build', 'Release')) {
  const triplet = shippedTripletFor() ?? `${process.platform}-${process.arch}-node${process.versions.modules}`;
  const target = join(PREBUILT_ROOT, triplet);
  mkdirSync(target, { recursive: true });
  for (const name of runtimeFiles(target)) rmSync(join(target, name));
  for (const name of runtimeFiles(fromDir)) copyFileSync(join(fromDir, name), join(target, name));
  const manifest = writeManifest(target);
  return { triplet, target, manifest };
}

export function checkTriplet(triplet, expected, root = PREBUILT_ROOT) {
  const dir = join(root, triplet);
  if (!existsSync(join(dir, ADDON_FILE))) return { triplet, status: 'missing', detail: `no ${ADDON_FILE}` };
  const manifestPath = join(dir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) return { triplet, status: 'pending-rebuild', detail: 'no manifest.json' };
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return { triplet, status: 'corrupt', detail: `unreadable manifest.json: ${error.message}` };
  }
  const target = parseTriplet(triplet);
  if (!target) return { triplet, status: 'wrong-platform', detail: 'invalid triplet name' };
  if (manifest.platform !== target.platform || manifest.arch !== target.arch) {
    return { triplet, status: 'wrong-platform', detail: `manifest is for ${manifest.platform}-${manifest.arch}` };
  }
  const present = runtimeFiles(dir);
  const runtimeProblems = checkRuntimeSet(dir, target.platform, target.arch, present);
  if (runtimeProblems.length) return { triplet, status: 'invalid-runtime', detail: runtimeProblems.join('; ') };

  const problems = [];
  const recorded = Object.keys(manifest.files ?? {}).sort();
  for (const name of recorded) {
    if (!present.includes(name)) problems.push(`${name} missing`);
    else if (sha256File(join(dir, name)) !== manifest.files[name].sha256) problems.push(`${name} hash differs from manifest`);
  }
  if (!recorded.includes(ADDON_FILE)) problems.push(`manifest does not record ${ADDON_FILE}`);
  else if (
    typeof manifest.sourceDigest === 'string' &&
    manifest.sourceDigest &&
    !readFileSync(join(dir, ADDON_FILE)).includes(Buffer.from(manifest.sourceDigest, 'latin1'))
  ) {
    problems.push(`${ADDON_FILE} does not embed the manifest sourceDigest`);
  }
  if (problems.length) return { triplet, status: 'corrupt', detail: problems.join('; ') };

  if (manifest.sourceDigest !== expected.sourceDigest) {
    return {
      triplet,
      status: 'pending-rebuild',
      detail: `sourceDigest ${String(manifest.sourceDigest).slice(0, 12)} != ${expected.sourceDigest.slice(0, 12)}`,
    };
  }
  if (manifest.apiLevel !== expected.apiLevel) {
    return { triplet, status: 'pending-rebuild', detail: `apiLevel ${manifest.apiLevel} != ${expected.apiLevel}` };
  }
  return {
    triplet,
    status: 'ok',
    detail: `digest ${manifest.sourceDigest.slice(0, 12)}, api ${manifest.apiLevel}, ${manifest.provenance?.cCompiler ?? 'unknown'}`,
  };
}

export function checkManifests({ root = PREBUILT_ROOT } = {}) {
  const expected = {
    sourceDigest: computeBindingDigest(),
    apiLevel: expectedApiLevel(),
  };
  return {
    expected,
    results: SHIPPED_TRIPLETS.map((triplet) => checkTriplet(triplet, expected, root)),
  };
}

export function printManifestReport({ expected, results }, log = console.log) {
  log(`[transfer-fs] binding source digest ${expected.sourceDigest} (api ${expected.apiLevel})`);
  for (const r of results) {
    log(`  ${r.status === 'ok' ? '✓' : '✗'} ${r.triplet.padEnd(22)} ${r.status.padEnd(16)} ${r.detail}`);
  }
  const bad = results.filter((r) => r.status !== 'ok');
  log(`[transfer-fs] ${results.length - bad.length}/${results.length} prebuilts match the binding sources`);
  return bad.length === 0;
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const [command, arg] = process.argv.slice(2);
  if (command === 'write' && arg) {
    const manifest = writeManifest(resolve(arg));
    console.log(`[transfer-fs] wrote ${join(arg, MANIFEST_FILE)} (digest ${manifest.sourceDigest})`);
  } else if (command === 'emit') {
    const { target, manifest } = emitPrebuilt(arg ? resolve(arg) : undefined);
    console.log(`[transfer-fs] emitted prebuilt → ${target} (digest ${manifest.sourceDigest})`);
  } else if (command === 'check') {
    if (!printManifestReport(checkManifests())) process.exit(1);
  } else {
    console.error('usage: prebuilt-manifest.mjs write <dir> | emit [<from>] | check');
    process.exit(2);
  }
}
