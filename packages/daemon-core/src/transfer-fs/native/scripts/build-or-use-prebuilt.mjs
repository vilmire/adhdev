#!/usr/bin/env node
// Build or use prebuilt for transfer_fs_node.node.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PACKAGE_DIR, computeBindingDigest } from './binding-digest.mjs';
import { ADDON_FILE } from './native-format.mjs';
import { PREBUILT_ROOT, emitPrebuilt, shippedTripletFor } from './prebuilt-manifest.mjs';

const outputDir = path.join(PACKAGE_DIR, 'build', 'Release');
const outputFile = path.join(outputDir, ADDON_FILE);
const triplet = `${process.platform}-${process.arch}-node${process.versions.modules}`;

function hasMatchingDigest(file) {
  if (!fs.existsSync(file)) return false;
  const expected = computeBindingDigest();
  return fs.readFileSync(file).includes(Buffer.from(expected, 'latin1'));
}

const forceCompile = process.env.ADHDEV_TRANSFER_FS_FORCE_COMPILE === '1';

if (!forceCompile) {
  if (hasMatchingDigest(outputFile)) {
    console.log(`[transfer-fs] keeping existing local build at ${outputFile}`);
    process.exit(0);
  }
  const shipped = shippedTripletFor();
  const prebuiltFile = shipped ? path.join(PREBUILT_ROOT, shipped, ADDON_FILE) : null;
  if (prebuiltFile && hasMatchingDigest(prebuiltFile)) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.copyFileSync(prebuiltFile, outputFile);
    console.log(`[transfer-fs] using prebuilt native binding from ${prebuiltFile}`);
    process.exit(0);
  }
}

const isWindows = process.platform === 'win32';
const command = isWindows ? (process.env.ComSpec || 'cmd.exe') : 'npx';
const args = isWindows
  ? ['/d', '/s', '/c', 'npx cmake-js rebuild']
  : ['cmake-js', 'rebuild'];

console.log(`[transfer-fs] compiling ${triplet} via ${command} ${args.join(' ')}`);
const result = spawnSync(command, args, {
  cwd: PACKAGE_DIR,
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
});

if ((result.status ?? 1) === 0 && process.env.ADHDEV_TRANSFER_FS_EMIT_PREBUILT === '1') {
  const { target, manifest } = emitPrebuilt(outputDir);
  console.log(`[transfer-fs] emitted prebuilt → ${target} (digest ${manifest.sourceDigest})`);
}

process.exit(result.status ?? 1);
