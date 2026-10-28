#!/usr/bin/env node
// Byte-level host-path scan for shipped transfer_fs_node.node binaries (ASCII + UTF-16LE).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PACKAGE_DIR } from './binding-digest.mjs';

export const PREBUILT_ROOT = join(PACKAGE_DIR, 'prebuilt');
export const RUNTIME_FILE_PATTERN = /\.(node|dylib|so|so\.\d.*|dll)$/;
export const ALLOWED_ACCOUNTS = ['runner', 'runneradmin'];
export const DENYLIST_ENV = 'ADHDEV_TRANSFER_FS_HOST_PATH_DENYLIST';
export const DENYLIST_FILE = join(PACKAGE_DIR, '.host-path-denylist');

const SEGMENT = String.raw`([^\\/\x00-\x1f"'<>|*?:]{1,128})`;
const POSIX_HOME_ROOTS = ['U' + 'sers', 'home'].join('|');
const WIN_USERS_ROOT = 'u' + 'sers';
const HOME_PATHS = [
  new RegExp(String.raw`(?<![A-Za-z]:)/(?:${POSIX_HOME_ROOTS})/${SEGMENT}/`, 'g'),
  new RegExp(String.raw`[A-Za-z]:[\\/]${WIN_USERS_ROOT}[\\/]${SEGMENT}[\\/]`, 'gi'),
];
const PREFIX_WIDTH = 48;

export function loadDenylist(env = process.env) {
  const file = env[DENYLIST_ENV] || DENYLIST_FILE;
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function* decodedViews(buffer) {
  yield { encoding: 'ascii', text: buffer.toString('latin1'), offsetOf: (index) => index };
  for (const shift of [0, 1]) {
    const slice = buffer.subarray(shift, shift + ((buffer.length - shift) & ~1));
    yield { encoding: 'utf16le', text: slice.toString('utf16le'), offsetOf: (index) => shift + index * 2 };
  }
}

export function scanBuffer(buffer, { denylist = [] } = {}) {
  const hits = [];
  const deny = denylist.length ? new RegExp(denylist.map(escapeRegExp).join('|'), 'gi') : null;
  for (const view of decodedViews(buffer)) {
    for (const pattern of HOME_PATHS) {
      for (const match of view.text.matchAll(pattern)) {
        if (ALLOWED_ACCOUNTS.includes(match[1].toLowerCase())) continue;
        hits.push({
          offset: view.offsetOf(match.index),
          encoding: view.encoding,
          kind: 'home-path',
          prefix: match[0].slice(0, PREFIX_WIDTH),
        });
      }
    }
    if (!deny) continue;
    for (const match of view.text.matchAll(deny)) {
      hits.push({
        offset: view.offsetOf(match.index),
        encoding: view.encoding,
        kind: 'denylist',
        prefix: match[0].slice(0, PREFIX_WIDTH),
      });
    }
  }
  return hits.sort((a, b) => a.offset - b.offset);
}

export function runtimeFilesIn(dir) {
  return readdirSync(dir)
    .filter((name) => RUNTIME_FILE_PATTERN.test(name) && statSync(join(dir, name)).isFile())
    .sort();
}

export function shippedPrebuiltDirs(root = PREBUILT_ROOT) {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((name) => join(root, name))
    .filter((dir) => statSync(dir).isDirectory())
    .sort();
}

export function scanHostPaths(dirs = shippedPrebuiltDirs(), { denylist = loadDenylist() } = {}) {
  const results = [];
  for (const dir of dirs) {
    for (const name of runtimeFilesIn(dir)) {
      const file = join(dir, name);
      results.push({ file, hits: scanBuffer(readFileSync(file), { denylist }) });
    }
  }
  return results;
}

export function printHostPathReport(results, log = console.log, { maxHitsPerFile = 10 } = {}) {
  for (const { file, hits } of results) {
    const shown = relative(PACKAGE_DIR, file);
    log(`  ${hits.length ? '✗' : '✓'} ${shown.startsWith('..') ? file : shown}: ${hits.length} host-path hit(s)`);
    for (const hit of hits.slice(0, maxHitsPerFile)) {
      log(`      offset 0x${hit.offset.toString(16)} ${hit.encoding} ${hit.kind}: ${JSON.stringify(hit.prefix)}`);
    }
    if (hits.length > maxHitsPerFile) log(`      … ${hits.length - maxHitsPerFile} more`);
  }
  const bad = results.filter((r) => r.hits.length);
  log(`[transfer-fs] ${results.length - bad.length}/${results.length} native files free of host paths`);
  return results.length > 0 && bad.length === 0;
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const dirs = process.argv.slice(2).map((dir) => resolve(dir));
  if (!printHostPathReport(scanHostPaths(dirs.length ? dirs : undefined))) process.exit(1);
}
