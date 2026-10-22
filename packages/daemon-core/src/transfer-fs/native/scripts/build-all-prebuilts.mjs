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

const ZIG_EXE = process.env.ZIG_EXECUTABLE || 'C:\\zig-0.15.2\\zig.exe';
const NODE_INC = process.env.CMAKE_JS_INC || 'C:/gvn-home/.cmake-js/node-x64/v22.14.0/include/node';
const NODE_LIB = process.env.CMAKE_JS_LIB || 'C:/gvn-home/.cmake-js/node-x64/v22.14.0/win-x64/node.lib';

const digest = computeBindingDigest(PACKAGE_DIR);
const apiLevel = expectedApiLevel(PACKAGE_DIR);

const neutralEnv = {
  ...process.env,
  HOME: 'C:\\gvn-home',
  USERPROFILE: 'C:\\gvn-home',
  ZIG_GLOBAL_CACHE_DIR: join(PACKAGE_DIR, 'build', 'zig-global'),
  ZIG_LOCAL_CACHE_DIR: join(PACKAGE_DIR, 'build', 'zig-local'),
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
}

if (existsSync(ZIG_EXE)) {
  // 1. linux-x64-node137
  console.log('[transfer-fs] cross-compiling linux-x64-node137 with zig cc...');
  const linuxDir = join(PREBUILT_ROOT, 'linux-x64-node137');
  mkdirSync(linuxDir, { recursive: true });
  const linuxSo = join(linuxDir, 'transfer_fs_node.so');
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
      '-Wl,--allow-shlib-undefined',
      `-I${NODE_INC}`,
      '-DNAPI_VERSION=8',
      `-DADHDEV_TRANSFER_FS_API_LEVEL=${apiLevel}`,
      `-DADHDEV_TRANSFER_FS_SOURCE_DIGEST="${digest}"`,
      '-DADHDEV_TRANSFER_FS_C_COMPILER="zig cc 0.15.2"',
      '-DADHDEV_TRANSFER_FS_BUILD_TYPE="Release"',
      'src/transfer_fs_napi.c',
      '-o', linuxSo,
    ],
    { cwd: PACKAGE_DIR, stdio: 'inherit', env: neutralEnv, windowsHide: true },
  );
  renameSync(linuxSo, linuxNode);
  writeManifest(linuxDir, { platform: 'linux', arch: 'x64', cCompiler: 'zig cc 0.15.2' });

  // 2. darwin-arm64-node137
  console.log('[transfer-fs] cross-compiling darwin-arm64-node137 with zig cc...');
  const darwinDir = join(PREBUILT_ROOT, 'darwin-arm64-node137');
  mkdirSync(darwinDir, { recursive: true });
  const darwinDylib = join(darwinDir, 'transfer_fs_node.dylib');
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
      '-Wl,-undefined,dynamic_lookup',
      '-std=c11',
      `-I${NODE_INC}`,
      '-DNAPI_VERSION=8',
      `-DADHDEV_TRANSFER_FS_API_LEVEL=${apiLevel}`,
      `-DADHDEV_TRANSFER_FS_SOURCE_DIGEST="${digest}"`,
      '-DADHDEV_TRANSFER_FS_C_COMPILER="zig cc 0.15.2"',
      '-DADHDEV_TRANSFER_FS_BUILD_TYPE="Release"',
      'src/transfer_fs_napi.c',
      '-o', darwinDylib,
    ],
    { cwd: PACKAGE_DIR, stdio: 'inherit', env: neutralEnv, windowsHide: true },
  );
  renameSync(darwinDylib, darwinNode);
  writeManifest(darwinDir, { platform: 'darwin', arch: 'arm64', cCompiler: 'zig cc 0.15.2' });
}

if (!printManifestReport(checkManifests())) process.exit(1);
if (!printHostPathReport(scanHostPaths())) process.exit(1);
