/**
 * daemon-standalone — Embedded HTTP/WS server for local dashboard
 *
 * Standalone-only server:
 * 1. DaemonCore init (IDE detection, CDP connection, Provider loading)
 * 2. HTTP REST API — /api/v1/status, /api/v1/command, /api/v1/ides, /api/v1/clis, /api/v1/agents
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
  DevServer,
  LOG,
  initDaemonComponents,
  shutdownDaemonComponents,
  loadConfig,
  buildStatusSnapshot,
  forwardAgentStreamsToIdeInstance,
  type DaemonComponents,
  type StatusResponse,
  type AgentEntry,
} from '@adhdev/daemon-core';

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
  private running = false;
  private components: DaemonComponents | null = null;
  private devServer: DevServer | null = null;

  async start(options: StandaloneOptions = {}): Promise<void> {
    const port = options.port || DEFAULT_PORT;
    const host = options.host || '127.0.0.1';

    // Auth token setup (opt-in only)
    this.authToken = options.token || process.env.ADHDEV_TOKEN || null;

    // Initialize all core components via daemon-core bootstrapper
    this.components = await initDaemonComponents({
      cliManagerDeps: {
        getServerConn: () => null,
        getP2p: () => ({
          broadcastPtyOutput: (key: string, data: string) => {
            if (this.clients.size === 0) return;
            const msg = JSON.stringify({ type: 'pty_output', cliId: key, data });
            for (const client of this.clients) {
              if (client.readyState === 1) { // OPEN
                client.send(msg);
              }
            }
          }
        }),
        onStatusChange: () => this.broadcastStatus(),
        removeAgentTracking: () => {},
      },
      onStatusChange: () => this.broadcastStatus(),
      onStreamsUpdated: (ideType: string, streams: any[]) => {
        if (!this.components) return;
        forwardAgentStreamsToIdeInstance(this.components.instanceManager, ideType, streams);
        this.broadcastStatus();
      },
      tickIntervalMs: 3000,
      cdpScanIntervalMs: 15_000,
    });

    // DevServer (optional)
    if (options.dev) {
      this.devServer = new DevServer({
        providerLoader: this.components.providerLoader,
        cdpManagers: this.components.cdpManagers,
        instanceManager: this.components.instanceManager,
        cliManager: this.components.cliManager,
        logFn: (msg: string) => console.log(msg),
      });
      await this.devServer.start();
      
      // Auto-reload providers on file changes in --dev mode
      this.components.providerLoader.watch();
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
      this.broadcastStatus();
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

    if (apiPath === '/status' && method === 'GET') {
      const status = this.getStatus(getSharedSnapshot());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
      return;
    }

    if (apiPath === '/ides' && method === 'GET') {
      const ides = getSharedSnapshot().managedIdes;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ides }));
      return;
    }

    if (apiPath === '/clis' && method === 'GET') {
      const clis = getSharedSnapshot().managedClis;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ clis }));
      return;
    }

    if (apiPath === '/agents' && method === 'GET') {
      const ides = getSharedSnapshot().managedIdes;
      const agents: AgentEntry[] = [];
      for (const ide of ides) {
        // IDE native chat
        if (ide.activeChat) {
          agents.push({
            ideId: ide.instanceId,
            type: ide.ideType,
            name: ide.ideType,
            status: ide.activeChat.status || 'idle',
            source: 'native',
          });
        }
        // Extension agent streams
        for (const stream of (ide.agentStreams || [])) {
          agents.push({
            ideId: ide.instanceId,
            type: stream.agentType,
            name: stream.agentName,
            status: stream.status || 'idle',
            source: 'extension',
          });
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ agents }));
      return;
    }

    if (apiPath === '/command' && method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const { type, payload, target } = JSON.parse(body);
          const args = { ...payload, _targetInstance: target };
          const result = await this.executeCommand(type, args);
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

    ws.on('message', async (raw) => {
      try {
        const msg: WsMessage = JSON.parse(raw.toString());
        if (msg.type === 'command' && msg.data) {
          const { type, payload, target } = msg.data;
          const requestId = msg.requestId;
          const args = { ...payload, _targetInstance: target };
          const result = await this.executeCommand(type, args);
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
    if (type.startsWith('workspace_')) this.broadcastStatus();
    return result;
  }

  private broadcastStatus(): void {
    if (this.clients.size === 0) return;
    const status = this.getStatus();
    const msg = JSON.stringify({ type: 'status', data: status });
    const cdpCount = [...this.components!.cdpManagers.values()].filter(m => m.isConnected).length;
    LOG.debug('Broadcast', `status → ${this.clients.size} client(s), ${(status as any).ides?.length || 0} IDE(s), ${cdpCount} CDP`);
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
  const args = process.argv.slice(2);
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

Options:
  --port, -p <port>   Port to run the standalone server on (default: 3847)
  --host, -H          Allow external network connections (binds to 0.0.0.0)
  --token <token>     Set an authentication token for the dashboard UI
  --dev               Enable DevConsole to debug and test providers
  --public <path>     Custom path to the web dashboard distribution
  --no-open           Do not automatically open the browser on startup
  --help, -h          Show this help message
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
