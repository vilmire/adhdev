#!/usr/bin/env node
// Native file format checks that never load the binary, so the release gate can
// validate every platform's prebuilt from any host (release runs on Linux).
// Each shipped triplet must contain its platform's mandatory runtime set, and
// every file in it must be a shared library of that platform and architecture:
//
//   darwin-arm64  Mach-O 64-bit, CPU_TYPE_ARM64 (thin; fat binaries refused)
//   linux-x64     ELF64 little-endian, EM_X86_64, ET_DYN; the libraries carry
//                 SONAME libghostty-vt.so.0 and the addon NEEDs it
//   win32-x64     PE32+ DLL, IMAGE_FILE_MACHINE_AMD64
//
//   node scripts/native-format.mjs <dir>        # dir name: <platform>-<arch>-node<abi>
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ADDON_FILE = 'ghostty_vt_node.node';
export const LINUX_SONAME = 'libghostty-vt.so.0';

// The mandatory runtime set per platform: exact names or one-of patterns.
export const REQUIRED_RUNTIME = {
    darwin: [ADDON_FILE, 'libghostty-vt.dylib', /^libghostty-vt\.\d+\.\d+\.\d+\.dylib$/],
    linux: [ADDON_FILE, 'libghostty-vt.so', LINUX_SONAME, /^libghostty-vt\.so\.0\.\d+\.\d+$/],
    win32: [ADDON_FILE, 'ghostty-vt.dll'],
};

export const EXPECTED_FORMAT = {
    'darwin-arm64': { format: 'macho', arch: 'arm64' },
    'linux-x64': { format: 'elf', arch: 'x64' },
    'win32-x64': { format: 'pe', arch: 'x64' },
};

// "<platform>-<arch>-node<abi>" → { platform, arch }, or null.
export function parseTriplet(name) {
    const match = /^(darwin|linux|win32)-([a-z0-9]+)-node\d+$/.exec(name);
    return match ? { platform: match[1], arch: match[2] } : null;
}

const MACHO_CPU = { 0x0100000c: 'arm64', 0x01000007: 'x64' };
const MACHO_FILETYPE = { 6: 'dylib', 8: 'bundle' };
const ELF_MACHINE = { 62: 'x64', 183: 'arm64' };
const PE_MACHINE = { 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'ia32' };

function readCString(buffer, offset) {
    if (offset < 0 || offset >= buffer.length) return null;
    const end = buffer.indexOf(0, offset);
    return buffer.toString('latin1', offset, end < 0 ? buffer.length : end);
}

function inspectElf(buffer) {
    if (buffer.length < 64) return { format: 'elf', problem: 'truncated ELF header' };
    if (buffer[4] !== 2) return { format: 'elf', problem: 'not ELF64' };
    if (buffer[5] !== 1) return { format: 'elf', problem: 'not little-endian' };
    const type = buffer.readUInt16LE(16);
    const machine = buffer.readUInt16LE(18);
    const result = { format: 'elf', arch: ELF_MACHINE[machine] ?? `machine-${machine}`, kind: type === 3 ? 'shared' : `type-${type}`, soname: null, needed: [] };
    // DT_SONAME / DT_NEEDED from the SHT_DYNAMIC section and its linked string table.
    const shoff = Number(buffer.readBigUInt64LE(40));
    const shentsize = buffer.readUInt16LE(58);
    const shnum = buffer.readUInt16LE(60);
    if (!shoff || shentsize < 64 || shoff + shnum * shentsize > buffer.length) return { ...result, problem: 'no readable section headers' };
    const section = (index) => {
        const base = shoff + index * shentsize;
        return { type: buffer.readUInt32LE(base + 4), offset: Number(buffer.readBigUInt64LE(base + 24)), size: Number(buffer.readBigUInt64LE(base + 32)), link: buffer.readUInt32LE(base + 40) };
    };
    for (let i = 0; i < shnum; i++) {
        const dynamic = section(i);
        if (dynamic.type !== 6 /* SHT_DYNAMIC */) continue;
        if (dynamic.link >= shnum) return { ...result, problem: 'dynamic section has no string table' };
        const strtab = section(dynamic.link);
        for (let at = dynamic.offset; at + 16 <= dynamic.offset + dynamic.size && at + 16 <= buffer.length; at += 16) {
            const tag = Number(buffer.readBigInt64LE(at));
            if (tag === 0) break;
            if (tag !== 1 && tag !== 14) continue;
            const value = readCString(buffer, strtab.offset + Number(buffer.readBigUInt64LE(at + 8)));
            if (tag === 1) result.needed.push(value);
            else result.soname = value;
        }
        return result;
    }
    return { ...result, problem: 'no dynamic section' };
}

function inspectMachO(buffer) {
    if (buffer.length < 32) return { format: 'macho', problem: 'truncated Mach-O header' };
    const cpu = buffer.readUInt32LE(4);
    const filetype = buffer.readUInt32LE(12);
    return { format: 'macho', arch: MACHO_CPU[cpu] ?? `cpu-0x${cpu.toString(16)}`, kind: MACHO_FILETYPE[filetype] ?? `filetype-${filetype}` };
}

function inspectPe(buffer) {
    if (buffer.length < 0x40) return { format: 'pe', problem: 'truncated DOS header' };
    const peOffset = buffer.readUInt32LE(0x3c);
    if (peOffset + 24 > buffer.length || buffer.readUInt32LE(peOffset) !== 0x00004550) return { format: 'pe', problem: 'no PE signature' };
    const machine = buffer.readUInt16LE(peOffset + 4);
    const characteristics = buffer.readUInt16LE(peOffset + 22);
    return { format: 'pe', arch: PE_MACHINE[machine] ?? `machine-0x${machine.toString(16)}`, kind: characteristics & 0x2000 ? 'dll' : 'exe' };
}

// Identifies a native binary from its bytes alone.
export function inspectNative(buffer) {
    if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0x7f454c46) return inspectElf(buffer);
    if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0xfeedfacf) return inspectMachO(buffer);
    if (buffer.length >= 4 && (buffer.readUInt32BE(0) === 0xcafebabe || buffer.readUInt32BE(0) === 0xbebafeca)) return { format: 'macho-fat', problem: 'universal (fat) Mach-O; ship a thin binary' };
    if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0xfeedface) return { format: 'macho', problem: '32-bit Mach-O' };
    if (buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a) return inspectPe(buffer);
    return { format: 'unknown', problem: 'unrecognized file format' };
}

// Problems with one file for the given platform-arch ([] when it fits).
export function checkNativeFile(name, buffer, platform, arch) {
    const expected = EXPECTED_FORMAT[`${platform}-${arch}`];
    if (!expected) return [`${name}: no shipped format for ${platform}-${arch}`];
    const info = inspectNative(buffer);
    const problems = [];
    if (info.problem) problems.push(`${name}: ${info.problem}`);
    if (info.format !== expected.format) return [`${name}: ${info.format} binary, want ${expected.format} for ${platform}-${arch}`];
    if (info.arch && info.arch !== expected.arch) problems.push(`${name}: ${info.format} ${info.arch}, want ${expected.arch}`);
    if (info.problem) return problems;
    if (info.format === 'macho' && info.kind !== 'dylib' && info.kind !== 'bundle') problems.push(`${name}: Mach-O ${info.kind}, want a dylib/bundle`);
    if (info.format === 'pe' && info.kind !== 'dll') problems.push(`${name}: PE image is not a DLL`);
    if (info.format === 'elf') {
        if (info.kind !== 'shared') problems.push(`${name}: ELF ${info.kind}, want ET_DYN`);
        if (name === ADDON_FILE) {
            if (!info.needed.includes(LINUX_SONAME)) problems.push(`${name}: does not NEED ${LINUX_SONAME} (needs ${info.needed.join(', ') || 'nothing'})`);
        } else if (info.soname !== LINUX_SONAME) {
            problems.push(`${name}: SONAME ${info.soname ?? 'missing'}, want ${LINUX_SONAME}`);
        }
    }
    return problems;
}

// Problems with the runtime set present in `dir` for platform-arch.
export function checkRuntimeSet(dir, platform, arch, runtimeFiles) {
    const required = REQUIRED_RUNTIME[platform];
    if (!required || !EXPECTED_FORMAT[`${platform}-${arch}`]) return [`no shipped runtime set for ${platform}-${arch}`];
    const problems = [];
    for (const want of required) {
        const found = typeof want === 'string' ? runtimeFiles.includes(want) : runtimeFiles.some((name) => want.test(name));
        if (!found) problems.push(`required ${typeof want === 'string' ? want : want.source} missing`);
    }
    for (const name of runtimeFiles) problems.push(...checkNativeFile(name, readFileSync(resolve(dir, name)), platform, arch));
    return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    const dir = process.argv[2] && resolve(process.argv[2]);
    const parsed = dir && parseTriplet(basename(dir));
    if (!parsed || !existsSync(dir)) {
        console.error('usage: native-format.mjs <dir named <platform>-<arch>-node<abi>>');
        process.exit(2);
    }
    const files = readdirSync(dir).filter((name) => /\.(node|dylib|so|so\.\d.*|dll)$/.test(name)).sort();
    for (const name of files) console.log(`  ${name}: ${JSON.stringify(inspectNative(readFileSync(resolve(dir, name))))}`);
    const problems = checkRuntimeSet(dir, parsed.platform, parsed.arch, files);
    for (const problem of problems) console.log(`  ✗ ${problem}`);
    console.log(`[ghostty-vt] ${problems.length ? 'native format FAILED' : 'native format ok'} for ${parsed.platform}-${parsed.arch}`);
    if (problems.length) process.exit(1);
}
