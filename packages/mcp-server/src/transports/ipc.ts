/**
 * IpcTransport — WebSocket client for the cloud daemon's local IPC server.
 *
 * This is used by Repo Mesh coordinators launched by `adhdev daemon` (cloud
 * daemon). They run on the same machine as the daemon, but not against the
 * standalone HTTP server at localhost:3847.
 */

const DEFAULT_IPC_PORT = 19222;
const DEFAULT_IPC_PATH = '/ipc';

export interface IpcTransportOptions {
  port?: number;
  path?: string;
}

export class IpcTransport {
  private port: number;
  private path: string;

  constructor(opts: IpcTransportOptions = {}) {
    this.port = opts.port ?? DEFAULT_IPC_PORT;
    this.path = opts.path || DEFAULT_IPC_PATH;
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async getStatus(): Promise<any> {
    return this.command('get_status_metadata');
  }

  async command(type: string, args: Record<string, unknown> = {}): Promise<any> {
    return this.sendIpcCommand(type, args);
  }

  async meshCommand(
    targetDaemonId: string,
    command: string,
    args: Record<string, unknown> = {},
  ): Promise<any> {
    return this.sendIpcCommand('mesh_relay_command', {
      targetDaemonId,
      command,
      args,
    });
  }

  private async sendIpcCommand(type: string, args: Record<string, unknown>): Promise<any> {
    const WebSocketCtor = globalThis.WebSocket;
    if (!WebSocketCtor) {
      throw new Error('WebSocket is not available in this Node runtime; Node 20+ is required for daemon IPC mode');
    }

    return new Promise((resolve, reject) => {
      const requestId = `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const ws = new WebSocketCtor(`ws://127.0.0.1:${this.port}${this.path}`);
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { ws.close(); } catch { /* noop */ }
        fn();
      };

      const timeout = setTimeout(() => {
        finish(() => reject(new Error(`Daemon IPC command '${type}' timed out after 15s`)));
      }, 15_000);

      let commandSent = false;
      const send = () => {
        if (commandSent) return;
        commandSent = true;
        ws.send(JSON.stringify({
          type: 'ext:command',
          payload: { command: type, args, requestId },
        }));
      };

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({
          type: 'ext:register',
          payload: {
            ideType: 'mcp-server',
            ideVersion: '1.0.0',
            extensionVersion: '1.0.0',
            instanceId: `mcp-server-${process.pid}`,
            machineId: 'mcp-server',
            workspaceFolders: [],
          },
        }));
      });

      ws.addEventListener('message', (event) => {
        try {
          const raw = typeof event.data === 'string' ? event.data : String(event.data);
          const msg = JSON.parse(raw);
          if (msg?.type === 'daemon:welcome') {
            send();
            return;
          }
          if (msg?.type !== 'ext:command_result') return;
          if (msg?.payload?.requestId !== requestId) return;
          const payload = msg.payload;
          if (payload?.success === false) {
            finish(() => reject(new Error(payload.error || `Daemon IPC command '${type}' failed`)));
            return;
          }
          finish(() => resolve(payload?.result ?? payload));
        } catch {
          // Ignore non-JSON or unrelated daemon messages.
        }
      });

      ws.addEventListener('error', () => {
        finish(() => reject(new Error(`Cannot connect to daemon IPC at ws://127.0.0.1:${this.port}${this.path}`)));
      });
    });
  }
}
