#!/usr/bin/env node
// Release-safety gate for the committed ghostty-vt-node prebuilts. Three
// checks, all printed, any failure fails the gate:
//
//   (a) manifests  every shipped triplet carries a manifest whose binding source
//                  digest / API level / ghostty pin match the sources in this
//                  checkout and whose file hashes match the files. A triplet
//                  built from older sources reports "pending-rebuild" — after a
//                  bridge/addon change the branch is not shippable until all
//                  three platforms are rebuilt and re-stamped.
//   (b) exact      the host platform's committed prebuilt, require()d by path,
//                  embeds the current digest and its viewport API behaves
//                  (loading alone proves nothing: a stale binary loads fine).
//   (c) native-ci  the native CI build compiles from source instead of copying
//                  the tracked prebuilt, and verifies + stamps what it built;
//                  the release job checks every prebuilt it is about to publish.
//
//   node scripts/check-prebuilts.mjs [--all-present]
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PACKAGE_DIR } from './binding-digest.mjs';
import { PREBUILT_ROOT, checkManifests, printManifestReport, shippedTripletFor } from './prebuilt-manifest.mjs';
import { printVerifyReport, verifyPrebuilt } from './verify-prebuilt.mjs';

const WORKFLOW_DIR = join(PACKAGE_DIR, '..', '..', '.github', 'workflows');

function checkExactHostPrebuilt() {
    const triplet = shippedTripletFor();
    if (!triplet) {
        console.log(`[ghostty-vt] no shipped prebuilt for ${process.platform}-${process.arch}; exact check runs on darwin-arm64 / linux-x64 / win32-x64`);
        return true;
    }
    return printVerifyReport(verifyPrebuilt(join(PREBUILT_ROOT, triplet)));
}

// Returns [name, ok, detail] rows.
export function nativeCiFindings(workflowDir = WORKFLOW_DIR, packageDir = PACKAGE_DIR) {
    const findings = [];
    const nativePath = join(workflowDir, 'ghostty-vt-node.yml');
    const ciPath = join(workflowDir, 'ci.yml');
    if (!existsSync(nativePath) || !existsSync(ciPath)) {
        return [['workflows present', false, `missing ${existsSync(nativePath) ? ciPath : nativePath}`]];
    }
    const native = readFileSync(nativePath, 'utf8');
    const ci = readFileSync(ciPath, 'utf8');

    const buildStep = native.match(/- name: Build ghostty-vt-node\n([\s\S]*?)(?=\n {6}- name:)/);
    const buildText = buildStep ? buildStep[1] : '';
    const forced = /ADHDEV_GHOSTTY_VT_FORCE_COMPILE:\s*['"]?1['"]?/.test(buildText) || /npm run rebuild -w packages\/ghostty-vt-node/.test(buildText);
    findings.push(['native build forces a compile', forced, buildStep ? buildText.trim().replace(/\s+/g, ' ') : 'no "Build ghostty-vt-node" step']);
    findings.push(['native build verifies the exact staged artifact', /scripts\/verify-prebuilt\.mjs "?dist-prebuilt\//.test(native), 'verify-prebuilt.mjs on dist-prebuilt/<triplet>']);
    findings.push(['native build stamps a manifest from the built binary', /scripts\/prebuilt-manifest\.mjs write "?dist-prebuilt\//.test(native), 'prebuilt-manifest.mjs write dist-prebuilt/<triplet>']);
    findings.push(['release gate checks every downloaded prebuilt', /scripts\/check-prebuilts\.mjs --all-present/.test(ci), 'ci.yml runs check-prebuilts.mjs --all-present']);

    const plan = spawnSync(process.execPath, [join(packageDir, 'scripts', 'build-or-use-prebuilt.mjs'), '--plan'], {
        cwd: packageDir,
        encoding: 'utf8',
        env: { ...process.env, ADHDEV_GHOSTTY_VT_FORCE_COMPILE: '1' },
        windowsHide: true,
    });
    const planLine = (plan.stdout || '').trim().split('\n').pop() || (plan.stderr || '').trim();
    findings.push(['build script honours ADHDEV_GHOSTTY_VT_FORCE_COMPILE', /plan: compile/.test(planLine), planLine]);
    return findings;
}

function checkNativeCi() {
    const findings = nativeCiFindings();
    console.log('[ghostty-vt] native CI build path');
    for (const [name, ok, detail] of findings) console.log(`  ${ok ? '✓' : '✗'} ${name}: ${detail}`);
    return findings.every(([, ok]) => ok);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    const allPresent = process.argv.includes('--all-present');
    const results = {};
    console.log('── (a) prebuilt manifests vs binding sources');
    results.manifests = printManifestReport(checkManifests({ allPresent }));
    console.log('── (b) exact host prebuilt exercises the new API');
    results.exact = checkExactHostPrebuilt();
    console.log('── (c) native CI compiles instead of copying');
    results.nativeCi = existsSync(WORKFLOW_DIR) ? checkNativeCi() : (console.log('[ghostty-vt] no .github/workflows next to this package (npm install); skipped'), true);
    const failed = Object.entries(results).filter(([, ok]) => !ok).map(([name]) => name);
    if (failed.length) {
        console.error(`✗ ghostty-vt-node prebuilt gate failed: ${failed.join(', ')}`);
        process.exit(1);
    }
    console.log('✓ ghostty-vt-node prebuilt gate passed');
}
