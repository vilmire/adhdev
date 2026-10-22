/**
 * Handle-relative / atomic no-replace file transfer native helper surface (Phase 1).
 */

export {
  MAX_PATH_SEGMENTS,
  MAX_RELATIVE_PATH_BYTES,
  MAX_SEGMENT_BYTES,
  TransferFsError,
  isProtectedMetadataSegment,
  splitPortableRelativePath,
  validateTransferSegment,
  type TransferFsErrorCode,
} from './path-validation.js';

export {
  close,
  createExcl,
  fullFsync,
  getBindingInfo,
  getIdentity,
  mkdirExcl,
  openFileRead,
  openRoot,
  probeRoot,
  readExistingFileSafe,
  readHandle,
  renameAtExcl,
  renameExcl,
  resolveParentDirHandle,
  unlinkAt,
  verifyHandleIdentity,
  walkDir,
  writeHandle,
  writeNewFileAtomic,
  type NativeHandleIdentity,
  type ResolvedParentChain,
  type RootCapabilitiesProbe,
  type TransferFsBindingInfo,
} from './transfer-fs-native.js';
