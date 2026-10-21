#!/usr/bin/env node
// Per-platform prebuilt manifests: prebuilt/<triplet>/manifest.json records the
// binding source digest and API level the binary reports about ITSELF (read
// from the compiled addon, never from the current sources) plus the sha256 of
// every runtime file in the directory. `check` compares each shipped triplet
// against the sources in this checkout, so editing the bridge/addon makes every
// prebuilt "pending rebuild" until it is rebuilt on its own platform.
//
//   node scripts/prebuilt-manifest.mjs write <dir>     # stamp a directory (loads its addon)
//   node scripts/prebuilt-manifest.mjs emit [<from>]   # copy build/Release into the shipped
//                                                      # triplet for this platform-arch + stamp
//   node scripts/prebuilt-manifest.mjs check [--all-present]
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PACKAGE_DIR, computeBindingDigest, pinnedGhosttyRevision } from './binding-digest.mjs';

export const PREBUILT_ROOT = join(PACKAGE_DIR, 'prebuilt');
export const ADDON_FILE = 'ghostty_vt_node.node';
export const MANIFEST_FILE = 'manifest.json';
// The addon plus its co-located runtime libs. Matches build-or-use-prebuilt.mjs.
export const RUNTIME_FILE_PATTERN = /\.(node|dylib|so|so\.\d.*|dll)$/;
// The committed prebuilt set (see .gitignore). One N-API binary per
// platform-arch serves every Node ABI; the node137 name is only an address.
export const SHIPPED_TRIPLETS = ['darwin-arm64-node137', 'linux-x64-node137', 'win32-x64-node137'];

const requireNative = createRequire(import.meta.url);

export function expectedApiLevel(packageDir = PACKAGE_DIR) {
    const header = readFileSync(join(packageDir, 'src', 'ghostty_bridge.h'), 'utf8');
    const match = header.match(/#define ADHDEV_GHOSTTY_API_LEVEL (\d+)/);
    if (!match) throw new Error('src/ghostty_bridge.h does not define ADHDEV_GHOSTTY_API_LEVEL');
    return Number(match[1]);
}

export function shippedTripletFor(platform = process.platform, arch = process.arch) {
    return SHIPPED_TRIPLETS.find((name) => name.startsWith(`${platform}-${arch}-`)) ?? null;
}

const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function runtimeFiles(dir) {
    return readdirSync(dir).filter((name) => RUNTIME_FILE_PATTERN.test(name)).sort();
}

// Loads the exact addon in `dir` (no package-level fallback) and returns what
// it reports about itself. Binaries predating getBindingInfo report level 1.
export function readBinaryInfo(dir) {
    const addon = requireNative(resolve(dir, ADDON_FILE));
    if (typeof addon.getBindingInfo !== 'function') {
        return { apiLevel: 1, sourceDigest: null, ghosttyRevision: null, napiVersion: null };
    }
    return addon.getBindingInfo();
}

export function writeManifest(dir) {
    const info = readBinaryInfo(dir);
    if (!info.sourceDigest) throw new Error(`${dir}: addon does not embed a binding source digest (api level ${info.apiLevel})`);
    const files = {};
    for (const name of runtimeFiles(dir)) {
        const file = join(dir, name);
        files[name] = { sha256: sha256File(file), size: statSync(file).size };
    }
    const manifest = {
        schema: 1,
        platform: process.platform,
        arch: process.arch,
        apiLevel: info.apiLevel,
        sourceDigest: info.sourceDigest,
        ghosttyRevision: info.ghosttyRevision,
        napiVersion: info.napiVersion,
        builtWithNode: process.version,
        files,
    };
    writeFileSync(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
}

const LINUX_SONAME = 'libghostty-vt.so.0';
const LINUX_VERSIONED = /^libghostty-vt\.so\.0\.\d+\.\d+$/;

export function emitPrebuilt(fromDir = join(PACKAGE_DIR, 'build', 'Release')) {
    const triplet = shippedTripletFor() ?? `${process.platform}-${process.arch}-node${process.versions.modules}`;
    const target = join(PREBUILT_ROOT, triplet);
    mkdirSync(target, { recursive: true });
    // Replace the whole runtime set: a leftover library from the previous build
    // (e.g. the Linux SONAME file, which the build output may not contain) would
    // otherwise be shipped next to an addon built against a different one.
    for (const name of runtimeFiles(target)) rmSync(join(target, name));
    for (const name of runtimeFiles(fromDir)) copyFileSync(join(fromDir, name), join(target, name));
    const versioned = readdirSync(target).find((name) => LINUX_VERSIONED.test(name));
    if (versioned && !existsSync(join(target, LINUX_SONAME))) copyFileSync(join(target, versioned), join(target, LINUX_SONAME));
    const manifest = writeManifest(target);
    return { triplet, target, manifest };
}

// Status of one prebuilt directory against the current sources:
//   ok              manifest matches the sources and every file hash matches
//   pending-rebuild built from other sources (or never stamped): rebuild it on its platform
//   corrupt         files differ from what the manifest recorded
export function checkTriplet(triplet, expected) {
    const dir = join(PREBUILT_ROOT, triplet);
    if (!existsSync(join(dir, ADDON_FILE))) return { triplet, status: 'missing', detail: `no ${ADDON_FILE}` };
    const manifestPath = join(dir, MANIFEST_FILE);
    if (!existsSync(manifestPath)) return { triplet, status: 'pending-rebuild', detail: 'no manifest.json (binary predates the current binding sources)' };
    let manifest;
    try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
        return { triplet, status: 'corrupt', detail: `unreadable manifest.json: ${error.message}` };
    }
    const problems = [];
    const present = runtimeFiles(dir);
    const recorded = Object.keys(manifest.files ?? {}).sort();
    for (const name of recorded) {
        if (!present.includes(name)) problems.push(`${name} missing`);
        else if (sha256File(join(dir, name)) !== manifest.files[name].sha256) problems.push(`${name} hash differs from manifest`);
    }
    // An unrecorded file is accepted only as a byte-identical alias of a recorded
    // one: release CI materializes the Linux SONAME copy after artifacts drop
    // symlinks (ensure-prebuilt-sonames.mjs).
    const recordedHashes = new Set(recorded.map((name) => manifest.files[name].sha256));
    for (const name of present) {
        if (!recorded.includes(name) && !recordedHashes.has(sha256File(join(dir, name)))) problems.push(`${name} not in manifest`);
    }
    if (!recorded.includes(ADDON_FILE)) problems.push(`manifest does not record ${ADDON_FILE}`);
    if (problems.length) return { triplet, status: 'corrupt', detail: problems.join('; ') };

    const stale = [];
    if (manifest.sourceDigest !== expected.sourceDigest) stale.push(`sourceDigest ${String(manifest.sourceDigest).slice(0, 12)} != ${expected.sourceDigest.slice(0, 12)}`);
    if (manifest.apiLevel !== expected.apiLevel) stale.push(`apiLevel ${manifest.apiLevel} != ${expected.apiLevel}`);
    if (manifest.ghosttyRevision !== expected.ghosttyRevision) stale.push(`ghosttyRevision ${manifest.ghosttyRevision} != ${expected.ghosttyRevision}`);
    if (stale.length) return { triplet, status: 'pending-rebuild', detail: stale.join('; ') };
    return { triplet, status: 'ok', detail: `digest ${manifest.sourceDigest.slice(0, 12)}, api ${manifest.apiLevel}, node ${manifest.builtWithNode}` };
}

export function currentExpectation(packageDir = PACKAGE_DIR) {
    return {
        sourceDigest: computeBindingDigest(packageDir),
        apiLevel: expectedApiLevel(packageDir),
        ghosttyRevision: pinnedGhosttyRevision(packageDir),
    };
}

export function checkManifests({ allPresent = false } = {}) {
    const expected = currentExpectation();
    const triplets = new Set(SHIPPED_TRIPLETS);
    if (allPresent && existsSync(PREBUILT_ROOT)) {
        for (const name of readdirSync(PREBUILT_ROOT)) {
            if (existsSync(join(PREBUILT_ROOT, name, ADDON_FILE))) triplets.add(name);
        }
    }
    return { expected, results: [...triplets].sort().map((triplet) => checkTriplet(triplet, expected)) };
}

export function printManifestReport({ expected, results }, log = console.log) {
    log(`[ghostty-vt] binding source digest ${expected.sourceDigest} (api ${expected.apiLevel}, ghostty ${expected.ghosttyRevision.slice(0, 12)})`);
    for (const r of results) log(`  ${r.status === 'ok' ? '✓' : '✗'} ${r.triplet.padEnd(22)} ${r.status.padEnd(16)} ${r.detail}`);
    const bad = results.filter((r) => r.status !== 'ok');
    log(`[ghostty-vt] ${results.length - bad.length}/${results.length} prebuilts match the binding sources`);
    return bad.length === 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    const [command, arg] = process.argv.slice(2);
    if (command === 'write' && arg) {
        const manifest = writeManifest(resolve(arg));
        console.log(`[ghostty-vt] wrote ${join(arg, MANIFEST_FILE)} (digest ${manifest.sourceDigest}, api ${manifest.apiLevel})`);
    } else if (command === 'emit') {
        const { target, manifest } = emitPrebuilt(arg ? resolve(arg) : undefined);
        console.log(`[ghostty-vt] emitted prebuilt → ${target} (digest ${manifest.sourceDigest}, api ${manifest.apiLevel})`);
    } else if (command === 'check') {
        if (!printManifestReport(checkManifests({ allPresent: process.argv.includes('--all-present') }))) process.exit(1);
    } else {
        console.error('usage: prebuilt-manifest.mjs write <dir> | emit [<from>] | check [--all-present]');
        process.exit(2);
    }
}
