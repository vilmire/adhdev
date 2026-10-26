export type SessionTransport = 'pty';

export type SessionHostCategory = 'cli' | 'acp' | 'shell';

export type SessionLifecycle = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed' | 'interrupted';

export type SessionClientType = 'daemon' | 'web' | 'local-terminal';

export type SessionOwnerType = 'agent' | 'user';

export interface SessionLaunchCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Unmarked older daemon records contained the full inherited environment. */
  envMode?: 'launch_overrides';
}

export interface SessionWriteOwner {
  clientId: string;
  ownerType: SessionOwnerType;
  acquiredAt: number;
}

export interface SessionAttachedClient {
  clientId: string;
  type: SessionClientType;
  readOnly: boolean;
  attachedAt: number;
  lastSeenAt: number;
}

export interface SessionBufferSnapshot {
  seq: number;
  text: string;
  truncated: boolean;
  cols?: number;
  rows?: number;
}

export interface SessionTerminalState {
  cursor: { row: number; col: number };
  altScreen: boolean;
  pasteMode: boolean;
  rawMode: boolean;
  scrollRegion: { top: number; bot: number };
  cols: number;
  rows: number;
}

export interface SessionTerminalSnapshot {
  text: string;
  state: SessionTerminalState;
}

export interface SessionBufferState {
  scrollbackBytes: number;
  snapshotSeq: number;
}

export type SessionHostSurfaceKind = 'live_runtime' | 'recovery_snapshot' | 'inactive_record';

/**
 * Compact, secret-free record of how a session's PTY process terminated.
 *
 * Preserves the nullable/unknown exitCode and signal exactly as observed from
 * the first node-pty `onExit` — an `exitCode` of `null` means "unknown" (the
 * process was terminated by a signal, or the exit code was otherwise not
 * reported) and MUST NOT be collapsed to 0. Persisted as a tombstone so
 * termination diagnostics remain inspectable after the live runtime and its
 * transport adapter are torn down.
 */
export interface SessionTermination {
  /** Exit code exactly as observed; `null` = unknown / signal-terminated. Never fabricated to 0. */
  exitCode: number | null;
  /** Signal number that terminated the process, if any; `null` when not signalled. */
  signal: number | null;
  /** Classification derived from (exitCode, signal): clean exit vs. failure vs. unknown. */
  reason: 'exit' | 'signal' | 'failed' | 'unknown';
  /** Lifecycle recorded for this termination (`stopped` | `failed`). */
  lifecycle: Extract<SessionLifecycle, 'stopped' | 'failed'>;
  /** Wall-clock time the termination was observed. */
  terminatedAt: number;
  /** OS pid of the terminated process, if it was known. */
  osPid?: number;
  /** Lifecycle the session was in immediately before termination. */
  previousLifecycle?: SessionLifecycle;
  /** Last time output was observed from the session, if known. */
  lastOutputAt?: number;
  /** Whether the termination followed an explicit stop/delete request, and which. */
  requestedStop?: 'stop' | 'delete' | 'restart' | 'prune';
}

export interface SessionHostRecord {
  sessionId: string;
  runtimeKey: string;
  displayName: string;
  workspaceLabel: string;
  transport: SessionTransport;
  providerType: string;
  category: SessionHostCategory;
  workspace: string;
  launchCommand: SessionLaunchCommand;
  osPid?: number;
  createdAt: number;
  startedAt?: number;
  lastActivityAt: number;
  lifecycle: SessionLifecycle;
  surfaceKind?: SessionHostSurfaceKind;
  writeOwner: SessionWriteOwner | null;
  attachedClients: SessionAttachedClient[];
  buffer: SessionBufferState;
  meta: Record<string, unknown>;
  /** Termination tombstone, stamped when the PTY process exits. Retained for post-mortem inspection. */
  termination?: SessionTermination;
  /**
   * Monotonic count of input accepted into this runtime by `send_input`, from
   * any client (SUBMIT-UNCONFIRMED-RECLAIM: the authoritative input boundary).
   * Every accepted input is also announced as a `session_input` event carrying
   * this number and the writer. Absent on records from a host that predates it
   * — a reader must then treat input provenance as unknown.
   */
  inputSeq?: number;
  /**
   * Identifies one lifetime of `inputSeq`. It changes whenever the counter
   * could have restarted or been rewound — a new host process loading the
   * record, or a restore with a lower count — so equal (epoch, seq) pairs
   * really are the same point in the input stream.
   */
  inputEpoch?: string;
}

export interface CreateSessionPayload {
  sessionId?: string;
  runtimeKey?: string;
  displayName?: string;
  providerType: string;
  category: SessionHostCategory;
  workspace: string;
  launchCommand: SessionLaunchCommand;
  cols?: number;
  rows?: number;
  clientId?: string;
  clientType?: SessionClientType;
  meta?: Record<string, unknown>;
}

export interface AttachSessionPayload {
  sessionId: string;
  clientId: string;
  clientType: SessionClientType;
  readOnly?: boolean;
}

export interface DetachSessionPayload {
  sessionId: string;
  clientId: string;
}

export interface SendInputPayload {
  sessionId: string;
  clientId: string;
  data: string;
}

/**
 * `send_input_if_seq`: write `data` only if NOTHING else has been input since
 * the caller last accounted the stream — the host's (inputEpoch, inputSeq) is
 * still exactly (expectedInputEpoch, expectedInputSeq) — and the caller may
 * write without taking ownership (no force). Atomic on the host, so no input
 * can slip between the caller's check and this write.
 */
export interface SendInputIfSeqPayload extends SendInputPayload {
  expectedInputSeq: number;
  expectedInputEpoch: string;
}

export interface GetInputStatePayload {
  sessionId: string;
}

/** `get_input_state`: the host's current input counter. A host without it
 *  rejects the request type, which is how a client knows not to trust. */
export interface SessionHostInputState {
  inputSeq: number;
  inputEpoch: string;
}

export interface ResizeSessionPayload {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface StopSessionPayload {
  sessionId: string;
}
export interface MeshWriterAssignment {
  meshId: string; nodeId: string; taskId: string; attemptId: string;
  generation: number; dispatchNonce: number; ownerDaemonId: string;
}
export interface MeshWriterStopTarget {
  runtimeKey: string; startedAt: number; osPid: number; providerType: string;
  assignment: MeshWriterAssignment;
}
export interface StopMeshWriterPayload extends MeshWriterStopTarget { sessionId: string; clientId: string }

export interface DeleteSessionPayload {
  sessionId: string;
  /** Stop a live runtime before deleting the persisted record. */
  force?: boolean;
}

export interface ResumeSessionPayload {
  sessionId: string;
}

export interface AcquireWritePayload {
  sessionId: string;
  clientId: string;
  ownerType: SessionOwnerType;
  force?: boolean;
}

export interface ReleaseWritePayload {
  sessionId: string;
  clientId: string;
}

export interface GetSnapshotPayload {
  sessionId: string;
  sinceSeq?: number;
}

export interface GetTerminalSnapshotPayload {
  sessionId: string;
}

export interface ClearSessionBufferPayload {
  sessionId: string;
}

export interface UpdateSessionMetaPayload {
  sessionId: string;
  meta: Record<string, unknown>;
  replace?: boolean;
}

/** Bounded liveness check for identities whose provenance the caller already holds.
 * No launch arguments, metadata, snapshots or diagnostic log bodies cross IPC. */
export interface SessionHostCensus {
  hostStartedAt: number;
  endpoint: string;
  hostEntryPath?: string;
  liveSessionIds: string[];
  /** A live role-marked writer outside the caller's persisted identities. */
  hasOtherAssistantCandidates: boolean;
}

export interface GetHostDiagnosticsPayload {
  includeSessions?: boolean;
  limit?: number;
}

export interface ForceDetachClientPayload {
  sessionId: string;
  clientId: string;
}

export interface SendSignalPayload {
  sessionId: string;
  signal: string;
}

export interface RestartSessionPayload {
  sessionId: string;
}

export interface PruneDuplicateSessionsPayload {
  providerType?: string;
  workspace?: string;
  dryRun?: boolean;
}

export interface SessionHostDuplicateSessionGroup {
  bindingKey: string;
  providerType: string;
  workspace: string;
  providerSessionId: string;
  keptSessionId: string;
  prunedSessionIds: string[];
}

export interface SessionHostPruneDuplicatesResult {
  duplicateGroupCount: number;
  keptSessionIds: string[];
  prunedSessionIds: string[];
  groups: SessionHostDuplicateSessionGroup[];
}

export interface SessionHostLogEntry {
  timestamp: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  sessionId?: string;
  data?: Record<string, unknown>;
}

export interface SessionHostRequestTrace {
  timestamp: number;
  requestId: string;
  type: SessionHostRequest['type'];
  sessionId?: string;
  clientId?: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

export interface SessionHostRuntimeTransition {
  timestamp: number;
  sessionId: string;
  action: string;
  lifecycle?: SessionLifecycle;
  detail?: string;
  success?: boolean;
  error?: string;
}

export interface SessionHostDiagnostics {
  hostStartedAt: number;
  endpoint: string;
  /**
   * Absolute path of the script this host process is running (its own
   * `__filename`), self-reported.
   *
   * This is the only way a client can learn WHICH install a reachable host came
   * from without process inspection. On Windows the daemon's PowerShell/wmic
   * command-line probe is blocked outright on some boxes (AV/EDR, and `wmic` is
   * removed by default in Win11 24H2+), so identity checks that depend on it
   * fail silently — which let a host from a DELETED install prefix keep serving
   * its socket while every `create_session` died loading node-pty's conpty.node
   * from the missing tree. The host answering with its own path needs no
   * privileges and always works.
   *
   * Optional: an older host predating this field simply omits it, and callers
   * must treat `undefined` as "unknown", never as a match.
   */
  hostEntryPath?: string;
  runtimeCount: number;
  supportedRequestTypes?: SessionHostRequestType[];
  sessions?: SessionHostRecord[];
  liveRuntimes?: SessionHostRecord[];
  recoverySnapshots?: SessionHostRecord[];
  inactiveRecords?: SessionHostRecord[];
  recentLogs: SessionHostLogEntry[];
  recentRequests: SessionHostRequestTrace[];
  recentTransitions: SessionHostRuntimeTransition[];
}

export interface HostUpgradeLeasePayload {
  bootId: string;
  epoch: number;
  owner: string;
  token: string;
}

export type SessionHostRequest =
  | { type: 'get_upgrade_lease'; payload?: {} }
  | { type: 'acquire_upgrade_lease'; payload: HostUpgradeLeasePayload }
  | { type: 'release_upgrade_lease'; payload: HostUpgradeLeasePayload }
  | { type: 'create_session'; payload: CreateSessionPayload }
  | { type: 'attach_session'; payload: AttachSessionPayload }
  | { type: 'detach_session'; payload: DetachSessionPayload }
  | { type: 'send_input'; payload: SendInputPayload }
  | { type: 'send_input_if_seq'; payload: SendInputIfSeqPayload }
  | { type: 'get_input_state'; payload: GetInputStatePayload }
  | { type: 'resize_session'; payload: ResizeSessionPayload }
  | { type: 'stop_session'; payload: StopSessionPayload }
  | { type: 'stop_mesh_writer'; payload: StopMeshWriterPayload }
  | { type: 'delete_session'; payload: DeleteSessionPayload }
  | { type: 'resume_session'; payload: ResumeSessionPayload }
  | { type: 'acquire_write'; payload: AcquireWritePayload }
  | { type: 'release_write'; payload: ReleaseWritePayload }
  | { type: 'get_snapshot'; payload: GetSnapshotPayload }
  | { type: 'get_terminal_snapshot'; payload: GetTerminalSnapshotPayload }
  | { type: 'clear_session_buffer'; payload: ClearSessionBufferPayload }
  | { type: 'update_session_meta'; payload: UpdateSessionMetaPayload }
  | { type: 'get_host_diagnostics'; payload?: GetHostDiagnosticsPayload }
  | { type: 'force_detach_client'; payload: ForceDetachClientPayload }
  | { type: 'send_signal'; payload: SendSignalPayload }
  | { type: 'restart_session'; payload: RestartSessionPayload }
  | { type: 'prune_duplicate_sessions'; payload?: PruneDuplicateSessionsPayload }
  | { type: 'get_session_census'; payload: { sessionIds: string[] } }
  | { type: 'get_session'; payload: { sessionId: string } }
  | { type: 'list_sessions'; payload?: { activeOnly?: boolean } };

export type SessionHostRequestType = SessionHostRequest['type'];

export const SESSION_HOST_SUPPORTED_REQUEST_TYPES: readonly SessionHostRequestType[] = [
  'get_upgrade_lease',
  'acquire_upgrade_lease',
  'release_upgrade_lease',
  'create_session',
  'attach_session',
  'detach_session',
  'send_input',
  'send_input_if_seq',
  'get_input_state',
  'resize_session',
  'stop_session',
  'stop_mesh_writer',
  'delete_session',
  'resume_session',
  'acquire_write',
  'release_write',
  'get_snapshot',
  'get_terminal_snapshot',
  'clear_session_buffer',
  'update_session_meta',
  'get_host_diagnostics',
  'force_detach_client',
  'send_signal',
  'restart_session',
  'prune_duplicate_sessions',
  'get_session_census',
  'get_session',
  'list_sessions',
];

export interface SessionHostResponse<T = unknown> {
  success: boolean;
  result?: T;
  error?: string;
}

export type SessionHostEvent =
  | { type: 'session_created'; sessionId: string; record: SessionHostRecord }
  | { type: 'session_started'; sessionId: string; pid?: number }
  | { type: 'session_resumed'; sessionId: string; pid?: number }
  | { type: 'session_output'; sessionId: string; seq: number; data: string }
  /** An input was accepted into the runtime (emitted BEFORE it reaches the PTY). */
  | { type: 'session_input'; sessionId: string; seq: number; epoch: string; clientId: string }
  | { type: 'session_cleared'; sessionId: string }
  | { type: 'session_exit'; sessionId: string; exitCode: number | null; signal?: number | null; termination?: SessionTermination }
  | { type: 'session_stopped'; sessionId: string }
  | { type: 'session_deleted'; sessionId: string }
  | { type: 'session_resized'; sessionId: string; cols: number; rows: number }
  | { type: 'write_owner_changed'; sessionId: string; owner: SessionWriteOwner | null }
  | { type: 'client_attached'; sessionId: string; client: SessionAttachedClient }
  | { type: 'client_detached'; sessionId: string; clientId: string }
  | { type: 'host_log'; entry: SessionHostLogEntry }
  | { type: 'request_trace'; trace: SessionHostRequestTrace }
  | { type: 'runtime_transition'; transition: SessionHostRuntimeTransition };

export interface SessionHostRequestEnvelope {
  kind: 'request';
  requestId: string;
  request: SessionHostRequest;
}

export interface SessionHostResponseEnvelope {
  kind: 'response';
  requestId: string;
  response: SessionHostResponse;
}

export interface SessionHostEventEnvelope {
  kind: 'event';
  event: SessionHostEvent;
}

export type SessionHostWireEnvelope =
  | SessionHostRequestEnvelope
  | SessionHostResponseEnvelope
  | SessionHostEventEnvelope;
