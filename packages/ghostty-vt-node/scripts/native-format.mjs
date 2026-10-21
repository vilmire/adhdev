#!/usr/bin/env node
// Native file format checks that never load the binary, so the release gate can
// validate every platform's prebuilt from any host (release runs on Linux).
// Each shipped triplet must contain its platform's mandatory runtime set, and
// every file in it must be a shared library of that platform and architecture:
//
//   darwin-arm64  Mach-O 64-bit, CPU_TYPE_ARM64 (thin; fat binaries refused)
//   linux-x64     ELF64 little-endian, EM_X86_64, ET_DYN; the libraries carry
//                 SONAME libghostty-vt.so.0 and the addon NEEDs it
//   win32-x64     PE32+ DLL (optional header magic 0x20b, sane DLL fields),
//                 IMAGE_FILE_MACHINE_AMD64
//
// Headers are bounds-checked against the file length; a truncated or
// malformed header is a problem, never an exception or a silent pass.
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

// A NUL-terminated string that must lie entirely inside [base, base + size).
function readTableString(buffer, base, size, offset) {
    if (offset >= size) return null;
    const limit = Math.min(base + size, buffer.length);
    const end = buffer.indexOf(0, base + offset);
    if (end < 0 || end >= limit) return null;
    return buffer.toString('latin1', base + offset, end);
}

const fits = (buffer, offset, length) => Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0 && offset + length <= buffer.length;

function inspectElf(buffer) {
    if (buffer.length < 64) return { format: 'elf', problem: 'truncated ELF header' };
    if (buffer[4] !== 2) return { format: 'elf', problem: 'not ELF64' };
    if (buffer[5] !== 1) return { format: 'elf', problem: 'not little-endian' };
    if (buffer[6] !== 1 || buffer.readUInt32LE(20) !== 1) return { format: 'elf', problem: 'unsupported ELF version' };
    const type = buffer.readUInt16LE(16);
    const machine = buffer.readUInt16LE(18);
    const result = { format: 'elf', arch: ELF_MACHINE[machine] ?? `machine-${machine}`, kind: type === 3 ? 'shared' : `type-${type}`, soname: null, needed: [] };
    if (buffer.readUInt16LE(52) !== 64) return { ...result, problem: 'bad ELF header size' };
    // Program headers: a shared object is loaded through them.
    const phoff = Number(buffer.readBigUInt64LE(32));
    const phentsize = buffer.readUInt16LE(54);
    const phnum = buffer.readUInt16LE(56);
    if (phentsize !== 56 || phnum === 0 || !fits(buffer, phoff, phnum * phentsize)) return { ...result, problem: 'program header table missing or out of bounds' };
    // Section headers: DT_SONAME / DT_NEEDED come from SHT_DYNAMIC + its string table.
    const shoff = Number(buffer.readBigUInt64LE(40));
    const shentsize = buffer.readUInt16LE(58);
    const shnum = buffer.readUInt16LE(60);
    if (!shoff || shentsize !== 64 || shnum === 0 || !fits(buffer, shoff, shnum * shentsize)) return { ...result, problem: 'section header table missing or out of bounds' };
    if (buffer.readUInt16LE(62) >= shnum) return { ...result, problem: 'section name table index out of range' };
    const section = (index) => {
        const base = shoff + index * shentsize;
        return { type: buffer.readUInt32LE(base + 4), offset: Number(buffer.readBigUInt64LE(base + 24)), size: Number(buffer.readBigUInt64LE(base + 32)), link: buffer.readUInt32LE(base + 40) };
    };
    for (let i = 0; i < shnum; i++) {
        const dynamic = section(i);
        if (dynamic.type !== 6 /* SHT_DYNAMIC */) continue;
        if (!fits(buffer, dynamic.offset, dynamic.size) || dynamic.size % 16) return { ...result, problem: 'dynamic section out of bounds' };
        if (dynamic.link === 0 || dynamic.link >= shnum) return { ...result, problem: 'dynamic section has no string table' };
        const strtab = section(dynamic.link);
        if (strtab.type !== 3 /* SHT_STRTAB */ || !fits(buffer, strtab.offset, strtab.size)) return { ...result, problem: 'dynamic string table out of bounds' };
        for (let at = dynamic.offset; at < dynamic.offset + dynamic.size; at += 16) {
            const tag = Number(buffer.readBigInt64LE(at));
            if (tag === 0) break;
            if (tag !== 1 && tag !== 14) continue;
            const value = readTableString(buffer, strtab.offset, strtab.size, Number(buffer.readBigUInt64LE(at + 8)));
            if (value === null) return { ...result, problem: 'dynamic entry string out of bounds' };
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
    const result = { format: 'macho', arch: MACHO_CPU[cpu] ?? `cpu-0x${cpu.toString(16)}`, kind: MACHO_FILETYPE[filetype] ?? `filetype-${filetype}` };
    // Load commands: exactly ncmds well-formed commands filling sizeofcmds.
    const ncmds = buffer.readUInt32LE(16);
    const sizeofcmds = buffer.readUInt32LE(20);
    if (ncmds === 0 || !fits(buffer, 32, sizeofcmds)) return { ...result, problem: 'load commands missing or out of bounds' };
    let at = 32;
    for (let i = 0; i < ncmds; i++) {
        if (at + 8 > 32 + sizeofcmds) return { ...result, problem: 'load command table truncated' };
        const cmdsize = buffer.readUInt32LE(at + 4);
        if (cmdsize < 8 || cmdsize % 8 || at + cmdsize > 32 + sizeofcmds) return { ...result, problem: `malformed load command ${i}` };
        at += cmdsize;
    }
    if (at !== 32 + sizeofcmds) return { ...result, problem: 'load commands do not fill sizeofcmds' };
    return result;
}

const PE32_PLUS_MAGIC = 0x20b;
const PE32_PLUS_MIN_OPTIONAL_HEADER = 112; // standard + Windows-specific fields, before data directories

function inspectPe(buffer) {
    if (buffer.length < 0x40) return { format: 'pe', problem: 'truncated DOS header' };
    const peOffset = buffer.readUInt32LE(0x3c);
    if (peOffset < 0x40 || !fits(buffer, peOffset, 24) || buffer.readUInt32LE(peOffset) !== 0x00004550) return { format: 'pe', problem: 'no PE signature' };
    const machine = buffer.readUInt16LE(peOffset + 4);
    const sections = buffer.readUInt16LE(peOffset + 6);
    const optionalSize = buffer.readUInt16LE(peOffset + 20);
    const characteristics = buffer.readUInt16LE(peOffset + 22);
    const result = { format: 'pe', arch: PE_MACHINE[machine] ?? `machine-0x${machine.toString(16)}`, kind: characteristics & 0x2000 ? 'dll' : 'exe' };
    const opt = peOffset + 24;
    if (optionalSize === 0) return { ...result, problem: 'no optional header' };
    if (optionalSize < PE32_PLUS_MIN_OPTIONAL_HEADER || !fits(buffer, opt, optionalSize)) return { ...result, problem: `optional header size ${optionalSize} invalid or out of bounds` };
    const magic = buffer.readUInt16LE(opt);
    if (magic !== PE32_PLUS_MAGIC) return { ...result, problem: `optional header magic 0x${magic.toString(16)}, want 0x20b (PE32+)` };
    const problems = [];
    if (!(characteristics & 0x0002)) problems.push('not an executable image');
    const imageBase = buffer.readBigUInt64LE(opt + 24);
    const sectionAlignment = buffer.readUInt32LE(opt + 32);
    const fileAlignment = buffer.readUInt32LE(opt + 36);
    const sizeOfHeaders = buffer.readUInt32LE(opt + 60);
    const subsystem = buffer.readUInt16LE(opt + 68);
    const rvaCount = buffer.readUInt32LE(opt + 108);
    if (imageBase % 0x10000n !== 0n) problems.push('ImageBase not 64K aligned');
    if (fileAlignment < 512 || fileAlignment > 65536 || (fileAlignment & (fileAlignment - 1))) problems.push(`FileAlignment ${fileAlignment} invalid`);
    if (sectionAlignment < fileAlignment) problems.push('SectionAlignment below FileAlignment');
    if (subsystem !== 2 && subsystem !== 3) problems.push(`subsystem ${subsystem} is not a Windows GUI/CUI DLL`);
    if (rvaCount > 16 || PE32_PLUS_MIN_OPTIONAL_HEADER + rvaCount * 8 > optionalSize) problems.push(`NumberOfRvaAndSizes ${rvaCount} does not fit the optional header`);
    const sectionTable = opt + optionalSize;
    if (sections === 0 || sections > 96 || !fits(buffer, sectionTable, sections * 40)) problems.push('section table missing or out of bounds');
    else if (sizeOfHeaders < sectionTable + sections * 40 || sizeOfHeaders > buffer.length) problems.push('SizeOfHeaders inconsistent');
    return problems.length ? { ...result, problem: problems.join('; ') } : result;
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
