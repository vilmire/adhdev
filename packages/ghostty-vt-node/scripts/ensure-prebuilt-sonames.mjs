#!/usr/bin/env node
// Make every Linux prebuilt directory carry the SONAME file its addon links
// against (libghostty-vt.so.0). CI artifacts and npm tarballs drop symlinks, so
// a directory restored from an artifact has only libghostty-vt.so and
// libghostty-vt.so.0.1.0 — and the addon then fails to load on every Linux
// machine (v1.0.77). Copies the versioned file to the SONAME name when missing.
//
//   node scripts/ensure-prebuilt-sonames.mjs            # fix in place
//   node scripts/ensure-prebuilt-sonames.mjs --check    # fail if any is missing
//   ... --load   also require() the package and fail unless the binding loads
//                (only meaningful on a platform that has a prebuilt)
import { copyFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const prebuiltDir = join(pkgDir, 'prebuilt');
const check = process.argv.includes('--check');
const load = process.argv.includes('--load');
const SONAME = 'libghostty-vt.so.0';
const VERSIONED = /^libghostty-vt\.so\.0\.\d+\.\d+$/;

const problems = [];
for (const triplet of existsSync(prebuiltDir) ? readdirSync(prebuiltDir) : []) {
    if (!triplet.startsWith('linux-')) continue;
    const dir = join(prebuiltDir, triplet);
    if (!statSync(dir).isDirectory()) continue;
    if (existsSync(join(dir, SONAME))) continue;
    const versioned = readdirSync(dir).find((name) => VERSIONED.test(name));
    if (!versioned) { problems.push(`${triplet}: no ${SONAME} and no versioned library to copy`); continue; }
    if (check) { problems.push(`${triplet}: missing ${SONAME}`); continue; }
    copyFileSync(join(dir, versioned), join(dir, SONAME));
    console.log(`[ghostty-vt] ${triplet}: ${versioned} -> ${SONAME}`);
}

if (load) {
    try {
        const req = createRequire(join(pkgDir, 'index.js'));
        const mod = req(join(pkgDir, 'index.js'));
        if (!mod || (typeof mod !== 'object' && typeof mod !== 'function')) throw new Error('binding export is empty');
        console.log(`[ghostty-vt] binding loads on ${process.platform}-${process.arch} (abi ${process.versions.modules})`);
    } catch (error) {
        problems.push(`binding failed to load on ${process.platform}-${process.arch}: ${error?.message || error}`);
    }
}

if (problems.length) {
    for (const p of problems) console.error(`✗ ${p}`);
    process.exit(1);
}
if (check) console.log('[ghostty-vt] prebuilt SONAME check passed');
