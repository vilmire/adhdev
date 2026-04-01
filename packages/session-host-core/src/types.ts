export type SessionTransport = 'pty';

export type SessionHostCategory = 'cli' | 'acp' | 'shell';

export type SessionLifecycle = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed' | 'interrupted';

export type SessionClientType = 'daemon' | 'web' | 'local-terminal';

export type SessionOwnerType = 'agent' | 'user';

export interface SessionLaunchCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
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
}

export interface SessionBufferState {
  scrollbackBytes: number;
  snapshotSeq: number;
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
  writeOwner: SessionWriteOwner | null;
  attachedClients: SessionAttachedClient[];
  buffer: SessionBufferState;
  meta: Record<string, unknown>;
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

export interface ResizeSessionPayload {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface StopSessionPayload {
  sessionId: string;
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

export interface ClearSessionBufferPayload {
  sessionId: string;
}

export type SessionHostRequest =
  | { type: 'create_session'; payload: CreateSessionPayload }
  | { type: 'attach_session'; payload: AttachSessionPayload }
  | { type: 'detach_session'; payload: DetachSessionPayload }
  | { type: 'send_input'; payload: SendInputPayload }
  | { type: 'resize_session'; payload: ResizeSessionPayload }
  | { type: 'stop_session'; payload: StopSessionPayload }
  | { type: 'resume_session'; payload: ResumeSessionPayload }
  | { type: 'acquire_write'; payload: AcquireWritePayload }
  | { type: 'release_write'; payload: ReleaseWritePayload }
  | { type: 'get_snapshot'; payload: GetSnapshotPayload }
  | { type: 'clear_session_buffer'; payload: ClearSessionBufferPayload }
  | { type: 'list_sessions'; payload?: {} };

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
  | { type: 'session_cleared'; sessionId: string }
  | { type: 'session_exit'; sessionId: string; exitCode: number | null }
  | { type: 'session_stopped'; sessionId: string }
  | { type: 'session_resized'; sessionId: string; cols: number; rows: number }
  | { type: 'write_owner_changed'; sessionId: string; owner: SessionWriteOwner | null }
  | { type: 'client_attached'; sessionId: string; client: SessionAttachedClient }
  | { type: 'client_detached'; sessionId: string; clientId: string };

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
