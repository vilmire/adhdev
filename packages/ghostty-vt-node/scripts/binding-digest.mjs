#!/usr/bin/env node
// Binding source digest: the identity of the sources a native binary was
// compiled from. CMakeLists.txt computes the same value at configure time and
// embeds it in the addon (getBindingInfo().sourceDigest), so a prebuilt can be
// checked against the sources in this checkout.
//
// Algorithm (keep in sync with CMakeLists.txt): for each input in order,
// "<path>:<sha256 of content with CRLF -> LF>\n"; digest = sha256 of the
// concatenation. LF normalization keeps a win32 autocrlf checkout from
// reporting a different digest for identical sources.
//
//   node scripts/binding-digest.mjs        # prints the digest
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

export const BINDING_DIGEST_INPUTS = [
    'CMakeLists.txt',
    'toolchain.json',
    'src/addon.cc',
    'src/ghostty_bridge.c',
    'src/ghostty_bridge.h',
    'scripts/clean-dir.cjs',
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

// The zig version toolchain.json pins: the single source the native workflow
// installs, CMakeLists.txt enforces and the release gate compares against.
export function pinnedZigVersion(packageDir = PACKAGE_DIR) {
    const { zig } = JSON.parse(readFileSync(join(packageDir, 'toolchain.json'), 'utf8'));
    if (typeof zig !== 'string' || !/^\d+\.\d+\.\d+$/.test(zig)) throw new Error('toolchain.json does not pin "zig" to x.y.z');
    return zig;
}

// The ghostty revision CMakeLists.txt pins by default.
export function pinnedGhosttyRevision(packageDir = PACKAGE_DIR) {
    const cmake = readFileSync(join(packageDir, 'CMakeLists.txt'), 'utf8');
    const match = cmake.match(/set\(GHOSTTY_GIT_TAG "([0-9a-f]{40})"/);
    const pin = cmake.match(/set\(ADHDEV_GHOSTTY_PINNED_REVISION "([0-9a-f]{40})"\)/);
    if (!match || !pin) throw new Error('CMakeLists.txt does not pin GHOSTTY_GIT_TAG / ADHDEV_GHOSTTY_PINNED_REVISION to a 40-hex revision');
    if (match[1] !== pin[1]) throw new Error(`CMakeLists.txt pins disagree: GHOSTTY_GIT_TAG ${match[1]} != ADHDEV_GHOSTTY_PINNED_REVISION ${pin[1]}`);
    return pin[1];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    console.log(computeBindingDigest());
}
