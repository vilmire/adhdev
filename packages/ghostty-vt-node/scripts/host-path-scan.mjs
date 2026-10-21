#!/usr/bin/env node
// Byte-level host-path scan for shipped native binaries. Compilers and zig embed
// absolute build/cache paths (rpath, debug/source strings), so a prebuilt built
// inside a home directory publishes that user's account name. Every runtime file
// (.node/.dylib/.so*/.dll) is scanned as raw bytes, both as ASCII/UTF-8 and as
// UTF-16LE (PE resources and MSVC strings are wide), for
//
//   /Users/<seg>/   /home/<seg>/   X:\Users\<seg>\   X:/Users/<seg>/
//
// where <seg> is not a CI runner account (ALLOWED_ACCOUNTS). Build from a
// neutral directory (/tmp/..., C:\<dir>) with a neutral zig cache instead.
//
// An optional denylist of extra literals (hostnames, account names) is read from
// the file named by ADHDEV_GHOSTTY_HOST_PATH_DENYLIST, or from the untracked
// `.host-path-denylist` next to package.json. It is never committed: this script
// itself must stay free of personal identifiers.
//
//   node scripts/host-path-scan.mjs [<dir>...]   # default: every prebuilt/<triplet>
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PACKAGE_DIR } from './binding-digest.mjs';
import { PREBUILT_ROOT, RUNTIME_FILE_PATTERN } from './prebuilt-manifest.mjs';

export const ALLOWED_ACCOUNTS = ['runner', 'runneradmin'];
export const DENYLIST_ENV = 'ADHDEV_GHOSTTY_HOST_PATH_DENYLIST';
export const DENYLIST_FILE = join(PACKAGE_DIR, '.host-path-denylist');

const SEGMENT = String.raw`([^\\/\x00-\x1f"'<>|*?:]{1,128})`;
// POSIX homes are case-sensitive (avoids URL paths like /api/users/<id>/);
// Windows drive paths are not, and take either separator.
const HOME_PATHS = [
    new RegExp(String.raw`(?<![A-Za-z]:)/(?:Users|home)/${SEGMENT}/`, 'g'),
    new RegExp(String.raw`[A-Za-z]:[\\/]users[\\/]${SEGMENT}[\\/]`, 'gi'),
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

// Decoded views of the buffer whose character index maps back to a byte offset.
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
                hits.push({ offset: view.offsetOf(match.index), encoding: view.encoding, kind: 'home-path', prefix: match[0].slice(0, PREFIX_WIDTH) });
            }
        }
        if (!deny) continue;
        for (const match of view.text.matchAll(deny)) {
            hits.push({ offset: view.offsetOf(match.index), encoding: view.encoding, kind: 'denylist', prefix: match[0].slice(0, PREFIX_WIDTH) });
        }
    }
    return hits.sort((a, b) => a.offset - b.offset);
}

export function runtimeFilesIn(dir) {
    return readdirSync(dir).filter((name) => RUNTIME_FILE_PATTERN.test(name) && statSync(join(dir, name)).isFile()).sort();
}

export function shippedPrebuiltDirs(root = PREBUILT_ROOT) {
    if (!existsSync(root)) return [];
    return readdirSync(root).map((name) => join(root, name)).filter((dir) => statSync(dir).isDirectory()).sort();
}

// Returns [{ file, hits }] for every runtime file in `dirs`.
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
    log(`[ghostty-vt] ${results.length - bad.length}/${results.length} native files free of host paths (allowed accounts: ${ALLOWED_ACCOUNTS.join(', ')})`);
    return results.length > 0 && bad.length === 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    const dirs = process.argv.slice(2).map((dir) => resolve(dir));
    if (!printHostPathReport(scanHostPaths(dirs.length ? dirs : undefined))) process.exit(1);
}
