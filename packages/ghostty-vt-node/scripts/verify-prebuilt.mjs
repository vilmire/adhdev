#!/usr/bin/env node
// Exercise the EXACT addon in a directory — require()d by path, so neither the
// package loader's build/Release preference nor its same-platform fallback can
// substitute a different binary — and fail unless it is built from the binding
// sources in this checkout, by the pinned toolchain from a verified ghostty
// checkout (release eligible), and its viewport API behaves. Loading alone
// proves nothing about the API: a stale binary loads fine. Every native file in the
// directory is also byte-scanned for embedded home-directory paths.
//
//   node scripts/verify-prebuilt.mjs <dir>     # e.g. prebuilt/darwin-arm64-node137
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeBindingDigest, pinnedGhosttyRevision, pinnedZigVersion } from './binding-digest.mjs';
import { scanHostPaths } from './host-path-scan.mjs';
import { checkNativeFile } from './native-format.mjs';
import { ADDON_FILE, RUNTIME_FILE_PATTERN, expectedApiLevel } from './prebuilt-manifest.mjs';

const requireNative = createRequire(import.meta.url);

function expect(checks, name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    checks.push({ name, ok, detail: ok ? JSON.stringify(actual) : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}` });
    return ok;
}

function scanChecks(dir) {
    return scanHostPaths([dir]).map(({ file, hits }) => ({
        name: `no host paths in ${basename(file)}`,
        ok: hits.length === 0,
        detail: hits.length === 0
            ? 'clean (ASCII + UTF-16LE)'
            : hits.slice(0, 5).map((hit) => `0x${hit.offset.toString(16)} ${hit.encoding} ${JSON.stringify(hit.prefix)}`).join('; ') + (hits.length > 5 ? ` … +${hits.length - 5}` : ''),
    }));
}

export function verifyPrebuilt(dir, { hostPathScan = true } = {}) {
    // Scanned before loading: a binary that leaks paths fails even if it cannot load.
    const checks = hostPathScan ? scanChecks(dir) : [];
    for (const name of readdirSync(dir).filter((entry) => RUNTIME_FILE_PATTERN.test(entry)).sort()) {
        const problems = checkNativeFile(name, readFileSync(resolve(dir, name)), process.platform, process.arch);
        checks.push({ name: `native format of ${name}`, ok: problems.length === 0, detail: problems.length ? problems.join('; ') : `${process.platform}-${process.arch} shared library` });
    }
    const file = resolve(dir, ADDON_FILE);
    let addon;
    try {
        addon = requireNative(file);
    } catch (error) {
        checks.push({ name: 'load', ok: false, detail: error.message });
        return { file, checks };
    }
    if (typeof addon.getBindingInfo !== 'function') {
        checks.push({ name: 'getBindingInfo', ok: false, detail: 'missing: binary predates API level 2 (rebuild it)' });
        return { file, checks };
    }
    const info = addon.getBindingInfo();
    expect(checks, 'apiLevel', info.apiLevel, expectedApiLevel());
    expect(checks, 'sourceDigest matches sources', info.sourceDigest, computeBindingDigest());
    expect(checks, 'ghosttyRevision is the pin', info.ghosttyRevision, pinnedGhosttyRevision());
    expect(checks, 'built ghostty checkout is the pin', info.ghosttySourceRevision, pinnedGhosttyRevision());
    expect(checks, 'built ghostty checkout is clean', info.ghosttySourceClean, true);
    expect(checks, 'zig is the toolchain.json pin', info.zigVersion, pinnedZigVersion());
    expect(checks, 'release eligible (no provenance problems)', [info.releaseEligible, info.provenanceProblems], [true, []]);

    const terminal = addon.createTerminal({ cols: 12, rows: 4, scrollback: 100000 });
    try {
        for (const name of ['getViewport', 'readRow', 'scrollViewport']) {
            expect(checks, `${name} present`, typeof terminal[name], 'function');
        }
        if (checks.some((check) => !check.ok)) return { file, info, checks };

        terminal.write('old\r\n'.repeat(40) + '> FINAL');
        const view = terminal.getViewport({ includeRows: 'all', cells: true });
        expect(checks, 'scrollbar', view.scrollbar, { total: 41, offset: 37, len: 4 });
        expect(checks, 'cursor (active)', [view.cursorRow, view.cursorCol, view.cursorViewportRow], [3, 7, 3]);
        expect(checks, 'cursor row text', view.lines[view.cursorRow].text, '> FINAL');
        terminal.write('Z');
        const marked = terminal.getViewport({ includeRows: 'cursor' });
        expect(checks, 'marker lands on cursor row', marked.lines[0].text, '> FINALZ');
        terminal.scrollViewport('top');
        expect(checks, 'ACTIVE row survives viewport scroll', terminal.readRow(3).text, '> FINALZ');
        expect(checks, 'VIEWPORT row is history', terminal.readRow(3, { space: 'viewport' }).text, 'old');
        terminal.write('\x1bc\x1b[?1049hA한é');
        const alt = terminal.getViewport({ includeRows: 'cursor', cells: true });
        expect(checks, 'alternate screen', alt.activeScreen, 'alternate');
        expect(checks, 'cells', alt.lines[0].cells.slice(0, 4).map((cell) => [cell.text, cell.width, cell.wideKind]), [
            ['A', 1, 'narrow'], ['한', 2, 'wide'], ['', 0, 'spacer-tail'], ['é', 1, 'narrow'],
        ]);
        expect(checks, 'legacy formatter still works', terminal.formatPlainText({ trim: true }), 'A한é');
    } catch (error) {
        checks.push({ name: 'exercise', ok: false, detail: error.stack || String(error) });
    } finally {
        terminal.dispose();
    }
    return { file, info, checks };
}

export function printVerifyReport({ file, checks }, log = console.log) {
    log(`[ghostty-vt] exercising ${file}`);
    for (const check of checks) log(`  ${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}`);
    const ok = checks.length > 0 && checks.every((check) => check.ok);
    log(`[ghostty-vt] ${ok ? 'exact prebuilt verified' : 'exact prebuilt FAILED'}`);
    return ok;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    const dir = process.argv[2];
    if (!dir) {
        console.error('usage: verify-prebuilt.mjs <dir containing ghostty_vt_node.node>');
        process.exit(2);
    }
    if (!printVerifyReport(verifyPrebuilt(resolve(dir)))) process.exit(1);
}
