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
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

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
  type CliTransportFactoryParams,
  type StatusResponse,
  type StandaloneWsStatusPayload,
  type AgentEntry,
  type SessionChatTailSubscriptionParams,
  type SessionChatTailUpdate,
  type MachineRuntimeSubscriptionParams,
  type MachineRuntimeUpdate,
  type SessionHostDiagnosticsSnapshot,
  type SessionHostDiagnosticsSubscriptionParams,
  type SessionHostDiagnosticsUpdate,
  type SessionModalSubscriptionParams,
  type SessionModalUpdate,
  type DaemonMetadataSubscriptionParams,
  type DaemonMetadataUpdate,
  type ProviderState,
  type SubscribeRequest,
  type TopicUpdateEnvelope,
  type UnsubscribeRequest,
  buildMachineInfo,
  prepareSessionChatTailUpdate,
  prepareSessionModalUpdate,
  runAsyncBatch,
} from '@adhdev/daemon-core';
import {
  ensureSessionHostReady,
  getStandaloneSessionHostAppName,
  getStandaloneSessionHostAppNameWarning,
  listHostedCliRuntimes,
  proxySessionHostAttach,
  proxySessionHostList,
} from './session-host.js';
import { shouldAutoRestoreHostedSessionsOnStartup } from './startup-restore-policy.js';
import { StandaloneSessionHostControlPlane } from './session-host-control.js';
import { SessionHostClient, type SessionHostEndpoint, type SessionHostEvent } from '@adhdev/session-host-core';
import {
  AdhMuxControlClient,
  getWorkspaceSocketInfo,
  getWorkspaceState,
  requestWorkspaceControl,
  type AdhMuxControlEvent,
} from '@adhdev/terminal-mux-control/api';
import {
  classifyHotChatSessionsForSubscriptionFlush,
} from '@adhdev/daemon-core';

// ─── Constants ───
const DEFAULT_PORT = 3847;
const STATUS_INTERVAL = 2000;
const STANDALONE_AUTH_SESSION_COOKIE = 'adhdev_standalone_session';
const STANDALONE_PASSWORD_CONFIG_FILE = 'standalone-auth.json';
const STANDALONE_BIND_HOST_CONFIG_FILE = 'standalone-network.json';
const STANDALONE_BIND_HOST_DEFAULT = '127.0.0.1';
const PASSWORD_KEYLEN = 64;
const DEFAULT_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

interface StandalonePasswordConfig {
  passwordHash: string;
  passwordSalt: string;
  updatedAt: string;
}

function getStandalonePasswordConfigPath(): string {
  const dir = path.join(os.homedir(), '.adhdev');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return path.join(dir, STANDALONE_PASSWORD_CONFIG_FILE);
}

function getStandaloneConfigJsonPath(): string {
  const dir = path.join(os.homedir(), '.adhdev');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return path.join(dir, STANDALONE_BIND_HOST_CONFIG_FILE);
}

function loadStandaloneBindHostPreference(): '127.0.0.1' | '0.0.0.0' {
  try {
    const configPath = getStandaloneConfigJsonPath();
    if (!fs.existsSync(configPath)) return STANDALONE_BIND_HOST_DEFAULT;
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return parsed?.standaloneBindHost === '0.0.0.0' ? '0.0.0.0' : STANDALONE_BIND_HOST_DEFAULT;
  } catch {
    return STANDALONE_BIND_HOST_DEFAULT;
  }
}

function saveStandaloneBindHostPreference(bindHost: '127.0.0.1' | '0.0.0.0'): '127.0.0.1' | '0.0.0.0' {
  const configPath = getStandaloneConfigJsonPath();
  let parsed: Record<string, unknown> = {};
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      const next = JSON.parse(raw);
      if (next && typeof next === 'object' && !Array.isArray(next)) parsed = next as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }
  parsed.standaloneBindHost = bindHost;
  fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(configPath, 0o600); } catch {}
  return bindHost;
}

function createPasswordRecord(password: string, salt = randomBytes(16).toString('hex')): StandalonePasswordConfig {
  return {
    passwordHash: scryptSync(`${password || ''}`, salt, PASSWORD_KEYLEN).toString('hex'),
    passwordSalt: salt,
    updatedAt: new Date().toISOString(),
  };
}

function verifyPassword(password: string, config: StandalonePasswordConfig | null | undefined): boolean {
  if (!config?.passwordHash || !config.passwordSalt) return false;
  const actual = Buffer.from(scryptSync(`${password || ''}`, config.passwordSalt, PASSWORD_KEYLEN).toString('hex'), 'utf8');
  const expected = Buffer.from(config.passwordHash, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function loadStandalonePasswordConfig(filePath = getStandalonePasswordConfigPath()): StandalonePasswordConfig | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.passwordHash !== 'string' || typeof parsed.passwordSalt !== 'string') return null;
    return {
      passwordHash: parsed.passwordHash,
      passwordSalt: parsed.passwordSalt,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

function saveStandalonePasswordConfig(filePath: string, config: StandalonePasswordConfig): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

function clearStandalonePasswordConfig(filePath = getStandalonePasswordConfigPath()): void {
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
  }
}

function shouldWarnForPublicUnauthenticatedHost(input: { host: string; hasTokenAuth: boolean; hasPasswordAuth: boolean }): boolean {
  return input.host === '0.0.0.0' && !input.hasTokenAuth && !input.hasPasswordAuth;
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  return Object.fromEntries(
    cookieHeader.split(';').map(part => part.trim()).filter(Boolean).map(part => {
      const eq = part.indexOf('=');
      if (eq === -1) return [part, ''];
      return [part.slice(0, eq), decodeURIComponent(part.slice(eq + 1))];
    })
  );
}

function buildSessionCookie(sessionId: string, secure: boolean, maxAgeMs = DEFAULT_SESSION_TTL_MS): string {
  const parts = [
    `${STANDALONE_AUTH_SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function buildClearedSessionCookie(secure: boolean): string {
  return buildSessionCookie('', secure, 0);
}

class StandaloneSessionStore {
  private sessions = new Map<string, number>();

  create(ttlMs = DEFAULT_SESSION_TTL_MS): string {
    const id = randomBytes(24).toString('hex');
    this.sessions.set(id, Date.now() + ttlMs);
    return id;
  }

  has(sessionId: string | null | undefined): boolean {
    if (!sessionId) return false;
    const expiresAt = this.sessions.get(sessionId);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      this.sessions.delete(sessionId);
      return false;
    }
    return true;
  }

  revoke(sessionId: string | null | undefined): void {
    if (!sessionId) return;
    this.sessions.delete(sessionId);
  }

  clear(): void {
    this.sessions.clear();
  }
}

function isStandaloneRequestAuthenticated(input: {
  configuredToken: string | null;
  passwordConfig: StandalonePasswordConfig | null;
  bearerToken: string | null;
  queryToken: string | null;
  cookieHeader?: string;
  sessionStore: StandaloneSessionStore;
}): boolean {
  const hasTokenAuth = !!input.configuredToken;
  const hasPasswordAuth = !!input.passwordConfig;
  if (!hasTokenAuth && !hasPasswordAuth) return true;
  if (hasTokenAuth && (input.bearerToken === input.configuredToken || input.queryToken === input.configuredToken)) {
    return true;
  }
  if (hasPasswordAuth) {
    const cookies = parseCookies(input.cookieHeader);
    return input.sessionStore.has(cookies[STANDALONE_AUTH_SESSION_COOKIE]);
  }
  return false;
}

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

interface ChatTailSubscriptionState {
  request: SubscribeRequest & { topic: 'session.chat_tail'; params: SessionChatTailSubscriptionParams };
  seq: number;
  cursor: {
    knownMessageCount: number;
    lastMessageSignature: string;
    tailLimit: number;
  };
  lastDeliveredSignature: string;
}

interface MachineRuntimeSubscriptionState {
  request: SubscribeRequest & { topic: 'machine.runtime'; params: MachineRuntimeSubscriptionParams };
  seq: number;
  lastSentAt: number;
}

interface SessionHostDiagnosticsSubscriptionState {
  request: SubscribeRequest & { topic: 'session_host.diagnostics'; params: SessionHostDiagnosticsSubscriptionParams };
  seq: number;
  lastSentAt: number;
}

interface SessionModalSubscriptionState {
  request: SubscribeRequest & { topic: 'session.modal'; params: SessionModalSubscriptionParams };
  seq: number;
  lastSentAt: number;
  lastDeliveredSignature: string;
}

interface DaemonMetadataSubscriptionState {
  request: SubscribeRequest & { topic: 'daemon.metadata'; params: DaemonMetadataSubscriptionParams };
  seq: number;
  lastSentAt: number;
}

const SESSION_TARGET_COMMANDS = new Set([
  'send_chat',
  'read_chat',
  'chat_history',
  'resolve_action',
  'set_cli_view_mode',
  'stop_cli',
  'restart_session',
  'agent_command',
]);


// ─── Standalone Server ───

class StandaloneServer {
  private httpServer: ReturnType<typeof createServer> | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private wsSubscriptions = new Map<WebSocket, Map<string, ChatTailSubscriptionState>>();
  private wsMachineRuntimeSubscriptions = new Map<WebSocket, Map<string, MachineRuntimeSubscriptionState>>();
  private wsSessionHostDiagnosticsSubscriptions = new Map<WebSocket, Map<string, SessionHostDiagnosticsSubscriptionState>>();
  private wsSessionModalSubscriptions = new Map<WebSocket, Map<string, SessionModalSubscriptionState>>();
  private wsDaemonMetadataSubscriptions = new Map<WebSocket, Map<string, DaemonMetadataSubscriptionState>>();
  private authToken: string | null = null;
  private passwordConfigPath = getStandalonePasswordConfigPath();
  private passwordConfig: StandalonePasswordConfig | null = null;
  private authSessions = new StandaloneSessionStore();
  private listenHost = '127.0.0.1';
  private statusTimer: NodeJS.Timeout | null = null;
  private lastStatusBroadcastAt = 0;
  private statusBroadcastPending = false;
  private lastWsStatusSignature: string | null = null;
  private wsChatFlushInFlight = false;
  private pendingWsChatFlush: { targetWs?: WebSocket; onlyActive: boolean } | null = null;
  private hotWsChatSessionIds = new Set<string>();
  private running = false;
  private components: DaemonComponents | null = null;
  private devServer: Awaited<ReturnType<typeof startDaemonDevSupport>> | null = null;
  private sessionHostEndpoint: SessionHostEndpoint | null = null;
  private sessionHostControl: StandaloneSessionHostControlPlane | null = null;

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

  private isCliSession(sessionId: string): boolean {
    const mode = this.getCliPresentationMode(sessionId);
    return mode === 'chat' || mode === 'terminal';
  }

  private hasPasswordAuth(): boolean {
    return !!this.passwordConfig;
  }

  private hasAnyAuth(): boolean {
    return !!this.authToken || this.hasPasswordAuth();
  }

  private getCookieSecureFlag(req: IncomingMessage): boolean {
    const forwardedProto = req.headers['x-forwarded-proto'];
    return !!(req.socket as typeof req.socket & { encrypted?: boolean }).encrypted
      || (typeof forwardedProto === 'string' && forwardedProto.toLowerCase().includes('https'));
  }

  private getRequestTokens(req: IncomingMessage, rawUrl: string): { bearerToken: string | null; queryToken: string | null } {
    const authHeader = req.headers['authorization'];
    const bearerToken = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : null;
    const queryToken = new URL(rawUrl, `http://${req.headers.host || 'localhost'}`).searchParams.get('token');
    return { bearerToken, queryToken };
  }

  private isRequestAuthenticated(req: IncomingMessage, rawUrl: string): boolean {
    const { bearerToken, queryToken } = this.getRequestTokens(req, rawUrl);
    return isStandaloneRequestAuthenticated({
      configuredToken: this.authToken,
      passwordConfig: this.passwordConfig,
      bearerToken,
      queryToken,
      cookieHeader: typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined,
      sessionStore: this.authSessions,
    });
  }

  private getRequestSessionId(req: IncomingMessage): string | null {
    const cookies = parseCookies(typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined);
    return cookies.adhdev_standalone_session || null;
  }

  private buildAuthStatus(req: IncomingMessage, rawUrl: string) {
    const required = this.hasAnyAuth();
    return {
      required,
      authenticated: this.isRequestAuthenticated(req, rawUrl),
      hasTokenAuth: !!this.authToken,
      hasPasswordAuth: this.hasPasswordAuth(),
      publicHostWarning: shouldWarnForPublicUnauthenticatedHost({
        host: this.listenHost,
        hasTokenAuth: !!this.authToken,
        hasPasswordAuth: this.hasPasswordAuth(),
      }),
      boundHost: this.listenHost,
    };
  }

  private isTrustedStandaloneMutationRequest(req: IncomingMessage): boolean {
    const originHeader = req.headers.origin;
    if (typeof originHeader !== 'string' || !originHeader.trim()) return true;
    try {
      const origin = new URL(originHeader);
      const host = req.headers.host || '';
      return origin.host === host;
    } catch {
      return false;
    }
  }

  private async readJsonBody(req: IncomingMessage): Promise<Record<string, any>> {
    return await new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (error) {
          reject(error);
        }
      });
      req.on('error', reject);
    });
  }

  async start(options: StandaloneOptions = {}): Promise<void> {
    const persistedStandaloneBindHost = loadStandaloneBindHostPreference();
    const cfg = loadConfig();
    if (!options.host && persistedStandaloneBindHost !== STANDALONE_BIND_HOST_DEFAULT) {
      saveStandaloneBindHostPreference(persistedStandaloneBindHost);
    }
    const port = options.port || DEFAULT_PORT;
    const host = options.host || persistedStandaloneBindHost;
    this.listenHost = host;
    const sessionHostEndpoint = await ensureSessionHostReady();
    this.sessionHostEndpoint = sessionHostEndpoint;
    const sessionHostControl = new StandaloneSessionHostControlPlane(
      async () => this.ensureActiveSessionHostEndpoint(),
    );
    this.sessionHostControl = sessionHostControl;

    // Auth token setup (opt-in only)
    this.authToken = options.token || process.env.ADHDEV_TOKEN || null;
    this.passwordConfig = loadStandalonePasswordConfig(this.passwordConfigPath);
    const statusInstanceId = `standalone_${cfg.machineId || 'mach_unknown'}`;

    // Initialize all core components via daemon-core bootstrapper
    this.components = await initDaemonComponents({
      cliManagerDeps: {
        getServerConn: () => null,
        getP2p: () => ({
          broadcastSessionOutput: (key: string, data: string) => {
            if (this.clients.size === 0 || !this.isCliSession(key)) return;
            const msg = JSON.stringify({ type: 'session_output', sessionId: key, data });
            for (const client of this.clients) {
              if (client.readyState === 1) { // OPEN
                client.send(msg);
              }
            }
          }
        }),
        onStatusChange: () => {
          this.scheduleBroadcastStatus();
          void this.flushWsChatSubscriptions(undefined, { onlyActive: true });
        },
        removeAgentTracking: () => {},
        hostedRuntimeManagerTag: 'adhdev-standalone',
        createPtyTransportFactory: ({ runtimeId, providerType, workspace, cliArgs, providerSessionId, attachExisting }: CliTransportFactoryParams) => (
                        new SessionHostPtyTransportFactory({
                            endpoint: sessionHostEndpoint,
                            ensureReady: async () => {
                                const activeEndpoint = await this.ensureActiveSessionHostEndpoint();
                                this.sessionHostEndpoint = activeEndpoint;
                            },
                            clientId: `daemon-${process.pid}`,
                            runtimeId,
                            providerType,
            workspace,
            attachExisting,
            meta: {
              cliArgs: cliArgs || [],
              providerSessionId,
              managedBy: 'adhdev-standalone',
            },
          })
        ),
        listHostedCliRuntimes: async (): Promise<HostedCliRuntimeDescriptor[]> => (
          listHostedCliRuntimes(sessionHostEndpoint)
        ),
      },
      statusInstanceId,
      statusVersion: pkgVersion,
      statusDaemonMode: false,
      onStatusChange: () => {
        this.scheduleBroadcastStatus();
        // Flush recently active/finalizing chat sessions immediately on status change so completed
        // messages reach the dashboard without forcing cold background subscriptions to poll.
        void this.flushWsChatSubscriptions(undefined, { onlyActive: true });
      },
      sessionHostControl,
      onStreamsUpdated: (ideType: string, streams: any[]) => {
        if (!this.components) return;
        forwardAgentStreamsToIdeInstance(this.components.instanceManager, ideType, streams);
        this.scheduleBroadcastStatus();
      },
      tickIntervalMs: 3000,
      cdpScanIntervalMs: 15_000,
    });

    if (shouldAutoRestoreHostedSessionsOnStartup(process.env)) {
      await this.components.cliManager.restoreHostedSessions();
    }

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
        if (!this.isRequestAuthenticated(req, req.url || '/')) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
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
      void this.flushWsChatSubscriptions(undefined, { onlyActive: true });
      void this.flushWsMachineRuntimeSubscriptions();
      void this.flushWsSessionHostDiagnosticsSubscriptions();
      void this.flushWsSessionModalSubscriptions();
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
      console.log('   🔑 Token auth: enabled');
    }
    if (this.passwordConfig) {
      console.log('   🔐 Password auth: enabled');
    }
    if (shouldWarnForPublicUnauthenticatedHost({ host, hasTokenAuth: !!this.authToken, hasPasswordAuth: !!this.passwordConfig })) {
      console.warn('   ⚠️  Public host mode is enabled without any auth.');
      console.warn('      Anyone on your LAN can open and control this dashboard until you set a password or token.');
    }
    console.log('');

    const cdpCount = [...this.components.cdpManagers.values()].filter(m => m.isConnected).length;
    console.log(`   CDP: ${cdpCount > 0 ? `✅ ${cdpCount} connected` : '❌ none'}`);
    console.log(`   Providers: ${this.components.providerLoader.getAll().length} loaded`);
    const sessionHostWarning = getStandaloneSessionHostAppNameWarning();
    if (sessionHostWarning) {
      console.warn(`   ⚠️  ${sessionHostWarning}`);
    }
    console.log(`   Session Host: ${getStandaloneSessionHostAppName()}`);
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

    const parsedUrl = new URL(url, `http://${req.headers.host || 'localhost'}`);

    if (parsedUrl.pathname === '/auth/session' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.buildAuthStatus(req, url)));
      return;
    }

    if (parsedUrl.pathname === '/auth/login' && method === 'POST') {
      void (async () => {
        if (!this.passwordConfig) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Password auth is not configured.' }));
          return;
        }
        const body = await this.readJsonBody(req);
        if (!verifyPassword(typeof body.password === 'string' ? body.password : '', this.passwordConfig)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Incorrect password.' }));
          return;
        }
        this.authSessions.clear();
        const sessionId = this.authSessions.create();
        res.setHeader('Set-Cookie', buildSessionCookie(sessionId, this.getCookieSecureFlag(req)));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...this.buildAuthStatus(req, url), authenticated: true }));
      })().catch((error: any) => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error?.message || String(error) }));
      });
      return;
    }

    if (parsedUrl.pathname === '/auth/logout' && method === 'POST') {
      this.authSessions.revoke(this.getRequestSessionId(req));
      res.setHeader('Set-Cookie', buildClearedSessionCookie(this.getCookieSecureFlag(req)));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    if (parsedUrl.pathname === '/auth/password' && method === 'POST') {
      void (async () => {
        if (!this.hasAnyAuth() && !this.isTrustedStandaloneMutationRequest(req)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Cross-origin standalone settings changes are not allowed without existing auth.' }));
          return;
        }
        if (this.hasAnyAuth() && !this.isRequestAuthenticated(req, url)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        const body = await this.readJsonBody(req);
        const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
        const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
        const clearPassword = body.clear === true;

        if (this.passwordConfig && !verifyPassword(currentPassword, this.passwordConfig)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Current password is incorrect.' }));
          return;
        }

        if (clearPassword) {
          clearStandalonePasswordConfig(this.passwordConfigPath);
          this.passwordConfig = null;
          this.authSessions.clear();
          res.setHeader('Set-Cookie', buildClearedSessionCookie(this.getCookieSecureFlag(req)));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, ...this.buildAuthStatus(req, url), authenticated: !this.hasAnyAuth() }));
          return;
        }

        if (newPassword.trim().length < 4) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Password must be at least 4 characters.' }));
          return;
        }

        const nextConfig = createPasswordRecord(newPassword.trim());
        saveStandalonePasswordConfig(this.passwordConfigPath, nextConfig);
        this.passwordConfig = nextConfig;
        this.authSessions.clear();
        const sessionId = this.authSessions.create();
        res.setHeader('Set-Cookie', buildSessionCookie(sessionId, this.getCookieSecureFlag(req)));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, ...this.buildAuthStatus(req, url), authenticated: true }));
      })().catch((error: any) => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error?.message || String(error) }));
      });
      return;
    }

    if (parsedUrl.pathname === '/api/v1/standalone/preferences' && method === 'GET') {
      const configuredBindHost = loadStandaloneBindHostPreference();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        standaloneBindHost: configuredBindHost,
        currentBindHost: this.listenHost,
        hasPasswordAuth: !!this.passwordConfig,
        hasTokenAuth: !!this.authToken,
        publicHostWarning: shouldWarnForPublicUnauthenticatedHost({
          host: configuredBindHost,
          hasTokenAuth: !!this.authToken,
          hasPasswordAuth: !!this.passwordConfig,
        }),
      }));
      return;
    }

    if (parsedUrl.pathname === '/api/v1/standalone/preferences' && method === 'POST') {
      void (async () => {
        if (!this.hasAnyAuth() && !this.isTrustedStandaloneMutationRequest(req)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Cross-origin standalone settings changes are not allowed without existing auth.' }));
          return;
        }
        if (this.hasAnyAuth() && !this.isRequestAuthenticated(req, url)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        const body = await this.readJsonBody(req);
        const nextHost = body?.standaloneBindHost === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
        const savedHost = saveStandaloneBindHostPreference(nextHost);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          standaloneBindHost: savedHost,
          currentBindHost: this.listenHost,
          hasPasswordAuth: !!this.passwordConfig,
          hasTokenAuth: !!this.authToken,
          publicHostWarning: shouldWarnForPublicUnauthenticatedHost({
            host: savedHost,
            hasTokenAuth: !!this.authToken,
            hasPasswordAuth: !!this.passwordConfig,
          }),
        }));
      })().catch((error: any) => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error?.message || String(error) }));
      });
      return;
    }

    if (url.startsWith('/api/') && !this.isRequestAuthenticated(req, url)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized. Provide dashboard session cookie or token auth.' }));
      return;
    }

    // ─── API Routes (v1) ───
    const apiPath = url.startsWith('/api/v1/') ? url.slice(7) : null; // /api/v1/status → /status

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
        if (!this.isCliSession(sessionId)) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'CLI session runtime unavailable', code: 'CLI_RUNTIME_UNAVAILABLE' }));
          return;
        }
        void (async () => {
          const client = await this.createSessionHostClient();
          try {
            const snapshot = await client.request<{ seq: number; text: string; truncated: boolean; cols?: number; rows?: number }>({
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
          const parsed = JSON.parse(body || '{}');
          const { type, payload } = this.normalizeCommandEnvelope(parsed);
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
    if (!this.isCliSession(sessionId)) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'CLI session runtime unavailable', code: 'CLI_RUNTIME_UNAVAILABLE' }));
      return;
    }

    const client = await this.createSessionHostClient();

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const snapshot = await client.request<{ seq: number; text: string; truncated: boolean; cols?: number; rows?: number }>({
      type: 'get_snapshot',
      payload: { sessionId },
    });
    if (snapshot.success && snapshot.result) {
      res.write('event: runtime_snapshot\n');
      res.write(`data: ${JSON.stringify({ sessionId, ...snapshot.result })}\n\n`);
    }

    const writeEvent = (event: SessionHostEvent) => {
      if (!('sessionId' in event)) return;
      if (event.sessionId !== sessionId) return;
      if (!this.isCliSession(sessionId)) return;
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
    this.wsSubscriptions.set(ws, new Map());
    this.wsMachineRuntimeSubscriptions.set(ws, new Map());
    this.wsSessionHostDiagnosticsSubscriptions.set(ws, new Map());
    this.wsSessionModalSubscriptions.set(ws, new Map());
    this.wsDaemonMetadataSubscriptions.set(ws, new Map());
    console.log(`[WS] Client connected (total: ${this.clients.size})`);

    // Send initial status immediately
    const status = this.getWsStatus(this.buildSharedSnapshot('live'));
    this.lastWsStatusSignature = this.buildWsStatusSignature(status);
    ws.send(JSON.stringify({ type: 'status', data: status }));
    void this.pushWsRuntimeSnapshots(ws);

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
          const { type, payload } = this.normalizeCommandEnvelope(envelope);
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
      this.wsSubscriptions.delete(ws);
      this.wsMachineRuntimeSubscriptions.delete(ws);
      this.wsSessionHostDiagnosticsSubscriptions.delete(ws);
      this.wsSessionModalSubscriptions.delete(ws);
      this.wsDaemonMetadataSubscriptions.delete(ws);
      console.log(`[WS] Client disconnected (total: ${this.clients.size})`);
    });

    ws.on('error', () => {
      this.clients.delete(ws);
      this.wsSubscriptions.delete(ws);
      this.wsMachineRuntimeSubscriptions.delete(ws);
      this.wsSessionHostDiagnosticsSubscriptions.delete(ws);
      this.wsSessionModalSubscriptions.delete(ws);
      this.wsDaemonMetadataSubscriptions.delete(ws);
    });
  }

  private async handleWsSubscribe(ws: WebSocket, msg: SubscribeRequest): Promise<void> {
    if (msg.topic === 'session.chat_tail') {
      const params = msg.params as SessionChatTailSubscriptionParams;
      if (!params?.targetSessionId) return;
      const subs = this.wsSubscriptions.get(ws) || new Map<string, ChatTailSubscriptionState>();
      this.wsSubscriptions.set(ws, subs);
      subs.set(msg.key, {
        request: {
          ...msg,
          topic: 'session.chat_tail',
          params,
        },
        seq: 0,
        cursor: {
          knownMessageCount: Math.max(0, Number(params.knownMessageCount || 0)),
          lastMessageSignature: typeof params.lastMessageSignature === 'string' ? params.lastMessageSignature : '',
          tailLimit: Math.max(0, Number(params.tailLimit || 0)),
        },
        lastDeliveredSignature: '',
      });
      await this.flushWsChatSubscriptions(ws);
      return;
    }
    if (msg.topic === 'machine.runtime') {
      const params = msg.params as MachineRuntimeSubscriptionParams;
      const subs = this.wsMachineRuntimeSubscriptions.get(ws) || new Map<string, MachineRuntimeSubscriptionState>();
      this.wsMachineRuntimeSubscriptions.set(ws, subs);
      subs.set(msg.key, {
        request: {
          ...msg,
          topic: 'machine.runtime',
          params,
        },
        seq: 0,
        lastSentAt: 0,
      });
      await this.flushWsMachineRuntimeSubscriptions(ws);
      return;
    }
    if (msg.topic === 'session_host.diagnostics') {
      const params = msg.params as SessionHostDiagnosticsSubscriptionParams;
      const subs = this.wsSessionHostDiagnosticsSubscriptions.get(ws) || new Map<string, SessionHostDiagnosticsSubscriptionState>();
      this.wsSessionHostDiagnosticsSubscriptions.set(ws, subs);
      subs.set(msg.key, {
        request: {
          ...msg,
          topic: 'session_host.diagnostics',
          params,
        },
        seq: 0,
        lastSentAt: 0,
      });
      await this.flushWsSessionHostDiagnosticsSubscriptions(ws);
      return;
    }
    if (msg.topic === 'session.modal') {
      const params = msg.params as SessionModalSubscriptionParams;
      if (!params?.targetSessionId) return;
      const subs = this.wsSessionModalSubscriptions.get(ws) || new Map<string, SessionModalSubscriptionState>();
      this.wsSessionModalSubscriptions.set(ws, subs);
      subs.set(msg.key, {
        request: {
          ...msg,
          topic: 'session.modal',
          params,
        },
        seq: 0,
        lastSentAt: 0,
        lastDeliveredSignature: '',
      });
      await this.flushWsSessionModalSubscriptions(ws);
      return;
    }
    if (msg.topic === 'daemon.metadata') {
      const params = msg.params as DaemonMetadataSubscriptionParams;
      const subs = this.wsDaemonMetadataSubscriptions.get(ws) || new Map<string, DaemonMetadataSubscriptionState>();
      this.wsDaemonMetadataSubscriptions.set(ws, subs);
      subs.set(msg.key, {
        request: {
          ...msg,
          topic: 'daemon.metadata',
          params,
        },
        seq: 0,
        lastSentAt: 0,
      });
      await this.flushWsDaemonMetadataSubscriptions(ws);
    }
  }

  private handleWsUnsubscribe(ws: WebSocket, msg: UnsubscribeRequest): void {
    if (msg.topic === 'session.chat_tail') {
      this.wsSubscriptions.get(ws)?.delete(msg.key);
      return;
    }
    if (msg.topic === 'machine.runtime') {
      this.wsMachineRuntimeSubscriptions.get(ws)?.delete(msg.key);
      return;
    }
    if (msg.topic === 'session_host.diagnostics') {
      this.wsSessionHostDiagnosticsSubscriptions.get(ws)?.delete(msg.key);
      return;
    }
    if (msg.topic === 'session.modal') {
      this.wsSessionModalSubscriptions.get(ws)?.delete(msg.key);
      return;
    }
    if (msg.topic === 'daemon.metadata') {
      this.wsDaemonMetadataSubscriptions.get(ws)?.delete(msg.key);
    }
  }

  private async buildChatTailUpdate(
    request: SessionChatTailSubscriptionParams,
    state: ChatTailSubscriptionState,
    key: string,
  ): Promise<SessionChatTailUpdate | null> {
    const result = await this.executeCommand('read_chat', {
      targetSessionId: request.targetSessionId,
      ...(request.historySessionId ? { historySessionId: request.historySessionId } : {}),
      knownMessageCount: state.cursor.knownMessageCount,
      lastMessageSignature: state.cursor.lastMessageSignature,
      ...(state.cursor.tailLimit > 0 ? { tailLimit: state.cursor.tailLimit } : {}),
    });
    const prepared = prepareSessionChatTailUpdate({
      key,
      sessionId: request.targetSessionId,
      ...(request.historySessionId ? { historySessionId: request.historySessionId } : {}),
      seq: state.seq,
      timestamp: Date.now(),
      cursor: state.cursor,
      lastDeliveredSignature: state.lastDeliveredSignature,
      result,
    });
    state.cursor = prepared.cursor;
    state.seq = prepared.seq;
    state.lastDeliveredSignature = prepared.lastDeliveredSignature;
    return prepared.update;
  }

  private getHotChatSessionIdsForWsFlush(): { active: Set<string>; finalizing: Set<string> } {
    const snapshot = this.buildSharedSnapshot('live');
    const hotSessions = classifyHotChatSessionsForSubscriptionFlush(
      snapshot.sessions,
      this.hotWsChatSessionIds,
    );
    this.hotWsChatSessionIds = hotSessions.active;
    return hotSessions;
  }

  private async flushWsChatSubscriptions(
    targetWs?: WebSocket,
    options: { onlyActive?: boolean } = {},
  ): Promise<void> {
    if (this.wsChatFlushInFlight) {
      const nextOnlyActive = options.onlyActive === true;
      const pending = this.pendingWsChatFlush;
      this.pendingWsChatFlush = {
        targetWs: pending?.targetWs === undefined || targetWs === undefined ? undefined : targetWs,
        onlyActive: pending ? (pending.onlyActive && nextOnlyActive) : nextOnlyActive,
      };
      return;
    }

    this.wsChatFlushInFlight = true;
    try {
      const targets = targetWs ? [targetWs] : Array.from(this.clients);
      const hotSessionIds = options.onlyActive ? this.getHotChatSessionIdsForWsFlush() : null;
      const tasks: Array<{ ws: WebSocket; key: string; sub: ChatTailSubscriptionState }> = [];
      for (const ws of targets) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        const subs = this.wsSubscriptions.get(ws);
        if (!subs || subs.size === 0) continue;
        for (const [key, sub] of subs.entries()) {
          const targetSessionId = sub.request.params.targetSessionId;
          if (
            hotSessionIds
            && !hotSessionIds.active.has(targetSessionId)
            && !hotSessionIds.finalizing.has(targetSessionId)
          ) {
            continue;
          }
          tasks.push({ ws, key, sub });
        }
      }

      await runAsyncBatch(tasks, async ({ ws, key, sub }) => {
        try {
          const update = await this.buildChatTailUpdate(sub.request.params, sub, key);
          if (!update || ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ type: 'topic_update', update }));
        } catch (error: any) {
          LOG.warn('Standalone', `[chat_tail] skipped session=${sub.request.params.targetSessionId} key=${key} error=${error?.message || error}`)
        }
      }, { concurrency: 4 });
    } finally {
      this.wsChatFlushInFlight = false;
      if (this.pendingWsChatFlush) {
        const pending = this.pendingWsChatFlush;
        this.pendingWsChatFlush = null;
        void this.flushWsChatSubscriptions(pending.targetWs, { onlyActive: pending.onlyActive });
      }
    }
  }

  private buildMachineRuntimeUpdate(
    state: MachineRuntimeSubscriptionState,
    key: string,
  ): MachineRuntimeUpdate | null {
    const intervalMs = Math.max(5_000, Number(state.request.params.intervalMs || 15_000));
    const now = Date.now();
    if (state.lastSentAt > 0 && (now - state.lastSentAt) < intervalMs) {
      return null;
    }
    state.seq += 1;
    state.lastSentAt = now;
    return {
      topic: 'machine.runtime',
      key,
      machine: buildMachineInfo('full'),
      seq: state.seq,
      timestamp: now,
    };
  }

  private async flushWsMachineRuntimeSubscriptions(targetWs?: WebSocket): Promise<void> {
    const targets = targetWs ? [targetWs] : Array.from(this.clients);
    for (const ws of targets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const subs = this.wsMachineRuntimeSubscriptions.get(ws);
      if (!subs || subs.size === 0) continue;
      for (const [key, sub] of subs.entries()) {
        const update = this.buildMachineRuntimeUpdate(sub, key);
        if (!update || ws.readyState !== WebSocket.OPEN) continue;
        ws.send(JSON.stringify({ type: 'topic_update', update }));
      }
    }
  }

  private async buildSessionHostDiagnosticsUpdate(
    state: SessionHostDiagnosticsSubscriptionState,
    key: string,
  ): Promise<SessionHostDiagnosticsUpdate | null> {
    if (!this.sessionHostControl) return null;
    const intervalMs = Math.max(5_000, Number(state.request.params.intervalMs || 10_000));
    const now = Date.now();
    if (state.lastSentAt > 0 && (now - state.lastSentAt) < intervalMs) {
      return null;
    }
    const diagnostics = await this.sessionHostControl.getDiagnostics({
      includeSessions: state.request.params.includeSessions !== false,
      limit: Number(state.request.params.limit) || undefined,
    }) as SessionHostDiagnosticsSnapshot;
    state.seq += 1;
    state.lastSentAt = now;
    return {
      topic: 'session_host.diagnostics',
      key,
      diagnostics,
      seq: state.seq,
      timestamp: now,
    };
  }

  private async flushWsSessionHostDiagnosticsSubscriptions(targetWs?: WebSocket): Promise<void> {
    const targets = targetWs ? [targetWs] : Array.from(this.clients);
    for (const ws of targets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const subs = this.wsSessionHostDiagnosticsSubscriptions.get(ws);
      if (!subs || subs.size === 0) continue;
      for (const [key, sub] of subs.entries()) {
        const update = await this.buildSessionHostDiagnosticsUpdate(sub, key);
        if (!update || ws.readyState !== WebSocket.OPEN) continue;
        ws.send(JSON.stringify({ type: 'topic_update', update }));
      }
    }
  }

  private findProviderStateBySessionId(sessionId: string): ProviderState | null {
    if (!this.components || !sessionId) return null;
    const states = this.components.instanceManager.collectAllStates();
    for (const state of states) {
      if (state.instanceId === sessionId) return state;
      if (state.category === 'ide') {
        const child = state.extensions.find((entry: { instanceId?: string }) => entry.instanceId === sessionId);
        if (child) return child;
      }
    }
    return null;
  }

  private buildSessionModalUpdate(
    state: SessionModalSubscriptionState,
    key: string,
  ): SessionModalUpdate | null {
    const providerState = this.findProviderStateBySessionId(state.request.params.targetSessionId);
    if (!providerState) return null;
    const now = Date.now();
    const activeModal = providerState.activeChat?.activeModal;
    const status = String(providerState.activeChat?.status || providerState.status || 'idle');
    const title = typeof providerState.activeChat?.title === 'string' ? providerState.activeChat.title : undefined;
    const prepared = prepareSessionModalUpdate({
      key,
      sessionId: state.request.params.targetSessionId,
      status,
      title,
      activeModal,
      seq: state.seq,
      timestamp: now,
      lastDeliveredSignature: state.lastDeliveredSignature,
    });
    state.seq = prepared.seq;
    state.lastDeliveredSignature = prepared.lastDeliveredSignature;
    if (!prepared.update) {
      return null;
    }
    state.lastSentAt = now;
    return prepared.update;
  }

  private async flushWsSessionModalSubscriptions(targetWs?: WebSocket): Promise<void> {
    const targets = targetWs ? [targetWs] : Array.from(this.clients);
    for (const ws of targets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const subs = this.wsSessionModalSubscriptions.get(ws);
      if (!subs || subs.size === 0) continue;
      for (const [key, sub] of subs.entries()) {
        const update = this.buildSessionModalUpdate(sub, key);
        if (!update || ws.readyState !== WebSocket.OPEN) continue;
        ws.send(JSON.stringify({ type: 'topic_update', update }));
      }
    }
  }

  private buildDaemonMetadataUpdate(
    state: DaemonMetadataSubscriptionState,
    key: string,
  ): DaemonMetadataUpdate {
    const now = Date.now();
    state.seq += 1;
    state.lastSentAt = now;
    const cfgSnap = loadConfig();
    return {
      topic: 'daemon.metadata',
      key,
      daemonId: `standalone_${cfgSnap.machineId || 'standalone'}`,
      status: this.buildSharedSnapshot('metadata'),
      userName: cfgSnap.userName || undefined,
      seq: state.seq,
      timestamp: now,
    };
  }

  private async flushWsDaemonMetadataSubscriptions(targetWs?: WebSocket): Promise<void> {
    const targets = targetWs ? [targetWs] : Array.from(this.clients);
    for (const ws of targets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const subs = this.wsDaemonMetadataSubscriptions.get(ws);
      if (!subs || subs.size === 0) continue;
      for (const [key, sub] of subs.entries()) {
        const update = this.buildDaemonMetadataUpdate(sub, key);
        if (ws.readyState !== WebSocket.OPEN) continue;
        ws.send(JSON.stringify({ type: 'topic_update', update }));
      }
    }
  }

  // ─── Core Logic ───

  private buildSharedSnapshot(profile: 'full' | 'live' | 'metadata' = 'full') {
    const cfgSnap = loadConfig();
    const machineId = cfgSnap.machineId || 'mach_unknown';
    const allStates = this.components!.instanceManager.collectAllStates();

    return buildStatusSnapshot({
      allStates,
      cdpManagers: this.components!.cdpManagers,
      providerLoader: this.components!.providerLoader,
      detectedIdes: this.components!.detectedIdes.value.map((ide: {
        id: string;
        name?: string;
        displayName?: string;
        installed?: boolean;
        path?: string | null;
      }) => ({
        ...ide,
        path: ide.path ?? undefined,
      })),
      instanceId: `standalone_${machineId}`,
      version: pkgVersion,
      profile,
    });
  }

  private async pushWsRuntimeSnapshots(ws: WebSocket): Promise<void> {
    if (!this.components || ws.readyState !== WebSocket.OPEN) return;

    const client = await this.createSessionHostClient();
    try {
      const states = this.components.instanceManager.collectAllStates();
      for (const state of states as any[]) {
        const sessionId = typeof state?.instanceId === 'string' ? state.instanceId : '';
        if (!sessionId || state?.category !== 'cli') continue;

        const snapshot = await client.request<{ seq: number; text: string; truncated: boolean; cols?: number; rows?: number }>({
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

  private getStatus(snapshot: ReturnType<StandaloneServer['buildSharedSnapshot']> = this.buildSharedSnapshot('full')): StatusResponse {
    const cfgSnap = loadConfig();
    const machineRuntime = buildMachineInfo('full');

    return {
      ...snapshot,
      id: snapshot.instanceId,
      type: 'standalone',
      platform: snapshot.machine.platform,
      hostname: snapshot.machine.hostname,
      userName: cfgSnap.userName || undefined,
      system: {
        cpus: snapshot.machine.cpus ?? machineRuntime.cpus ?? 0,
        totalMem: snapshot.machine.totalMem ?? machineRuntime.totalMem ?? 0,
        freeMem: snapshot.machine.freeMem ?? machineRuntime.freeMem ?? 0,
        availableMem: snapshot.machine.availableMem ?? machineRuntime.availableMem ?? 0,
        loadavg: snapshot.machine.loadavg ?? machineRuntime.loadavg ?? [],
        uptime: snapshot.machine.uptime ?? machineRuntime.uptime ?? 0,
        arch: snapshot.machine.arch ?? machineRuntime.arch ?? os.arch(),
      },
    };
  }

  private getWsStatus(snapshot: ReturnType<StandaloneServer['buildSharedSnapshot']> = this.buildSharedSnapshot('live')): StandaloneWsStatusPayload {
    return {
      instanceId: snapshot.instanceId,
      machine: snapshot.machine,
      timestamp: snapshot.timestamp,
      sessions: snapshot.sessions,
      terminalBackend: snapshot.terminalBackend,
    };
  }

  private buildWsStatusSignature(status: StandaloneWsStatusPayload): string {
    return JSON.stringify({
      instanceId: status.instanceId,
      machine: {
        hostname: status.machine.hostname,
        platform: status.machine.platform,
      },
      sessions: status.sessions.map((session: typeof status.sessions[number]) => ({
        id: session.id,
        parentId: session.parentId,
        providerType: session.providerType,
        kind: session.kind,
        transport: session.transport,
        status: session.status,
        title: session.title,
        cdpConnected: session.cdpConnected,
        lastSeenAt: session.lastSeenAt,
        unread: session.unread,
        inboxBucket: session.inboxBucket,
        surfaceHidden: session.surfaceHidden,
      })),
    });
  }

  private normalizeCommandEnvelope(input: Record<string, any> | null | undefined): { type: string; payload: Record<string, any> } {
    const body = input && typeof input === 'object' ? input : {};
    const type = typeof body.type === 'string' && body.type.trim()
      ? body.type.trim()
      : typeof body.commandType === 'string' && body.commandType.trim()
        ? body.commandType.trim()
        : typeof body.command === 'string' && body.command.trim()
          ? body.command.trim()
          : '';

    const payloadSource =
      body.payload && typeof body.payload === 'object'
        ? body.payload
        : body.args && typeof body.args === 'object'
          ? body.args
          : body.data && typeof body.data === 'object'
            ? body.data
          : null;

    const payload = payloadSource
      ? { ...payloadSource }
      : Object.fromEntries(
          Object.entries(body).filter(([key]) => (
            key !== 'type'
            && key !== 'commandType'
            && key !== 'command'
            && key !== 'payload'
            && key !== 'args'
            && key !== 'requestId'
            && key !== 'id'
          )),
        );

    if (
      type
      && SESSION_TARGET_COMMANDS.has(type)
      && typeof payload.targetSessionId !== 'string'
      && typeof payload.sessionId === 'string'
      && payload.sessionId.trim()
    ) {
      payload.targetSessionId = payload.sessionId.trim();
    }

    return { type, payload };
  }

  private async executeCommand(type: string, args: any): Promise<any> {
    if (!this.components) {
      return { success: false, error: 'Components not initialized' };
    }
    if (typeof type !== 'string' || !type.trim()) {
      return { success: false, error: 'command type required' };
    }
    const result = await this.components.router.execute(type, args, 'standalone');
    if (type === 'invoke_provider_script' || type.startsWith('workspace_') || type.startsWith('session_host_')) {
      this.scheduleBroadcastStatus();
    }
    if (
      type === 'invoke_provider_script'
      || type === 'get_status_metadata'
      || type === 'set_user_name'
      || type === 'set_machine_nickname'
      || type.startsWith('workspace_')
      || type.startsWith('session_host_')
    ) {
      void this.flushWsDaemonMetadataSubscriptions();
    }
    if (type.startsWith('session_host_')) void this.flushWsSessionHostDiagnosticsSubscriptions();
    if (type === 'resolve_action' || type === 'send_chat' || type === 'read_chat') void this.flushWsSessionModalSubscriptions();
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
    const status = this.getWsStatus(this.buildSharedSnapshot('live'));
    const signature = this.buildWsStatusSignature(status);
    if (signature === this.lastWsStatusSignature) return;
    this.lastWsStatusSignature = signature;
    this.lastStatusBroadcastAt = Date.now();
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
    this.wsSubscriptions.clear();
    this.wsMachineRuntimeSubscriptions.clear();
    this.wsSessionHostDiagnosticsSubscriptions.clear();
    this.wsSessionModalSubscriptions.clear();
    this.wsDaemonMetadataSubscriptions.clear();
    this.lastWsStatusSignature = null;

    // Close WSS
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    // Shutdown core components
    if (this.components) {
      await shutdownDaemonComponents(this.components);
    }
    this.sessionHostControl = null;

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
  const options: StandaloneOptions = {};
  let hostExplicit = false;

  // Parse simple args
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) {
      options.port = parseInt(args[i + 1]);
      i++;
    }
    if (args[i] === '--host' || args[i] === '-H') {
      options.host = '0.0.0.0';
      hostExplicit = true;
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

Environment:
  ADHDEV_SESSION_HOST_NAME   Override session host namespace (default: adhdev-standalone)
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
