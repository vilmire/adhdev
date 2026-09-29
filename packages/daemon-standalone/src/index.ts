/**
 * daemon-standalone — Embedded HTTP/WS server for local dashboard
 *
 * Standalone-only server:
 * 1. DaemonCore init (IDE detection, CDP connection, Provider loading)
 * 2. HTTP REST API — /api/v1/status, /api/v1/command
 * 3. WebSocket — ws://localhost:3847/ws (real-time status broadcast + command execution)
 *    + ws://localhost:3847/ws/seqscribe (dashboard transcript replica lane — raw seqscribe frames)
 * 4. Static file serving — web-standalone build output
 *
 * Usage:
 *   npx @adhdev/daemon-standalone
 *   npx @adhdev/daemon-standalone --port 4000
 */

import './bootstrap-config-dir.js'; // FIRST: pins ADHDEV_CONFIG_DIR before any config-dir-reading module evaluates
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  parseStandaloneCliArgs,
  normalizeStandaloneLogLevel,
  StandaloneCliArgsError,
  STANDALONE_HELP_TEXT,
  resolveStandalonePortEnvOverride,
  type StandaloneLogLevel,
} from './standalone-cli-args.js';

import {
  LOG,
  setLogInstancePort,
  setLogLevel,
  setConsoleLogLevel,
  resolveDebugRuntimeConfig,
  setDebugRuntimeConfig,
  configureDebugTraceStore,
  bootDaemonRuntime,
  bootSessionHost,
  createDaemonHostRuntime,
  loadConfig,
  maybeRunDaemonUpgradeHelperFromEnv,
  withRawTerminalAttachment,
  shouldAutoRestoreHostedSessionsOnStartup,
  STANDALONE_CDP_SCAN_INTERVAL_MS,
  DEFAULT_DAEMON_PORT,
  DAEMON_WS_PATH,
  DEFAULT_STANDALONE_PORT,
  StandaloneTranscriptLane,
  transcriptTopicsAvailableFrame,
  STANDALONE_SEQSCRIBE_WS_PATH,
  type DaemonHostRuntime,
  type DaemonRuntime,
  type DevServer,
  type LocalIpcServerHandle,
  type NamedKey,
  type SessionHostHandle,
  type SubscribeRequest,
  type TopicUpdateEnvelope,
  type UnsubscribeRequest,
} from '@adhdev/daemon-core';
import {
  ensureSessionHostReady,
  getStandaloneSessionHostAppName,
  getStandaloneSessionHostAppNameWarning,
  proxySessionHostAttach,
  proxySessionHostList,
} from './session-host.js';
import { runQuotaCommand } from './quota-cli.js';
import { SessionHostClient } from '@adhdev/session-host-core';
import type { RawTerminalHttpService } from './raw-terminal-http.js';
import { createRouterInteractivePromptService } from './interactive-prompt-http.js';
import { StandaloneHttpApi } from './standalone-http.js';
import { normalizeCommandEnvelope } from './standalone-command-envelope.js';
import {
  rejectStandaloneUpgrade,
  routeStandaloneUpgrade,
} from './standalone-seqscribe-upgrade.js';
import { standaloneIpcEnabled, startStandaloneIpcCompatServer } from './standalone-ipc-compat.js';
import { broadcastToOpenClients, createStandaloneHostTransport, standaloneHelloFrame } from './standalone-host-transport.js';
import { buildStandaloneStatusResponse } from './standalone-status-payload.js';

// ─── Constants ───
const DEFAULT_PORT = DEFAULT_STANDALONE_PORT;
// Standalone auth/session/preference helpers live in ./standalone-auth.ts
// (pure move, 2026-09-18). Re-exported so every existing importer keeps
// resolving them through this entry unchanged.
import {
  STANDALONE_BIND_HOST_DEFAULT,
  loadStandaloneBindHostPreference,
  saveStandaloneBindHostPreference,
  shouldWarnForPublicUnauthenticatedHost,
} from './standalone-auth.js';
export * from './standalone-auth.js';

let pkgVersion = process.env.ADHDEV_PKG_VERSION || 'unknown';
if (pkgVersion === 'unknown') {
  try {
    const possiblePaths = [
      path.join(__dirname, '..', 'package.json'),
      path.join(__dirname, 'package.json'),
    ];
    for (const candidate of possiblePaths) {
      try {
        const data = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
        if (data.version) {
          pkgVersion = data.version;
          break;
        }
      } catch { /* noop */ }
    }
  } catch { /* noop */ }
}

if (process.platform === 'win32') {
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] || '0', 10);
  if (nodeMajor >= 24) {
    console.error('\n✗ Windows is currently unsupported on Node.js 24+ for ADHDev standalone.');
    console.error('  Install Node.js 22.x on Windows, then retry.\n');
    process.exit(1);
  }
}

// ─── Types ───
interface StandaloneOptions {
  port?: number;
  host?: string;
  publicDir?: string;
  open?: boolean;
  token?: string;
  dev?: boolean;
  logLevel?: StandaloneLogLevel;
}

interface WsMessage {
  type: string;
  requestId?: string;
  data?: Record<string, any>;
  topic?: string;
  key?: string;
  params?: Record<string, any>;
  update?: TopicUpdateEnvelope;
}

// ─── Standalone Server ───

class StandaloneServer {
  private httpServer: ReturnType<typeof createServer> | null = null;
  private wss: WebSocketServer | null = null;
  /**
   * Optional IPC server (ws://127.0.0.1:19222/ipc). Standalone normally stays
   * isolated on its HTTP/local MCP port and must not contend with the global
   * daemon for the canonical IPC port.
   */
  private ipcServer: LocalIpcServerHandle | null = null;
  private clients = new Set<WebSocket>();
  /** Stable id per WS client so the core topic registry can address a connection. */
  private wsConnectionIds = new WeakMap<WebSocket, string>();
  private wsByConnectionId = new Map<string, WebSocket>();
  private wsConnectionSeq = 0;
  /** Canonical status instance id (`standalone_<mid>`), set at start. */
  private statusInstanceId = 'standalone';
  /**
   * `session.runtime_output` subscriptions per WS client (key → sessionId).
   * Terminal bytes go only to a client that subscribed to that session
   * (audit P1-10) — the same contract cloud's P2P peers follow.
   */
  private runtimeOutputSubscriptions = new Map<WebSocket, Map<string, string>>();
  private running = false;
  /** The staged boot (daemon-core `bootDaemonRuntime`). */
  private runtime: DaemonRuntime | null = null;
  /**
   * The shared host surface (daemon-core `createDaemonHostRuntime`): topic
   * registry, snapshot / metadata builders, command entry, and every bus
   * subscriber that replaced this file's old onStatusChange lambdas. This class
   * supplies only the WS transport (`buildTransport`).
   */
  private host: DaemonHostRuntime | null = null;
  private sessionHost: SessionHostHandle | null = null;
  private devServer: DevServer | null = null;
  private offBus: Array<() => void> = [];
  /**
   * The dashboard's seqscribe transcript replica lane (`/ws/seqscribe`,
   * the dashboard's ONLY chat delivery path). Null only when the seqscribe
   * node did not open.
   */
  private transcriptLane: StandaloneTranscriptLane | null = null;
  private readonly http = new StandaloneHttpApi({
    isReady: () => !!this.host,
    getStatus: () => buildStandaloneStatusResponse(this.host!.buildSnapshot('full')),
    executeCommand: (type, payload) => this.executeCommand(type, payload),
    rawTerminalService: () => this.rawTerminalService(),
    interactivePromptService: () => createRouterInteractivePromptService(this.host!),
    isCliSession: (sessionId) => this.host?.isCliSession(sessionId) ?? false,
    createSessionHostClient: () => this.createSessionHostClient(),
  });

  private rawTerminalService(): RawTerminalHttpService {
    const endpoint = this.sessionHost?.endpoint() || undefined;
    return {
      readScreen: (sessionId) => withRawTerminalAttachment(
        { endpoint, sessionId, mode: 'read' },
        attachment => attachment.readScreenText(),
      ),
      readState: (sessionId) => withRawTerminalAttachment(
        { endpoint, sessionId, mode: 'read' },
        attachment => attachment.readState(),
      ),
      writeInput: (sessionId, text) => withRawTerminalAttachment(
        { endpoint, sessionId, mode: 'write' },
        attachment => attachment.writeInput(text),
      ),
      writeKeys: (sessionId, keys: readonly NamedKey[]) => withRawTerminalAttachment(
        { endpoint, sessionId, mode: 'write' },
        attachment => attachment.writeKeys(keys),
      ),
    };
  }

  private isRecoverableSessionHostError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes('ECONNREFUSED') ||
      message.includes('ENOENT') ||
      message.includes('Session host socket unavailable')
    );
  }

  /** A short-lived client for the runtime snapshot / SSE routes (respawns a dead host once). */
  private async createSessionHostClient(): Promise<SessionHostClient> {
    const sessionHost = this.sessionHost;
    let endpoint = sessionHost ? sessionHost.endpoint() : await ensureSessionHostReady();
    let client = new SessionHostClient({ endpoint });
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      if (!this.isRecoverableSessionHostError(error)) throw error;
    }
    endpoint = sessionHost ? await sessionHost.ensure() : await ensureSessionHostReady();
    client = new SessionHostClient({ endpoint });
    await client.connect();
    return client;
  }

  private broadcastToClients(message: unknown): void {
    broadcastToOpenClients(this.clients, message);
  }

  private flushTopic(topic: 'machine.runtime' | 'session_host.diagnostics' | 'workspace.git' | 'daemon.metadata'): void {
    const topics = this.host?.topics;
    if (topics?.hasSubscriptions(topic)) void topics.flushNow(topic);
  }

  async start(options: StandaloneOptions = {}): Promise<void> {
    const persistedStandaloneBindHost = loadStandaloneBindHostPreference();
    const cfg = loadConfig();
    if (!options.host && persistedStandaloneBindHost !== STANDALONE_BIND_HOST_DEFAULT) {
      saveStandaloneBindHostPreference(persistedStandaloneBindHost);
    }
    const port = options.port || resolveStandalonePortEnvOverride() || DEFAULT_PORT;
    // Tag the daemon-core file logger with this server's port so its
    // daemon-<port>-YYYY-MM-DD.log never interleaves with another daemon
    // sharing the same log dir (e.g. an explicit shared ADHDEV_CONFIG_DIR).
    setLogInstancePort(port);
    // Repo Mesh coordinators launched from standalone must talk back to this
    // standalone HTTP daemon, not the user's global cloud-daemon IPC port.
    process.env.ADHDEV_COORDINATOR_MCP_TRANSPORT = 'local';
    process.env.ADHDEV_COORDINATOR_MCP_PORT = String(port);
    if (!process.env.ADHDEV_COORDINATOR_MCP_ENTRY_PATH?.trim()) {
      const bundledMcpServer = path.resolve(__dirname, '../vendor/mcp-server/index.js');
      if (fs.existsSync(bundledMcpServer)) {
        process.env.ADHDEV_COORDINATOR_MCP_ENTRY_PATH = bundledMcpServer;
        process.env.ADHDEV_COORDINATOR_NODE_EXECUTABLE = process.execPath;
      }
    }
    const host = options.host || persistedStandaloneBindHost;
    this.http.listenHost = host;
    const statusInstanceId = `standalone_${cfg.machineId || 'mach_unknown'}`;
    this.statusInstanceId = statusInstanceId;
    // One session-host bring-up for both hosts (D7): a persistent controller
    // with host events, and a stable write-owner id that survives restarts.
    this.sessionHost = await bootSessionHost({
      ensureReady: ensureSessionHostReady,
      clientId: statusInstanceId,
      managedBy: 'adhdev-standalone',
      onHostEvent: () => {
        this.flushTopic('session_host.diagnostics');
        // A hosted runtime changed state: its session row (status / modal) moved.
        this.flushTopic('daemon.metadata');
      },
    });

    // Auth token setup (opt-in only)
    this.http.configureAuth(options.token || process.env.ADHDEV_TOKEN || null);

    // Staged boot. Hosted sessions are restored INSIDE the boot (startLoops),
    // after every bus subscriber is attached and before the residue sweep.
    this.runtime = await bootDaemonRuntime({
      statusInstanceId,
      statusVersion: pkgVersion,
      statusDaemonMode: false,
      sessionHost: this.sessionHost.bootConfig(),
      tickIntervalMs: 3000,
      cdpScanIntervalMs: STANDALONE_CDP_SCAN_INTERVAL_MS,
      restoreHostedSessions: shouldAutoRestoreHostedSessionsOnStartup(process.env),
    });
    const components = this.runtime.components;
    this.host = createDaemonHostRuntime(this.runtime, createStandaloneHostTransport({
      statusInstanceId,
      version: pkgVersion,
      clients: this.clients,
      wsByConnectionId: this.wsByConnectionId,
      getRuntime: () => this.runtime,
      getSessionHostControl: () => this.sessionHost?.control ?? null,
      runtimeOutputTargets: (sessionId) => this.runtimeOutputTargets(sessionId),
      flushTopic: (topic) => this.flushTopic(topic),
    }));
    if (this.runtime.seqscribe) {
      this.transcriptLane = new StandaloneTranscriptLane(this.runtime.seqscribe.node);
      // A session's chat topic just became SUB-able on the replica lane: tell
      // every dashboard NOW (over /ws — the lane socket carries seqscribe
      // frames only) so its worker re-SUBs immediately instead of waiting for
      // its retry backoff. Topic names only; see TRANSCRIPT_TOPICS_AVAILABLE_TYPE.
      this.transcriptLane.onTopicsAvailable((topics) => {
        this.broadcastToClients(transcriptTopicsAvailableFrame(topics));
      });
    }

    // DevServer (optional) — shared with cloud, with provider hot reload.
    if (options.dev) {
      this.devServer = await this.host.startDevSupport({ logFn: (msg: string) => console.log(msg) });
    }

    // 5. HTTP Server
    this.httpServer = createServer((req, res) => {
      this.http.handle(req, res, options.publicDir);
    });

    // 6. WebSocket Server (upgrade)
    this.wss = new WebSocketServer({ noServer: true });
    this.httpServer.on('upgrade', (req, socket, head) => {
      // Both legs (/ws JSON dashboard lane, /ws/seqscribe transcript replica
      // lane) pass the SAME Origin + token/password gate before upgrading —
      // without it any page could open a WS to this daemon, subscribe to
      // topic_update streams and dispatch commands.
      const route = routeStandaloneUpgrade(req, this.http, {
        seqscribePath: STANDALONE_SEQSCRIBE_WS_PATH,
        seqscribeLaneAvailable: this.transcriptLane !== null,
      });
      switch (route.kind) {
        case 'dashboard':
          this.wss!.handleUpgrade(req, socket, head, (ws) => {
            this.handleWsConnection(ws);
          });
          return;
        case 'seqscribe':
          this.wss!.handleUpgrade(req, socket, head, (ws) => {
            this.handleSeqscribeLaneConnection(ws);
          });
          return;
        case 'reject':
          rejectStandaloneUpgrade(socket, route.status);
          return;
        default:
          socket.destroy();
      }
    });

    // 7. (was: a 2s "status broadcast timer" safety net.) Every facts / status
    // edge already pushes through the bus subscribers (host.metadata-pump →
    // the keyed daemon.metadata flush, host.modal /
    // host.mesh-state / host.topics → the push-topic flushes above) — see
    // boot/host-runtime.ts's DaemonHostRuntime wiring. The interval is gone;
    // a 60s WARN-only reconciliation tick (host-subscribers.ts
    // subscribeHostTopicReconciliation, armed inside createDaemonHostRuntime)
    // is the only thing left watching for a silently-missed edge.

    // 8. Start listening
    this.running = true;
    await new Promise<void>((resolve, reject) => {
      // listen()'s completion callback only fires on success; a bind failure
      // (e.g. EADDRINUSE because another daemon already holds this port)
      // surfaces as an async 'error' event instead. Without this listener
      // Node treats it as an uncaught exception on the whole process instead
      // of a clean, attributable startup failure via main().catch() below.
      const onError = (err: NodeJS.ErrnoException): void => {
        this.running = false;
        if (err.code === 'EADDRINUSE') {
          reject(new Error(
            `Port ${port} is already in use — another process (possibly another ADHDev daemon) `
            + `is listening on ${host}:${port}. Use --port <port> or set ADHDEV_STANDALONE_PORT `
            + 'to pick a different one.',
          ));
        } else {
          reject(err);
        }
      };
      this.httpServer!.once('error', onError);
      this.httpServer!.listen(port, host, () => {
        this.httpServer!.off('error', onError);
        resolve();
      });
    });

    // 8.5 Optional local IPC server. The canonical IPC port belongs to the
    // global daemon by default; standalone stays on HTTP/local MCP unless an
    // operator explicitly opts into compatibility mode.
    if (standaloneIpcEnabled()) {
      this.ipcServer = await startStandaloneIpcCompatServer({ pkgVersion, host: () => this.host });
    }

    console.log('');
    console.log('🚀 ADHDev Standalone Server');
    console.log(`   http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    console.log(`   ws://${host === '0.0.0.0' ? 'localhost' : host}:${port}/ws`);
    if (host === '0.0.0.0') {
      const lanIps = this.getLanIPs();
      for (const ip of lanIps) {
        console.log(`   http://${ip}:${port}  (LAN)`);
      }
    }
    if (this.http.authToken) {
      console.log('   🔑 Token auth: enabled');
    }
    if (this.http.passwordConfig) {
      console.log('   🔐 Password auth: enabled');
    }
    if (this.ipcServer?.isListening()) {
      console.log(`   IPC: ws://127.0.0.1:${DEFAULT_DAEMON_PORT}${DAEMON_WS_PATH} (for adhdev mcp --mode ipc)`);
    } else if (standaloneIpcEnabled()) {
      console.log(`   IPC: disabled (port ${DEFAULT_DAEMON_PORT} unavailable)`);
    }
    if (shouldWarnForPublicUnauthenticatedHost({ host, hasTokenAuth: !!this.http.authToken, hasPasswordAuth: !!this.http.passwordConfig })) {
      console.warn('   ⚠️  Public host mode is enabled without any auth.');
      console.warn('      Anyone on your LAN can open and control this dashboard until you set a password or token.');
    }
    console.log('');

    // CDP/Providers/Session-Host detail is diagnostic, not decision-relevant
    // at startup — keep it under --dev/--log-level (verbose) and `status
    // --verbose`-equivalent output only. A misconfigured session host is
    // surfaced regardless: it is actionable, not routine telemetry.
    const verboseBanner = Boolean(options.dev || (options.logLevel && options.logLevel !== 'warn' && options.logLevel !== 'error'));
    const sessionHostWarning = getStandaloneSessionHostAppNameWarning();
    if (sessionHostWarning) {
      console.warn(`   ⚠️  ${sessionHostWarning}`);
    }
    if (verboseBanner) {
      const cdpCount = [...components.cdpManagers.values()].filter(m => m.isConnected).length;
      console.log(`   CDP: ${cdpCount > 0 ? `✅ ${cdpCount} connected` : '❌ none'}`);
      console.log(`   Providers: ${components.providerLoader.getAll().length} loaded`);
      console.log(`   Session Host: ${getStandaloneSessionHostAppName()}`);
      if (options.dev) {
        console.log(`   🛠️  DevConsole: http://127.0.0.1:19280`);
      }
      console.log('');
    }
    console.log('   Press Ctrl+C to stop.');
    console.log('');

    // Open browser
    if (options.open !== false) {
      try {
        const open = (await import('open')).default;
        await open(`http://localhost:${port}`);
      } catch { /* noop */ }
    }

    // Signal handling
    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
  }

  // ─── WebSocket Handler ───

  private handleWsConnection(ws: WebSocket): void {
    // Max client limit to prevent connection storms
    const MAX_WS_CLIENTS = 10;
    if (this.clients.size >= MAX_WS_CLIENTS) {
      // Close oldest connection
      const oldest = this.clients.values().next().value;
      if (oldest) {
        try { (oldest as WebSocket).close(1000, 'Too many connections'); } catch {}
        this.clients.delete(oldest);
      }
    }
    this.clients.add(ws);
    this.registerWsConnection(ws);
    LOG.debug('WS', `Client connected (total: ${this.clients.size})`);

    // Identity only: the dashboard learns which daemon this is and subscribes
    // daemon.metadata (the ONE state lane — its first frame is the snapshot).
    // Runtime terminal snapshots stay pull-based (runtime snapshot / events
    // routes) so standalone does not seed hidden panes with stale buffers.
    if (this.host) {
      ws.send(JSON.stringify(standaloneHelloFrame(this.statusInstanceId)));
    }

    ws.on('message', async (raw) => {
      try {
        const msg: WsMessage = JSON.parse(raw.toString());
        if (msg.type === 'subscribe') {
          await this.handleWsSubscribe(ws, msg as WsMessage & SubscribeRequest);
          return;
        }
        if (msg.type === 'unsubscribe') {
          this.handleWsUnsubscribe(ws, msg as WsMessage & UnsubscribeRequest);
          return;
        }
        if (msg.type === 'command') {
          const envelope = msg.data && typeof msg.data === 'object'
            ? {
                ...msg.data,
                ...((msg as any).commandType ? { commandType: (msg as any).commandType } : {}),
              }
            : (msg as any);
          const { type, payload } = normalizeCommandEnvelope(envelope);
          const requestId = msg.requestId;
          const result = await this.executeCommand(type, payload || {});
          ws.send(JSON.stringify({ type: 'command_result', requestId, data: result }));
        }
      } catch (e: any) {
        const requestId = (() => { try { return JSON.parse(raw.toString()).requestId; } catch { return undefined; } })();
        ws.send(JSON.stringify({ type: 'error', requestId, data: { message: e.message } }));
      }
    });

    ws.on('close', () => {
      this.clients.delete(ws);
      this.releaseWsConnection(ws);
      LOG.debug('WS', `Client disconnected (total: ${this.clients.size})`);
    });

    ws.on('error', () => {
      this.clients.delete(ws);
      this.releaseWsConnection(ws);
    });
  }

  /**
   * One authenticated transcript replica lane. The socket carries raw
   * seqscribe frames only (daemon-core `StandaloneTranscriptLane` wraps it with
   * `webSocketChannel`); it is NOT a dashboard client — no status pushes, no
   * commands, not counted against the `/ws` client cap.
   */
  private handleSeqscribeLaneConnection(ws: WebSocket): void {
    // `ws` is an EventEmitter: an 'error' with no listener would throw and take
    // the daemon down. The lane observes the subsequent 'close' and detaches.
    ws.on('error', () => { /* close follows */ });
    const lane = this.transcriptLane;
    if (!lane) {
      try { ws.close(1013, 'transcript lane unavailable'); } catch { /* noop */ }
      return;
    }
    lane.accept(ws);
  }

  private registerWsConnection(ws: WebSocket): string {
    let id = this.wsConnectionIds.get(ws);
    if (id) return id;
    this.wsConnectionSeq += 1;
    id = `ws_${this.wsConnectionSeq}`;
    this.wsConnectionIds.set(ws, id);
    this.wsByConnectionId.set(id, ws);
    return id;
  }

  /** Dispose registry-owned subscriptions (workspace.git, push topics) for a closed client. */
  private releaseWsConnection(ws: WebSocket): void {
    this.runtimeOutputSubscriptions.delete(ws);
    const id = this.wsConnectionIds.get(ws);
    if (!id) return;
    this.host?.topics.dropConnection(id);
    this.wsByConnectionId.delete(id);
    this.wsConnectionIds.delete(ws);
  }

  private async handleWsSubscribe(ws: WebSocket, msg: SubscribeRequest): Promise<void> {
    if (msg.topic === 'session.runtime_output') {
      const targetSessionId = typeof msg.params?.targetSessionId === 'string' ? msg.params.targetSessionId.trim() : '';
      if (!targetSessionId || !msg.key) return;
      const subs = this.runtimeOutputSubscriptions.get(ws) ?? new Map<string, string>();
      subs.set(msg.key, targetSessionId);
      this.runtimeOutputSubscriptions.set(ws, subs);
      return;
    }
    const topics = this.host?.topics;
    if (topics?.handlesTopic(msg.topic)) {
      // Engine (storage/normalize/throttle/seq/dedup/refresh-concurrency) is
      // core-owned; standalone keeps only the WS sink and the targeted first flush.
      const connectionId = this.registerWsConnection(ws);
      if (!topics.subscribe(connectionId, msg)) return;
      await topics.flushNow(msg.topic, connectionId, msg.key);
    }
  }

  private handleWsUnsubscribe(ws: WebSocket, msg: UnsubscribeRequest): void {
    if (msg.topic === 'session.runtime_output') {
      const subs = this.runtimeOutputSubscriptions.get(ws);
      subs?.delete(msg.key);
      if (subs && subs.size === 0) this.runtimeOutputSubscriptions.delete(ws);
      return;
    }
    const topics = this.host?.topics;
    if (topics?.handlesTopic(msg.topic)) {
      const connectionId = this.wsConnectionIds.get(ws);
      if (connectionId) topics.unsubscribe(connectionId, msg);
    }
  }

  // ─── Core Logic ───

  /**
   * Every standalone command entry (WS, `/api/v1/command`, provider REST).
   * Interaction id, invalidation and the metadata push all ride the host
   * runtime / router now (`command_executed` → `buildTransport().onCommandExecuted`).
   */
  private async executeCommand(type: string, args: any): Promise<any> {
    if (!this.host) {
      return { success: false, error: 'Components not initialized' };
    }
    if (typeof type !== 'string' || !type.trim()) {
      return { success: false, error: 'command type required' };
    }
    return this.host.execute(type, args, 'standalone');
  }

  /** OPEN clients subscribed to this session's terminal output. */
  private *runtimeOutputTargets(sessionId: string): Iterable<WebSocket> {
    for (const [ws, subs] of this.runtimeOutputSubscriptions) {
      for (const target of subs.values()) {
        if (target === sessionId) {
          yield ws;
          break;
        }
      }
    }
  }

  // ─── Network ───

  private getLanIPs(): string[] {
    const interfaces = os.networkInterfaces();
    const ips: string[] = [];
    for (const iface of Object.values(interfaces)) {
      if (!iface) continue;
      for (const info of iface) {
        if (info.family === 'IPv4' && !info.internal) {
          ips.push(info.address);
        }
      }
    }
    return ips;
  }


  // ─── Lifecycle ───

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    console.log('\n   Shutting down...');

    // Close WS clients
    for (const ws of this.clients) {
      try { ws.close(); } catch { /* noop */ }
    }
    this.clients.clear();
    // Replica lanes detach BEFORE the node closes (runtime.shutdown below).
    this.transcriptLane?.close();
    this.transcriptLane = null;
    this.runtimeOutputSubscriptions.clear();

    // Close WSS
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    // IPC server (19222)
    if (this.ipcServer) {
      try { await this.ipcServer.close(); } catch { /* best-effort */ }
      this.ipcServer = null;
    }

    try { this.devServer?.stop(); } catch { /* noop */ }
    this.devServer = null;
    for (const off of this.offBus.splice(0)) {
      try { off(); } catch { /* noop */ }
    }
    this.host?.stop();
    this.host = null;

    // Shutdown core components (reverse stage order, ends with bus.close + VACUUM)
    if (this.runtime) {
      await this.runtime.shutdown();
      this.runtime = null;
    }
    // Detach from the session host WITHOUT killing it (hosted CLIs outlive us).
    try { await this.sessionHost?.stop(); } catch { /* noop */ }
    this.sessionHost = null;

    // HTTP server
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }

    console.log('   ✓ ADHDev Standalone stopped.\n');
    process.exit(0);
  }
}

// ─── CLI ───

async function main(): Promise<void> {
  // ADHDEV_CONFIG_DIR is already pinned (and the legacy-ledger migration hint
  // already emitted) by the bootstrap-config-dir import at the top of this
  // file, before any config-dir-reading module evaluated.
  const helperMode = await maybeRunDaemonUpgradeHelperFromEnv();
  if (helperMode) {
    return;
  }

  const args = process.argv.slice(2);
  const primaryCommand = args[0] || '';
  if (primaryCommand === 'attach') {
    const target = args[1];
    if (!target) {
      console.error('Usage: adhdev-standalone attach <sessionId> [--read-only|--takeover]');
      process.exit(1);
    }
    const readOnly = args.includes('--read-only');
    const takeover = args.includes('--takeover');
    const exitCode = await proxySessionHostAttach(target, { readOnly, takeover });
    process.exit(exitCode);
  }
  if (primaryCommand === 'list' || primaryCommand === 'runtimes') {
    const showAll = args.includes('--all');
    const exitCode = await proxySessionHostList(showAll);
    process.exit(exitCode);
  }
  if (primaryCommand === 'quota') {
    const exitCode = await runQuotaCommand(args.slice(1));
    process.exit(exitCode);
  }
  // Canonical CLI contract (see standalone-cli-args.ts): --host/-H takes an
  // explicit, validated address and the server binds exactly that. A missing
  // or invalid value fails visibly here — the server never starts on a bind
  // the operator did not ask for. Public binding stays an explicit opt-in
  // (--host 0.0.0.0 / --host ::) with the unauthenticated-public warning.
  let parsed: ReturnType<typeof parseStandaloneCliArgs>;
  try {
    parsed = parseStandaloneCliArgs(args);
  } catch (error) {
    if (error instanceof StandaloneCliArgsError) {
      console.error(`\n✗ ${error.message}`);
      console.error('  Run with --help to see usage.\n');
      process.exit(1);
    }
    throw error;
  }
  if (parsed.showHelp) {
    console.log(STANDALONE_HELP_TEXT);
    process.exit(0);
  }
  const options: StandaloneOptions = parsed.options;
  const hostExplicit = parsed.hostExplicit;

  // Debug runtime (log level + structured trace store), the same resolver the
  // cloud daemon applies: `--log-level` > ADHDEV_LOG_LEVEL > (`--dev` ⇒ debug)
  // > info. Before this the standalone never called `setLogLevel`, so `--dev`
  // could not surface DEBUG-only proof lines (`[bus] …`, TurnEvidencePort).
  const envLogLevel = process.env.ADHDEV_LOG_LEVEL?.trim();
  const debugRuntime = resolveDebugRuntimeConfig({
    dev: options.dev,
    logLevel: parsed.options.logLevel ?? (envLogLevel ? normalizeStandaloneLogLevel(envLogLevel, 'ADHDEV_LOG_LEVEL') : undefined),
  });
  setDebugRuntimeConfig(debugRuntime);
  configureDebugTraceStore();
  setLogLevel(debugRuntime.logLevel);
  // Terminal echo defaults to 'warn' for the same reason as the cloud daemon
  // (routine INFO telemetry should not flood an interactive foreground
  // process); an explicit --log-level/--dev ask restores it on the console.
  const wantsVerboseConsole = Boolean(parsed.options.logLevel || envLogLevel || options.dev);
  setConsoleLogLevel(wantsVerboseConsole ? debugRuntime.logLevel : 'warn');

  // Try to find web-standalone build
  if (!hostExplicit) {
    options.host = loadStandaloneBindHostPreference();
  }

  if (!options.publicDir) {
    const candidates = [
      path.join(__dirname, '../../web-standalone/dist'),
      path.join(__dirname, '../public'),
      path.join(process.cwd(), 'public'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(path.join(candidate, 'index.html'))) {
        options.publicDir = candidate;
        break;
      }
    }
  }

  const server = new StandaloneServer();
  await server.start(options);
  if (!hostExplicit) {
    saveStandaloneBindHostPreference(options.host === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1');
  }

  // Keep process alive
  await new Promise<void>(() => {});
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
