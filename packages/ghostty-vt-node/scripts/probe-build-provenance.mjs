#!/usr/bin/env node
// Scripted probe for the build-provenance guarantees in CMakeLists.txt. Needs a
// configured cmake-js build of this package (e.g. a neutral /tmp/gvn copy after
// `cmake-js rebuild`) plus cmake, git, network access and the pinned zig; it is
// not part of the unit tests because it compiles twice from empty caches.
// Each probe mutates the build tree and restores it; the final state is a
// fresh, release-eligible build. Run it with exclusive use of the build tree.
//
//   node scripts/probe-build-provenance.mjs <package copy dir>   # uses <dir>/build
//
// Probes:
//   stale-runtime-relink   same-size garbage in the installed runtime + addon
//                          relink: the shipped runtime must be the rebuilt one
//   stale-runtime-idle     same, nothing to relink: the runtime is still refreshed
//   ambient-cache-poison   ZIG_GLOBAL_CACHE_DIR / ZIG_LOCAL_CACHE_DIR pointing at
//                          a poisoned package cache are never read or written
//   source-modified        a ghostty source edit after configure fails the build
//   dev-override           ADHDEV_GHOSTTY_UNVERIFIED_DEV_BUILD=ON alone => release=0
//   poison-is-live         control: the poisoned PRIVATE caches break a build
//                          that keeps them (dev override), so the poison bites
//   zig-strict             "0.15.2!" / "0.15 .2" / two lines refused, " X\r\n" accepted
//   clean-fails-closed     a cache clean that leaves anything behind (simulated
//                          with a no-op fs.rmSync) fails the release configure
//   reconfigure-clears     a release configure empties the private caches/prefix,
//                          including planted trailing-dot (`._.`) entries that
//                          CMake's file(REMOVE_RECURSE) cannot delete on Windows
//   private-cache-poison   ...so the poisoned package/artifact caches are never
//                          used: the release rebuild yields the baseline runtime
//   source-override        FETCHCONTENT_SOURCE_DIR_GHOSTTY => refused
import { spawnSync } from 'node:child_process';
import { createHash, randomFillSync } from 'node:crypto';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { pinnedZigVersion } from './binding-digest.mjs';
import { checkNativeFile } from './native-format.mjs';

// Canonical path: the build embeds source paths (e.g. /tmp vs /private/tmp on
// macOS), so every configure must see the same spelling for runtimes to match.
const dir = process.argv[2] && existsSync(process.argv[2]) ? realpathSync(resolve(process.argv[2])) : null;
if (!dir || !existsSync(join(dir, 'build', 'CMakeCache.txt'))) {
    console.error('usage: probe-build-provenance.mjs <dir containing a configured cmake-js build/>');
    process.exit(2);
}
const build = join(dir, 'build');
const source = join(build, '_deps', 'ghostty-src');
const zigDir = join(build, 'ghostty-zig');
const globalCache = join(zigDir, 'global-cache');
const localCache = join(zigDir, 'local-cache');
const cache = readFileSync(join(build, 'CMakeCache.txt'), 'utf8');
const realZig = /^ZIG_EXECUTABLE:FILEPATH=(.*)$/m.exec(cache)?.[1];
const isWin = process.platform === 'win32';
const libName = process.platform === 'darwin' ? 'libghostty-vt.0.1.0.dylib' : isWin ? 'ghostty-vt.dll' : 'libghostty-vt.so.0.1.0';
const installedLib = join(zigDir, 'prefix', isWin ? 'bin' : 'lib', libName);
const releaseLib = join(build, 'Release', libName);
const sha = (file) => (existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null);
const run = (cmd, args, env = {}) => {
    const result = spawnSync(cmd, args, { cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env }, maxBuffer: 1 << 28 });
    return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};
const configure = (defs = [], env = {}) => run('cmake', [build, ...defs.map((d) => `-D${d}`)], env);
const compile = (env = {}) => run('cmake', ['--build', build, '--config', 'Release'], env);
// Two fresh zig builds are not byte-identical: the debug map / debug info names
// the per-build local-cache object directories and their mtimes, and the image
// id (LC_UUID, build-id, PDB GUID) and code signature follow from that. The
// LOADED code and data must be identical, so runtimes from different fresh
// builds are compared by a digest of their loaded sections:
//   Mach-O  every section outside __LINKEDIT (zerofill excluded)
//   ELF     SHF_ALLOC sections except NOBITS and notes (build-id)
//   PE      every section, with debug-directory and export timestamps / debug
//           payloads zeroed
const loadedDigest = (file) => {
    if (!existsSync(file)) return null;
    const b = Buffer.from(readFileSync(file));
    const hash = createHash('sha256');
    if (b.readUInt32LE(0) === 0xfeedfacf) {
        let at = 32;
        for (let i = 0; i < b.readUInt32LE(16); i++) {
            const cmd = b.readUInt32LE(at);
            if (cmd === 0x19 && b.toString('latin1', at + 8, at + 24).replace(/\0.*$/s, '') !== '__LINKEDIT') {
                for (let k = 0; k < b.readUInt32LE(at + 64); k++) {
                    const sect = at + 72 + k * 80;
                    const type = b.readUInt32LE(sect + 64) & 0xff;
                    if (type === 0x01 || type === 0x0c || type === 0x12) continue; // zerofill kinds
                    const size = Number(b.readBigUInt64LE(sect + 40));
                    const off = b.readUInt32LE(sect + 48);
                    hash.update(b.subarray(sect, sect + 32)).update(b.subarray(off, off + size));
                }
            }
            at += b.readUInt32LE(at + 4);
        }
    } else if (b.readUInt32BE(0) === 0x7f454c46) {
        const shoff = Number(b.readBigUInt64LE(40));
        for (let i = 0; i < b.readUInt16LE(60); i++) {
            const sh = shoff + i * 64;
            const type = b.readUInt32LE(sh + 4);
            const flags = Number(b.readBigUInt64LE(sh + 8));
            if (!(flags & 2) || type === 8 || type === 7) continue;
            const off = Number(b.readBigUInt64LE(sh + 24));
            hash.update(b.subarray(sh, sh + 64)).update(b.subarray(off, off + Number(b.readBigUInt64LE(sh + 32))));
        }
    } else if (b[0] === 0x4d && b[1] === 0x5a) {
        const pe = b.readUInt32LE(0x3c);
        const opt = pe + 24;
        const sectionTable = opt + b.readUInt16LE(pe + 20);
        const sections = Array.from({ length: b.readUInt16LE(pe + 6) }, (_, i) => {
            const sh = sectionTable + i * 40;
            return { sh, va: b.readUInt32LE(sh + 12), vsize: b.readUInt32LE(sh + 8), raw: b.readUInt32LE(sh + 20), rawSize: b.readUInt32LE(sh + 16) };
        });
        const fileOffset = (rva) => { const s = sections.find((x) => rva >= x.va && rva < x.va + Math.max(x.vsize, x.rawSize)); return s ? s.raw + rva - s.va : -1; };
        const exportDir = fileOffset(b.readUInt32LE(opt + 112));
        if (b.readUInt32LE(opt + 116) && exportDir >= 0) b.fill(0, exportDir + 4, exportDir + 8);
        const debugDir = fileOffset(b.readUInt32LE(opt + 112 + 6 * 8));
        const debugSize = b.readUInt32LE(opt + 116 + 6 * 8);
        for (let d = 0; debugDir >= 0 && d + 28 <= debugSize; d += 28) {
            const entry = debugDir + d;
            b.fill(0, entry + 4, entry + 8);
            const dataSize = b.readUInt32LE(entry + 16);
            const dataPtr = b.readUInt32LE(entry + 24);
            if (dataPtr && dataPtr + dataSize <= b.length) b.fill(0, dataPtr, dataPtr + dataSize);
        }
        for (const s of sections) hash.update(b.subarray(s.sh, s.sh + 40)).update(b.subarray(s.raw, s.raw + s.rawSize));
    } else {
        return null;
    }
    return hash.digest('hex');
};
const platformArch = [process.platform, process.arch];
const releaseFlag = (out) => /provenance: .* release=(\d)/.exec(out)?.[1] ?? null;
const walk = (root) => (existsSync(root) ? readdirSync(root, { recursive: true, withFileTypes: true }) : [])
    .filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath ?? entry.path, entry.name));
// path:size:mtime of every file: shows a tree was neither modified nor added to.
const snapshot = (root) => JSON.stringify(walk(root).sort().map((file) => { const st = statSync(file); return `${file}:${st.size}:${st.mtimeMs}`; }));

const results = [];
const probe = (name, ok, detail) => { results.push(ok); console.log(`  ${ok ? '✓' : '✗'} ${name}: ${detail}`); };
const plantGarbage = () => {
    const garbage = Buffer.alloc(statSync(installedLib).size);
    randomFillSync(garbage);
    writeFileSync(installedLib, garbage);
    return sha(installedLib);
};
// Make every Zig source in a package cache fail to compile and every cached
// libghostty-vt artifact garbage, so any use of the poisoned state is visible.
const POISON = '\ncomptime { @compileError("adhdev probe: poisoned zig package cache"); }\n';
const poisonCaches = (globalRoot, localRoot) => {
    let sources = 0;
    let artifacts = 0;
    for (const file of walk(join(globalRoot, 'p'))) {
        if (file.endsWith('.zig')) { appendFileSync(file, POISON); sources++; }
    }
    for (const file of walk(localRoot)) {
        if (/ghostty-vt/.test(file) && /\.(dylib|so[.\d]*|dll|lib|a)$/.test(file)) {
            const garbage = Buffer.alloc(statSync(file).size);
            randomFillSync(garbage);
            writeFileSync(file, garbage);
            artifacts++;
        }
    }
    return { sources, artifacts };
};

// Baseline: a fresh release configure + build (empty private caches).
const baseline = configure(['ADHDEV_GHOSTTY_UNVERIFIED_DEV_BUILD=OFF', `ZIG_EXECUTABLE=${realZig}`]);
let built = baseline.status === 0 ? compile() : baseline;
if (built.status !== 0 || releaseFlag(baseline.out) !== '1') { console.error(`baseline release build failed:\n${built.out.slice(-2000)}`); process.exit(1); }
const good = sha(installedLib);
const goodLoaded = loadedDigest(installedLib);
console.log(`[probe] baseline runtime ${good?.slice(0, 16)} (loaded sections ${goodLoaded?.slice(0, 16)}, ${libName})`);

let planted = plantGarbage();
rmSync(join(build, 'Release', 'ghostty_vt_node.node'), { force: true });
built = compile();
probe('stale-runtime-relink', built.status === 0 && sha(installedLib) === good && sha(releaseLib) === good,
    `planted ${planted.slice(0, 16)} -> installed ${sha(installedLib)?.slice(0, 16)}, Release ${sha(releaseLib)?.slice(0, 16)}`);

planted = plantGarbage();
built = compile();
probe('stale-runtime-idle', built.status === 0 && sha(installedLib) === good, `planted ${planted.slice(0, 16)} -> installed ${sha(installedLib)?.slice(0, 16)}`);

const ambient = mkdtempSync(join(tmpdir(), 'ghostty-ambient-zig-'));
try {
    // Ambient caches: a poisoned copy of this build's own package cache.
    const ambientGlobal = join(ambient, 'global');
    const ambientLocal = join(ambient, 'local');
    cpSync(join(globalCache, 'p'), join(ambientGlobal, 'p'), { recursive: true });
    mkdirSync(ambientLocal, { recursive: true });
    const ambientPoison = poisonCaches(ambientGlobal, ambientLocal);
    const ambientEnv = { ZIG_GLOBAL_CACHE_DIR: ambientGlobal, ZIG_LOCAL_CACHE_DIR: ambientLocal };
    let before = snapshot(ambient);
    rmSync(join(build, 'Release', 'ghostty_vt_node.node'), { force: true });
    built = compile(ambientEnv);
    probe('ambient-cache-poison', built.status === 0 && sha(installedLib) === good && snapshot(ambient) === before,
        `${ambientPoison.sources} poisoned package sources in ZIG_GLOBAL_CACHE_DIR; build exit ${built.status}, runtime ${sha(installedLib)?.slice(0, 16)}, ambient caches ${snapshot(ambient) === before ? 'untouched' : 'CHANGED'}`);

    try {
        appendFileSync(join(source, 'README.md'), 'probe\n');
        built = compile();
        probe('source-modified', built.status !== 0 && /ghostty source tree changed since configure/.test(built.out), `build exit ${built.status}`);
    } finally {
        run('git', ['-C', source, 'checkout', '--', 'README.md']);
    }

    // Poison this build's PRIVATE caches. A configure that keeps them (dev
    // override) must then fail to build: proof that the poison would be used.
    const privatePoison = poisonCaches(globalCache, localCache);
    let configured = configure(['ADHDEV_GHOSTTY_UNVERIFIED_DEV_BUILD=ON']);
    probe('dev-override', configured.status === 0 && releaseFlag(configured.out) === '0' && /unverified-dev-build/.test(configured.out), `release=${releaseFlag(configured.out)}`);
    built = compile();
    probe('poison-is-live', built.status !== 0 && /poisoned zig package cache/.test(built.out),
        `${privatePoison.sources} sources / ${privatePoison.artifacts} artifacts poisoned in the private caches; kept caches => build exit ${built.status}`);

    // The fake zig prints EXACT bytes on every platform: a node script copies a
    // data file to stdout, behind a shell (POSIX) or .cmd (Windows) wrapper. A
    // cmd.exe `set /p` stub cannot emit a CR/LF or leading whitespace verbatim.
    const fakeDir = mkdtempSync(join(tmpdir(), 'ghostty-fake-zig-'));
    try {
        const fakeOutput = join(fakeDir, 'version-output.txt');
        const fakeScript = join(fakeDir, 'fake-zig.cjs');
        writeFileSync(fakeScript, `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(fakeOutput)}));\n`);
        const fake = join(fakeDir, isWin ? 'zig.cmd' : 'zig');
        writeFileSync(fake, isWin
            ? `@"${process.execPath}" "${fakeScript}" %*\r\n`
            : `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' '${fakeScript.replace(/'/g, "'\\''")}' "$@"\n`);
        chmodSync(fake, 0o755);
        const pin = pinnedZigVersion();
        for (const [output, accept] of [[`${pin}!`, false], [pin.replace(/\.(\d+)$/, ' .$1'), false], [`${pin}\nextra`, false], [` ${pin}\r\n`, true]]) {
            writeFileSync(fakeOutput, output);
            configured = configure(['ADHDEV_GHOSTTY_UNVERIFIED_DEV_BUILD=OFF', `ZIG_EXECUTABLE=${fake}`]);
            const accepted = configured.status === 0 && releaseFlag(configured.out) === '1';
            probe(`zig-strict ${JSON.stringify(output)}`, accepted === accept, accept ? 'accepted' : `refused (exit ${configured.status})`);
        }
    } finally {
        rmSync(fakeDir, { recursive: true, force: true });
    }

    // Plant names Win32 normalizes away (zig extracts such `._.` AppleDouble
    // files from some packages); \\?\ keeps the trailing dot on Windows.
    const raw = (file) => (isWin ? `\\\\?\\${file}` : file);
    mkdirSync(join(globalCache, 'p', 'adhdev-probe'), { recursive: true });
    writeFileSync(raw(join(globalCache, 'p', 'adhdev-probe', '._.')), 'AppleDouble');
    writeFileSync(raw(join(localCache, 'stale.')), 'x');

    // A clean that leaves the caches in place must stop the release configure.
    const mockDir = mkdtempSync(join(tmpdir(), 'ghostty-rm-mock-'));
    try {
        const mock = join(mockDir, 'rm-noop.cjs');
        writeFileSync(mock, "require('node:fs').rmSync = () => {};\n");
        configured = configure(['ADHDEV_GHOSTTY_UNVERIFIED_DEV_BUILD=OFF', `ZIG_EXECUTABLE=${realZig}`], { NODE_OPTIONS: `--require ${JSON.stringify(mock)}` });
        const kept = walk(globalCache).length + walk(localCache).length;
        probe('clean-fails-closed', configured.status !== 0 && /could not empty the private zig caches/.test(configured.out) && kept > 0,
            `configure exit ${configured.status}; ${kept} planted cache files left in place`);
    } finally {
        rmSync(mockDir, { recursive: true, force: true });
    }

    // Release configure with the real zig and the ambient poison still in the
    // environment: the private caches and prefix are emptied, then rebuilt
    // from freshly fetched packages.
    configured = configure(['ADHDEV_GHOSTTY_UNVERIFIED_DEV_BUILD=OFF', `ZIG_EXECUTABLE=${realZig}`], ambientEnv);
    const leftovers = walk(globalCache).length + walk(localCache).length;
    probe('reconfigure-clears', configured.status === 0 && releaseFlag(configured.out) === '1' && leftovers === 0 && !existsSync(installedLib),
        `release=${releaseFlag(configured.out)}, ${leftovers} files left in the private caches (incl. planted ._. / trailing-dot), runtime ${existsSync(installedLib) ? 'still present' : 'deleted'}`);
    before = snapshot(ambient);
    built = compile(ambientEnv);
    // A fresh build: equal loaded sections to the baseline (bytes differ only in
    // per-build debug metadata), a well-formed library, shipped as built.
    const formatProblems = existsSync(installedLib) ? checkNativeFile(libName, readFileSync(installedLib), ...platformArch) : ['missing'];
    probe('private-cache-poison', built.status === 0 && loadedDigest(installedLib) === goodLoaded && formatProblems.length === 0
        && sha(releaseLib) === sha(installedLib) && snapshot(ambient) === before,
        `fresh release build exit ${built.status}, loaded sections ${loadedDigest(installedLib)?.slice(0, 16)} (baseline ${goodLoaded?.slice(0, 16)}; raw ${sha(installedLib)?.slice(0, 16)} vs ${good?.slice(0, 16)}), format ${formatProblems.length ? formatProblems.join('; ') : 'ok'}, ambient ${snapshot(ambient) === before ? 'untouched' : 'CHANGED'}`);
} finally {
    rmSync(ambient, { recursive: true, force: true });
    run('git', ['-C', source, 'checkout', '--', '.']);
}

const probeBuild = mkdtempSync(join(tmpdir(), 'ghostty-override-'));
try {
    const override = run('cmake', ['-S', dir, '-B', probeBuild, `-DFETCHCONTENT_SOURCE_DIR_GHOSTTY=${source}`, `-DZIG_EXECUTABLE=${realZig}`]);
    probe('source-override', override.status !== 0 && /ghostty-source-override/.test(override.out), `configure exit ${override.status}`);
} finally {
    rmSync(probeBuild, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`[probe] ${results.length - failed}/${results.length} provenance probes passed`);
if (failed) process.exit(1);
