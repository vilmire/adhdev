import {
  SessionHostClient,
  createSessionHostControlPlane,
  type AcquireWritePayload,
  type GetHostDiagnosticsPayload,
  type PruneDuplicateSessionsPayload,
  type ReleaseWritePayload,
  type SessionHostControlPlane,
  type SessionHostDiagnostics,
  type SessionHostEndpoint,
  type SessionHostPruneDuplicatesResult,
  type SessionHostRecord,
  type SessionHostRequestType,
} from '@adhdev/session-host-core';

export class StandaloneSessionHostControlPlane implements SessionHostControlPlane {
  private readonly plane: SessionHostControlPlane;

  constructor(
    private readonly getEndpoint: () => Promise<SessionHostEndpoint>,
  ) {
    // The 11-method dispatch table (type strings + throw text) is shared with the
    // cloud daemon via @adhdev/session-host-core. Standalone injects a per-request
    // transport that opens a fresh client and closes it in `finally`.
    this.plane = createSessionHostControlPlane({
      request: <T>(type: SessionHostRequestType, payload: Record<string, unknown>) =>
        this.request<T>(type, payload),
    });
  }

  getDiagnostics(payload: GetHostDiagnosticsPayload = {}): Promise<SessionHostDiagnostics> {
    return this.plane.getDiagnostics(payload);
  }

  listSessions(): Promise<SessionHostRecord[]> {
    return this.plane.listSessions();
  }

  stopSession(sessionId: string): Promise<SessionHostRecord | null> {
    return this.plane.stopSession(sessionId);
  }

  deleteSession(sessionId: string, opts: { force?: boolean } = {}): Promise<SessionHostRecord | null> {
    return this.plane.deleteSession(sessionId, opts);
  }

  resumeSession(sessionId: string): Promise<SessionHostRecord | null> {
    return this.plane.resumeSession(sessionId);
  }

  restartSession(sessionId: string): Promise<SessionHostRecord | null> {
    return this.plane.restartSession(sessionId);
  }

  sendSignal(sessionId: string, signal: string): Promise<SessionHostRecord | null> {
    return this.plane.sendSignal(sessionId, signal);
  }

  forceDetachClient(sessionId: string, clientId: string): Promise<SessionHostRecord | null> {
    return this.plane.forceDetachClient(sessionId, clientId);
  }

  pruneDuplicateSessions(payload: PruneDuplicateSessionsPayload = {}): Promise<SessionHostPruneDuplicatesResult> {
    return this.plane.pruneDuplicateSessions(payload);
  }

  acquireWrite(payload: AcquireWritePayload): Promise<SessionHostRecord | null> {
    return this.plane.acquireWrite(payload);
  }

  releaseWrite(payload: ReleaseWritePayload): Promise<SessionHostRecord | null> {
    return this.plane.releaseWrite(payload);
  }

  private async request<T>(type: SessionHostRequestType, payload: Record<string, unknown>): Promise<T> {
    const endpoint = await this.getEndpoint();
    const client = new SessionHostClient({ endpoint });
    try {
      await client.connect();
      const response = await client.request({
        type: type as any,
        payload,
      });
      if (!response.success) {
        throw new Error(response.error || `Session host request failed: ${type}`);
      }
      return (response.result ?? null) as T;
    } finally {
      await client.close().catch(() => {});
    }
  }
}
