import type {
  AcquireWritePayload,
  GetHostDiagnosticsPayload,
  PruneDuplicateSessionsPayload,
  ReleaseWritePayload,
  SessionHostDiagnostics,
  SessionHostPruneDuplicatesResult,
  SessionHostRecord,
  SessionHostRequestType,
} from './types.js';

/**
 * The 11-method session-host control-plane surface shared by the cloud and
 * standalone daemons. Both daemons used to carry a byte-for-byte copy of this
 * dispatch table plus the identical throw strings; this is the single source of
 * truth for that mapping. The wire `type` strings and error text here are the
 * daemon IPC contract and MUST match what the session-host daemon accepts.
 */
export interface SessionHostControlPlane {
  getDiagnostics(payload?: GetHostDiagnosticsPayload): Promise<SessionHostDiagnostics>;
  listSessions(): Promise<SessionHostRecord[]>;
  stopSession(sessionId: string): Promise<SessionHostRecord | null>;
  deleteSession(sessionId: string, opts?: { force?: boolean }): Promise<SessionHostRecord | null>;
  resumeSession(sessionId: string): Promise<SessionHostRecord | null>;
  restartSession(sessionId: string): Promise<SessionHostRecord | null>;
  sendSignal(sessionId: string, signal: string): Promise<SessionHostRecord | null>;
  forceDetachClient(sessionId: string, clientId: string): Promise<SessionHostRecord | null>;
  pruneDuplicateSessions(payload?: PruneDuplicateSessionsPayload): Promise<SessionHostPruneDuplicatesResult>;
  acquireWrite(payload: AcquireWritePayload): Promise<SessionHostRecord | null>;
  releaseWrite(payload: ReleaseWritePayload): Promise<SessionHostRecord | null>;
}

/**
 * Minimal request transport the control-plane factory needs. Each daemon injects
 * its own implementation:
 *   - cloud reuses a single persistent SessionHostClient (with reconnect); its
 *     `request` calls `ensureConnected()` then the shared client.
 *   - standalone opens a fresh client per request and closes it in `finally`.
 *
 * The factory below owns ONLY the type/payload dispatch table; the connection
 * lifecycle and success/error unwrapping stay in each daemon's transport so the
 * observable behavior of both paths is preserved exactly.
 */
export interface SessionHostControlTransport {
  request<T>(type: SessionHostRequestType, payload: Record<string, unknown>): Promise<T>;
}

/**
 * Build the shared 11-method control-plane over an injected request transport.
 * The (type string, payload shape) pairs are verbatim what both daemons emitted
 * previously — do not reword them without matching the session-host daemon's
 * request handlers.
 */
export function createSessionHostControlPlane(
  transport: SessionHostControlTransport,
): SessionHostControlPlane {
  return {
    getDiagnostics(payload: GetHostDiagnosticsPayload = {}): Promise<SessionHostDiagnostics> {
      return transport.request<SessionHostDiagnostics>('get_host_diagnostics', payload as Record<string, unknown>);
    },
    listSessions(): Promise<SessionHostRecord[]> {
      return transport.request<SessionHostRecord[]>('list_sessions', {});
    },
    stopSession(sessionId: string): Promise<SessionHostRecord | null> {
      return transport.request<SessionHostRecord | null>('stop_session', { sessionId });
    },
    deleteSession(sessionId: string, opts: { force?: boolean } = {}): Promise<SessionHostRecord | null> {
      return transport.request<SessionHostRecord | null>('delete_session', { sessionId, force: opts.force === true });
    },
    resumeSession(sessionId: string): Promise<SessionHostRecord | null> {
      return transport.request<SessionHostRecord | null>('resume_session', { sessionId });
    },
    restartSession(sessionId: string): Promise<SessionHostRecord | null> {
      return transport.request<SessionHostRecord | null>('restart_session', { sessionId });
    },
    sendSignal(sessionId: string, signal: string): Promise<SessionHostRecord | null> {
      return transport.request<SessionHostRecord | null>('send_signal', { sessionId, signal });
    },
    forceDetachClient(sessionId: string, clientId: string): Promise<SessionHostRecord | null> {
      return transport.request<SessionHostRecord | null>('force_detach_client', { sessionId, clientId });
    },
    pruneDuplicateSessions(payload: PruneDuplicateSessionsPayload = {}): Promise<SessionHostPruneDuplicatesResult> {
      return transport.request<SessionHostPruneDuplicatesResult>('prune_duplicate_sessions', payload as Record<string, unknown>);
    },
    acquireWrite(payload: AcquireWritePayload): Promise<SessionHostRecord | null> {
      return transport.request<SessionHostRecord | null>('acquire_write', payload as unknown as Record<string, unknown>);
    },
    releaseWrite(payload: ReleaseWritePayload): Promise<SessionHostRecord | null> {
      return transport.request<SessionHostRecord | null>('release_write', payload as unknown as Record<string, unknown>);
    },
  };
}
