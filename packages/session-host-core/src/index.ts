export type {
  AcquireWritePayload,
  AttachSessionPayload,
  ClearSessionBufferPayload,
  CreateSessionPayload,
  DetachSessionPayload,
  ForceDetachClientPayload,
  GetHostDiagnosticsPayload,
  GetSnapshotPayload,
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
  SessionLaunchCommand,
  SessionLifecycle,
  SessionOwnerType,
  SessionTransport,
  SessionHostWireEnvelope,
  SessionWriteOwner,
  StopSessionPayload,
} from './types.js';

export { SESSION_HOST_SUPPORTED_REQUEST_TYPES } from './types.js';

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
  resolveAttachableRuntimeRecord,
  resolveRuntimeRecord,
} from './runtime-labels.js';
export {
  SessionHostClient,
  createLineParser,
  createResponseEnvelope,
  getDefaultSessionHostEndpoint,
  writeEnvelope,
} from './ipc.js';
export type { SessionHostClientOptions, SessionHostEndpoint } from './ipc.js';
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
