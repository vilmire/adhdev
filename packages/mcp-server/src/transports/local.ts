/**
 * LocalTransport — HTTP client for standalone daemon at localhost:3847
 */

const DEFAULT_PORT = 3847;

export interface LocalTransportOptions {
  port?: number;
  password?: string;
}

export class LocalTransport {
  private baseUrl: string;
  private authHeader: string | null;

  constructor(opts: LocalTransportOptions = {}) {
    this.baseUrl = `http://localhost:${opts.port ?? DEFAULT_PORT}`;
    this.authHeader = opts.password ? `Bearer ${opts.password}` : null;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.authHeader) h['Authorization'] = this.authHeader;
    return h;
  }

  async getStatus(): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/v1/status`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Status fetch failed: ${res.status}`);
    return res.json();
  }

  async command(type: string, args: Record<string, unknown> = {}): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/v1/command`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ type, ...args }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`Command ${type} failed: ${res.status} ${text}`);
    }
    return res.json();
  }

  async ping(): Promise<boolean> {
    try {
      await this.getStatus();
      return true;
    } catch {
      return false;
    }
  }
}
