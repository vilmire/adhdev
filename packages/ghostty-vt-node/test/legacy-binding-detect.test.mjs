// index.js must load a pre-viewport binary (API level 1) without throwing and
// report the missing surface through `capabilities`, so callers treat the
// exact-read path as unavailable instead of crashing on it. The child process
// swaps the `.node` loader for a JS stand-in with the API-level-1 shape.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

const indexPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js');

function loadWithStandIn(standIn) {
    const script = `
        require.extensions['.node'] = (module) => { module.exports = (${standIn})(); };
        const binding = require(${JSON.stringify(indexPath)});
        const terminal = binding.createTerminal({ cols: 4, rows: 2, scrollback: 0 });
        console.log(JSON.stringify({
            capabilities: binding.capabilities,
            bindingInfo: binding.bindingInfo,
            getViewport: typeof terminal.getViewport,
            readRow: typeof terminal.readRow,
            legacy: terminal.formatPlainText({ trim: false }),
        }));
    `;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim().split('\n').pop());
}

const legacyHandle = `({
    write() {}, resize() {}, formatVT: () => '', getCursorPosition: () => ({ col: 0, row: 0 }), dispose() {},
    formatPlainText: () => 'legacy',
})`;

it('an API level 1 binary loads with capabilities.viewport === false', () => {
    const report = loadWithStandIn(`() => ({ createTerminal: () => ${legacyHandle} })`);
    assert.deepEqual(report.capabilities, { viewport: false });
    assert.equal(report.bindingInfo.apiLevel, 1);
    assert.equal(report.bindingInfo.sourceDigest, null);
    assert.equal(report.getViewport, 'undefined');
    assert.equal(report.readRow, 'undefined');
    assert.equal(report.legacy, 'legacy');
});

it('a binary claiming level 2 but missing a method is still not viewport-capable', () => {
    const report = loadWithStandIn(`() => ({
        getBindingInfo: () => ({ apiLevel: 2, sourceDigest: 'x', ghosttyRevision: 'y', napiVersion: 8 }),
        createTerminal: () => Object.assign(${legacyHandle}, { getViewport() {} }),
    })`);
    assert.deepEqual(report.capabilities, { viewport: false });
    assert.equal(report.bindingInfo.apiLevel, 2);
});
