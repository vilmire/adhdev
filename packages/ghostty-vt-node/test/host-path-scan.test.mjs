// The prebuilt gate's host-path byte scan (scripts/host-path-scan.mjs) and the
// CRLF-tolerant native CI workflow parse in scripts/check-prebuilts.mjs.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { nativeCiFindings } from '../scripts/check-prebuilts.mjs';
import { scanBuffer, scanHostPaths } from '../scripts/host-path-scan.mjs';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflowDir = join(packageDir, '..', '..', '.github', 'workflows');

const hitsOf = (buffer, options) => scanBuffer(buffer, options).map(({ offset, encoding, kind, prefix }) => [offset, encoding, kind, prefix]);

it('flags POSIX and Windows home paths in ASCII with byte offsets', () => {
    assert.deepEqual(hitsOf(Buffer.from('\0\0/Users/alice/build\0/home/bob/zig\0C:\\Users\\carol\\x\0d:/users/dave/y')), [
        [2, 'ascii', 'home-path', '/Users/alice/'],
        [21, 'ascii', 'home-path', '/home/bob/'],
        [35, 'ascii', 'home-path', 'C:\\Users\\carol\\'],
        [52, 'ascii', 'home-path', 'd:/users/dave/'],
    ]);
});

it('flags UTF-16LE home paths at either byte alignment', () => {
    assert.deepEqual(hitsOf(Buffer.from('C:\\Users\\erin\\src', 'utf16le')), [[0, 'utf16le', 'home-path', 'C:\\Users\\erin\\']]);
    const odd = Buffer.concat([Buffer.from([0x7f]), Buffer.from('/home/frank/x', 'utf16le')]);
    assert.deepEqual(hitsOf(odd), [[1, 'utf16le', 'home-path', '/home/frank/']]);
});

it('allows CI runner accounts and ignores non-home paths', () => {
    const clean = '/Users/runner/work/x/ /home/runneradmin/y/ C:\\Users\\runneradmin\\z\\ /tmp/gvn/build/ /api/users/42/ @loader_path';
    assert.deepEqual(hitsOf(Buffer.from(clean)), []);
    assert.deepEqual(hitsOf(Buffer.from(clean, 'utf16le')), []);
});

it('applies an optional denylist case-insensitively in both encodings', () => {
    assert.deepEqual(hitsOf(Buffer.from('built on Example-Host.local'), { denylist: ['example-host'] }), [[9, 'ascii', 'denylist', 'Example-Host']]);
    assert.deepEqual(hitsOf(Buffer.from('EXAMPLE-HOST', 'utf16le'), { denylist: ['example-host'] }), [[0, 'utf16le', 'denylist', 'EXAMPLE-HOST']]);
});

it('scans every runtime file in a directory and skips the manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghostty-host-path-'));
    try {
        writeFileSync(join(dir, 'ghostty_vt_node.node'), Buffer.from('rpath /home/grace/gvn/build\0'));
        writeFileSync(join(dir, 'libghostty-vt.so.0'), Buffer.from('clean\0'));
        writeFileSync(join(dir, 'manifest.json'), '{"note":"/Users/heidi/"}');
        const results = scanHostPaths([dir], { denylist: [] }).map(({ file, hits }) => [file.slice(dir.length + 1), hits.length]);
        assert.deepEqual(results, [['ghostty_vt_node.node', 1], ['libghostty-vt.so.0', 0]]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

it('parses the native CI workflow with CRLF line endings (Windows checkout)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghostty-crlf-'));
    try {
        for (const name of ['ghostty-vt-node.yml', 'ci.yml']) {
            writeFileSync(join(dir, name), readFileSync(join(workflowDir, name), 'utf8').replace(/\r?\n/g, '\r\n'));
        }
        const findings = nativeCiFindings(dir, packageDir);
        assert.deepEqual(findings.filter(([, ok]) => !ok), []);
        assert.equal(findings.length, 6);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
