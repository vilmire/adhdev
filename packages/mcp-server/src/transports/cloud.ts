/**
 * CloudTransport — HTTP client for ADHDev cloud API (api.adhf.dev)
 *
 * Uses shortcuts API: /api/v1/shortcuts/:targetId/*
 * Requires an API key (adk_*) with appropriate scopes.
 */

const DEFAULT_BASE_URL = 'https://api.adhf.dev';

export interface CloudTransportOptions {
  apiKey: string;
  baseUrl?: string;
}

export class CloudTransport {
  private baseUrl: string;
  private apiKey: string;

  constructor(opts: CloudTransportOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };
  }

  async listDaemons(): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/v1/daemons`, { headers: this.headers() });
    if (!res.ok) throw new Error(`List daemons failed: ${res.status}`);
    return res.json();
  }

  async getStatus(targetId: string): Promise<any> {
    const res = await fetch(
      `${this.baseUrl}/api/v1/shortcuts/${encodeURIComponent(targetId)}/status`,
      { headers: this.headers() },
    );
    if (!res.ok) throw new Error(`Status failed: ${res.status}`);
    return res.json();
  }

  /** Get all sessions for a daemon (returns CompactSessionEntry[]). */
  async getDaemonStatus(daemonId: string): Promise<any> {
    const res = await fetch(
      `${this.baseUrl}/api/v1/daemons/${encodeURIComponent(daemonId)}/status`,
      { headers: this.headers() },
    );
    if (!res.ok) throw new Error(`Daemon status failed: ${res.status}`);
    return res.json();
  }

  async readChat(targetId: string, opts: { limit?: number; sessionId?: string } = {}): Promise<any> {
    const params = new URLSearchParams();
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.sessionId) params.set('sessionId', opts.sessionId);
    const qs = params.toString() ? `?${params}` : '';
    const res = await fetch(
      `${this.baseUrl}/api/v1/shortcuts/${encodeURIComponent(targetId)}/chat${qs}`,
      { headers: this.headers() },
    );
    if (!res.ok) throw new Error(`Read chat failed: ${res.status}`);
    return res.json();
  }

  async sendChat(targetId: string, message: string, opts: { sessionId?: string; ideType?: string } = {}): Promise<any> {
    const res = await fetch(
      `${this.baseUrl}/api/v1/shortcuts/${encodeURIComponent(targetId)}/chat`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ message, ...opts }),
      },
    );
    if (!res.ok) throw new Error(`Send chat failed: ${res.status}`);
    return res.json();
  }

  async approve(targetId: string, action: 'approve' | 'reject', agentType?: string): Promise<any> {
    const res = await fetch(
      `${this.baseUrl}/api/v1/shortcuts/${encodeURIComponent(targetId)}/approve`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ action, ...(agentType ? { agentType } : {}) }),
      },
    );
    if (!res.ok) throw new Error(`Approve failed: ${res.status}`);
    return res.json();
  }

  async gitStatus(daemonId: string, workspace: string, includeDiff = true): Promise<any> {
    const params = new URLSearchParams({ workspace, includeDiff: String(includeDiff) });
    const res = await fetch(
      `${this.baseUrl}/api/v1/shortcuts/${encodeURIComponent(daemonId)}/git-status?${params}`,
      { headers: this.headers() },
    );
    if (!res.ok) throw new Error(`Git status failed: ${res.status}`);
    return res.json();
  }

  async stop(daemonId: string, opts: { id?: string; type?: string; dir?: string }): Promise<any> {
    const res = await fetch(
      `${this.baseUrl}/api/v1/shortcuts/${encodeURIComponent(daemonId)}/stop`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(opts),
      },
    );
    if (!res.ok) throw new Error(`Stop failed: ${res.status}`);
    return res.json();
  }

  async launch(daemonId: string, opts: { type: string; dir?: string; model?: string }): Promise<any> {
    const res = await fetch(
      `${this.baseUrl}/api/v1/shortcuts/${encodeURIComponent(daemonId)}/launch`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(opts),
      },
    );
    if (!res.ok) throw new Error(`Launch failed: ${res.status}`);
    return res.json();
  }

  async gitLog(daemonId: string, workspace: string, opts: { limit?: number; file?: string; since?: string; until?: string } = {}): Promise<any> {
    const params = new URLSearchParams({ workspace });
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.file) params.set('file', opts.file);
    if (opts.since) params.set('since', opts.since);
    if (opts.until) params.set('until', opts.until);
    const res = await fetch(
      `${this.baseUrl}/api/v1/shortcuts/${encodeURIComponent(daemonId)}/git-log?${params}`,
      { headers: this.headers() },
    );
    if (!res.ok) throw new Error(`Git log failed: ${res.status}`);
    return res.json();
  }

  async gitDiff(daemonId: string, workspace: string, opts: { file?: string; maxLines?: number; staged?: boolean } = {}): Promise<any> {
    const params = new URLSearchParams({ workspace });
    if (opts.file) params.set('file', opts.file);
    if (opts.maxLines) params.set('maxLines', String(opts.maxLines));
    if (opts.staged) params.set('staged', 'true');
    const res = await fetch(
      `${this.baseUrl}/api/v1/shortcuts/${encodeURIComponent(daemonId)}/git-diff?${params}`,
      { headers: this.headers() },
    );
    if (!res.ok) throw new Error(`Git diff failed: ${res.status}`);
    return res.json();
  }

  async gitPush(daemonId: string, opts: { workspace: string; remote?: string; branch?: string }): Promise<any> {
    const res = await fetch(
      `${this.baseUrl}/api/v1/shortcuts/${encodeURIComponent(daemonId)}/git-push`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(opts),
      },
    );
    if (!res.ok) throw new Error(`Git push failed: ${res.status}`);
    return res.json();
  }

  async gitCheckpoint(daemonId: string, opts: { workspace: string; message: string; includeUntracked?: boolean }): Promise<any> {
    const res = await fetch(
      `${this.baseUrl}/api/v1/shortcuts/${encodeURIComponent(daemonId)}/git-checkpoint`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(opts),
      },
    );
    if (!res.ok) throw new Error(`Git checkpoint failed: ${res.status}`);
    return res.json();
  }

  async ping(): Promise<boolean> {
    try {
      await this.listDaemons();
      return true;
    } catch {
      return false;
    }
  }
}
