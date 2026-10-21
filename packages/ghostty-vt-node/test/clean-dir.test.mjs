// scripts/clean-dir.cjs empties the private zig caches before a release build
// (CMakeLists.txt treats any non-zero exit as a fatal configure error). It must
// delete names Win32 normalizes away -- zig extracts macOS AppleDouble `._.`
// files into its package cache, and CMake's file(REMOVE_RECURSE) stops on them
// -- and must fail closed whenever anything survives.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'clean-dir.cjs');
const scratch = mkdtempSync(join(tmpdir(), 'ghostty-clean-dir-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const isWin = process.platform === 'win32';
// Win32 APIs strip a trailing dot unless the path carries the \\?\ prefix.
const raw = (file) => (isWin ? `\\\\?\\${file}` : file);
const clean = (dir, preload) => spawnSync(process.execPath, [...(preload ? ['--require', preload] : []), script, dir], { encoding: 'utf8', windowsHide: true });

let counter = 0;
function cacheLike() {
    const dir = join(scratch, `zig-${counter++}`);
    const pkg = join(dir, 'global-cache', 'p', 'N-V-__8AAexample');
    mkdirSync(join(pkg, 'src'), { recursive: true });
    mkdirSync(join(dir, 'local-cache', 'o', 'abc'), { recursive: true });
    mkdirSync(join(dir, 'prefix', 'lib'), { recursive: true });
    writeFileSync(join(pkg, 'src', 'root.zig'), 'pub fn f() void {}\n');
    writeFileSync(raw(join(pkg, '._.')), 'AppleDouble');
    writeFileSync(raw(join(pkg, 'src', 'trailing.')), 'x');
    writeFileSync(join(dir, 'local-cache', 'o', 'abc', 'libghostty-vt.a'), 'x');
    writeFileSync(join(dir, 'prefix', 'lib', 'libghostty-vt.so.0.1.0'), 'x');
    return dir;
}

it('removes a cache tree including trailing-dot AppleDouble entries', () => {
    const dir = cacheLike();
    const result = clean(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(dir), false);
    assert.equal(clean(dir).status, 0, 'an absent directory is already clean');
});

it('fails closed when the removal silently leaves the directory behind', () => {
    const dir = cacheLike();
    const mock = join(scratch, 'rm-noop.cjs');
    writeFileSync(mock, "require('node:fs').rmSync = () => {};\n");
    const result = clean(dir, mock);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /still exists after removal/);
    assert.equal(existsSync(dir), true);
});

it('fails closed when the removal throws', () => {
    const dir = cacheLike();
    const mock = join(scratch, 'rm-throws.cjs');
    writeFileSync(mock, "require('node:fs').rmSync = () => { const e = new Error('ERROR_FILE_NOT_FOUND on ._.'); e.code = 'ENOENT_SIM'; throw e; };\n");
    const result = clean(dir, mock);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not remove .*ENOENT_SIM/);
});

it('fails closed on a genuinely undeletable entry', { skip: isWin || process.getuid?.() === 0 ? 'needs POSIX permissions as a non-root user' : false }, () => {
    const dir = cacheLike();
    const locked = join(dir, 'global-cache', 'p', 'N-V-__8AAexample', 'src');
    chmodSync(locked, 0o555);
    try {
        const result = clean(dir);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /could not remove/);
    } finally {
        chmodSync(locked, 0o755);
    }
});

it('refuses relative paths and filesystem roots', () => {
    assert.equal(clean('relative/dir').status, 2);
    assert.equal(clean(isWin ? 'C:\\' : '/').status, 2);
});
