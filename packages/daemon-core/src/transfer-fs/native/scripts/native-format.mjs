#!/usr/bin/env node
// Native file format checks for transfer_fs_node.node without loading foreign binaries.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ADDON_FILE = 'transfer_fs_node.node';

export const REQUIRED_RUNTIME = {
  darwin: [ADDON_FILE],
  linux: [ADDON_FILE],
  win32: [ADDON_FILE],
};

export const EXPECTED_FORMAT = {
  'darwin-arm64': { format: 'macho', arch: 'arm64' },
  'linux-x64': { format: 'elf', arch: 'x64' },
  'win32-x64': { format: 'pe', arch: 'x64' },
};

export function parseTriplet(name) {
  const match = /^(darwin|linux|win32)-([a-z0-9]+)-node\d+$/.exec(name);
  return match ? { platform: match[1], arch: match[2] } : null;
}

const MACHO_CPU = { 0x0100000c: 'arm64', 0x01000007: 'x64' };
const MACHO_FILETYPE = { 6: 'dylib', 8: 'bundle' };
const ELF_MACHINE = { 62: 'x64', 183: 'arm64' };
const PE_MACHINE = { 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'ia32' };

const fits = (buffer, offset, length) =>
  Number.isSafeInteger(offset) &&
  Number.isSafeInteger(length) &&
  offset >= 0 &&
  length >= 0 &&
  offset + length <= buffer.length;

function inspectElf(buffer) {
  if (buffer.length < 64) return { format: 'elf', problem: 'truncated ELF header' };
  if (buffer[4] !== 2) return { format: 'elf', problem: 'not ELF64' };
  if (buffer[5] !== 1) return { format: 'elf', problem: 'not little-endian' };
  if (buffer[6] !== 1 || buffer.readUInt32LE(20) !== 1) return { format: 'elf', problem: 'unsupported ELF version' };
  const type = buffer.readUInt16LE(16);
  const machine = buffer.readUInt16LE(18);
  const result = {
    format: 'elf',
    arch: ELF_MACHINE[machine] ?? `machine-${machine}`,
    kind: type === 3 ? 'shared' : `type-${type}`,
  };
  if (buffer.readUInt16LE(52) !== 64) return { ...result, problem: 'bad ELF header size' };
  const phoff = Number(buffer.readBigUInt64LE(32));
  const phentsize = buffer.readUInt16LE(54);
  const phnum = buffer.readUInt16LE(56);
  if (phentsize !== 56 || phnum === 0 || !fits(buffer, phoff, phnum * phentsize)) {
    return { ...result, problem: 'program header table missing or out of bounds' };
  }
  return result;
}

function inspectMachO(buffer) {
  if (buffer.length < 32) return { format: 'macho', problem: 'truncated Mach-O header' };
  const cpu = buffer.readUInt32LE(4);
  const filetype = buffer.readUInt32LE(12);
  const result = {
    format: 'macho',
    arch: MACHO_CPU[cpu] ?? `cpu-0x${cpu.toString(16)}`,
    kind: MACHO_FILETYPE[filetype] ?? `filetype-${filetype}`,
  };
  const ncmds = buffer.readUInt32LE(16);
  const sizeofcmds = buffer.readUInt32LE(20);
  if (ncmds === 0 || !fits(buffer, 32, sizeofcmds)) {
    return { ...result, problem: 'load commands missing or out of bounds' };
  }
  return result;
}

const PE32_PLUS_MAGIC = 0x20b;
const PE32_PLUS_MIN_OPTIONAL_HEADER = 112;

function inspectPe(buffer) {
  if (buffer.length < 0x40) return { format: 'pe', problem: 'truncated DOS header' };
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset < 0x40 || !fits(buffer, peOffset, 24) || buffer.readUInt32LE(peOffset) !== 0x00004550) {
    return { format: 'pe', problem: 'no PE signature' };
  }
  const machine = buffer.readUInt16LE(peOffset + 4);
  const optionalSize = buffer.readUInt16LE(peOffset + 20);
  const characteristics = buffer.readUInt16LE(peOffset + 22);
  const result = {
    format: 'pe',
    arch: PE_MACHINE[machine] ?? `machine-0x${machine.toString(16)}`,
    kind: characteristics & 0x2000 ? 'dll' : 'exe',
  };
  const opt = peOffset + 24;
  if (optionalSize < PE32_PLUS_MIN_OPTIONAL_HEADER || !fits(buffer, opt, optionalSize)) {
    return { ...result, problem: `optional header size ${optionalSize} invalid or out of bounds` };
  }
  const magic = buffer.readUInt16LE(opt);
  if (magic !== PE32_PLUS_MAGIC) {
    return { ...result, problem: `optional header magic 0x${magic.toString(16)}, want 0x20b (PE32+)` };
  }
  return result;
}

export function inspectNative(buffer) {
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0x7f454c46) return inspectElf(buffer);
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0xfeedfacf) return inspectMachO(buffer);
  if (buffer.length >= 4 && (buffer.readUInt32BE(0) === 0xcafebabe || buffer.readUInt32BE(0) === 0xbebafeca)) {
    return { format: 'macho-fat', problem: 'universal (fat) Mach-O; ship a thin binary' };
  }
  if (buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a) return inspectPe(buffer);
  return { format: 'unknown', problem: 'unrecognized file format' };
}

export function checkNativeFile(name, buffer, platform, arch) {
  const expected = EXPECTED_FORMAT[`${platform}-${arch}`];
  if (!expected) return [`${name}: no shipped format for ${platform}-${arch}`];
  const info = inspectNative(buffer);
  const problems = [];
  if (info.problem) problems.push(`${name}: ${info.problem}`);
  if (info.format !== expected.format) return [`${name}: ${info.format} binary, want ${expected.format} for ${platform}-${arch}`];
  if (info.arch && info.arch !== expected.arch) problems.push(`${name}: ${info.format} ${info.arch}, want ${expected.arch}`);
  if (info.format === 'macho' && info.kind !== 'dylib' && info.kind !== 'bundle') {
    problems.push(`${name}: Mach-O ${info.kind}, want a dylib/bundle`);
  }
  if (info.format === 'pe' && info.kind !== 'dll') {
    problems.push(`${name}: PE image is not a DLL`);
  }
  if (info.format === 'elf' && info.kind !== 'shared') {
    problems.push(`${name}: ELF ${info.kind}, want ET_DYN`);
  }
  return problems;
}

export function checkRuntimeSet(dir, platform, arch, runtimeFiles) {
  const required = REQUIRED_RUNTIME[platform];
  if (!required || !EXPECTED_FORMAT[`${platform}-${arch}`]) return [`no shipped runtime set for ${platform}-${arch}`];
  const problems = [];
  for (const want of required) {
    if (!runtimeFiles.includes(want)) problems.push(`required ${want} missing`);
  }
  for (const name of runtimeFiles) {
    problems.push(...checkNativeFile(name, readFileSync(resolve(dir, name)), platform, arch));
  }
  return problems;
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const dir = process.argv[2] && resolve(process.argv[2]);
  const parsed = dir && parseTriplet(basename(dir));
  if (!parsed || !existsSync(dir)) {
    console.error('usage: native-format.mjs <dir named <platform>-<arch>-node<abi>>');
    process.exit(2);
  }
  const files = readdirSync(dir).filter((name) => /\.node$/.test(name)).sort();
  const problems = checkRuntimeSet(dir, parsed.platform, parsed.arch, files);
  for (const problem of problems) console.log(`  ✗ ${problem}`);
  console.log(`[transfer-fs] ${problems.length ? 'native format FAILED' : 'native format ok'} for ${parsed.platform}-${parsed.arch}`);
  if (problems.length) process.exit(1);
}
