// Minimum macOS version every darwin Mach-O we ship must load on.
//
// Why: a prebuilt linked without a deployment target inherits the BUILD
// machine's OS as `minos` (a macOS 26 builder produced minos 26.0), and dyld
// then refuses to load it on anything older. The loader falls back to a
// cmake-js + zig source compile, which end users cannot run, so terminal
// rendering breaks. libghostty-vt already targets 13.0 through zig's default;
// the node addon (clang via cmake-js) needs MACOSX_DEPLOYMENT_TARGET.
//
// This is deliberately NOT in CMakeLists.txt: that file is a binding digest
// input, so editing it would invalidate the linux/win32 prebuilts too.
//
// Floor 13.0: the lowest target zig 0.15.2 / this ghostty pin build for
// (ghostty itself supports macOS 13+); nothing here needs newer APIs.
import { readFileSync } from 'node:fs';

export const MACOS_MIN_VERSION = '13.0';

// Env for darwin builds; an explicit caller value is kept only if not newer than the floor.
export function withMacosDeploymentTarget(env = process.env, platform = process.platform) {
    if (platform !== 'darwin') return env;
    const current = env.MACOSX_DEPLOYMENT_TARGET;
    if (current && compareVersions(current, MACOS_MIN_VERSION) <= 0) return env;
    return { ...env, MACOSX_DEPLOYMENT_TARGET: MACOS_MIN_VERSION };
}

export function compareVersions(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) return d;
    }
    return 0;
}

const decode = (v) => `${v >>> 16}.${(v >>> 8) & 0xff}${(v & 0xff) ? `.${v & 0xff}` : ''}`;

// Returns [{ offset, minos, sdk }] for each macOS slice of a Mach-O (thin or
// fat), or null if the buffer is not a Mach-O. Parsed in JS so the guard runs
// on every host, not only where `otool` exists.
export function readMachOMinos(buf) {
    if (buf.length < 8) return null;
    const magicBE = buf.readUInt32BE(0);
    if (magicBE === 0xcafebabe) {
        const n = buf.readUInt32BE(4);
        const out = [];
        for (let i = 0; i < n; i++) {
            const off = buf.readUInt32BE(8 + i * 20 + 8);
            const slice = readMachOMinos(buf.subarray(off));
            if (slice) out.push(...slice);
        }
        return out;
    }
    if (buf.readUInt32LE(0) !== 0xfeedfacf) return null;
    const ncmds = buf.readUInt32LE(16);
    let p = 32;
    const out = [];
    for (let i = 0; i < ncmds && p + 8 <= buf.length; i++) {
        const cmd = buf.readUInt32LE(p);
        const size = buf.readUInt32LE(p + 4);
        if (cmd === 0x32 && buf.readUInt32LE(p + 8) === 1) { // LC_BUILD_VERSION, PLATFORM_MACOS
            out.push({ minos: decode(buf.readUInt32LE(p + 12)), sdk: decode(buf.readUInt32LE(p + 16)) });
        } else if (cmd === 0x24) { // LC_VERSION_MIN_MACOSX
            out.push({ minos: decode(buf.readUInt32LE(p + 8)), sdk: decode(buf.readUInt32LE(p + 12)) });
        }
        p += size;
    }
    return out;
}

// Problems for one file ([] when fine or when it is not a Mach-O).
export function macosMinVersionProblems(name, buf, floor = MACOS_MIN_VERSION) {
    const slices = readMachOMinos(buf);
    if (!slices) return [];
    if (slices.length === 0) return [`${name}: Mach-O carries no macOS minimum-version load command`];
    return slices
        .filter(({ minos }) => compareVersions(minos, floor) > 0)
        .map(({ minos }) => `${name}: minos ${minos} is above the macOS ${floor} floor (dyld will refuse it on older macOS; rebuild with MACOSX_DEPLOYMENT_TARGET=${floor})`);
}

export function macosMinVersionProblemsForFile(path, floor = MACOS_MIN_VERSION) {
    return macosMinVersionProblems(path.split(/[\\/]/).pop(), readFileSync(path), floor);
}
