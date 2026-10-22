/**
 * Cross-platform N-API handle-relative / atomic no-replace filesystem helper (Phase 1).
 *
 * Wraps `transfer_fs_node.node` (`src/transfer_fs_napi.c`) to provide:
 * - Handle-pinned root opening (`openRoot`) with symlink/junction/reparse refusal
 *   and full-width 128-bit Windows `FileIdInfo` / 64-bit POSIX `(dev, ino)` identity
 * - Step-by-step handle-relative directory walk (`walkDir`) and exclusive directory
 *   creation (`mkdirExcl`) via `ntdll!NtCreateFile(RootDirectory=parent, FILE_OPEN_REPARSE_POINT)`
 *   on Windows and `openat(..., O_NOFOLLOW | O_DIRECTORY)` / `mkdirat` on POSIX
 * - Exclusive file creation (`createExcl`) and safe regular-file read open (`openFileRead`,
 *   rejecting hardlinks `linkCount > 1`)
 * - Direct handle-based I/O (`writeHandle`, `readHandle`) and directory+file durability
 *   (`fullFsync` -> `FlushFileBuffers` on Windows, `fcntl(F_FULLFSYNC)` on macOS, `fsync` on Linux)
 * - Atomic no-replace rename (`renameExcl` / `renameAtExcl` -> `ntdll!NtSetInformationFile`
 *   class 65 `FileRenameInformationEx` with `Flags = 0` and `RootDirectory = targetDirHandle`
 *   on Windows; `renameatx_np(..., RENAME_EXCL)` on macOS; `renameat2(..., RENAME_NOREPLACE)` on Linux)
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TransferFsError,
  splitPortableRelativePath,
  validateTransferSegment,
  type TransferFsErrorCode,
} from './path-validation.js';

const ADDON_FILE = 'transfer_fs_node.node';
const requireNative = createRequire(import.meta.url);

export interface TransferFsBindingInfo {
  apiLevel: number;
  sourceDigest: string;
  napiVersion: number;
  cCompiler: string;
  buildType: string;
  releaseEligible: boolean;
}

export interface NativeHandleIdentity {
  volumeId: bigint;
  fileId: bigint;
  fileIdLow: bigint;
  fileIdHigh: bigint;
  fileIdHex: string;
  linkCount: number;
  size: bigint;
  isDirectory: boolean;
  isReparsePoint: boolean;
  reparseTag: number;
}

export interface RootCapabilitiesProbe {
  filesystem: string;
  volumeFlags: number;
  supports128BitFileId: boolean;
  supportsDirFullFsync: boolean;
  caseSensitiveDir: boolean;
}

interface RawTransferFsAddon {
  getBindingInfo(): TransferFsBindingInfo;
  openRoot(rootPath: string): number;
  walkDir(parentHandle: number, segment: string): number;
  mkdirExcl(parentHandle: number, segment: string): number;
  createExcl(parentHandle: number, segment: string): number;
  openFileRead(parentHandle: number, segment: string): number;
  renameExcl(srcHandle: number, targetDirHandle: number, newName: string): boolean;
  renameAtExcl(srcDirHandle: number, srcName: string, targetDirHandle: number, newName: string): boolean;
  writeHandle(
    handle: number,
    buffer: Buffer,
    offset?: number,
    length?: number,
    position?: number,
  ): number;
  readHandle(
    handle: number,
    buffer: Buffer,
    offset?: number,
    length?: number,
    position?: number,
  ): number;
  fullFsync(handle: number): boolean;
  unlinkAt(parentHandle: number, segment: string, isDirectory?: boolean): boolean;
  getIdentity(handle: number): NativeHandleIdentity;
  probeRoot(rootPath: string): RootCapabilitiesProbe;
  close(handle: number): boolean;
}

function resolveNativeRootDirs(): string[] {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(moduleDir, 'native'),
    path.resolve(moduleDir, '../src/transfer-fs/native'),
    path.resolve(moduleDir, '../../src/transfer-fs/native'),
    path.resolve(process.cwd(), 'oss/packages/daemon-core/src/transfer-fs/native'),
    path.resolve(process.cwd(), 'packages/daemon-core/src/transfer-fs/native'),
    path.resolve(process.cwd(), 'src/transfer-fs/native'),
  ];
}

function listSamePlatformTriplets(prebuiltRoot: string, exactTriplet: string): string[] {
  const prefix = `${process.platform}-${process.arch}-`;
  try {
    return fs
      .readdirSync(prebuiltRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix) && entry.name !== exactTriplet)
      .map((entry) => entry.name)
      .filter((name) => fs.existsSync(path.join(prebuiltRoot, name, ADDON_FILE)))
      .sort();
  } catch {
    return [];
  }
}

let cachedBinding: RawTransferFsAddon | null = null;

function loadRawBinding(): RawTransferFsAddon {
  if (cachedBinding) return cachedBinding;

  const triplet = `${process.platform}-${process.arch}-node${process.versions.modules}`;
  const explicitPrebuiltDir = process.env.ADHDEV_TRANSFER_FS_PREBUILT_DIR
    ? path.resolve(process.env.ADHDEV_TRANSFER_FS_PREBUILT_DIR)
    : null;

  const candidates: string[] = [];
  if (explicitPrebuiltDir) {
    candidates.push(path.join(explicitPrebuiltDir, triplet, ADDON_FILE));
    candidates.push(path.join(explicitPrebuiltDir, ADDON_FILE));
  }

  for (const nativeRoot of resolveNativeRootDirs()) {
    const prebuiltRoot = path.join(nativeRoot, 'prebuilt');
    candidates.push(path.join(nativeRoot, 'build', 'Release', ADDON_FILE));
    candidates.push(path.join(nativeRoot, 'build', 'Debug', ADDON_FILE));
    candidates.push(path.join(prebuiltRoot, triplet, ADDON_FILE));
    for (const fallback of listSamePlatformTriplets(prebuiltRoot, triplet)) {
      candidates.push(path.join(prebuiltRoot, fallback, ADDON_FILE));
    }
  }

  const seen = new Set<string>();
  const errors: string[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (!fs.existsSync(candidate)) continue;
    try {
      const loaded = requireNative(candidate) as RawTransferFsAddon;
      cachedBinding = loaded;
      return loaded;
    } catch (err) {
      errors.push(`${candidate}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(
    `Unable to load transfer_fs_node native binding for triplet "${triplet}". Attempts: ${
      errors.join(' | ') || 'no candidate files found'
    }`,
  );
}

function classifyNativeError(op: string, err: unknown): TransferFsError {
  if (err instanceof TransferFsError) return err;
  const nativeErr = err as { code?: string; message?: string };
  const code = String(nativeErr?.code ?? 'EIO');
  const msg = String(nativeErr?.message ?? err);

  let reason: TransferFsErrorCode = 'IO_ERROR';
  if (code === 'ELOOP' || /WIN_1920\b/.test(msg)) {
    reason = 'SYMLINK_OR_REPARSE_REJECTED';
  } else if (code === 'EEXIST' || /WIN_(?:80|183)\b/.test(msg)) {
    reason = 'TARGET_EXISTS';
  } else if (code === 'EINVAL' || /WIN_(?:87|123|161|206)\b/.test(msg)) {
    reason = 'PATH_TRAVERSAL_REJECTED';
  } else if (code === 'EMLINK') {
    reason = 'HARDLINK_REJECTED';
  } else if (code === 'ENOSPC' || /WIN_(?:39|112)\b/.test(msg)) {
    reason = 'DISK_SPACE_EXHAUSTED';
  } else if (code === 'EBADF' || /WIN_6\b/.test(msg)) {
    reason = 'INVALID_HANDLE';
  } else if (op === 'openRoot' || op === 'probeRoot') {
    reason = 'ROOT_UNAVAILABLE';
  }

  return new TransferFsError(reason, `${op}: ${msg}`, code, msg);
}

export function getBindingInfo(): TransferFsBindingInfo {
  return loadRawBinding().getBindingInfo();
}

export function openRoot(rootPath: string): number {
  if (typeof rootPath !== 'string' || rootPath.trim().length === 0 || rootPath.includes('\0')) {
    throw new TransferFsError(
      'ROOT_UNAVAILABLE',
      'Root path must be a non-empty string without NUL bytes',
      'EINVAL',
    );
  }
  try {
    return loadRawBinding().openRoot(rootPath);
  } catch (err) {
    throw classifyNativeError('openRoot', err);
  }
}

export function walkDir(
  parentHandle: number,
  segment: string,
  options?: { allowProtectedMetadata?: boolean },
): number {
  validateTransferSegment(segment, options);
  try {
    return loadRawBinding().walkDir(parentHandle, segment);
  } catch (err) {
    throw classifyNativeError('walkDir', err);
  }
}

export function mkdirExcl(
  parentHandle: number,
  segment: string,
  options?: { allowProtectedMetadata?: boolean },
): number {
  validateTransferSegment(segment, options);
  try {
    return loadRawBinding().mkdirExcl(parentHandle, segment);
  } catch (err) {
    throw classifyNativeError('mkdirExcl', err);
  }
}

export function createExcl(
  parentHandle: number,
  segment: string,
  options?: { allowProtectedMetadata?: boolean },
): number {
  validateTransferSegment(segment, options);
  try {
    return loadRawBinding().createExcl(parentHandle, segment);
  } catch (err) {
    throw classifyNativeError('createExcl', err);
  }
}

export function openFileRead(
  parentHandle: number,
  segment: string,
  options?: { allowProtectedMetadata?: boolean },
): number {
  validateTransferSegment(segment, options);
  try {
    return loadRawBinding().openFileRead(parentHandle, segment);
  } catch (err) {
    throw classifyNativeError('openFileRead', err);
  }
}

export function renameExcl(
  srcHandle: number,
  targetDirHandle: number,
  newName: string,
  options?: { allowProtectedMetadata?: boolean },
): boolean {
  validateTransferSegment(newName, options);
  try {
    return loadRawBinding().renameExcl(srcHandle, targetDirHandle, newName);
  } catch (err) {
    throw classifyNativeError('renameExcl', err);
  }
}

export function renameAtExcl(
  srcDirHandle: number,
  srcName: string,
  targetDirHandle: number,
  newName: string,
  options?: { allowProtectedMetadata?: boolean },
): boolean {
  validateTransferSegment(srcName, options);
  validateTransferSegment(newName, options);
  try {
    return loadRawBinding().renameAtExcl(srcDirHandle, srcName, targetDirHandle, newName);
  } catch (err) {
    throw classifyNativeError('renameAtExcl', err);
  }
}

export function writeHandle(
  handle: number,
  buffer: Buffer | Uint8Array,
  offset?: number,
  length?: number,
  position?: number,
): number {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  try {
    return loadRawBinding().writeHandle(handle, buf, offset, length, position);
  } catch (err) {
    throw classifyNativeError('writeHandle', err);
  }
}

export function readHandle(
  handle: number,
  buffer: Buffer | Uint8Array,
  offset?: number,
  length?: number,
  position?: number,
): number {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  try {
    return loadRawBinding().readHandle(handle, buf, offset, length, position);
  } catch (err) {
    throw classifyNativeError('readHandle', err);
  }
}

export function fullFsync(handle: number): boolean {
  try {
    return loadRawBinding().fullFsync(handle);
  } catch (err) {
    throw classifyNativeError('fullFsync', err);
  }
}

export function unlinkAt(
  parentHandle: number,
  segment: string,
  isDirectory: boolean = false,
  options?: { allowProtectedMetadata?: boolean },
): boolean {
  validateTransferSegment(segment, options);
  try {
    return loadRawBinding().unlinkAt(parentHandle, segment, isDirectory);
  } catch (err) {
    throw classifyNativeError('unlinkAt', err);
  }
}

export function getIdentity(handle: number): NativeHandleIdentity {
  try {
    return loadRawBinding().getIdentity(handle);
  } catch (err) {
    throw classifyNativeError('getIdentity', err);
  }
}

export function probeRoot(rootPath: string): RootCapabilitiesProbe {
  try {
    return loadRawBinding().probeRoot(rootPath);
  } catch (err) {
    throw classifyNativeError('probeRoot', err);
  }
}

export function close(handle: number): boolean {
  try {
    return loadRawBinding().close(handle);
  } catch (err) {
    throw classifyNativeError('close', err);
  }
}

export function verifyHandleIdentity(
  handle: number,
  expected: { volumeId: bigint; fileId: bigint },
): NativeHandleIdentity {
  const current = getIdentity(handle);
  if (current.isReparsePoint) {
    throw new TransferFsError(
      'SYMLINK_OR_REPARSE_REJECTED',
      'Handle became a reparse point or symlink',
      'ELOOP',
    );
  }
  if (current.volumeId !== expected.volumeId || current.fileId !== expected.fileId) {
    throw new TransferFsError(
      'ROOT_UNAVAILABLE',
      `Handle identity changed (${current.volumeId}:${current.fileIdHex} !== ${expected.volumeId}:${expected.fileId.toString(16)})`,
      'ELOOP',
    );
  }
  return current;
}

export interface ResolvedParentChain {
  parentHandle: number;
  leafName: string;
  intermediateHandles: number[];
  createdDirs: Array<{ parentHandle: number; name: string }>;
}

/**
 * Resolve every directory hop of a relative path handle-relatively from `rootHandle`
 * without ever following symlinks, junctions, or reparse points.
 */
export function resolveParentDirHandle(
  rootHandle: number,
  relPath: string,
  options?: { createDirs?: boolean; allowProtectedMetadata?: boolean },
): ResolvedParentChain {
  const segments = splitPortableRelativePath(relPath, {
    allowProtectedMetadata: options?.allowProtectedMetadata,
  });
  const leafName = segments[segments.length - 1]!;
  const dirSegments = segments.slice(0, -1);

  const intermediateHandles: number[] = [];
  const createdDirs: Array<{ parentHandle: number; name: string }> = [];
  let currentHandle = rootHandle;

  try {
    for (const seg of dirSegments) {
      let nextHandle: number;
      try {
        nextHandle = walkDir(currentHandle, seg, {
          allowProtectedMetadata: options?.allowProtectedMetadata,
        });
      } catch (err) {
        const tfErr = err as TransferFsError;
        if (options?.createDirs && tfErr.code === 'ENOENT') {
          try {
            nextHandle = mkdirExcl(currentHandle, seg, {
              allowProtectedMetadata: options?.allowProtectedMetadata,
            });
            createdDirs.push({ parentHandle: currentHandle, name: seg });
          } catch (mkErr) {
            const mkTfErr = mkErr as TransferFsError;
            if (mkTfErr.code === 'EEXIST') {
              nextHandle = walkDir(currentHandle, seg, {
                allowProtectedMetadata: options?.allowProtectedMetadata,
              });
            } else {
              throw mkErr;
            }
          }
        } else {
          throw err;
        }
      }
      intermediateHandles.push(nextHandle);
      currentHandle = nextHandle;
    }

    return {
      parentHandle: currentHandle,
      leafName,
      intermediateHandles,
      createdDirs,
    };
  } catch (err) {
    for (let i = intermediateHandles.length - 1; i >= 0; i--) {
      try {
        close(intermediateHandles[i]!);
      } catch {
        /* ignore cleanup close error */
      }
    }
    throw err;
  }
}

/**
 * Write a brand-new file handle-relatively inside `rootHandle` using staging + `fullFsync` +
 * atomic no-replace `renameExcl` + parent directory `fullFsync`.
 */
export function writeNewFileAtomic(
  rootHandle: number,
  relPath: string,
  data: Buffer | Uint8Array,
  options?: { createDirs?: boolean; stagePrefix?: string },
): { identity: NativeHandleIdentity } {
  const chain = resolveParentDirHandle(rootHandle, relPath, {
    createDirs: options?.createDirs ?? true,
  });
  const stageName = `${options?.stagePrefix ?? '.adhdev-stage'}-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`;

  let stageHandle: number | null = null;
  let stageCreated = false;
  let published = false;

  try {
    stageHandle = createExcl(chain.parentHandle, stageName, { allowProtectedMetadata: true });
    stageCreated = true;

    if (data.byteLength > 0) {
      writeHandle(stageHandle, data);
    }
    fullFsync(stageHandle);

    const identity = getIdentity(stageHandle);
    renameExcl(stageHandle, chain.parentHandle, chain.leafName);
    published = true;

    close(stageHandle);
    stageHandle = null;

    fullFsync(chain.parentHandle);
    for (let i = chain.createdDirs.length - 1; i >= 0; i--) {
      try {
        fullFsync(chain.createdDirs[i]!.parentHandle);
      } catch {
        /* best effort parent dir flush */
      }
    }

    return { identity };
  } finally {
    if (stageHandle !== null) {
      try {
        close(stageHandle);
      } catch {
        /* ignore */
      }
    }
    if (stageCreated && !published) {
      try {
        unlinkAt(chain.parentHandle, stageName, false, { allowProtectedMetadata: true });
      } catch {
        /* ignore cleanup failure */
      }
    }
    for (let i = chain.intermediateHandles.length - 1; i >= 0; i--) {
      try {
        close(chain.intermediateHandles[i]!);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Safely read an existing regular file handle-relatively from `rootHandle`,
 * rejecting symlinks, junctions, reparse points, and hardlinked files (`linkCount > 1`).
 */
export function readExistingFileSafe(
  rootHandle: number,
  relPath: string,
  options?: { maxBytes?: number },
): { buffer: Buffer; identity: NativeHandleIdentity } {
  const maxBytes = options?.maxBytes ?? 64 * 1024 * 1024;
  const chain = resolveParentDirHandle(rootHandle, relPath, { createDirs: false });
  let fileHandle: number | null = null;

  try {
    fileHandle = openFileRead(chain.parentHandle, chain.leafName);
    const preIdentity = getIdentity(fileHandle);
    if (preIdentity.isDirectory || preIdentity.isReparsePoint) {
      throw new TransferFsError(
        'SYMLINK_OR_REPARSE_REJECTED',
        'Target is not a regular non-reparse file',
        'ELOOP',
      );
    }
    if (preIdentity.linkCount > 1) {
      throw new TransferFsError(
        'HARDLINK_REJECTED',
        `Hardlinked file rejected (linkCount=${preIdentity.linkCount})`,
        'EMLINK',
      );
    }
    if (preIdentity.size > BigInt(maxBytes)) {
      throw new TransferFsError(
        'IO_ERROR',
        `File size (${preIdentity.size}) exceeds maxBytes (${maxBytes})`,
        'EFBIG',
      );
    }

    const expectedSize = Number(preIdentity.size);
    const out = Buffer.allocUnsafe(expectedSize);
    let offset = 0;
    while (offset < expectedSize) {
      const n = readHandle(fileHandle, out, offset, expectedSize - offset, offset);
      if (n <= 0) break;
      offset += n;
    }

    const postIdentity = verifyHandleIdentity(fileHandle, preIdentity);
    if (postIdentity.linkCount > 1) {
      throw new TransferFsError('HARDLINK_REJECTED', 'File gained hardlinks during read', 'EMLINK');
    }
    if (postIdentity.size !== preIdentity.size || offset !== expectedSize) {
      throw new TransferFsError('IO_ERROR', 'File size changed concurrently during read', 'EIO');
    }

    return { buffer: out, identity: postIdentity };
  } finally {
    if (fileHandle !== null) {
      try {
        close(fileHandle);
      } catch {
        /* ignore */
      }
    }
    for (let i = chain.intermediateHandles.length - 1; i >= 0; i--) {
      try {
        close(chain.intermediateHandles[i]!);
      } catch {
        /* ignore */
      }
    }
  }
}
