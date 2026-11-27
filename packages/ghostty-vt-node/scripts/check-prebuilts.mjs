#!/usr/bin/env node
// Release-safety gate for the committed ghostty-vt-node prebuilts. Four
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
//                  the release job checks every committed prebuilt it is about to publish.
//   (d) host-paths every shipped native file is free of absolute home-directory
//                  paths (ASCII and UTF-16LE), see scripts/host-path-scan.mjs.
//
//   node scripts/check-prebuilts.mjs [--all-present]
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PACKAGE_DIR } from './binding-digest.mjs';
import { printHostPathReport, scanHostPaths } from './host-path-scan.mjs';
import { PREBUILT_ROOT, checkManifests, printManifestReport, shippedTripletFor } from './prebuilt-manifest.mjs';
import { printVerifyReport, verifyPrebuilt } from './verify-prebuilt.mjs';

const WORKFLOW_DIR = join(PACKAGE_DIR, '..', '..', '.github', 'workflows');

function workflowJob(workflow, name) {
    const normalized = workflow.replace(/\r\n/g, '\n');
    const jobs = normalized.match(/^jobs:[ \t]*\n([\s\S]*?)(?=^\w|$(?![\s\S]))/m)?.[1] ?? '';
    return jobs.match(new RegExp(`^  ${name}:[ \\t]*\\n([\\s\\S]*?)(?=^  \\S|$(?![\\s\\S]))`, 'm'))?.[1] ?? '';
}

function checkExactHostPrebuilt() {
    const triplet = shippedTripletFor();
    if (!triplet) {
        console.log(`[ghostty-vt] no shipped prebuilt for ${process.platform}-${process.arch}; exact check runs on darwin-arm64 / linux-x64 / win32-x64`);
        return true;
    }
    // (d) scans every triplet, including this one.
    return printVerifyReport(verifyPrebuilt(join(PREBUILT_ROOT, triplet), { hostPathScan: false }));
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

    // A Windows checkout (core.autocrlf) has CRLF line endings.
    const buildStep = native.match(/- name: Build ghostty-vt-node\r?\n([\s\S]*?)(?=\r?\n {6}- name:)/);
    const buildText = buildStep ? buildStep[1] : '';
    const forced = /ADHDEV_GHOSTTY_VT_FORCE_COMPILE:\s*['"]?1['"]?/.test(buildText) || /npm run rebuild -w packages\/ghostty-vt-node/.test(buildText);
    // The zig version comes from toolchain.json (the pin CMake enforces and the
    // release gate compares), never from a literal in the workflow.
    const zigStep = native.match(/- name: Setup Zig\r?\n([\s\S]*?)(?=\r?\n {6}- name:)/);
    const zigFromPin = !!zigStep && /version:\s*\$\{\{\s*steps\.toolchain\.outputs\.zig\s*\}\}/.test(zigStep[1])
        && /id: toolchain[\s\S]*?packages\/ghostty-vt-node\/toolchain\.json/.test(native);
    findings.push(['native build installs the zig pinned in toolchain.json', zigFromPin, zigStep ? zigStep[1].trim().replace(/\s+/g, ' ') : 'no "Setup Zig" step']);
    // A restored zig cache is mutable state from another run; release artifacts
    // must not see one (setup-zig caches by default). No other step may
    // restore a cache path that zig reads either.
    const zigNoCache = !!zigStep && /use-cache:\s*false\b/.test(zigStep[1]);
    const restoresZigCache = /actions\/cache@[\s\S]*?(zig|ZIG_)/i.test(native) || /ZIG_(GLOBAL|LOCAL)_CACHE_DIR/.test(native);
    findings.push(['native build restores no zig cache', zigNoCache && !restoresZigCache,
        `setup-zig use-cache: ${zigNoCache ? 'false' : 'not disabled'}${restoresZigCache ? '; another step restores or points at a zig cache' : ''}`]);
    findings.push(['native build forces a compile', forced, buildStep ? buildText.trim().replace(/\s+/g, ' ') : 'no "Build ghostty-vt-node" step']);
    findings.push(['native build verifies the exact staged artifact', /scripts\/verify-prebuilt\.mjs "?dist-prebuilt\//.test(native), 'verify-prebuilt.mjs on dist-prebuilt/<triplet>']);
    findings.push(['native build stamps a manifest from the built binary', /scripts\/prebuilt-manifest\.mjs write "?dist-prebuilt\//.test(native), 'prebuilt-manifest.mjs write dist-prebuilt/<triplet>']);
    const publish = workflowJob(ci, 'publish');
    const gate = '        run: bash packages/ghostty-vt-node/scripts/check-release-prebuilts.sh';
    const publishLines = publish.split('\n').filter((line) => !/^\s*#/.test(line));
    const publishSteps = publishLines.join('\n').split(/^      - /m).slice(1);
    const downloadSteps = publishSteps.filter((step) => /uses:\s*actions\/download-artifact@/.test(step));
    findings.push(['release gate checks committed prebuilts', publishLines.includes(gate), 'publish runs check-release-prebuilts.sh']);
    const replacesPrebuilts = publishLines.some((line) => line !== gate
        && !/^\s*- name:/.test(line)
        && /prebuilt|\bgh\s+run\s+download\b|\bgh\s+api\b/i.test(line));
    const onlyDistDownload = downloadSteps.length === 1
        && /^        with:\n          name: publish-artifacts\n          path: packages\s*$/m.test(downloadSteps[0])
        && !/^          (?:pattern|run-id|artifact-ids|github-token|repository):/m.test(downloadSteps[0]);
    const build = workflowJob(ci, 'build');
    const uploadPaths = build.match(/^          path: \|\r?\n((?: {12}\S[^\n]*\n)+)/m)?.[1] ?? '';
    const distPaths = ['session-host-core', 'session-host-daemon', 'mcp-server', 'daemon-core', 'daemon-standalone', 'web-standalone']
        .map((name) => `packages/${name}/dist`).sort().join('\n');
    findings.push(['publish downloads only build dist', !replacesPrebuilts && onlyDistDownload
        && uploadPaths.trim().split(/\n/).map((line) => line.trim()).sort().join('\n') === distPaths,
    'publish-artifacts is same-run dist only; no Ghostty replacement']);
    const windows = workflowJob(native, 'native-build').split(/^          - runner: /m).slice(1)
        .filter((entry) => /^            platform: win32\s*$/m.test(entry));
    findings.push(['Windows native build uses windows-2022', windows.length === 1 && windows[0].startsWith('windows-2022\n'),
        'Windows x64 must use the VS 2022 runner']);

    const plan = spawnSync(process.execPath, [join(packageDir, 'scripts', 'build-or-use-prebuilt.mjs'), '--plan'], {
        cwd: packageDir,
        encoding: 'utf8',
        env: { ...process.env, ADHDEV_GHOSTTY_VT_FORCE_COMPILE: '1' },
        windowsHide: true,
    });
    const planLine = (plan.stdout || '').trim().split('\n').pop() || (plan.stderr || '').trim();
    // A forced compile must be a clean `cmake-js rebuild`, never an incremental
    // compile that could reuse a previous build directory's outputs.
    findings.push(['build script honours ADHDEV_GHOSTTY_VT_FORCE_COMPILE with a clean rebuild', /plan: compile \(cmake-js rebuild\)/.test(planLine), planLine]);
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
    console.log('── (d) shipped native files carry no host paths');
    results.hostPaths = printHostPathReport(scanHostPaths());
    const failed = Object.entries(results).filter(([, ok]) => !ok).map(([name]) => name);
    if (failed.length) {
        console.error(`✗ ghostty-vt-node prebuilt gate failed: ${failed.join(', ')}`);
        process.exit(1);
    }
    console.log('✓ ghostty-vt-node prebuilt gate passed');
}
