#!/usr/bin/env node
// Build and stamp prebuilts for win32-x64, linux-x64, and darwin-arm64.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PACKAGE_DIR, computeBindingDigest, expectedApiLevel } from './binding-digest.mjs';
import { printHostPathReport, scanHostPaths } from './host-path-scan.mjs';
import { ADDON_FILE } from './native-format.mjs';
import { PREBUILT_ROOT, checkManifests, emitPrebuilt, printManifestReport, writeManifest } from './prebuilt-manifest.mjs';

function firstExisting(candidates) {
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return candidates[0];
}

const ZIG_EXE = firstExisting([
  process.env.ZIG_EXECUTABLE,
  '/opt/homebrew/bin/zig',
  '/usr/local/bin/zig',
  '/usr/bin/zig',
  'C:\\zig-0.15.2\\zig.exe',
]);

const NODE_INC = firstExisting([
  process.env.CMAKE_JS_INC,
  resolve(process.execPath, '../../include/node'),
  '/opt/homebrew/include/node',
  resolve(PACKAGE_DIR, '../../../../node_modules/node-api-headers/include'),
  resolve(PACKAGE_DIR, '../../../../../node_modules/node-api-headers/include'),
  'C:/gvn-home/.cmake-js/node-x64/v22.14.0/include/node',
]);

const NODE_DEF = firstExisting([
  process.env.NODE_API_DEF,
  '/opt/homebrew/lib/node_modules/openclaw/node_modules/node-api-headers/def/node_api.def',
  resolve(PACKAGE_DIR, '../../../../node_modules/node-api-headers/def/node_api.def'),
  resolve(PACKAGE_DIR, '../../../../../node_modules/node-api-headers/def/node_api.def'),
]);

const NODE_LIB = process.env.CMAKE_JS_LIB || 'C:/gvn-home/.cmake-js/node-x64/v22.14.0/win-x64/node.lib';

const digest = computeBindingDigest(PACKAGE_DIR);
const apiLevel = expectedApiLevel(PACKAGE_DIR);
let zigCompilerLabel = 'zig cc 0.15.2';
if (existsSync(ZIG_EXE)) {
  try {
    const ver = execFileSync(ZIG_EXE, ['version'], { encoding: 'utf8' }).trim();
    if (ver) zigCompilerLabel = `zig cc ${ver}`;
  } catch {
    /* keep default */
  }
}

const neutralHome = process.platform === 'win32' ? 'C:\\gvn-home' : '/tmp/adhdev-tfs-build-home';
const neutralCacheBase = process.platform === 'win32' ? join(PACKAGE_DIR, 'build') : '/tmp/adhdev-tfs-zig-cache';

const neutralEnv = {
  ...process.env,
  HOME: neutralHome,
  USERPROFILE: neutralHome,
  ZIG_GLOBAL_CACHE_DIR: join(neutralCacheBase, 'zig-global'),
  ZIG_LOCAL_CACHE_DIR: join(neutralCacheBase, 'zig-local'),
};

if (process.platform === 'win32') {
  console.log('[transfer-fs] building win32-x64-node137 with CMake/MSVC...');
  execFileSync(
    'cmake',
    [
      '-B', join(PACKAGE_DIR, 'build'),
      '-S', PACKAGE_DIR,
      `-DCMAKE_JS_INC=${NODE_INC}`,
      `-DCMAKE_JS_LIB=${NODE_LIB}`,
    ],
    { cwd: PACKAGE_DIR, stdio: 'inherit', env: neutralEnv, windowsHide: true },
  );
  execFileSync(
    'cmake',
    ['--build', join(PACKAGE_DIR, 'build'), '--config', 'Release'],
    { cwd: PACKAGE_DIR, stdio: 'inherit', env: neutralEnv, windowsHide: true },
  );
  emitPrebuilt(join(PACKAGE_DIR, 'build', 'Release'));
} else if (existsSync(ZIG_EXE) && existsSync(NODE_DEF)) {
  console.log(`[transfer-fs] cross-compiling win32-x64-node137 with ${zigCompilerLabel}...`);
  const winDir = join(PREBUILT_ROOT, 'win32-x64-node137');
  mkdirSync(winDir, { recursive: true });
  mkdirSync(neutralCacheBase, { recursive: true });
  const winImportLib = join(neutralCacheBase, 'node.lib');
  execFileSync(
    ZIG_EXE,
    ['dlltool', '-m', 'i386:x86-64', '-D', 'node.exe', '-d', NODE_DEF, '-l', winImportLib],
    { cwd: PACKAGE_DIR, stdio: 'inherit', env: neutralEnv },
  );
  const winDllRel = 'prebuilt/win32-x64-node137/transfer_fs_node.dll';
  const winDll = join(PACKAGE_DIR, winDllRel);
  const winNode = join(winDir, ADDON_FILE);
  rmSync(winNode, { force: true });
  execFileSync(
    ZIG_EXE,
    [
      'cc',
      '-target', 'x86_64-windows-gnu',
      '-shared',
      '-O2',
      '-s',
      '-std=c11',
      `-ffile-prefix-map=${PACKAGE_DIR}=.`,
      `-I${NODE_INC}`,
      '-DNAPI_VERSION=8',
      `-DADHDEV_TRANSFER_FS_API_LEVEL=${apiLevel}`,
      `-DADHDEV_TRANSFER_FS_SOURCE_DIGEST="${digest}"`,
      `-DADHDEV_TRANSFER_FS_C_COMPILER="${zigCompilerLabel}"`,
      '-DADHDEV_TRANSFER_FS_BUILD_TYPE="Release"',
      'src/transfer_fs_napi.c',
      winImportLib,
      '-lntdll',
      '-o', winDllRel,
    ],
    { cwd: PACKAGE_DIR, stdio: 'inherit', env: neutralEnv },
  );
  renameSync(winDll, winNode);
  rmSync(join(winDir, 'transfer_fs_napi.lib'), { force: true });
  rmSync(join(winDir, 'transfer_fs_node.lib'), { force: true });
  rmSync(join(winDir, 'transfer_fs_node.pdb'), { force: true });
  writeManifest(winDir, { platform: 'win32', arch: 'x64', cCompiler: zigCompilerLabel });
}

if (existsSync(ZIG_EXE)) {
  // 1. linux-x64-node137
  console.log(`[transfer-fs] cross-compiling linux-x64-node137 with ${zigCompilerLabel}...`);
  const linuxDir = join(PREBUILT_ROOT, 'linux-x64-node137');
  mkdirSync(linuxDir, { recursive: true });
  const linuxSoRel = 'prebuilt/linux-x64-node137/transfer_fs_node.so';
  const linuxSo = join(PACKAGE_DIR, linuxSoRel);
  const linuxNode = join(linuxDir, ADDON_FILE);
  rmSync(linuxNode, { force: true });
  execFileSync(
    ZIG_EXE,
    [
      'cc',
      '-target', 'x86_64-linux-gnu',
      '-shared',
      '-fPIC',
      '-O2',
      '-s',
      '-std=c11',
      `-ffile-prefix-map=${PACKAGE_DIR}=.`,
      '-Wl,--allow-shlib-undefined',
      `-I${NODE_INC}`,
      '-DNAPI_VERSION=8',
      `-DADHDEV_TRANSFER_FS_API_LEVEL=${apiLevel}`,
      `-DADHDEV_TRANSFER_FS_SOURCE_DIGEST="${digest}"`,
      `-DADHDEV_TRANSFER_FS_C_COMPILER="${zigCompilerLabel}"`,
      '-DADHDEV_TRANSFER_FS_BUILD_TYPE="Release"',
      'src/transfer_fs_napi.c',
      '-o', linuxSoRel,
    ],
    { cwd: PACKAGE_DIR, stdio: 'inherit', env: neutralEnv, windowsHide: true },
  );
  renameSync(linuxSo, linuxNode);
  writeManifest(linuxDir, { platform: 'linux', arch: 'x64', cCompiler: zigCompilerLabel });

  // 2. darwin-arm64-node137
  console.log(`[transfer-fs] compiling darwin-arm64-node137 with ${zigCompilerLabel}...`);
  const darwinDir = join(PREBUILT_ROOT, 'darwin-arm64-node137');
  mkdirSync(darwinDir, { recursive: true });
  const darwinDylibRel = 'prebuilt/darwin-arm64-node137/transfer_fs_node.dylib';
  const darwinDylib = join(PACKAGE_DIR, darwinDylibRel);
  const darwinNode = join(darwinDir, ADDON_FILE);
  rmSync(darwinNode, { force: true });
  execFileSync(
    ZIG_EXE,
    [
      'cc',
      '-target', 'aarch64-macos',
      '-dynamiclib',
      '-fPIC',
      '-O2',
      '-Wl,-x',
      '-Wl,-S',
      `-Wl,-install_name,@rpath/${ADDON_FILE}`,
      '-Wl,-undefined,dynamic_lookup',
      '-std=c11',
      `-ffile-prefix-map=${PACKAGE_DIR}=.`,
      `-I${NODE_INC}`,
      '-DNAPI_VERSION=8',
      `-DADHDEV_TRANSFER_FS_API_LEVEL=${apiLevel}`,
      `-DADHDEV_TRANSFER_FS_SOURCE_DIGEST="${digest}"`,
      `-DADHDEV_TRANSFER_FS_C_COMPILER="${zigCompilerLabel}"`,
      '-DADHDEV_TRANSFER_FS_BUILD_TYPE="Release"',
      'src/transfer_fs_napi.c',
      '-o', darwinDylibRel,
    ],
    { cwd: PACKAGE_DIR, stdio: 'inherit', env: neutralEnv, windowsHide: true },
  );
  renameSync(darwinDylib, darwinNode);
  writeManifest(darwinDir, { platform: 'darwin', arch: 'arm64', cCompiler: zigCompilerLabel });
}

if (!printManifestReport(checkManifests())) process.exit(1);
if (!printHostPathReport(scanHostPaths())) process.exit(1);
