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
// P5 (2026-08-18 freeze RCA): the 15s default is now env-overridable
// (ADHDEV_IPC_COMMAND_TIMEOUT_MS) as an operator escape hatch. This is symptom
// relief ONLY — it cannot prevent the daemon event-loop freeze that caused the
// timeouts; the fixes for that are the Refinery concurrency cap and the probe
// retry below. Per-command table entries above still win over this default.
const IPC_COMMAND_TIMEOUT_ENV = 'ADHDEV_IPC_COMMAND_TIMEOUT_MS';
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
  // P0 (2026-08-28 RCA, false 15s timeouts on 4 unregistered commands): these commands
  // fell through to the bare 15s default and violated IPC >= relay >= responder for a
  // LOCAL node (no relay layer wraps a local dispatch — see the module comment above).
  //
  // plan_mesh_onboarding: relay classifies it as a git-status probe (30s, daemon-cloud
  // GIT_STATUS_PROBE_COMMANDS) but the responder's own worst case can exceed that —
  // detectCLIs(includeVersion:true) fans out across providers in parallel, but EACH
  // provider runs its --version/-V/-v/custom fallback chain SEQUENTIALLY, up to 4 x 3s
  // = 12s for a single slow/hanging provider (cli-detector.ts), stacked on top of
  // mesh-onboarding-plan.ts's sequential git probes (each capped at GIT_TIMEOUT_MS 15s).
  // 45s covers the relay's 30s plus headroom for that responder spike; see the
  // detectCLIs parallelization fix below for the actual root-cause mitigation.
  plan_mesh_onboarding: 45_000,
  // get_runtime_snapshot / session_host_get_diagnostics: both are answered by the
  // session-host process via SessionHostClient.request(), which has its own hard 30s
  // timeout (session-host-core/src/ipc.ts). IPC must stay >= that responder budget.
  get_runtime_snapshot: 45_000,
  session_host_get_diagnostics: 45_000,
  // get_mesh: the default (no refresh) read is in-memory/synchronous, but
  // args.refresh/forceRefresh fans out a direct mesh probe per remote node with its own
  // 25s timeout + 25s retry (mesh-node-identity.ts MESH_DIRECT_PROBE_TIMEOUT_MS /
  // MESH_DIRECT_PROBE_RETRY_TIMEOUT_MS), up to ~50s for that node's own probe+retry
  // chain (nodes run in parallel, so this is not multiplied by node count). 60s covers
  // that refresh path with headroom.
  get_mesh: 60_000,
  // cleanup_mesh_sessions: Mutating command for cleaning up stale sessions,
  // needs sufficient time to terminate processes and clear state.
  cleanup_mesh_sessions: 60_000,
};

// IPC-PROBE-TIMEOUT-RETRY (2026-08-18 RCA, verdict D — whole-process freeze):
// the daemon's event loop blacked out for 28–34s under Refinery load and probe
// commands false-timed-out 0.6s before the process resumed; a manual retry
// 1–2 minutes later succeeded. Automate that: a read-only probe that TIMES OUT
// gets one automatic retry after a short backoff (a fresh full deadline
// window), instead of surfacing a spurious failure to the user.
//
// SAFETY: retry is restricted to this allowlist of pure read-only probes —
// commands with no state to mutate, so re-sending them can never duplicate an
// effect. Mutating verbs (task dispatch, merge, push, refine, queue ops,
// mesh_forward_event — which CONSUMES pending events on some handlers) are
// deliberately ABSENT: a retried dispatch could double-execute, which is
// strictly worse than the timeout it was meant to hide. Never add a verb here
// without proving its handler is side-effect free.
const IPC_PROBE_RETRYABLE_COMMANDS: ReadonlySet<string> = new Set([
  'get_status_metadata',
  'get_mesh',
  'mesh_status',
  'git_status',
  'git_diff_summary',
  'git_log',
  'git_diff_file',
  'read_chat',
  'get_spec_debug',
  'get_chat_debug_bundle',
  'list_coordinator_prompts',
  'list_provider_availability',
  // P0 (2026-08-28): added alongside the timeout-tier fix above. All four are
  // read-only queries (onboarding plan preview, session-host snapshot/diagnostics
  // reads, in-memory mesh graph read) with nothing to mutate, so a timed-out retry
  // can never double-execute an effect — same safety bar as the entries above.
  'plan_mesh_onboarding',
  'get_runtime_snapshot',
  'session_host_get_diagnostics',
]);
const IPC_PROBE_RETRY_MAX_ENV = 'ADHDEV_IPC_PROBE_RETRY_MAX';
const IPC_PROBE_RETRY_BACKOFF_MS_ENV = 'ADHDEV_IPC_PROBE_RETRY_BACKOFF_MS';
const DEFAULT_IPC_PROBE_RETRY_MAX = 1;
const DEFAULT_IPC_PROBE_RETRY_BACKOFF_MS = 2_000;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function resolveDefaultCommandTimeoutMs(): number {
  const parsed = parsePositiveInt(process.env[IPC_COMMAND_TIMEOUT_ENV], DEFAULT_IPC_COMMAND_TIMEOUT_MS);
  return parsed > 0 ? parsed : DEFAULT_IPC_COMMAND_TIMEOUT_MS;
}

export function resolveProbeRetryMax(): number {
  return parsePositiveInt(process.env[IPC_PROBE_RETRY_MAX_ENV], DEFAULT_IPC_PROBE_RETRY_MAX);
}

export function resolveProbeRetryBackoffMs(): number {
  return parsePositiveInt(process.env[IPC_PROBE_RETRY_BACKOFF_MS_ENV], DEFAULT_IPC_PROBE_RETRY_BACKOFF_MS);
}

/** Probe-class allowlist check (exported for tests and for the retry loop). */
export function isRetryableProbeCommand(type: string): boolean {
  return IPC_PROBE_RETRYABLE_COMMANDS.has(type);
}

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
  const fallback = resolveDefaultCommandTimeoutMs();
  return Math.max(
    IPC_COMMAND_TIMEOUTS_MS[type] ?? fallback,
    IPC_COMMAND_TIMEOUTS_MS[nestedCommand] ?? fallback,
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

  private async sendIpcCommand(type: string, args: Record<string, unknown>): Promise<any> {
    // IPC-PROBE-TIMEOUT-RETRY: one bounded retry, only for allowlisted
    // read-only probes, and only on a TIMEOUT (the freeze symptom) — never on
    // a semantic failure reply and never for a mutating verb (see the
    // allowlist's safety note). A relayed probe (mesh_relay_command wrapping
    // get_status_metadata) is intentionally NOT retried here: its 120s budget
    // already dwarfs the observed freeze windows.
    const maxRetries = isRetryableProbeCommand(type) ? resolveProbeRetryMax() : 0;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.sendIpcCommandOnce(type, args);
      } catch (e: any) {
        if (!e?.ipcTimeout || attempt >= maxRetries) throw e;
        const backoffMs = resolveProbeRetryBackoffMs();
        console.error(`[ipc] probe command '${type}' timed out; retrying (${attempt + 1}/${maxRetries}) in ${backoffMs}ms — read-only command, safe to re-send`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  }

  private sendIpcCommandOnce(type: string, args: Record<string, unknown>): Promise<any> {
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
        const error = new Error(`Daemon IPC ${diagnosticParts.join(' ')} timed out after ${Math.round(timeoutMs / 1000)}s (requestId=${requestId})`);
        // Tagged so the retry loop in sendIpcCommand can tell a TIMEOUT (the
        // freeze symptom, retryable for read-only probes) apart from a
        // semantic failure reply or a connection error (neither retried).
        (error as any).ipcTimeout = true;
        reject(error);
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
