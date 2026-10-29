import { resolveHostBootId } from './cleanup-expected.js';
import type {
  AcquireWritePayload,
  GetHostDiagnosticsPayload,
  GetSnapshotPayload,
  PruneDuplicateSessionsPayload,
  ReleaseWritePayload,
  SessionCleanupExpectedAssignment,
  SessionHostDiagnostics,
  SessionHostPruneDuplicatesResult,
  SessionHostRecord,
  SessionHostRequestType,
} from './types.js';

/** Response shape of the `get_snapshot` wire request — a PTY snapshot for a session. */
export interface SessionHostSnapshot {
  seq: number;
  text: string;
  truncated: boolean;
  cols?: number;
  rows?: number;
}

/**
 * The session-host control-plane surface shared by the cloud and
 * standalone daemons. Both daemons used to carry a byte-for-byte copy of this
 * dispatch table plus the identical throw strings; this is the single source of
 * truth for that mapping. The wire `type` strings and error text here are the
 * daemon IPC contract and MUST match what the session-host daemon accepts.
 */
export interface SessionHostControlPlane {
  getDiagnostics(payload?: GetHostDiagnosticsPayload): Promise<SessionHostDiagnostics>;
  /**
   * Authoritative host boot identity for idle inventory / cleanup expected CAS.
   * Prefers diagnostics.hostBootId (host SoT), else proves upgrade lease bootId
   * via get_upgrade_lease, else hs:<hostStartedAt> for non-upgrade / old hosts.
   * Ambiguous upgrade-lease failures fail closed (null) — never invent a UUID.
   */
  resolveHostBootId(): Promise<string | null>;
  listSessions(): Promise<SessionHostRecord[]>;
  stopSession(sessionId: string): Promise<SessionHostRecord | null>;
  /** Host CAS stop: refuses without mutating when expected assignment/boot/incarnation drift. */
  stopSessionIfExpected(sessionId: string, expected: SessionCleanupExpectedAssignment): Promise<SessionHostRecord | null>;
  deleteSession(sessionId: string, opts?: { force?: boolean }): Promise<SessionHostRecord | null>;
  /** Host CAS delete: refuses without mutating when expected assignment/boot/incarnation drift. */
  deleteSessionIfExpected(
    sessionId: string,
    expected: SessionCleanupExpectedAssignment,
    opts?: { force?: boolean },
  ): Promise<{ sessionId: string; deleted: boolean; alreadyAbsent?: boolean } | null>;
  resumeSession(sessionId: string): Promise<SessionHostRecord | null>;
  restartSession(sessionId: string): Promise<SessionHostRecord | null>;
  sendSignal(sessionId: string, signal: string): Promise<SessionHostRecord | null>;
  forceDetachClient(sessionId: string, clientId: string): Promise<SessionHostRecord | null>;
  pruneDuplicateSessions(payload?: PruneDuplicateSessionsPayload): Promise<SessionHostPruneDuplicatesResult>;
  acquireWrite(payload: AcquireWritePayload): Promise<SessionHostRecord | null>;
  releaseWrite(payload: ReleaseWritePayload): Promise<SessionHostRecord | null>;
  /**
   * A PTY snapshot for `sessionId` (optionally only the tail since `sinceSeq`),
   * over wire type `get_snapshot`. Mirrors the shape daemon-core's local
   * `SessionHostControlPlane` interface (`commands/router.ts`) and cloud's
   * former `cloud-command-transports.ts` P2P-only `get_runtime_snapshot` case
   * both already used against a raw `SessionHostClient`.
   */
  getSnapshot(sessionId: string, sinceSeq?: number): Promise<SessionHostSnapshot | null>;
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
 * Build the shared 12-method control-plane over an injected request transport.
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
    async resolveHostBootId(): Promise<string | null> {
      let diagnostics: SessionHostDiagnostics;
      try {
        diagnostics = await transport.request<SessionHostDiagnostics>('get_host_diagnostics', {});
      } catch {
        return null;
      }
      if (typeof diagnostics.hostBootId === 'string' && diagnostics.hostBootId) {
        return diagnostics.hostBootId;
      }
      // Host omitted hostBootId (older binary). Prove upgrade lease or fall back to hs:.
      try {
        const proof = await transport.request<{ bootId?: string }>('get_upgrade_lease', {});
        return resolveHostBootId({
          upgradeBootId: typeof proof?.bootId === 'string' ? proof.bootId : null,
          hostStartedAt: diagnostics.hostStartedAt,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (
          msg.includes('native_host_upgrade_binding_unavailable')
          || /unsupported|unknown request/i.test(msg)
        ) {
          return resolveHostBootId({ hostStartedAt: diagnostics.hostStartedAt });
        }
        return null;
      }
    },
    listSessions(): Promise<SessionHostRecord[]> {
      return transport.request<SessionHostRecord[]>('list_sessions', {});
    },
    stopSession(sessionId: string): Promise<SessionHostRecord | null> {
      return transport.request<SessionHostRecord | null>('stop_session', { sessionId });
    },
    stopSessionIfExpected(sessionId: string, expected: SessionCleanupExpectedAssignment): Promise<SessionHostRecord | null> {
      return transport.request<SessionHostRecord | null>('stop_session_if_expected', { sessionId, expected });
    },
    deleteSession(sessionId: string, opts: { force?: boolean } = {}): Promise<SessionHostRecord | null> {
      return transport.request<SessionHostRecord | null>('delete_session', { sessionId, force: opts.force === true });
    },
    deleteSessionIfExpected(
      sessionId: string,
      expected: SessionCleanupExpectedAssignment,
      opts: { force?: boolean } = {},
    ): Promise<{ sessionId: string; deleted: boolean; alreadyAbsent?: boolean } | null> {
      return transport.request<{ sessionId: string; deleted: boolean; alreadyAbsent?: boolean } | null>(
        'delete_session_if_expected',
        { sessionId, expected, force: opts.force === true },
      );
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
    getSnapshot(sessionId: string, sinceSeq?: number): Promise<SessionHostSnapshot | null> {
      return transport.request<SessionHostSnapshot | null>('get_snapshot', { sessionId, sinceSeq } as GetSnapshotPayload as unknown as Record<string, unknown>);
    },
  };
}
