import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
    MACOS_MIN_VERSION, macosMinVersionProblems, readMachOMinos, withMacosDeploymentTarget,
} from '../scripts/macos-min-version.mjs';

const prebuiltRoot = join(fileURLToPath(new URL('..', import.meta.url)), 'prebuilt');

function thinMachO(minos, sdk = 0x1a0000) {
    const buf = Buffer.alloc(32 + 24);
    buf.writeUInt32LE(0xfeedfacf, 0);
    buf.writeUInt32LE(1, 16); // ncmds
    buf.writeUInt32LE(24, 20);
    buf.writeUInt32LE(0x32, 32); buf.writeUInt32LE(24, 36); buf.writeUInt32LE(1, 40);
    buf.writeUInt32LE(minos, 44); buf.writeUInt32LE(sdk, 48);
    return buf;
}

test('parser flags a minos above the floor and accepts the floor', () => {
    assert.deepEqual(readMachOMinos(thinMachO(26 << 16)).map((s) => s.minos), ['26.0']);
    assert.equal(macosMinVersionProblems('x.node', thinMachO(26 << 16)).length, 1);
    assert.deepEqual(macosMinVersionProblems('x.node', thinMachO(13 << 16)), []);
    assert.deepEqual(macosMinVersionProblems('x.node', thinMachO(12 << 16)), []);
    assert.deepEqual(macosMinVersionProblems('x.so', Buffer.from('\x7fELF....')), []);
});

test('build env pins the deployment target on darwin only', () => {
    assert.equal(withMacosDeploymentTarget({}, 'darwin').MACOSX_DEPLOYMENT_TARGET, MACOS_MIN_VERSION);
    assert.equal(withMacosDeploymentTarget({ MACOSX_DEPLOYMENT_TARGET: '26.0' }, 'darwin').MACOSX_DEPLOYMENT_TARGET, MACOS_MIN_VERSION);
    assert.equal(withMacosDeploymentTarget({ MACOSX_DEPLOYMENT_TARGET: '12.0' }, 'darwin').MACOSX_DEPLOYMENT_TARGET, '12.0');
    assert.equal(withMacosDeploymentTarget({}, 'linux').MACOSX_DEPLOYMENT_TARGET, undefined);
});

test(`every committed darwin Mach-O has minos <= ${MACOS_MIN_VERSION}`, (t) => {
    const dirs = readdirSync(prebuiltRoot).filter((d) => d.startsWith('darwin-'));
    if (dirs.length === 0) return t.skip('no committed darwin prebuilt');
    let checked = 0;
    for (const dir of dirs) {
        for (const name of readdirSync(join(prebuiltRoot, dir)).filter((n) => /\.(node|dylib)$/.test(n))) {
            const file = join(prebuiltRoot, dir, name);
            assert.deepEqual(macosMinVersionProblems(`${dir}/${name}`, readFileSync(file)), []);
            checked++;
            if (process.platform === 'darwin' && existsSync('/usr/bin/otool')) {
                // Cross-check the JS parser against otool.
                const out = spawnSync('otool', ['-l', file], { encoding: 'utf8' }).stdout;
                const m = out.match(/LC_BUILD_VERSION[\s\S]*?minos ([\d.]+)/);
                assert.equal(m && m[1], readMachOMinos(readFileSync(file))[0].minos, `${dir}/${name} parser vs otool`);
            }
        }
    }
    assert.ok(checked > 0, 'no darwin Mach-O files were examined');
});
