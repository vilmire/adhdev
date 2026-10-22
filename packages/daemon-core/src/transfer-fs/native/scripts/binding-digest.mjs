#!/usr/bin/env node
// Binding source digest for transfer_fs_node.node.
// Keeps the exact LF-normalized SHA-256 contract as CMakeLists.txt.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

export const BINDING_DIGEST_INPUTS = [
  'CMakeLists.txt',
  'src/transfer_fs_napi.c',
];

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

export function computeBindingDigest(packageDir = PACKAGE_DIR) {
  let manifest = '';
  for (const input of BINDING_DIGEST_INPUTS) {
    const content = readFileSync(join(packageDir, input), 'utf8').replace(/\r\n/g, '\n');
    manifest += `${input}:${sha256(Buffer.from(content, 'utf8'))}\n`;
  }
  return sha256(Buffer.from(manifest, 'utf8'));
}

export function expectedApiLevel(packageDir = PACKAGE_DIR) {
  const cmake = readFileSync(join(packageDir, 'CMakeLists.txt'), 'utf8');
  const match = cmake.match(/set\(ADHDEV_TRANSFER_FS_API_LEVEL (\d+)\)/);
  if (!match) throw new Error('CMakeLists.txt does not define ADHDEV_TRANSFER_FS_API_LEVEL');
  return Number(match[1]);
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  console.log(computeBindingDigest());
}
