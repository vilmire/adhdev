#!/usr/bin/env node
// Scripted probe for the build-provenance guarantees in CMakeLists.txt. Needs a
// completed cmake-js build of this package (e.g. a neutral /tmp/gvn copy after
// `cmake-js rebuild`) plus cmake, git and the pinned zig; it is not part of the
// unit tests because it compiles. Each probe mutates the build tree and then
// restores it; the final state is a fresh, release-eligible build.
//
//   node scripts/probe-build-provenance.mjs <package copy dir>   # uses <dir>/build
//
// Probes:
//   stale-runtime-relink   same-size garbage in ghostty zig-out + addon relink:
//                          the shipped runtime must be the rebuilt one
//   stale-runtime-idle     same, nothing to relink: zig-out is still refreshed
//   reconfigure-clears     configure deletes zig-out in the managed clone
//   source-modified        a ghostty source edit after configure fails the build
//   dev-override           ADHDEV_GHOSTTY_UNVERIFIED_DEV_BUILD=ON alone => release=0
//   zig-strict             "0.15.2!" / "0.15 .2" / two lines are refused, " X\r\n" accepted
//   source-override        FETCHCONTENT_SOURCE_DIR_GHOSTTY => refused (not touched)
import { spawnSync } from 'node:child_process';
import { createHash, randomFillSync } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { pinnedZigVersion } from './binding-digest.mjs';

const dir = process.argv[2] && resolve(process.argv[2]);
if (!dir || !existsSync(join(dir, 'build', 'CMakeCache.txt'))) {
    console.error('usage: probe-build-provenance.mjs <dir containing a configured cmake-js build/>');
    process.exit(2);
}
const build = join(dir, 'build');
const source = join(build, '_deps', 'ghostty-src');
const cache = readFileSync(join(build, 'CMakeCache.txt'), 'utf8');
const realZig = /^ZIG_EXECUTABLE:FILEPATH=(.*)$/m.exec(cache)?.[1];
const isWin = process.platform === 'win32';
const libName = process.platform === 'darwin' ? 'libghostty-vt.0.1.0.dylib' : isWin ? 'ghostty-vt.dll' : 'libghostty-vt.so.0.1.0';
const zigOutLib = join(source, 'zig-out', isWin ? 'bin' : 'lib', libName);
const releaseLib = join(build, 'Release', libName);
const sha = (file) => (existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null);
const run = (cmd, args) => {
    const result = spawnSync(cmd, args, { cwd: dir, encoding: 'utf8', windowsHide: true });
    return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};
const configure = (...defs) => run('cmake', [build, ...defs.map((d) => `-D${d}`)]);
const compile = () => run('cmake', ['--build', build, '--config', 'Release']);
const releaseFlag = (out) => /provenance: .* release=(\d)/.exec(out)?.[1] ?? null;

const results = [];
const probe = (name, ok, detail) => { results.push(ok); console.log(`  ${ok ? '✓' : '✗'} ${name}: ${detail}`); };
const plantGarbage = () => {
    const garbage = Buffer.alloc(statSync(zigOutLib).size);
    randomFillSync(garbage);
    writeFileSync(zigOutLib, garbage);
    return sha(zigOutLib);
};

if (compile().status !== 0) { console.error('baseline build failed'); process.exit(1); }
const good = sha(zigOutLib);
console.log(`[probe] baseline runtime ${good?.slice(0, 16)} (${libName})`);

let planted = plantGarbage();
rmSync(join(build, 'Release', 'ghostty_vt_node.node'), { force: true });
let built = compile();
probe('stale-runtime-relink', built.status === 0 && sha(zigOutLib) === good && sha(releaseLib) === good,
    `planted ${planted.slice(0, 16)} -> zig-out ${sha(zigOutLib)?.slice(0, 16)}, Release ${sha(releaseLib)?.slice(0, 16)}`);

planted = plantGarbage();
built = compile();
probe('stale-runtime-idle', built.status === 0 && sha(zigOutLib) === good, `planted ${planted.slice(0, 16)} -> zig-out ${sha(zigOutLib)?.slice(0, 16)}`);

let configured = configure();
probe('reconfigure-clears', configured.status === 0 && !existsSync(zigOutLib), `zig-out runtime ${existsSync(zigOutLib) ? 'still present' : 'deleted'} after configure`);
built = compile();
probe('reconfigure-rebuilds', built.status === 0 && sha(zigOutLib) === good, `zig-out ${sha(zigOutLib)?.slice(0, 16)}`);

appendFileSync(join(source, 'README.md'), 'probe\n');
built = compile();
run('git', ['-C', source, 'checkout', '--', 'README.md']);
probe('source-modified', built.status !== 0 && /ghostty source tree changed since configure/.test(built.out), `build exit ${built.status}`);

configured = configure('ADHDEV_GHOSTTY_UNVERIFIED_DEV_BUILD=ON');
probe('dev-override', configured.status === 0 && releaseFlag(configured.out) === '0' && /unverified-dev-build/.test(configured.out), `release=${releaseFlag(configured.out)}`);
configured = configure('ADHDEV_GHOSTTY_UNVERIFIED_DEV_BUILD=OFF');
probe('dev-override-off', configured.status === 0 && releaseFlag(configured.out) === '1', `release=${releaseFlag(configured.out)}`);

const fakeDir = mkdtempSync(join(tmpdir(), 'ghostty-fake-zig-'));
const pin = pinnedZigVersion();
for (const [output, accept] of [[`${pin}!`, false], [pin.replace(/\.(\d+)$/, ' .$1'), false], [`${pin}\nextra`, false], [` ${pin}\r\n`, true]]) {
    const fake = join(fakeDir, isWin ? 'zig.cmd' : 'zig');
    writeFileSync(fake, isWin ? `@echo off\r\n<nul set /p="${output}"\r\n` : `#!/bin/sh\nprintf '%s' '${output.replace(/'/g, "'\\''")}'\n`);
    chmodSync(fake, 0o755);
    configured = configure(`ZIG_EXECUTABLE=${fake}`);
    const accepted = configured.status === 0 && releaseFlag(configured.out) === '1';
    probe(`zig-strict ${JSON.stringify(output)}`, accepted === accept, accept ? 'accepted' : `refused (exit ${configured.status})`);
}
rmSync(fakeDir, { recursive: true, force: true });
configured = configure(`ZIG_EXECUTABLE=${realZig}`);

const probeBuild = mkdtempSync(join(tmpdir(), 'ghostty-override-'));
const override = run('cmake', ['-S', dir, '-B', probeBuild, `-DFETCHCONTENT_SOURCE_DIR_GHOSTTY=${source}`, `-DZIG_EXECUTABLE=${realZig}`]);
probe('source-override', override.status !== 0 && /ghostty-source-override/.test(override.out) && existsSync(join(source, 'zig-out')),
    `configure exit ${override.status}; substituted checkout left untouched`);
rmSync(probeBuild, { recursive: true, force: true });

built = compile();
probe('restored', configured.status === 0 && built.status === 0 && sha(zigOutLib) === good, `release=${releaseFlag(configured.out)}, runtime ${sha(zigOutLib)?.slice(0, 16)}`);
const failed = results.filter((ok) => !ok).length;
console.log(`[probe] ${results.length - failed}/${results.length} provenance probes passed`);
if (failed) process.exit(1);
