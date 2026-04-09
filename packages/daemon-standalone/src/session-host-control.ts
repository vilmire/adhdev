import { SessionHostClient, type SessionHostEndpoint } from '@adhdev/session-host-core';

interface SessionHostControlPlane {
  getDiagnostics(payload?: { includeSessions?: boolean; limit?: number }): Promise<any>;
  listSessions(): Promise<any[]>;
  stopSession(sessionId: string): Promise<any>;
  resumeSession(sessionId: string): Promise<any>;
  restartSession(sessionId: string): Promise<any>;
  sendSignal(sessionId: string, signal: string): Promise<any>;
  forceDetachClient(sessionId: string, clientId: string): Promise<any>;
  pruneDuplicateSessions(payload?: { providerType?: string; workspace?: string; dryRun?: boolean }): Promise<any>;
  acquireWrite(payload: { sessionId: string; clientId: string; ownerType: 'agent' | 'user'; force?: boolean }): Promise<any>;
  releaseWrite(payload: { sessionId: string; clientId: string }): Promise<any>;
}

export class StandaloneSessionHostControlPlane implements SessionHostControlPlane {
  constructor(
    private readonly getEndpoint: () => Promise<SessionHostEndpoint>,
  ) {}

  async getDiagnostics(payload: { includeSessions?: boolean; limit?: number } = {}): Promise<any> {
    return this.request('get_host_diagnostics', payload);
  }

  async listSessions(): Promise<any[]> {
    return this.request('list_sessions', {});
  }

  async stopSession(sessionId: string): Promise<any> {
    return this.request('stop_session', { sessionId });
  }

  async resumeSession(sessionId: string): Promise<any> {
    return this.request('resume_session', { sessionId });
  }

  async restartSession(sessionId: string): Promise<any> {
    return this.request('restart_session', { sessionId });
  }

  async sendSignal(sessionId: string, signal: string): Promise<any> {
    return this.request('send_signal', { sessionId, signal });
  }

  async forceDetachClient(sessionId: string, clientId: string): Promise<any> {
    return this.request('force_detach_client', { sessionId, clientId });
  }

  async pruneDuplicateSessions(payload: { providerType?: string; workspace?: string; dryRun?: boolean } = {}): Promise<any> {
    return this.request('prune_duplicate_sessions', payload);
  }

  async acquireWrite(payload: { sessionId: string; clientId: string; ownerType: 'agent' | 'user'; force?: boolean }): Promise<any> {
    return this.request('acquire_write', payload);
  }

  async releaseWrite(payload: { sessionId: string; clientId: string }): Promise<any> {
    return this.request('release_write', payload);
  }

  private async request(type: string, payload: Record<string, unknown>): Promise<any> {
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
      return response.result ?? null;
    } finally {
      await client.close().catch(() => {});
    }
  }
}
