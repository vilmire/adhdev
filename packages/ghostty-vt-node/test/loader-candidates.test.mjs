import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const { orderPrebuiltTriplets } = createRequire(import.meta.url)('../binding-candidates.js');

const run = (levels, abi = 127, platform = 'darwin', arch = 'arm64') =>
    orderPrebuiltTriplets({
        names: Object.keys(levels),
        platform,
        arch,
        abi,
        readApiLevel: (name) => levels[name],
    });

test('highest apiLevel beats the exact ABI match', () => {
    const r = run({ 'darwin-arm64-node127': 1, 'darwin-arm64-node137': 2, 'darwin-arm64-node115': 1 });
    assert.deepEqual(r.samePlatform, ['darwin-arm64-node137', 'darwin-arm64-node127', 'darwin-arm64-node115']);
    assert.equal(r.bestApiLevel, 2);
});

test('missing manifest counts as level 0 and never beats a manifest', () => {
    const r = run({ 'darwin-arm64-node127': 0, 'darwin-arm64-node137': 2 });
    assert.equal(r.samePlatform[0], 'darwin-arm64-node137');
    const r2 = run({ 'darwin-arm64-node127': undefined, 'darwin-arm64-node137': 1 });
    assert.equal(r2.samePlatform[0], 'darwin-arm64-node137');
});

test('equal apiLevel: exact ABI first, then higher ABI', () => {
    const r = run({ 'darwin-arm64-node115': 2, 'darwin-arm64-node127': 2, 'darwin-arm64-node137': 2 });
    assert.deepEqual(r.samePlatform, ['darwin-arm64-node127', 'darwin-arm64-node137', 'darwin-arm64-node115']);
});

test('other platforms are separated and sorted last-resort', () => {
    const r = run({ 'linux-x64-node137': 2, 'darwin-arm64-node137': 2, 'win32-x64-node137': 2 });
    assert.deepEqual(r.samePlatform, ['darwin-arm64-node137']);
    assert.deepEqual(r.otherPlatform, ['linux-x64-node137', 'win32-x64-node137']);
});

test('no same-platform dirs gives bestApiLevel 0', () => {
    assert.equal(run({ 'linux-x64-node137': 2 }).bestApiLevel, 0);
});
