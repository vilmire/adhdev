/**
 * IpcTransport — WebSocket client for the cloud daemon's local IPC server.
 *
 * This is used by Repo Mesh coordinators launched by `adhdev daemon` (cloud
 * daemon). They run on the same machine as the daemon, but not against the
 * standalone HTTP server at localhost:3847.
 *
 * Uses a persistent connection pool (one WS per port+path) so concurrent
 * mesh tool calls share a single connection instead of opening a new socket
 * per request.
 */

import { IDENTITY } from '@adhdev/daemon-core';

// Track-scoped default (19222 stable / 19223 preview). A hardcoded 19222 here
// made a PREVIEW coordinator silently drive the STABLE daemon whenever the
// caller omitted --port, because nothing downstream re-derived the track.
const DEFAULT_IPC_PORT = IDENTITY.defaultPort;
const DEFAULT_IPC_PATH = '/ipc';
const DEFAULT_IPC_COMMAND_TIMEOUT_MS = 15_000;
// IPC (layer-1) is the OUTERMOST deadline. For a REMOTE node the coordinator wraps
// the verb in `mesh_relay_command` (120s here), so getTimeoutMs() already covers the
// relay/responder budget. But for a LOCAL node commandForNode() sends the BARE verb
// (transport.command), so the only deadline is this table — and any heavy verb missing
// an entry fell back to the 15s default and false-timed-out while the responder was
// still working (e.g. a local `clone_mesh_node` worktree create). Entries below keep
// IPC ≥ the relay budget (daemon-cloud resultTimeoutForCommand) ≥ the responder budget.
const IPC_COMMAND_TIMEOUTS_MS: Record<string, number> = {
  mesh_relay_command: 120_000,
  agent_command: 30_000,
  git_status: 45_000,
  git_diff_summary: 45_000,
  fast_forward_mesh_node: 120_000,
  mesh_status: 120_000,
  // Heavy repo-mutating worktree ops (relay budgets: clone 90s, remove 60s). A local
  // clone synchronously creates a worktree (~30s) plus a bounded setup-wait (~14s);
  // 120s leaves headroom and matches the relay-wrapped remote path.
  clone_mesh_node: 120_000,
  remove_mesh_node: 60_000,
  // Retention plan/execute runs the same git probes as a remove dry-run plus
  // queue/session/ledger reads; 60s matches the remove budget.
  cleanup_worktree_nodes: 60_000,
  // A5: plan_mesh_refine_node is the SYNCHRONOUS refine dry-run — it runs several git
  // probes (status/merge-tree/submodule) inline before replying, which can approach the
  // 15s default on a slow (Windows) host. 45s defensively, matching git_status/diff.
  plan_mesh_refine_node: 45_000,
  // A2: refine_mesh_node / batch_refine_mesh_nodes are async-job-ack (the responder
  // returns { async:true, status:'accepted' } immediately and works in the background),
  // so 15s already suffices. 30s is a defensive floor guarding a future sync-dry-run
  // regression; it is intentionally BELOW the relay 90s budget because the synchronous
  // ack reply is sub-second and never bounded by the relay deadline.
  refine_mesh_node: 30_000,
  batch_refine_mesh_nodes: 30_000,
};

// WS readyState constants (same as browser)
const WS_CONNECTING = 0;
const WS_OPEN = 1;

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const POOL_IDLE_EVICT_MS = 5 * 60_000;   // evict connections idle for >5 min
const POOL_MAX_AGE_MS = 10 * 60_000;     // force-refresh connections older than 10 min

interface PooledConnection {
  ws: WebSocket;
  ready: boolean;
  commandQueue: Array<{ type: string; args: Record<string, unknown>; requestId: string }>;
  pending: Map<string, PendingRequest>;
  lastUsedAt: number;
  createdAt: number;
}

const connectionPool = new Map<string, PooledConnection>();

function buildRequestId(): string {
  return `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function getTimeoutMs(type: string, nestedCommand: string): number {
  return Math.max(
    IPC_COMMAND_TIMEOUTS_MS[type] ?? DEFAULT_IPC_COMMAND_TIMEOUT_MS,
    IPC_COMMAND_TIMEOUTS_MS[nestedCommand] ?? DEFAULT_IPC_COMMAND_TIMEOUT_MS,
  );
}

function getOrCreateConnection(
  WebSocketCtor: typeof WebSocket,
  url: string,
): PooledConnection {
  const existing = connectionPool.get(url);
  if (existing) {
    const { readyState } = existing.ws;
    const now = Date.now();
    const isAlive = readyState === WS_CONNECTING || readyState === WS_OPEN;
    const isIdle = now - existing.lastUsedAt > POOL_IDLE_EVICT_MS && existing.pending.size === 0;
    const isTooOld = now - existing.createdAt > POOL_MAX_AGE_MS && existing.pending.size === 0;
    if (isAlive && !isIdle && !isTooOld) {
      return existing;
    }
    if (isAlive && (isIdle || isTooOld)) {
      try { existing.ws.close(); } catch { /* noop */ }
      connectionPool.delete(url);
    }
    // Stale — remove and recreate
    connectionPool.delete(url);
  }

  const now = Date.now();
  const conn: PooledConnection = {
    ws: new WebSocketCtor(url),
    ready: false,
    commandQueue: [],
    pending: new Map(),
    lastUsedAt: now,
    createdAt: now,
  };
  connectionPool.set(url, conn);

  const drainQueue = () => {
    conn.ready = true;
    for (const { type, args, requestId } of conn.commandQueue) {
      conn.ws.send(JSON.stringify({ type: 'ext:command', payload: { command: type, args, requestId } }));
    }
    conn.commandQueue = [];
  };

  let tornDown = false;
  const teardown = (error: Error) => {
    if (tornDown) return;
    tornDown = true;
    connectionPool.delete(url);
    conn.ready = false;
    for (const [, req] of conn.pending) {
      clearTimeout(req.timer);
      req.reject(error);
    }
    conn.pending.clear();
    conn.commandQueue = [];
  };

  conn.ws.addEventListener('open', () => {
    conn.ws.send(JSON.stringify({
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

  conn.ws.addEventListener('message', (event: MessageEvent) => {
    try {
      const raw = typeof event.data === 'string' ? event.data : String(event.data);
      const msg = JSON.parse(raw);
      if (msg?.type === 'daemon:welcome') {
        drainQueue();
        return;
      }
      if (msg?.type !== 'ext:command_result') return;
      const req = conn.pending.get(msg?.payload?.requestId);
      if (!req) return;
      conn.pending.delete(msg.payload.requestId);
      clearTimeout(req.timer);
      const payload = msg.payload;
      // A structured `result` means the responder actually processed the command
      // and produced a semantic outcome — including a legitimate FAILURE such as a
      // `blocked` fast-forward carrying `blockingReasons` (success:false, no top-level
      // `error`). That is NOT a transport failure; rejecting here would discard the
      // result and surface an opaque "Daemon IPC command failed" to the coordinator.
      // Only reject when the reply carries no structured result to preserve (i.e. a
      // genuine transport/handler failure with just an error string).
      const hasStructuredResult = payload != null && payload.result != null;
      if (payload?.success === false && !hasStructuredResult) {
        req.reject(new Error(payload.error || 'Daemon IPC command failed'));
      } else {
        req.resolve(payload?.result ?? payload);
      }
    } catch {
      // Ignore non-JSON or unrelated daemon messages.
    }
  });

  conn.ws.addEventListener('error', () => {
    teardown(new Error(`Cannot connect to daemon IPC at ${url}`));
  });

  conn.ws.addEventListener('close', () => {
    teardown(new Error(`Daemon IPC connection closed: ${url}`));
  });

  return conn;
}

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

  private sendIpcCommand(type: string, args: Record<string, unknown>): Promise<any> {
    const WebSocketCtor = globalThis.WebSocket;
    if (!WebSocketCtor) {
      return Promise.reject(new Error('WebSocket is not available in this Node runtime; Node 20+ is required for daemon IPC mode'));
    }

    const requestId = buildRequestId();
    const nestedCommand = typeof args?.command === 'string' ? args.command : '';
    const timeoutMs = getTimeoutMs(type, nestedCommand);
    const targetDaemonId = typeof args?.targetDaemonId === 'string' ? args.targetDaemonId : '';

    const diagnosticParts = [
      `command='${type}'`,
      ...(nestedCommand ? [`relayedCommand='${nestedCommand}'`] : []),
      ...(targetDaemonId ? [`targetDaemonId='${targetDaemonId.slice(0, 12)}'`] : []),
      ...(typeof args?.nodeId === 'string' ? [`nodeId='${args.nodeId}'`] : []),
      ...(typeof args?.workspace === 'string' ? [`workspace='${args.workspace}'`] : []),
    ];

    const url = `ws://127.0.0.1:${this.port}${this.path}`;

    return new Promise((resolve, reject) => {
      let conn: PooledConnection;
      try {
        conn = getOrCreateConnection(WebSocketCtor as typeof WebSocket, url);
      } catch (e: any) {
        return reject(new Error(`Failed to create IPC connection: ${e?.message || e}`));
      }

      const timer = setTimeout(() => {
        conn.pending.delete(requestId);
        reject(new Error(`Daemon IPC ${diagnosticParts.join(' ')} timed out after ${Math.round(timeoutMs / 1000)}s (requestId=${requestId})`));
      }, timeoutMs);

      conn.pending.set(requestId, { resolve, reject, timer });
      conn.lastUsedAt = Date.now();

      if (conn.ready) {
        conn.ws.send(JSON.stringify({ type: 'ext:command', payload: { command: type, args, requestId } }));
      } else {
        conn.commandQueue.push({ type, args, requestId });
      }
    });
  }
}
