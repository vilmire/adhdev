export type {
  AcquireWritePayload,
  AttachSessionPayload,
  ClearSessionBufferPayload,
  CreateSessionPayload,
  DetachSessionPayload,
  ForceDetachClientPayload,
  GetHostDiagnosticsPayload,
  GetSnapshotPayload,
  GetTerminalSnapshotPayload,
  PruneDuplicateSessionsPayload,
  ReleaseWritePayload,
  ResumeSessionPayload,
  RestartSessionPayload,
  ResizeSessionPayload,
  SendSignalPayload,
  SendInputPayload,
  UpdateSessionMetaPayload,
  SessionAttachedClient,
  SessionBufferSnapshot,
  SessionClientType,
  SessionHostDiagnostics,
  SessionHostDuplicateSessionGroup,
  SessionHostCategory,
  SessionHostSurfaceKind,
  SessionHostEvent,
  SessionHostEventEnvelope,
  SessionHostLogEntry,
  SessionHostPruneDuplicatesResult,
  SessionHostRecord,
  SessionHostRequest,
  SessionHostRequestEnvelope,
  SessionHostRequestTrace,
  SessionHostRequestType,
  SessionHostResponse,
  SessionHostResponseEnvelope,
  SessionHostRuntimeTransition,
  SessionTerminalSnapshot,
  SessionTerminalState,
  SessionLaunchCommand,
  SessionLifecycle,
  SessionOwnerType,
  SessionTransport,
  SessionTermination,
  SessionHostWireEnvelope,
  SessionWriteOwner,
  StopSessionPayload,
} from './types.js';

export { SESSION_HOST_SUPPORTED_REQUEST_TYPES } from './types.js';
export { classifyTermination } from './termination.js';

export { DEFAULT_SESSION_RING_BUFFER_MAX_BYTES, SessionRingBuffer } from './buffer.js';
export type { SessionRingBufferOptions } from './buffer.js';
export { SessionHostRegistry } from './registry.js';
export {
  buildRuntimeDisplayName,
  buildRuntimeKey,
  formatRuntimeOwner,
  getSessionHostRecoveryLabel,
  getSessionHostSurfaceKind,
  getWorkspaceLabel,
  isSessionHostLiveRuntime,
  isSessionHostRecoverySnapshot,
  isTerminalRecord,
  partitionSessionHostDiagnosticsSessions,
  partitionSessionHostRecords,
  resolveAttachableRuntimeRecord,
  resolveRuntimeRecord,
} from './runtime-labels.js';
export type { SessionHostSurfaceRecordLike } from './runtime-labels.js';
export {
  SessionHostClient,
  createLineParser,
  createResponseEnvelope,
  getDefaultSessionHostEndpoint,
  writeEnvelope,
} from './ipc.js';
export type {
  SessionHostClientOptions,
  SessionHostEndpoint,
  SessionHostEndpointOptions,
  SessionHostDisconnectInfo,
  SessionHostDisconnectReason,
} from './ipc.js';
export {
  DEFAULT_CONFIG_DIR_NAME,
  canonicalizeInstancePath,
  isDefaultInstanceConfigDir,
  resolveInstanceConfigDir,
  resolveSessionHostIpcKey,
} from './instance-key.js';
export {
  DEFAULT_SESSION_HOST_COLS,
  DEFAULT_SESSION_HOST_ROWS,
  resolveSessionHostCols,
  resolveSessionHostRows,
} from './defaults.js';
export {
  sanitizeSpawnEnv,
  applyTerminalColorEnv,
  ensureNodePtySpawnHelperPermissions,
} from './spawn-env.js';
export { createSessionHostControlPlane } from './control-plane.js';
export type { SessionHostControlPlane, SessionHostControlTransport } from './control-plane.js';
