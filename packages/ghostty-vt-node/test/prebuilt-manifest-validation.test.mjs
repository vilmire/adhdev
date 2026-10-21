// Release-gate manifest validation (scripts/prebuilt-manifest.mjs checkTriplet)
// and the load-free native format checks it relies on (scripts/native-format.mjs).
// A prebuilt set must match its directory's platform/arch, hold that platform's
// mandatory runtime set in the right native format, and carry release
// provenance for the pinned ghostty + zig. Every case below runs on any host:
// nothing is loaded.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkNativeFile, inspectNative } from '../scripts/native-format.mjs';
import { checkTriplet } from '../scripts/prebuilt-manifest.mjs';

const prebuiltRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'prebuilt');
const DARWIN = 'darwin-arm64-node137';
const LINUX = 'linux-x64-node137';
const WIN32 = 'win32-x64-node137';
// The expectation is taken from the committed darwin manifest, not from the
// current sources: these cases test the validation rules, and must not turn red
// in the native CI build of a source change whose prebuilts are not rebuilt yet
// (check-prebuilts.mjs is what enforces freshness).
const darwinManifest = JSON.parse(readFileSync(join(prebuiltRoot, DARWIN, 'manifest.json'), 'utf8'));
const expected = {
    sourceDigest: darwinManifest.sourceDigest,
    apiLevel: darwinManifest.apiLevel,
    ghosttyRevision: darwinManifest.ghosttyRevision,
    zigVersion: darwinManifest.provenance.zigVersion,
};
const scratch = mkdtempSync(join(tmpdir(), 'ghostty-manifest-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
// Copies a committed triplet into a fresh root under `as`, then lets `mutate`
// edit the files and the parsed manifest before it is written back.
function stage(from, as = from, mutate = () => {}) {
    const root = join(scratch, String(counter++));
    const dir = join(root, as);
    cpSync(join(prebuiltRoot, from), dir, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    mutate(manifest, dir);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return checkTriplet(as, expected, root);
}

const file = (triplet, name) => readFileSync(join(prebuiltRoot, triplet, name));

it('the committed darwin set passes as-is (baseline for the negative cases)', () => {
    assert.equal(stage(DARWIN).status, 'ok');
});

it('rejects another platform\'s files placed in a triplet directory', () => {
    // Manifest left as darwin: the platform/arch it records is checked.
    const asIs = stage(DARWIN, WIN32);
    assert.equal(asIs.status, 'wrong-platform');
    assert.match(asIs.detail, /manifest is for darwin-arm64/);
    // Manifest relabelled win32/x64: the runtime set and magic bytes still disagree.
    const relabelled = stage(DARWIN, WIN32, (manifest) => { manifest.platform = 'win32'; manifest.arch = 'x64'; });
    assert.equal(relabelled.status, 'invalid-runtime');
    assert.match(relabelled.detail, /required ghostty-vt\.dll missing/);
    assert.match(relabelled.detail, /ghostty_vt_node\.node: macho binary, want pe for win32-x64/);
    const linuxAsDarwin = stage(LINUX, DARWIN, (manifest) => { manifest.platform = 'darwin'; manifest.arch = 'arm64'; });
    assert.equal(linuxAsDarwin.status, 'invalid-runtime');
    assert.match(linuxAsDarwin.detail, /elf binary, want macho for darwin-arm64/);
});

it('rejects an incomplete runtime set even when the manifest agrees', () => {
    const darwin = stage(DARWIN, DARWIN, (manifest, dir) => {
        unlinkSync(join(dir, 'libghostty-vt.dylib'));
        delete manifest.files['libghostty-vt.dylib'];
    });
    assert.equal(darwin.status, 'invalid-runtime');
    assert.match(darwin.detail, /required libghostty-vt\.dylib missing/);
    const linux = stage(LINUX, LINUX, (manifest, dir) => {
        unlinkSync(join(dir, 'libghostty-vt.so.0'));
        delete manifest.files['libghostty-vt.so.0'];
    });
    assert.equal(linux.status, 'invalid-runtime');
    assert.match(linux.detail, /required libghostty-vt\.so\.0 missing/);
    const win32 = stage(WIN32, WIN32, (manifest, dir) => {
        unlinkSync(join(dir, 'ghostty-vt.dll'));
        delete manifest.files['ghostty-vt.dll'];
    });
    assert.equal(win32.status, 'invalid-runtime');
    assert.match(win32.detail, /required ghostty-vt\.dll missing/);
});

it('requires the current manifest schema, sources and zig pin', () => {
    const schema1 = stage(DARWIN, DARWIN, (manifest) => { manifest.schema = 1; });
    assert.equal(schema1.status, 'pending-rebuild');
    assert.match(schema1.detail, /schema 1/);
    const zig = stage(DARWIN, DARWIN, (manifest) => { manifest.provenance.zigVersion = '0.16.0'; });
    assert.equal(zig.status, 'pending-rebuild');
    assert.match(zig.detail, /zig 0\.16\.0 != /);
    const digest = stage(DARWIN, DARWIN, (manifest) => { manifest.sourceDigest = 'f'.repeat(64); });
    assert.equal(digest.status, 'corrupt');
    assert.match(digest.detail, /does not embed the manifest sourceDigest/);
});

it('refuses non-release (unverified) builds', () => {
    const flagged = stage(DARWIN, DARWIN, (manifest) => { manifest.release = false; manifest.provenance.problems = ['ghostty-source-dirty']; });
    assert.equal(flagged.status, 'non-release');
    assert.match(flagged.detail, /stamped non-release; problems: ghostty-source-dirty/);
    const dirty = stage(DARWIN, DARWIN, (manifest) => { manifest.provenance.ghosttySourceClean = false; });
    assert.equal(dirty.status, 'non-release');
    const head = stage(DARWIN, DARWIN, (manifest) => { manifest.provenance.ghosttySourceRevision = '0'.repeat(40); });
    assert.equal(head.status, 'non-release');
    assert.match(head.detail, /built ghostty 0{40} != pin/);
});

it('identifies the committed binaries by magic bytes without loading them', () => {
    assert.deepEqual(inspectNative(file(DARWIN, 'ghostty_vt_node.node')), { format: 'macho', arch: 'arm64', kind: 'dylib' });
    assert.deepEqual(inspectNative(file(WIN32, 'ghostty-vt.dll')), { format: 'pe', arch: 'x64', kind: 'dll' });
    const so = inspectNative(file(LINUX, 'libghostty-vt.so.0'));
    assert.deepEqual([so.format, so.arch, so.kind, so.soname], ['elf', 'x64', 'shared', 'libghostty-vt.so.0']);
    assert.ok(inspectNative(file(LINUX, 'ghostty_vt_node.node')).needed.includes('libghostty-vt.so.0'));
    for (const [triplet, platform, arch] of [[DARWIN, 'darwin', 'arm64'], [LINUX, 'linux', 'x64'], [WIN32, 'win32', 'x64']]) {
        assert.deepEqual(checkNativeFile('ghostty_vt_node.node', file(triplet, 'ghostty_vt_node.node'), platform, arch), []);
    }
});

it('rejects wrong architectures, a wrong SONAME and non-binaries', () => {
    const elf = Buffer.from(file(LINUX, 'libghostty-vt.so.0'));
    elf.writeUInt16LE(183, 18); // EM_AARCH64
    assert.match(checkNativeFile('libghostty-vt.so.0', elf, 'linux', 'x64').join(), /elf arm64, want x64/);

    const renamed = Buffer.from(file(LINUX, 'libghostty-vt.so.0').toString('latin1').replaceAll('libghostty-vt.so.0', 'libghostty-vt.so.9'), 'latin1');
    assert.match(checkNativeFile('libghostty-vt.so.0', renamed, 'linux', 'x64').join(), /SONAME libghostty-vt\.so\.9, want libghostty-vt\.so\.0/);

    const pe = Buffer.from(file(WIN32, 'ghostty-vt.dll'));
    pe.writeUInt16LE(0xaa64, pe.readUInt32LE(0x3c) + 4);
    assert.match(checkNativeFile('ghostty-vt.dll', pe, 'win32', 'x64').join(), /pe arm64, want x64/);

    const macho = Buffer.from(file(DARWIN, 'libghostty-vt.dylib'));
    macho.writeUInt32LE(0x01000007, 4); // CPU_TYPE_X86_64
    assert.match(checkNativeFile('libghostty-vt.dylib', macho, 'darwin', 'arm64').join(), /macho x64, want arm64/);

    const fat = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]);
    assert.match(checkNativeFile('libghostty-vt.dylib', fat, 'darwin', 'arm64').join(), /macho-fat binary, want macho/);
    assert.match(checkNativeFile('ghostty-vt.dll', Buffer.from('not a binary'), 'win32', 'x64').join(), /unknown binary, want pe/);
    assert.match(checkNativeFile('ghostty-vt.dll', Buffer.from('MZ'), 'win32', 'x64').join(), /truncated DOS header/);
});
