/**
 * daemon-standalone — Embedded HTTP/WS server for local dashboard
 *
 * Standalone-only server:
 * 1. DaemonCore init (IDE detection, CDP connection, Provider loading)
 * 2. HTTP REST API — /api/v1/status, /api/v1/command
 * 3. WebSocket — ws://localhost:3847/ws (real-time status broadcast + command execution)
 * 4. Static file serving — web-standalone build output
 *
 * Usage:
 *   npx @adhdev/daemon-standalone
 *   npx @adhdev/daemon-standalone --port 4000
 */

import { createServer, type IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

import {
  LOG,
  initDaemonComponents,
  startDaemonDevSupport,
  shutdownDaemonComponents,
  loadConfig,
  buildStatusSnapshot,
  forwardAgentStreamsToIdeInstance,
  SessionHostPtyTransportFactory,
  maybeRunDaemonUpgradeHelperFromEnv,
  type DaemonComponents,
  type HostedCliRuntimeDescriptor,
  type StatusResponse,
  type AgentEntry,
} from '@adhdev/daemon-core';
import {
  ensureSessionHostReady,
  listHostedCliRuntimes,
  proxySessionHostAttach,
  proxySessionHostList,
} from './session-host.js';
import { SessionHostClient, type SessionHostEndpoint, type SessionHostEvent } from '@adhdev/session-host-core';
import {
  AdhMuxControlClient,
  getWorkspaceSocketInfo,
  getWorkspaceState,
  requestWorkspaceControl,
  type AdhMuxControlEvent,
} from '@adhdev/terminal-mux-control/api';

// ─── Constants ───
const DEFAULT_PORT = 3847;
const STATUS_INTERVAL = 2000;

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

// ─── Types ───
interface StandaloneOptions {
  port?: number;
  host?: string;
  publicDir?: string;
  open?: boolean;
  token?: string;
  dev?: boolean;
}

interface WsMessage {
  type: string;
  requestId?: string;
  data?: Record<string, any>;
}


// ─── Standalone Server ───

class StandaloneServer {
  private httpServer: ReturnType<typeof createServer> | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private authToken: string | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private lastStatusBroadcastAt = 0;
  private statusBroadcastPending = false;
  private running = false;
  private components: DaemonComponents | null = null;
  private devServer: Awaited<ReturnType<typeof startDaemonDevSupport>> | null = null;
  private sessionHostEndpoint: SessionHostEndpoint | null = null;

  private isRecoverableSessionHostError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes('ECONNREFUSED') ||
      message.includes('ENOENT') ||
      message.includes('Session host socket unavailable')
    );
  }

  private async ensureActiveSessionHostEndpoint(): Promise<SessionHostEndpoint> {
    const endpoint = await ensureSessionHostReady();
    this.sessionHostEndpoint = endpoint;
    return endpoint;
  }

  private async createSessionHostClient(): Promise<SessionHostClient> {
    let endpoint = this.sessionHostEndpoint;
    if (!endpoint) {
      endpoint = await this.ensureActiveSessionHostEndpoint();
    }

    let client = new SessionHostClient({ endpoint });
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      if (!this.isRecoverableSessionHostError(error)) {
        throw error;
      }
    }

    endpoint = await this.ensureActiveSessionHostEndpoint();
    client = new SessionHostClient({ endpoint });
    await client.connect();
    return client;
  }

  private getCliPresentationMode(sessionId: string): 'terminal' | 'chat' | null {
    if (!sessionId || !this.components) return null;
    const instance = this.components.instanceManager.getInstance(sessionId) as any;
    if (instance?.category !== 'cli') return null;
    const mode = instance.getPresentationMode?.();
    return mode === 'chat' || mode === 'terminal' ? mode : null;
  }

  private isTerminalCliSession(sessionId: string): boolean {
    return this.getCliPresentationMode(sessionId) === 'terminal';
  }

  async start(options: StandaloneOptions = {}): Promise<void> {
    const port = options.port || DEFAULT_PORT;
    const host = options.host || '127.0.0.1';
    const sessionHostEndpoint = await ensureSessionHostReady();
    this.sessionHostEndpoint = sessionHostEndpoint;

    // Auth token setup (opt-in only)
    this.authToken = options.token || process.env.ADHDEV_TOKEN || null;

    // Initialize all core components via daemon-core bootstrapper
    this.components = await initDaemonComponents({
      cliManagerDeps: {
        getServerConn: () => null,
        getP2p: () => ({
          broadcastPtyOutput: (key: string, data: string) => {
            if (this.clients.size === 0 || !this.isTerminalCliSession(key)) return;
            const msg = JSON.stringify({ type: 'pty_output', sessionId: key, data });
            for (const client of this.clients) {
              if (client.readyState === 1) { // OPEN
                client.send(msg);
              }
            }
          }
        }),
        onStatusChange: () => this.scheduleBroadcastStatus(),
        removeAgentTracking: () => {},
        createPtyTransportFactory: ({ runtimeId, providerType, workspace, cliArgs, attachExisting }) => (
          new SessionHostPtyTransportFactory({
            endpoint: sessionHostEndpoint,
            clientId: `daemon-${process.pid}`,
            runtimeId,
            providerType,
            workspace,
            attachExisting,
            meta: {
              cliArgs: cliArgs || [],
              managedBy: 'adhdev-standalone',
            },
          })
        ),
        listHostedCliRuntimes: async (): Promise<HostedCliRuntimeDescriptor[]> => (
          listHostedCliRuntimes(sessionHostEndpoint)
        ),
      },
      onStatusChange: () => this.scheduleBroadcastStatus(),
      onStreamsUpdated: (ideType: string, streams: any[]) => {
        if (!this.components) return;
        forwardAgentStreamsToIdeInstance(this.components.instanceManager, ideType, streams);
        this.scheduleBroadcastStatus();
      },
      tickIntervalMs: 3000,
      cdpScanIntervalMs: 15_000,
    });

    await this.components.cliManager.restoreHostedSessions();

    // DevServer (optional)
    if (options.dev) {
      this.devServer = await startDaemonDevSupport({
        components: this.components,
        logFn: (msg: string) => console.log(msg),
      });
    }

    // 5. HTTP Server
    this.httpServer = createServer((req, res) => {
      this.handleHttp(req, res, options.publicDir);
    });

    // 6. WebSocket Server (upgrade)
    this.wss = new WebSocketServer({ noServer: true });
    this.httpServer.on('upgrade', (req, socket, head) => {
      const wsUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (wsUrl.pathname === '/ws') {
        // Token auth for WS
        if (this.authToken) {
          const urlToken = wsUrl.searchParams.get('token');
          if (urlToken !== this.authToken) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
        }
        this.wss!.handleUpgrade(req, socket, head, (ws) => {
          this.handleWsConnection(ws);
        });
      } else {
        socket.destroy();
      }
    });

    // 7. Status broadcast timer
    this.statusTimer = setInterval(() => {
      this.scheduleBroadcastStatus();
    }, STATUS_INTERVAL);

    // 8. Start listening
    this.running = true;
    await new Promise<void>((resolve) => {
      this.httpServer!.listen(port, host, () => {
        resolve();
      });
    });

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
    if (this.authToken) {
      console.log(`   🔑 Token: ${this.authToken}`);
    }
    console.log('');

    const cdpCount = [...this.components.cdpManagers.values()].filter(m => m.isConnected).length;
    console.log(`   CDP: ${cdpCount > 0 ? `✅ ${cdpCount} connected` : '❌ none'}`);
    console.log(`   Providers: ${this.components.providerLoader.getAll().length} loaded`);
    if (options.dev) {
      console.log(`   🛠️  DevConsole: http://127.0.0.1:19280`);
    }
    console.log('');
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

  // ─── HTTP Handler ───

  private handleHttp(
    req: IncomingMessage,
    res: import('http').ServerResponse,
    publicDir?: string
  ): void {
    const url = req.url || '/';
    const method = req.method || 'GET';
    let sharedSnapshotCache: ReturnType<StandaloneServer['buildSharedSnapshot']> | null = null;
    const getSharedSnapshot = () => {
      if (!sharedSnapshotCache) sharedSnapshotCache = this.buildSharedSnapshot();
      return sharedSnapshotCache;
    };

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Token auth for API routes
    if (this.authToken && url.startsWith('/api/')) {
      const authHeader = req.headers['authorization'];
      const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
      const queryToken = new URL(url, `http://${req.headers.host || 'localhost'}`).searchParams.get('token');
      if (bearerToken !== this.authToken && queryToken !== this.authToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized. Provide token via Authorization header or ?token= query.' }));
        return;
      }
    }

    // ─── API Routes (v1) ───
    const apiPath = url.startsWith('/api/v1/') ? url.slice(7) : null; // /api/v1/status → /status
    const parsedUrl = new URL(url, `http://${req.headers.host || 'localhost'}`);

    if (apiPath === '/status' && method === 'GET') {
      const status = this.getStatus(getSharedSnapshot());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
      return;
    }

    if (apiPath?.startsWith('/mux/')) {
      const muxParts = parsedUrl.pathname.replace(/^\/api\/v1\/mux\//, '').split('/').filter(Boolean);
      const [workspaceSegment, action] = muxParts;
      const workspaceName = workspaceSegment ? decodeURIComponent(workspaceSegment) : '';

      if (!workspaceName || !action) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid mux route' }));
        return;
      }

      if (action === 'state' && method === 'GET') {
        void (async () => {
          const result = await getWorkspaceState(workspaceName);
          if (!result?.success || !result.result) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: result?.error || 'Workspace not available' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result.result));
        })().catch((error: any) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error?.message || String(error) }));
        });
        return;
      }

      if (action === 'socket-info' && method === 'GET') {
        void (async () => {
          const result = await getWorkspaceSocketInfo(workspaceName);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        })().catch((error: any) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error?.message || String(error) }));
        });
        return;
      }

      if (action === 'control' && method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          try {
            const { type, payload } = JSON.parse(body || '{}');
            const result = await requestWorkspaceControl(workspaceName, { type, payload });
            if (!result?.success) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: result?.error || 'Workspace control unavailable' }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result.result ?? { success: true }));
          } catch (error: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error?.message || String(error) }));
          }
        });
        return;
      }

      if (action === 'events' && method === 'GET') {
        void this.handleMuxEvents(req, res, workspaceName);
        return;
      }
    }

    if (apiPath?.startsWith('/runtime/')) {
      const runtimeParts = parsedUrl.pathname.replace(/^\/api\/v1\/runtime\//, '').split('/').filter(Boolean);
      const [sessionSegment, action] = runtimeParts;
      const sessionId = sessionSegment ? decodeURIComponent(sessionSegment) : '';

      if (!sessionId || !action) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid runtime route' }));
        return;
      }

      if (action === 'snapshot' && method === 'GET') {
        if (!this.isTerminalCliSession(sessionId)) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'CLI session is not in terminal mode', code: 'CLI_VIEW_MODE_NOT_TERMINAL' }));
          return;
        }
        void (async () => {
          const client = await this.createSessionHostClient();
          try {
            const snapshot = await client.request<{ seq: number; text: string; truncated: boolean }>({
              type: 'get_snapshot',
              payload: { sessionId },
            });
            if (!snapshot.success || !snapshot.result) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: snapshot.error || 'Runtime snapshot unavailable' }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ sessionId, ...snapshot.result }));
          } finally {
            await client.close().catch(() => {});
          }
        })().catch((error: any) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error?.message || String(error) }));
        });
        return;
      }

      if (action === 'events' && method === 'GET') {
        void this.handleRuntimeEvents(req, res, sessionId);
        return;
      }

    }

    if (apiPath === '/command' && method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const { type, payload } = JSON.parse(body);
          const result = await this.executeCommand(type, payload || {});
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
      return;
    }

    // ─── Static Files ───
    if (publicDir) {
      const filePath = url === '/' ? '/index.html' : url;
      const fullPath = path.join(publicDir, filePath);
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        const ext = path.extname(fullPath);
        const mimeTypes: Record<string, string> = {
          '.html': 'text/html',
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.json': 'application/json',
          '.png': 'image/png',
          '.svg': 'image/svg+xml',
          '.ico': 'image/x-icon',
          '.woff2': 'font/woff2',
        };
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
        fs.createReadStream(fullPath).pipe(res);
        return;
      }
      // SPA fallback → index.html
      const indexPath = path.join(publicDir, 'index.html');
      if (fs.existsSync(indexPath) && !url.startsWith('/api/')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        fs.createReadStream(indexPath).pipe(res);
        return;
      }
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private async handleMuxEvents(
    req: IncomingMessage,
    res: import('http').ServerResponse,
    workspaceName: string,
  ): Promise<void> {
    const socketInfo = await getWorkspaceSocketInfo(workspaceName);
    if (!socketInfo.live) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Workspace control socket unavailable' }));
      return;
    }

    const client = new AdhMuxControlClient(workspaceName);
    await client.connect();

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const writeEvent = (event: AdhMuxControlEvent) => {
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const initial = await client.request<{ workspaceName: string; workspace: unknown; panes: unknown[] }>({
      type: 'workspace_state',
    });
    if (initial.success && initial.result) {
      writeEvent({
        type: 'workspace_update',
        payload: initial.result as Record<string, unknown>,
      });
    }

    const unsubscribe = client.onEvent(writeEvent);
    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, 15000);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
      void client.close().catch(() => {});
    };

    req.on('close', cleanup);
    req.on('aborted', cleanup);
  }

  private async handleRuntimeEvents(
    req: IncomingMessage,
    res: import('http').ServerResponse,
    sessionId: string,
  ): Promise<void> {
    if (!this.isTerminalCliSession(sessionId)) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'CLI session is not in terminal mode', code: 'CLI_VIEW_MODE_NOT_TERMINAL' }));
      return;
    }

    const client = await this.createSessionHostClient();

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const snapshot = await client.request<{ seq: number; text: string; truncated: boolean }>({
      type: 'get_snapshot',
      payload: { sessionId },
    });
    if (snapshot.success && snapshot.result) {
      res.write('event: runtime_snapshot\n');
      res.write(`data: ${JSON.stringify({ sessionId, ...snapshot.result })}\n\n`);
    }

    const writeEvent = (event: SessionHostEvent) => {
      if (event.sessionId !== sessionId) return;
      if (!this.isTerminalCliSession(sessionId)) return;
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const unsubscribe = client.onEvent(writeEvent);
    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, 15000);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
      void client.close().catch(() => {});
    };

    req.on('close', cleanup);
    req.on('aborted', cleanup);
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
    console.log(`[WS] Client connected (total: ${this.clients.size})`);

    // Send initial status immediately
    const status = this.getStatus();
    ws.send(JSON.stringify({ type: 'status', data: status }));
    void this.pushWsRuntimeSnapshots(ws);

    ws.on('message', async (raw) => {
      try {
        const msg: WsMessage = JSON.parse(raw.toString());
        if (msg.type === 'command' && msg.data) {
          const { type, payload } = msg.data;
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
      console.log(`[WS] Client disconnected (total: ${this.clients.size})`);
    });

    ws.on('error', () => {
      this.clients.delete(ws);
    });
  }

  // ─── Core Logic ───

  private buildSharedSnapshot() {
    const cfgSnap = loadConfig();
    const machineId = cfgSnap.machineId || 'mach_unknown';
    const allStates = this.components!.instanceManager.collectAllStates();

    return buildStatusSnapshot({
      allStates,
      cdpManagers: this.components!.cdpManagers as Map<string, unknown>,
      providerLoader: this.components!.providerLoader,
      detectedIdes: this.components!.detectedIdes.value,
      instanceId: `standalone_${machineId}`,
      version: pkgVersion,
      daemonMode: false,
    });
  }

  private async pushWsRuntimeSnapshots(ws: WebSocket): Promise<void> {
    if (!this.components || ws.readyState !== WebSocket.OPEN) return;

    const client = await this.createSessionHostClient();
    try {
      const states = this.components.instanceManager.collectAllStates();
      for (const state of states as any[]) {
        const sessionId = typeof state?.instanceId === 'string' ? state.instanceId : '';
        if (!sessionId || state?.category !== 'cli' || state?.mode !== 'terminal') continue;

        const snapshot = await client.request<{ seq: number; text: string; truncated: boolean }>({
          type: 'get_snapshot',
          payload: { sessionId },
        });
        if (!snapshot.success || !snapshot.result || ws.readyState !== WebSocket.OPEN) continue;
        ws.send(JSON.stringify({
          type: 'runtime_snapshot',
          sessionId,
          ...snapshot.result,
        }));
      }
    } catch {
      // noop
    } finally {
      await client.close().catch(() => {});
    }
  }

  private getStatus(snapshot: ReturnType<StandaloneServer['buildSharedSnapshot']> = this.buildSharedSnapshot()): StatusResponse {
    const cfgSnap = loadConfig();

    return {
      ...snapshot,
      id: snapshot.instanceId,
      daemonMode: false,
      type: 'standalone',
      platform: snapshot.machine.platform,
      hostname: snapshot.machine.hostname,
      userName: cfgSnap.userName || undefined,
      system: {
        cpus: snapshot.machine.cpus,
        totalMem: snapshot.machine.totalMem,
        freeMem: snapshot.machine.freeMem,
        availableMem: snapshot.machine.availableMem,
        loadavg: snapshot.machine.loadavg,
        uptime: snapshot.machine.uptime,
        arch: snapshot.machine.arch,
      },
    };
  }

  private async executeCommand(type: string, args: any): Promise<any> {
    if (!this.components) {
      return { success: false, error: 'Components not initialized' };
    }
    const result = await this.components.router.execute(type, args, 'standalone');
    if (type.startsWith('workspace_')) this.scheduleBroadcastStatus();
    return result;
  }

  private scheduleBroadcastStatus(): void {
    const now = Date.now();
    const elapsed = now - this.lastStatusBroadcastAt;
    const minInterval = 500;
    if (elapsed >= minInterval) {
      this.broadcastStatus();
      return;
    }
    if (this.statusBroadcastPending) return;
    this.statusBroadcastPending = true;
    setTimeout(() => {
      this.statusBroadcastPending = false;
      this.broadcastStatus();
    }, minInterval - elapsed);
  }

  private broadcastStatus(): void {
    if (this.clients.size === 0) return;
    this.lastStatusBroadcastAt = Date.now();
    const status = this.getStatus();
    const msg = JSON.stringify({ type: 'status', data: status });
    const cdpCount = [...this.components!.cdpManagers.values()].filter(m => m.isConnected).length;
    LOG.debug('Broadcast', `status → ${this.clients.size} client(s), ${(status as any).sessions?.length || 0} session(s), ${cdpCount} CDP`);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
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

    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }

    // Close WS clients
    for (const ws of this.clients) {
      try { ws.close(); } catch { /* noop */ }
    }
    this.clients.clear();

    // Close WSS
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    // Shutdown core components
    if (this.components) {
      await shutdownDaemonComponents(this.components);
    }

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
  const helperMode = await maybeRunDaemonUpgradeHelperFromEnv();
  if (helperMode) {
    return;
  }

  const args = process.argv.slice(2);
  const primaryCommand = args[0] || '';
  if (primaryCommand === 'attach') {
    const target = args[1];
    if (!target) {
      console.error('Usage: adhdev attach <sessionId> [--read-only|--takeover]');
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
  const options: StandaloneOptions = {};

  // Parse simple args
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) {
      options.port = parseInt(args[i + 1]);
      i++;
    }
    if (args[i] === '--host' || args[i] === '-H') {
      options.host = '0.0.0.0';
    }
    if (args[i] === '--public' && args[i + 1]) {
      options.publicDir = args[i + 1];
      i++;
    }
    if (args[i] === '--no-open') {
      options.open = false;
    }
    if (args[i] === '--dev') {
      (options as any).dev = true;
    }
    if (args[i] === '--token' && args[i + 1]) {
      options.token = args[i + 1];
      i++;
    }
    if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage: adhdev-standalone [options]
       adhdev-standalone list [--all]
       adhdev-standalone attach <sessionId> [--read-only|--takeover]

Options:
  --port, -p <port>   Port to run the standalone server on (default: 3847)
  --host, -H          Allow external network connections (binds to 0.0.0.0)
  --token <token>     Set an authentication token for the dashboard UI
  --dev               Enable DevConsole to debug and test providers
  --public <path>     Custom path to the web dashboard distribution
  --no-open           Do not automatically open the browser on startup
  --help, -h          Show this help message

Runtime commands:
  list, runtimes      Show hosted CLI runtimes
  attach              Attach local terminal to a runtime
  open                Open a local terminal window running adhmux for a runtime
`);
      process.exit(0);
    }
  }

  // Try to find web-standalone build
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

  // Keep process alive
  await new Promise<void>(() => {});
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
