import type { DevServerContext } from './dev-server-types.js';
/**
 * Dev Server — HTTP API for Provider debugging + script development
 * 
 * Enabled with `adhdev daemon --dev`
 * Port: 19280 (fixed)
 * 
 * API list:
 * GET /api/providers — loaded provider list
 * POST /api/providers/:type/script — specific script execute
 * POST /api/cdp/evaluate — Execute JS expression
 * POST /api/cdp/dom/query — Test selector
 * GET /api/cdp/screenshot — screenshot
 * POST /api/scripts/run — Execute provider script (name + params)
 * GET /api/status — All status (CDP connection, provider etc)
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ProviderLoader } from '../providers/provider-loader.js';
import type { ProviderCategory, ProviderModule, ProviderScripts, ProviderSettingDef } from '../providers/contracts.js';
import { validateProviderDefinition } from '../providers/provider-schema.js';
import { loadConfig, saveConfig } from '../config/config.js';
import { parseProviderSourceConfigUpdate } from '../config/provider-source-config.js';
import type { ChildProcess } from 'child_process';
import type { DaemonCdpManager } from '../cdp/manager.js';
import type { ProviderInstanceManager } from '../providers/provider-instance-manager.js';
import type { DaemonCliManager } from '../commands/cli-manager.js';
import { generateTemplate as genScaffoldTemplate, generateFiles as genScaffoldFiles } from './scaffold-template.js';
import { VersionArchive, detectAllVersions } from '../providers/version-archive.js';
import { LOG } from '../logging/logger.js';
import { findCdpManager } from '../status/builders.js';
import { handleCdpEvaluate, handleCdpClick, handleCdpDomQuery, handleScreenshot, handleScriptsRun, handleTypeAndSend, handleTypeAndSendAt, handleScriptHints, handleCdpTargets, handleDomInspect, handleDomChildren, handleDomAnalyze, handleFindCommon, handleFindByText, handleDomContext } from './dev-cdp-handlers.js';
import { resolveLegacyProviderScript, type LegacyStringScript } from '../commands/provider-script-resolver.js';
import { handleCliStatus, handleCliLaunch, handleCliSend, handleCliStop, handleCliDebug, handleCliTrace, handleCliExercise, handleCliFixtureCapture, handleCliFixtureList, handleCliFixtureReplay, handleCliResolve, handleCliRaw, handleCliSSE } from './dev-cli-debug.js';
import { handleAutoImplement, handleAutoImplCancel, handleAutoImplSSE } from './dev-auto-implement.js';

export const DEV_SERVER_PORT = 19280;

interface ProviderListEntry {
  type: string;
  name: string;
  category: ProviderCategory;
  icon: string | null;
  displayName: string;
  scripts?: string[];
  inputMethod?: ProviderModule['inputMethod'] | null;
  inputSelector?: string | null;
  extensionId?: string | null;
  cdpPorts?: [number, number] | [];
  spawn?: ProviderModule['spawn'] | null;
  auth?: ProviderModule['auth'] | null;
  install?: string | null;
  hasSettings?: boolean;
  settingsCount?: number;
}

function getScriptNames(scripts?: ProviderScripts): string[] {
  if (!scripts) return [];
  return Object.entries(scripts)
    .filter(([, value]) => typeof value === 'function')
    .map(([name]) => name);
}

function toProviderListEntry(provider: ProviderModule): ProviderListEntry {
  const base: ProviderListEntry = {
    type: provider.type,
    name: provider.name,
    category: provider.category,
    icon: provider.icon || null,
    displayName: provider.displayName || provider.name,
  };

  if (provider.category === 'ide' || provider.category === 'extension') {
    base.scripts = getScriptNames(provider.scripts);
    base.inputMethod = provider.inputMethod || null;
    base.inputSelector = provider.inputSelector || null;
    base.extensionId = provider.extensionId || null;
    base.cdpPorts = provider.cdpPorts || [];
  }

  if (provider.category === 'acp') {
    base.spawn = provider.spawn || null;
    base.auth = provider.auth || null;
    base.install = provider.install || null;
    base.hasSettings = !!provider.settings;
    base.settingsCount = provider.settings ? Object.keys(provider.settings).length : 0;
  }

  if (provider.category === 'cli') {
    base.spawn = provider.spawn || null;
    base.install = provider.install || null;
  }

  return base;
}

export class DevServer implements DevServerContext {
  private server: http.Server | null = null;
  public providerLoader: ProviderLoader;
  public cdpManagers: Map<string, DaemonCdpManager>;
  public instanceManager: ProviderInstanceManager | null;
  public cliManager: DaemonCliManager | null;
  public onProviderSourceConfigChanged: (() => Promise<void> | void) | null;
  private logFn: (msg: string) => void;
  private sseClients: http.ServerResponse[] = [];
  private watchScriptPath: string | null = null;
  private watchScriptName: string | null = null;
  private watchTimer: NodeJS.Timeout | null = null;

  // Auto-implement state
  public autoImplProcess: ChildProcess | null = null;
  public autoImplSSEClients: http.ServerResponse[] = [];
  public autoImplStatus: { running: boolean; type: string | null; progress: any[] } = { running: false, type: null, progress: [] };

  // CLI debug SSE
  private cliSSEClients: http.ServerResponse[] = [];

  constructor(options: {
    providerLoader: ProviderLoader;
    cdpManagers: Map<string, DaemonCdpManager>;
    instanceManager?: ProviderInstanceManager;
    cliManager?: DaemonCliManager;
    logFn?: (msg: string) => void;
    onProviderSourceConfigChanged?: () => Promise<void> | void;
  }) {
    this.providerLoader = options.providerLoader;
    this.cdpManagers = options.cdpManagers;
    this.instanceManager = options.instanceManager || null;
    this.cliManager = options.cliManager || null;
    this.onProviderSourceConfigChanged = options.onProviderSourceConfigChanged || null;
    this.logFn = options.logFn || LOG.forComponent('DevServer').asLogFn();
  }

  public log(msg: string): void {
    this.logFn(`[DevServer] ${msg}`);
  }

  // ─── Route Table ─────────────────────────────────────
  private readonly routes: {
    method: string;
    pattern: string | RegExp;
    handler: (req: http.IncomingMessage, res: http.ServerResponse, params?: string[]) => Promise<void> | void;
  }[] = [
    // Static routes
    { method: 'GET',  pattern: '/api/providers',          handler: (q, s) => this.handleListProviders(q, s) },
    { method: 'GET',  pattern: '/api/providers/source-config', handler: (q, s) => this.handleGetProviderSourceConfig(q, s) },
    { method: 'POST', pattern: '/api/providers/source-config', handler: (q, s) => this.handleSetProviderSourceConfig(q, s) },
    { method: 'GET',  pattern: '/api/providers/versions',  handler: (q, s) => this.handleDetectVersions(q, s) },
    { method: 'POST', pattern: '/api/providers/reload',    handler: (q, s) => this.handleReload(q, s) },
    { method: 'POST', pattern: '/api/cdp/evaluate',        handler: (q, s) => this.handleCdpEvaluate(q, s) },
    { method: 'POST', pattern: '/api/cdp/click',           handler: (q, s) => this.handleCdpClick(q, s) },
    { method: 'POST', pattern: '/api/cdp/dom/query',       handler: (q, s) => this.handleCdpDomQuery(q, s) },
    { method: 'POST', pattern: '/api/cdp/dom/inspect',     handler: (q, s) => this.handleDomInspect(q, s) },
    { method: 'POST', pattern: '/api/cdp/dom/children',    handler: (q, s) => this.handleDomChildren(q, s) },
    { method: 'POST', pattern: '/api/cdp/dom/analyze',     handler: (q, s) => this.handleDomAnalyze(q, s) },
    { method: 'POST', pattern: '/api/cdp/dom/find-text',   handler: (q, s) => this.handleFindByText(q, s) },
    { method: 'POST', pattern: '/api/cdp/dom/find-common', handler: (q, s) => this.handleFindCommon(q, s) },
    { method: 'GET',  pattern: '/api/cdp/screenshot',      handler: (q, s) => this.handleScreenshot(q, s) },
    { method: 'GET',  pattern: '/api/cdp/targets',         handler: (q, s) => this.handleCdpTargets(q, s) },
    { method: 'POST', pattern: '/api/scripts/run',         handler: (q, s) => this.handleScriptsRun(q, s) },
    { method: 'GET',  pattern: '/api/status',              handler: (q, s) => this.handleStatus(q, s) },
    { method: 'POST', pattern: '/api/watch/start',         handler: (q, s) => this.handleWatchStart(q, s) },
    { method: 'POST', pattern: '/api/watch/stop',          handler: (q, s) => this.handleWatchStop(q, s) },
    { method: 'GET',  pattern: '/api/watch/events',        handler: (q, s) => this.handleSSE(q, s) },
    { method: 'POST', pattern: '/api/scaffold',            handler: (q, s) => this.handleScaffold(q, s) },
    // CLI Debug routes
    { method: 'GET',  pattern: '/api/cli/status',           handler: (q, s) => this.handleCliStatus(q, s) },
    { method: 'POST', pattern: '/api/cli/launch',           handler: (q, s) => this.handleCliLaunch(q, s) },
    { method: 'POST', pattern: '/api/cli/send',             handler: (q, s) => this.handleCliSend(q, s) },
    { method: 'POST', pattern: '/api/cli/exercise',         handler: (q, s) => this.handleCliExercise(q, s) },
    { method: 'POST', pattern: '/api/cli/fixture/capture',  handler: (q, s) => this.handleCliFixtureCapture(q, s) },
    { method: 'POST', pattern: '/api/cli/fixture/replay',   handler: (q, s) => this.handleCliFixtureReplay(q, s) },
    { method: 'POST', pattern: '/api/cli/resolve',           handler: (q, s) => this.handleCliResolve(q, s) },
    { method: 'POST', pattern: '/api/cli/raw',               handler: (q, s) => this.handleCliRaw(q, s) },
    { method: 'POST', pattern: '/api/cli/stop',              handler: (q, s) => this.handleCliStop(q, s) },
    { method: 'GET',  pattern: '/api/cli/events',            handler: (q, s) => this.handleCliSSE(q, s) },
    { method: 'GET',  pattern: /^\/api\/cli\/debug\/([^/]+)$/, handler: (q, s, p) => this.handleCliDebug(p![0], q, s) },
    { method: 'GET',  pattern: /^\/api\/cli\/trace\/([^/]+)$/, handler: (q, s, p) => this.handleCliTrace(p![0], q, s) },
    { method: 'GET',  pattern: /^\/api\/cli\/fixtures\/([^/]+)$/, handler: (q, s, p) => this.handleCliFixtureList(p![0], q, s) },
    // Dynamic routes (provider :type param)
    { method: 'POST', pattern: /^\/api\/providers\/([^/]+)\/script$/,                handler: (q, s, p) => this.handleRunScript(p![0], q, s) },
    { method: 'GET',  pattern: /^\/api\/providers\/([^/]+)\/files$/,                 handler: (q, s, p) => this.handleListFiles(p![0], q, s) },
    { method: 'GET',  pattern: /^\/api\/providers\/([^/]+)\/file$/,                  handler: (q, s, p) => this.handleReadFile(p![0], q, s) },
    { method: 'POST', pattern: /^\/api\/providers\/([^/]+)\/file$/,                  handler: (q, s, p) => this.handleWriteFile(p![0], q, s) },
    { method: 'GET',  pattern: /^\/api\/providers\/([^/]+)\/source$/,                handler: (q, s, p) => this.handleSource(p![0], q, s) },
    { method: 'POST', pattern: /^\/api\/providers\/([^/]+)\/save$/,                  handler: (q, s, p) => this.handleSave(p![0], q, s) },
    { method: 'POST', pattern: /^\/api\/providers\/([^/]+)\/typeAndSend$/,           handler: (q, s, p) => this.handleTypeAndSend(p![0], q, s) },
    { method: 'POST', pattern: /^\/api\/providers\/([^/]+)\/typeAndSendAt$/,         handler: (q, s, p) => this.handleTypeAndSendAt(p![0], q, s) },
    { method: 'GET',  pattern: /^\/api\/providers\/([^/]+)\/config$/,                handler: (q, s, p) => this.handleProviderConfig(p![0], q, s) },
    { method: 'POST', pattern: /^\/api\/providers\/([^/]+)\/dom-context$/,           handler: (q, s, p) => this.handleDomContext(p![0], q, s) },
    { method: 'POST', pattern: /^\/api\/providers\/([^/]+)\/auto-implement$/,        handler: (q, s, p) => this.handleAutoImplement(p![0], q, s) },
    { method: 'POST', pattern: /^\/api\/providers\/([^/]+)\/auto-implement\/cancel$/,handler: (q, s, p) => this.handleAutoImplCancel(p![0], q, s) },
    { method: 'GET',  pattern: /^\/api\/providers\/([^/]+)\/auto-implement\/status$/,handler: (q, s, p) => this.handleAutoImplSSE(p![0], q, s) },
    { method: 'POST', pattern: /^\/api\/providers\/([^/]+)\/spawn-test$/,            handler: (q, s, p) => this.handleSpawnTest(p![0], q, s) },
    { method: 'POST', pattern: /^\/api\/providers\/([^/]+)\/validate$/,              handler: (q, s, p) => this.handleValidate(p![0], q, s) },
    { method: 'POST', pattern: /^\/api\/providers\/([^/]+)\/acp-chat$/,              handler: (q, s, p) => this.handleAcpChat(p![0], q, s) },
    { method: 'GET',  pattern: /^\/api\/providers\/([^/]+)\/script-hints$/,          handler: (q, s, p) => this.handleScriptHints(p![0], q, s) },
  ];

  private matchRoute(method: string, pathname: string): { handler: (req: http.IncomingMessage, res: http.ServerResponse, params?: string[]) => Promise<void> | void; params?: string[] } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (typeof route.pattern === 'string') {
        if (pathname === route.pattern) return { handler: route.handler };
      } else {
        const m = pathname.match(route.pattern);
        if (m) return { handler: route.handler, params: m.slice(1) };
      }
    }
    return null;
  }

  private getEndpointList(): string[] {
    return this.routes.map(r => {
      const path = typeof r.pattern === 'string'
        ? r.pattern
        : r.pattern.source.replace(/\\\//g, '/').replace(/\(\[.*?\]\+\)/g, ':type').replace(/[\^$]/g, '');
      return `${r.method.padEnd(5)} ${path}`;
    });
  }

  async start(port = DEV_SERVER_PORT): Promise<void> {
    this.server = http.createServer(async (req, res) => {
      // CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      const url = new URL(req.url || '/', `http://localhost:${port}`);
      const pathname = url.pathname;

      try {
        // ─── Route Table ───
        const route = this.matchRoute(req.method || 'GET', pathname);
        if (route) {
          await route.handler(req, res, route.params);
        } else if (pathname.startsWith('/assets/') || pathname === '/favicon.ico') {
          await this.serveStaticAsset(pathname, res);
        } else if (pathname === '/' || pathname === '/console' || !pathname.startsWith('/api')) {
          await this.serveConsole(req, res);
        } else {
          this.json(res, 404, { error: 'Not found', endpoints: this.getEndpointList() });
        }
      } catch (e: any) {
        this.log(`Error: ${e.message}`);
        this.json(res, 500, { error: e.message });
      }
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(port, '127.0.0.1', () => {
        this.log(`Dev server listening on http://127.0.0.1:${port}`);
        resolve();
      });
      this.server!.on('error', (e: any) => {
        if (e.code === 'EADDRINUSE') {
          this.log(`Port ${port} in use, skipping dev server`);
          resolve(); // non-fatal
        } else {
          reject(e);
        }
      });
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  // ─── Handlers ───

  private async handleListProviders(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const providers = this.providerLoader.getAll().map(toProviderListEntry);
    this.json(res, 200, { providers, count: providers.length, sourceConfig: this.providerLoader.getSourceConfig() });
  }

  private async handleGetProviderSourceConfig(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.json(res, 200, { success: true, sourceConfig: this.providerLoader.getSourceConfig() });
  }

  private async handleSetProviderSourceConfig(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const parsed = parseProviderSourceConfigUpdate(body || {});
    if (!parsed.ok) {
      this.json(res, 400, { success: false, error: parsed.error });
      return;
    }

    const currentConfig = loadConfig();
    const nextConfig = {
      ...currentConfig,
      ...(parsed.updates.providerSourceMode ? { providerSourceMode: parsed.updates.providerSourceMode } : {}),
      ...(Object.prototype.hasOwnProperty.call(parsed.updates, 'providerDir') ? { providerDir: parsed.updates.providerDir } : {}),
    };
    saveConfig(nextConfig);

    const sourceConfig = this.providerLoader.applySourceConfig({
      sourceMode: nextConfig.providerSourceMode,
      userDir: Object.prototype.hasOwnProperty.call(parsed.updates, 'providerDir') ? parsed.updates.providerDir : this.providerLoader.getSourceConfig().explicitProviderDir || undefined,
    });
    this.providerLoader.reload();
    this.providerLoader.registerToDetector();
    await this.onProviderSourceConfigChanged?.();

    this.json(res, 200, { success: true, reloaded: true, sourceConfig });
  }

  private async handleProviderConfig(type: string, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const provider = this.providerLoader.resolve(type);
    if (!provider) {
      this.json(res, 404, { error: `Provider not found: ${type}` });
      return;
    }
    // Return full config (sans functions being serialized, just keys)
    const config: any = { ...provider };
    // Convert scripts to list of names
    if (config.scripts) {
      config.scriptNames = Object.keys(config.scripts).filter(k => typeof config.scripts[k] === 'function');
      delete config.scripts;
    }
    this.json(res, 200, { type, config });
  }

  private async handleSpawnTest(type: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const provider = this.providerLoader.resolve(type);
    if (!provider) {
      this.json(res, 404, { error: `Provider not found: ${type}` });
      return;
    }

    const spawn = provider.spawn;
    if (!spawn) {
      this.json(res, 400, { error: `Provider ${type} has no spawn config` });
      return;
    }

    const { spawn: spawnFn } = await import('child_process');
    const start = Date.now();
    try {
      const child = spawnFn(spawn.command, [...(spawn.args || [])], {
        shell: spawn.shell ?? false,
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString().slice(0, 2000); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString().slice(0, 2000); });

      // Wait for first output or exit (max 3s)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
        child.on('exit', () => { clearTimeout(timer); resolve(); });
        child.stdout?.once('data', () => { setTimeout(() => { child.kill(); clearTimeout(timer); resolve(); }, 500); });
      });

      const elapsed = Date.now() - start;
      this.json(res, 200, {
        success: true,
        command: `${spawn.command} ${(spawn.args || []).join(' ')}`,
        elapsed,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: child.exitCode,
      });
    } catch (e: any) {
      const elapsed = Date.now() - start;
      this.json(res, 200, {
        success: false,
        command: `${spawn.command} ${(spawn.args || []).join(' ')}`,
        elapsed,
        error: e.message,
      });
    }
  }

  public async handleRunScript(type: string, req: http.IncomingMessage, res: http.ServerResponse, parsedBody?: any): Promise<void> {
    const body = parsedBody || await this.readBody(req);
    const { script: scriptName, params, args, ideType: scriptIdeType } = body;
    const rawParams = args !== undefined ? args : params;

    const provider = this.providerLoader.resolve(type);
    if (!provider) {
      this.json(res, 404, { error: `Provider '${type}' not found` });
      return;
    }

    const fn = provider.scripts?.[scriptName];
    if (typeof fn !== 'function') {
      this.json(res, 400, { error: `Script '${scriptName}' not found in provider '${type}'`, available: provider.scripts ? Object.keys(provider.scripts) : [] });
      return;
    }

    const cdp = this.getCdp(scriptIdeType || type);
    if (!cdp) {
      this.json(res, 503, { error: 'No CDP connection available' });
      return;
    }

    try {
      const scriptCode = resolveLegacyProviderScript(fn as LegacyStringScript, scriptName, rawParams);
      if (!scriptCode) {
        this.json(res, 500, { error: 'Script function returned null' });
        return;
      }
      this.log(`Exec script length: ${scriptCode.length}, first 50 chars: ${scriptCode.slice(0, 50)}...`);

      // Execute based on provider category
      const isWebviewScript = scriptName.toLowerCase().includes('webview');
      let raw: any;
      if (provider.category === 'extension' && !isWebviewScript) {
        // Extension scripts: prefer the requested agent webview session.
        const sessions = cdp.getAgentSessions();
        let sessionId: string | null = null;
        for (const [sid, target] of sessions) {
          if (target.agentType === type) { sessionId = sid; break; }
        }
        if (!sessionId) {
          try {
            const discovered = await cdp.discoverAgentWebviews();
            const target = discovered.find((entry) => entry.agentType === type);
            if (target) {
              sessionId = await cdp.attachToAgent(target);
            }
          } catch (error) {
            this.log(`Extension attach fallback failed for ${type}: ${(error as Error)?.message || String(error)}`);
          }
        }
        if (sessionId) {
          raw = await cdp.evaluateInSessionFrame(sessionId, scriptCode);
        } else if (cdp.evaluateInWebviewFrame) {
          // Fallback: try evaluateInWebviewFrame
          const matchText = provider.webviewMatchText;
          const matchFn = matchText ? (body: string) => body.includes(matchText) : undefined;
          raw = await cdp.evaluateInWebviewFrame(scriptCode, matchFn);
        } else {
          raw = await cdp.evaluate(scriptCode, 30000);
        }
      } else if (isWebviewScript && cdp.evaluateInWebviewFrame) {
        const matchText = provider.webviewMatchText;
        const matchFn = matchText ? (body: string) => body.includes(matchText) : undefined;
        raw = await cdp.evaluateInWebviewFrame(scriptCode, matchFn);
      } else {
        raw = await cdp.evaluate(scriptCode, 30000);
      }

      let result = raw;
      if (typeof raw === 'string') {
        try { result = JSON.parse(raw); } catch { /* keep */ }
      }
      this.log(`Script raw debug: typeof=${typeof raw}, raw=${JSON.stringify(raw)}, parsed=${JSON.stringify(result)}`);
      this.json(res, 200, { type, script: scriptName, result });
    } catch (e: any) {
      this.json(res, 500, { error: `Script execution failed: ${e.message}` });
    }
  }

  private async handleCdpEvaluate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return handleCdpEvaluate(this, req, res);
  }

  private async handleCdpClick(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return handleCdpClick(this, req, res);
  }

  private async handleCdpDomQuery(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return handleCdpDomQuery(this, req, res);
  }

  private async handleScreenshot(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return handleScreenshot(this, req, res);
  }

  private async handleScriptsRun(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return handleScriptsRun(this, req, res);
  }

  private async handleStatus(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const providers = this.providerLoader.getAll().map(p => ({
      type: p.type, name: p.name, category: p.category,
    }));

    const cdpStatus: Record<string, { connected: boolean }> = {};
    for (const [key, cdp] of this.cdpManagers.entries()) {
      cdpStatus[key] = { connected: cdp.isConnected };
    }

    this.json(res, 200, {
      devMode: true,
      providers,
      cdp: cdpStatus,
      uptime: process.uptime(),
    });
  }

  private async handleReload(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      this.providerLoader.reload();
      let refreshedInstances = 0;
      if (this.instanceManager) {
        for (const id of this.instanceManager.listInstanceIds()) {
          const instance = this.instanceManager.getInstance(id) as any;
          const providerType = typeof instance?.type === 'string' ? instance.type : '';
          if (!providerType) continue;
          const resolved = this.providerLoader.resolve(providerType);
          if (!resolved) continue;
          if (instance && typeof instance === 'object' && 'provider' in instance) {
            instance.provider = resolved;
            refreshedInstances += 1;
          }
        }
      }
      const providers = this.providerLoader.getAll().map(p => ({
        type: p.type, name: p.name, category: p.category,
      }));
      for (const cdp of this.cdpManagers.values()) {
        if (!cdp.isConnected) {
          cdp.clearTargetId();
        }
      }
      this.json(res, 200, { reloaded: true, refreshedInstances, providers });
    } catch (e: any) {
      this.json(res, 500, { error: e.message });
    }
  }

  // ─── DevConsole SPA ───

  private getConsoleDistDir(): string | null {
    // Try to find web-devconsole/dist (Vite build output)
    const candidates = [
      path.resolve(__dirname, '../../web-devconsole/dist'),
      path.resolve(__dirname, '../../../web-devconsole/dist'),
      path.join(process.cwd(), 'packages/web-devconsole/dist'),
    ];
    for (const dir of candidates) {
      if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
    }
    return null;
  }

  private async serveConsole(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const distDir = this.getConsoleDistDir();
    if (!distDir) {
      this.json(res, 500, { error: 'DevConsole not found. Run: npm run build -w packages/web-devconsole' });
      return;
    }
    const htmlPath = path.join(distDir, 'index.html');
    try {
      const html = fs.readFileSync(htmlPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e: any) {
      this.json(res, 500, { error: `Cannot read index.html: ${e.message}` });
    }
  }

  // ─── Static Assets ───

  private static MIME_MAP: Record<string, string> = {
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };

  private async serveStaticAsset(pathname: string, res: http.ServerResponse): Promise<void> {
    const distDir = this.getConsoleDistDir();
    if (!distDir) {
      this.json(res, 404, { error: 'Not found' });
      return;
    }
    // Prevent directory traversal
    const safePath = path.normalize(pathname).replace(/^\.\.\//, '');
    const filePath = path.join(distDir, safePath);
    if (!filePath.startsWith(distDir)) {
      this.json(res, 403, { error: 'Forbidden' });
      return;
    }
    try {
      const content = fs.readFileSync(filePath);
      const ext = path.extname(filePath);
      const contentType = DevServer.MIME_MAP[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=31536000, immutable' });
      res.end(content);
    } catch {
      this.json(res, 404, { error: 'Not found' });
    }
  }

  // ─── Watch Mode (SSE) ───

  private handleSSE(_req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('data: {"type":"connected"}\n\n');
    this.sseClients.push(res);
    _req.on('close', () => {
      this.sseClients = this.sseClients.filter(c => c !== res);
    });
  }

  private sendSSE(data: any): void {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      try { client.write(msg); } catch { /* ignore */ }
    }
  }

  private async handleWatchStart(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const { type, script: scriptName, interval = 2000 } = body;
    if (!type) {
      this.json(res, 400, { error: 'type required' });
      return;
    }

    this.watchScriptPath = type;
    this.watchScriptName = scriptName || 'readChat';

    // Stop any existing watch
    if (this.watchTimer) clearInterval(this.watchTimer);

    this.log(`Watch started: ${type} → ${this.watchScriptName} (every ${interval}ms)`);
    this.sendSSE({ type: 'watch_started', provider: type, script: this.watchScriptName });

    const runWatch = async () => {
      if (!this.watchScriptPath) return;
      const provider = this.providerLoader.resolve(this.watchScriptPath);
      if (!provider) {
        this.sendSSE({ type: 'watch_error', error: `Provider '${this.watchScriptPath}' not found` });
        return;
      }
      const fn = provider.scripts?.[this.watchScriptName!];
      if (typeof fn !== 'function') {
        this.sendSSE({ type: 'watch_error', error: `Script '${this.watchScriptName}' not found` });
        return;
      }
      const cdp = this.getCdp();
      if (!cdp) {
        this.sendSSE({ type: 'watch_error', error: 'No CDP connection' });
        return;
      }
      try {
        const script = fn();
        const start = Date.now();
        const raw = await cdp.evaluate(script, 15000);
        const elapsed = Date.now() - start;
        let result = raw;
        if (typeof raw === 'string') {
          try { result = JSON.parse(raw); } catch { /* keep */ }
        }
        this.sendSSE({ type: 'watch_result', provider: type, script: this.watchScriptName, result, elapsed });
      } catch (e: any) {
        this.sendSSE({ type: 'watch_error', error: e.message });
      }
    };

    // Run immediately then on interval
    runWatch();
    this.watchTimer = setInterval(runWatch, Math.max(interval, 500));

    this.json(res, 200, { watching: true, type, script: this.watchScriptName, interval });
  }

  private async handleWatchStop(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
    this.watchScriptPath = null;
    this.watchScriptName = null;
    this.sendSSE({ type: 'watch_stopped' });
    this.json(res, 200, { watching: false });
  }

  // ─── Provider File Explorer ───

  /** Find the provider directory on disk */
  public findProviderDir(type: string): string | null {
    return this.providerLoader.findProviderDir(type);
  }

  /** GET /api/providers/:type/files — list all files in provider directory */
  private async handleListFiles(type: string, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const dir = this.findProviderDir(type);
    if (!dir) { this.json(res, 404, { error: `Provider directory not found: ${type}` }); return; }

    const files: { path: string; size: number; type: 'file' | 'dir' }[] = [];
    const scan = (d: string, prefix: string) => {
      try {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          if (entry.name.startsWith('.') || entry.name.endsWith('.bak')) continue;
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            files.push({ path: rel, size: 0, type: 'dir' });
            scan(path.join(d, entry.name), rel);
          } else {
            const stat = fs.statSync(path.join(d, entry.name));
            files.push({ path: rel, size: stat.size, type: 'file' });
          }
        }
      } catch { /* ignore */ }
    };
    scan(dir, '');
    this.json(res, 200, { type, dir, files });
  }

  /** GET /api/providers/:type/file?path=scripts.js — read a file */
  private async handleReadFile(type: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');
    const filePath = url.searchParams.get('path');
    if (!filePath) { this.json(res, 400, { error: 'path query param required' }); return; }

    const dir = this.findProviderDir(type);
    if (!dir) { this.json(res, 404, { error: `Provider directory not found: ${type}` }); return; }

    // Prevent directory traversal
    const fullPath = path.resolve(dir, path.normalize(filePath));
    if (!fullPath.startsWith(dir)) { this.json(res, 403, { error: 'Forbidden' }); return; }
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
      this.json(res, 404, { error: `File not found: ${filePath}` }); return;
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    this.json(res, 200, { type, path: filePath, content, lines: content.split('\n').length });
  }

  /** POST /api/providers/:type/file — write a file { path, content } */
  private async handleWriteFile(type: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const { path: filePath, content } = body;
    if (!filePath || typeof content !== 'string') {
      this.json(res, 400, { error: 'path and content required' }); return;
    }

    const dir = this.findProviderDir(type);
    if (!dir) { this.json(res, 404, { error: `Provider directory not found: ${type}` }); return; }

    const fullPath = path.resolve(dir, path.normalize(filePath));
    if (!fullPath.startsWith(dir)) { this.json(res, 403, { error: 'Forbidden' }); return; }

    try {
      if (fs.existsSync(fullPath)) fs.copyFileSync(fullPath, fullPath + '.bak');
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf-8');
      this.log(`File saved: ${fullPath} (${content.length} chars)`);
      this.providerLoader.reload();
      this.json(res, 200, { saved: true, path: filePath, chars: content.length });
    } catch (e: any) {
      this.json(res, 500, { error: `Save failed: ${e.message}` });
    }
  }

  // ─── Legacy Source/Save compat ───

  private async handleSource(type: string, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const dir = this.findProviderDir(type);
    if (!dir) { this.json(res, 404, { error: `Provider not found: ${type}` }); return; }
    for (const name of ['scripts.js', 'provider.json']) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) {
        const source = fs.readFileSync(p, 'utf-8');
        this.json(res, 200, { type, path: p, source, lines: source.split('\n').length });
        return;
      }
    }
    this.json(res, 404, { error: `Source file not found for '${type}'` });
  }

  private async handleSave(type: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const { source } = body;
    if (!source || typeof source !== 'string') {
      this.json(res, 400, { error: 'source (string) required' }); return;
    }
    const dir = this.findProviderDir(type);
    if (!dir) { this.json(res, 404, { error: `Provider not found: ${type}` }); return; }
    // Save to scripts.js if it exists, otherwise provider.json
    const target = fs.existsSync(path.join(dir, 'scripts.js')) ? 'scripts.js' : 'provider.json';
    const targetPath = path.join(dir, target);
    try {
      if (fs.existsSync(targetPath)) fs.copyFileSync(targetPath, targetPath + '.bak');
      fs.writeFileSync(targetPath, source, 'utf-8');
      this.log(`Saved provider: ${targetPath} (${source.length} chars)`);
      this.providerLoader.reload();
      this.json(res, 200, { saved: true, path: targetPath, chars: source.length });
    } catch (e: any) {
      this.json(res, 500, { error: `Save failed: ${e.message}` });
    }
  }

  private async handleTypeAndSend(type: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return handleTypeAndSend(this, type, req, res);
  }

  private async handleTypeAndSendAt(type: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return handleTypeAndSendAt(this, type, req, res);
  }

  private async handleScriptHints(type: string, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return handleScriptHints(this, type, _req, res);
  }

  // ─── Validate provider.json ───
  private async handleValidate(type: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const { content } = body;
    const errors: string[] = [];
    const warnings: string[] = [];
    try {
      const config = typeof content === 'string' ? JSON.parse(content) : content;
      const validation = validateProviderDefinition(config);
      errors.push(...validation.errors);
      warnings.push(...validation.warnings);
      // Settings validation
      if (config.settings) {
        for (const [key, val] of Object.entries(config.settings)) {
          const s = val as Partial<ProviderSettingDef>;
          if (!s.type) errors.push(`settings.${key}: missing type`);
          else if (!['boolean', 'number', 'string', 'select'].includes(s.type))
            errors.push(`settings.${key}: invalid type '${s.type}'`);
          if (s.default === undefined) warnings.push(`settings.${key}: no default value`);
          if (s.type === 'number' && s.min !== undefined && s.max !== undefined && s.min > s.max)
            errors.push(`settings.${key}: min (${s.min}) > max (${s.max})`);
          if (s.type === 'select' && (!s.options || !Array.isArray(s.options) || s.options.length === 0))
            errors.push(`settings.${key}: select type requires options[]`);
        }
      }
      // Port conflicts
      if (config.cdpPorts && Array.isArray(config.cdpPorts)) {
        const allProviders = this.providerLoader.getAll();
        for (const port of config.cdpPorts) {
          const conflict = allProviders.find(p => p.type !== type && p.cdpPorts?.includes(port));
          if (conflict) warnings.push(`CDP port ${port} conflicts with provider '${conflict.type}'`);
        }
      }
      this.json(res, 200, { valid: errors.length === 0, errors, warnings });
    } catch (e: any) {
      this.json(res, 200, { valid: false, errors: [`Invalid JSON: ${e.message}`], warnings: [] });
    }
  }

  // ─── ACP Chat Test ───
  private async handleAcpChat(type: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const { message, timeout = 30000 } = body;
    if (!message) { this.json(res, 400, { error: 'message required' }); return; }
    const provider = this.providerLoader.getMeta(type);
    if (!provider) { this.json(res, 404, { error: `Provider not found: ${type}` }); return; }
    const spawn = provider.spawn;
    if (!spawn) { this.json(res, 400, { error: `Provider ${type} has no spawn config` }); return; }

    const { spawn: spawnFn } = await import('child_process');
    const start = Date.now();
    try {
      const args = [...(spawn.args || []), message];
      const child = spawnFn(spawn.command, args, {
        shell: spawn.shell ?? false,
        timeout: timeout,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...(spawn.env || {}) },
      });

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill(); resolve(); }, timeout);
        child.on('exit', () => { clearTimeout(timer); resolve(); });
      });

      const elapsed = Date.now() - start;
      this.json(res, 200, {
        success: true,
        message,
        response: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: child.exitCode,
        elapsed,
      });
    } catch (e: any) {
      this.json(res, 200, {
        success: false,
        message,
        error: e.message,
        elapsed: Date.now() - start,
      });
    }
  }


  private async handleCdpTargets(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return handleCdpTargets(this, _req, res);
  }

  // ─── Scaffold ───

  private async handleScaffold(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const { type, name, category = 'ide', location = 'user',
      cdpPorts, cli, processName, installPath, binary, extensionId, version, osPaths, processNames } = body;
    if (!type || !name) {
      this.json(res, 400, { error: 'type and name required' });
      return;
    }

    let targetDir: string;
    targetDir = this.providerLoader.getUserProviderDir(category, type);

    const jsonPath = path.join(targetDir, 'provider.json');
    if (fs.existsSync(jsonPath)) {
      this.json(res, 409, { error: `Provider already exists at ${targetDir}`, path: targetDir });
      return;
    }

    try {
      const result = genScaffoldFiles(type, name, category, { cdpPorts, cli, processName, installPath, binary, extensionId, version, osPaths, processNames });
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(jsonPath, result['provider.json'], 'utf-8');
      const createdFiles = ['provider.json'];

      // Write per-function script files (new structure)
      if (result.files) {
        for (const [relPath, content] of Object.entries(result.files)) {
          const fullPath = path.join(targetDir, relPath);
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, content, 'utf-8');
          createdFiles.push(relPath);
        }
      }

      this.log(`Scaffolded provider: ${targetDir} (${createdFiles.length} files)`);
      this.json(res, 201, { created: true, path: targetDir, files: createdFiles, type, name, category });
    } catch (e: any) {
      this.json(res, 500, { error: e.message });
    }
  }

  // ─── Version Detection ───

  private async handleDetectVersions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const archive = new VersionArchive();
      const results = await detectAllVersions(this.providerLoader, archive);
      const installed = results.filter(r => r.installed);
      const notInstalled = results.filter(r => !r.installed);
      this.json(res, 200, {
        total: results.length,
        installed: installed.length,
        providers: results,
        history: archive.getAll(),
      });
    } catch (e: any) {
      this.json(res, 500, { error: e.message });
    }
  }

  // ─── DOM Inspector ───

  private async handleDomInspect(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return handleDomInspect(this, req, res);
  }

  private async handleDomChildren(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return handleDomChildren(this, req, res);
  }

  private async handleDomAnalyze(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return handleDomAnalyze(this, req, res);
  }

  private async handleFindCommon(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return handleFindCommon(this, req, res);
  }

  private async handleFindByText(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return handleFindByText(this, req, res);
  }

  // ─── Phase 1: DOM Context API ───

  private async handleDomContext(type: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return handleDomContext(this, type, req, res);
  }

  // ─── Phase 2: Auto-Implement Backend ───



  public getLatestScriptVersionDir(scriptsDir: string): string | null {
    if (!fs.existsSync(scriptsDir)) return null;

    const versions = fs.readdirSync(scriptsDir)
      .filter((d: string) => {
        try { return fs.statSync(path.join(scriptsDir, d)).isDirectory(); } catch { return false; }
      })
      .sort((a: string, b: string) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));

    if (versions.length === 0) return null;
    return path.join(scriptsDir, versions[0]);
  }

  private resolveAutoImplWritableProviderDir(
    category: ProviderCategory,
    type: string,
    requestedDir?: string,
  ): { dir: string | null; reason?: string } {
    const canonicalUserDir = path.resolve(this.providerLoader.getUserProviderDir(category, type));
    const desiredDir = requestedDir ? path.resolve(requestedDir) : canonicalUserDir;
    const upstreamRoot = path.resolve(this.providerLoader.getUpstreamDir());
    if (desiredDir === upstreamRoot || desiredDir.startsWith(`${upstreamRoot}${path.sep}`)) {
      return { dir: null, reason: `Refusing to write into upstream provider directory: ${desiredDir}` };
    }

    if (path.basename(desiredDir) !== type) {
      return { dir: null, reason: `Requested writable provider directory must end with '${type}': ${desiredDir}` };
    }

    const sourceDir = this.findProviderDir(type);
    if (!sourceDir) {
      return { dir: null, reason: `Provider source directory not found for '${type}'` };
    }

    if (!fs.existsSync(desiredDir)) {
      fs.mkdirSync(path.dirname(desiredDir), { recursive: true });
      fs.cpSync(sourceDir, desiredDir, { recursive: true });
      this.log(`Auto-implement writable copy created: ${desiredDir}`);
    }

  const providerJson = path.join(desiredDir, 'provider.json');
  if (!fs.existsSync(providerJson)) {
    return { dir: null, reason: `provider.json not found in writable provider directory: ${desiredDir}` };
  }

  return { dir: desiredDir };
}


  private async handleAutoImplement(type: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return handleAutoImplement(this, type, req, res);
  }

  private buildAutoImplPrompt(
    type: string,
    provider: any,
    providerDir: string,
    functions: string[],
    domContext: any,
    referenceScripts: Record<string, string>,
    userComment?: string,
    referenceType?: string | null,
  ): string {
    if (provider.category === 'cli') {
      return this.buildCliAutoImplPrompt(type, provider, providerDir, functions, referenceScripts, userComment, referenceType);
    }

    const lines: string[] = [];

    // ── System instructions ──
    lines.push('You are implementing browser automation scripts for an IDE provider.');
    lines.push('Be concise. Do NOT explain your reasoning. Just edit files directly.');
    lines.push('');

    // ── Target ──
    lines.push(`# Target: ${provider.name || type} (${type})`);
    lines.push(`Provider directory: \`${providerDir}\``);
    lines.push('');

    // ── funcToFile mapping (needed early for file classification) ──
    const funcToFile: Record<string, string> = {
      readChat: 'read_chat.js', sendMessage: 'send_message.js',
      resolveAction: 'resolve_action.js', listSessions: 'list_sessions.js',
      listChats: 'list_chats.js', switchSession: 'switch_session.js',
      newSession: 'new_session.js', focusEditor: 'focus_editor.js',
      openPanel: 'open_panel.js', listModels: 'list_models.js',
      listModes: 'list_modes.js', setModel: 'set_model.js', setMode: 'set_mode.js',
    };
    const targetFileNames = new Set(functions.map(fn => funcToFile[fn]).filter(Boolean));

    // ── Existing target files (inline, so no reading needed) ──
    const scriptsDir = path.join(providerDir, 'scripts');
    const latestScriptsDir = this.getLatestScriptVersionDir(scriptsDir);
    if (latestScriptsDir) {
      lines.push(`Scripts version directory: \`${latestScriptsDir}\``);
      lines.push('');

      // Target files: editable
      lines.push('## ✏️ Target Files (EDIT THESE)');
      lines.push('These are the ONLY files you are allowed to modify. Replace the TODO stubs with working implementations.');
      lines.push('');
      for (const file of fs.readdirSync(latestScriptsDir)) {
        if (file.endsWith('.js') && targetFileNames.has(file)) {
          try {
            const content = fs.readFileSync(path.join(latestScriptsDir, file), 'utf-8');
            lines.push(`### \`${file}\` ✏️ EDIT`);
            lines.push('```javascript');
            lines.push(content);
            lines.push('```');
            lines.push('');
          } catch { /* skip */ }
        }
      }

      // Non-target files: reference only
      const refFiles = fs.readdirSync(latestScriptsDir).filter(f => f.endsWith('.js') && !targetFileNames.has(f));
      if (refFiles.length > 0) {
        lines.push('## 🔒 Other Scripts (REFERENCE ONLY — DO NOT EDIT)');
        lines.push('These files are shown for context only. Do NOT modify them under any circumstances.');
        lines.push('');
        for (const file of refFiles) {
          try {
            const content = fs.readFileSync(path.join(latestScriptsDir, file), 'utf-8');
            lines.push(`### \`${file}\` 🔒`);
            lines.push('```javascript');
            lines.push(content);
            lines.push('```');
            lines.push('');
          } catch { /* skip */ }
        }
      }
    }

    // ── DOM context ──
    if (domContext) {
      lines.push('## Live DOM Analysis (from CDP)');
      lines.push('Use these selectors in your implementations:');
      lines.push('```json');
      lines.push(JSON.stringify(domContext, null, 2));
      lines.push('```');
      lines.push('');
    }

    // ── Reference implementation ── (funcToFile already defined above)

    if (Object.keys(referenceScripts).length > 0) {
      lines.push(`## Reference Implementation (from ${referenceType || 'antigravity'} provider)`);
      lines.push('These are WORKING scripts from another IDE. Adapt the PATTERNS (not selectors) for the target IDE.');
      lines.push('');
      for (const fn of functions) {
        const fileName = funcToFile[fn];
        if (fileName && referenceScripts[fileName]) {
          lines.push(`### ${fn} → \`${fileName}\``);
          lines.push('```javascript');
          lines.push(referenceScripts[fileName]);
          lines.push('```');
          lines.push('');
        }
      }
      if (referenceScripts['scripts.js']) {
        lines.push('### Router → `scripts.js`');
        lines.push('```javascript');
        lines.push(referenceScripts['scripts.js']);
        lines.push('```');
        lines.push('');
      }
    }

    // ── Markdown Guides (Provider Fix) ──
    const docsDir = path.join(providerDir, '../../docs');
    const loadGuide = (name: string) => {
      try {
        const p = path.join(docsDir, name);
        if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
      } catch { /* ignore */ }
      return null;
    };

    const providerGuide = loadGuide('PROVIDER_GUIDE.md');
    if (providerGuide) {
      lines.push('## Documentation: PROVIDER_GUIDE.md');
      lines.push('```markdown');
      lines.push(providerGuide);
      lines.push('```');
      lines.push('');
    }

    const cdpGuide = loadGuide('CDP_SELECTOR_GUIDE.md');
    if (cdpGuide) {
      lines.push('## Documentation: CDP_SELECTOR_GUIDE.md');
      lines.push('```markdown');
      lines.push(cdpGuide);
      lines.push('```');
      lines.push('');
    }

    // ── Task ──
    lines.push('## Task');
    lines.push(`Edit files in \`${providerDir}\` to implement: **${functions.join(', ')}**`);
    lines.push('');

    // ── Rules ──
    lines.push('## Rules');
    lines.push('0. **🚫 SCOPE CONSTRAINT**: You may ONLY edit files marked ✏️ EDIT above. ALL other files are READ-ONLY. Do NOT modify, rewrite, refactor, or "improve" any file not explicitly marked as editable — even if you notice bugs or improvements. No exceptions.');
    lines.push('1. **Scripts WITHOUT params** → IIFE: `(() => { ... })()`');
    lines.push('2. **Scripts WITH params** → arrow: `(params) => { ... }` — router calls `(${script})(${JSON.stringify(params)})`');
    lines.push('3. If live DOM analysis is included above, use it. Otherwise, discover selectors yourself via CDP before coding.');
    lines.push('4. Always wrap in try-catch, return `JSON.stringify(result)`');
    lines.push('5. Do NOT modify `scripts.js` router — only edit individual `*.js` files');
    lines.push('6. All scripts run in the browser (CDP evaluate) — use DOM APIs only');
    lines.push('7. **Cross-Platform Compatibility**: If you use ARIA labels that contain keyboard shortcuts (e.g., `Cascade (⌘L)`), you MUST use substring matches (`aria-label*="Cascade"`) or handle both macOS (`⌘`, `Cmd`) and Windows (`Ctrl`) so the script does not break on other operating systems.');
    lines.push('8. **CRITICAL: DO NOT explore the filesystem or read other providers.** The reference implementation pattern is already provided below. Do not run `find`, `rg`, or `cat` on upstream providers. Doing so wastes context tokens and will crash the agent session. Focus entirely on modifying the target files.');
    lines.push('9. Do NOT delete any files. Implement the logic by replacing the empty stubs.');
    lines.push('');

    // ── Output contracts ──
    lines.push('## Required Return Format');
    lines.push('| Function | Return JSON |');
    lines.push('|---|---|');
    lines.push('| readChat | `{ id, status, title, messages: [{role, content, index, kind?, meta?}], inputContent, activeModal, controlValues?, summaryMetadata? }` — optional `kind`: standard, thought, tool, terminal; prefer explicit `controlValues` for current selections and `summaryMetadata` for compact always-visible UI metadata |');
    lines.push('| sendMessage | `{ sent: false, needsTypeAndSend: true, selector }` |');
    lines.push('| resolveAction | `{ resolved: true/false, clicked? }` |');
    lines.push('| listSessions | `{ sessions: [{ id, title, active, index }] }` |');
    lines.push('| switchSession | `{ switched: true/false }` |');
    lines.push('| newSession | `{ created: true/false }` |');
    lines.push('| listModels | `{ models: [{ name, id }], current }` |');
    lines.push('| setModel | `{ success: true/false }` |');
    lines.push('| listModes | `{ modes: [{ name, id }], current }` |');
    lines.push('| setMode | `{ success: true/false }` |');
    lines.push('| focusEditor | `{ focused: true/false, error? }` |');
    lines.push('| openPanel | `{ opened: true/false, visible: true/false, focused?: true, error? }` |');
    lines.push('');

    // ── readChat.status lifecycle spec ──
    lines.push('## 🔴 CRITICAL: readChat `status` Lifecycle');
    lines.push('The `status` field in readChat controls how the dashboard and daemon auto-approve-loop behave.');
    lines.push('Getting this wrong will break the entire automation pipeline. The status MUST reflect the ACTUAL current state:');
    lines.push('');
    lines.push('| Status | When to use | How to detect |');
    lines.push('|---|---|---|');
    lines.push('| `idle` | AI is NOT generating, no approval needed | Default state. No stop button, no spinners, no approval pills/buttons |');
    lines.push('| `generating` | AI is actively streaming/thinking | ANY of: (1) Submit button icon SVG changes (e.g. arrow→stop square, fill="none"→fill="currentColor"), (2) Stop/Cancel button visible, (3) CSS animation, (4) Structural markers (aria-labels that only appear during generation) |');
    lines.push('| `waiting_approval` | AI stopped and needs user action | Actionable buttons like Run/Skip/Accept/Reject are visible AND clickable |');
    lines.push('');
    lines.push('### ⚠️ Status Detection Gotchas (MUST READ!)');
    lines.push('1. **DO NOT rely on button text/labels in the user\'s language.** OS locale may be Korean, Japanese, etc. Button text like "Cancel" or "Stop" will be localized. Instead, detect STRUCTURAL indicators: SVG icon changes, CSS classes, aria-labels from the extension\'s own React/Radix UI (which stay in English regardless of OS locale).');
    lines.push('2. **Use sendMessage to CREATE a generating state, then CAPTURE the DOM.** Send a LONG prompt (e.g. "Write an extremely detailed 5000-word essay...") so the AI takes 10+ seconds. Then periodically capture the DOM during generation to find which elements appear/change. Compare idle vs generating DOM snapshots to find reliable structural markers.');
    lines.push('3. **Look for SVG icon changes in the submit button.** Many IDEs change the submit button icon from an arrow (send) to a square (stop) during generation. Check the SVG `fill` attribute or path data.');
    lines.push('4. **FALSE POSITIVES from old messages**: Chat history may contain text like "Command Awaiting Approval" from PAST turns. ONLY match small leaf elements (under 80 chars) or use explicit button/pill selectors.');
    lines.push('5. **Awaiting Approval pill without actions**: Some IDEs show a floating pill/banner that is just a scroll-to indicator. If NO actionable buttons exist, the status should be `idle`, NOT `waiting_approval`.');
    lines.push('6. **activeModal must include actions**: When `status` is `waiting_approval`, the `activeModal` object MUST include a non-empty `actions` array.');
    lines.push('');

    lines.push('## Action');
    lines.push('1. Edit the script files to implement working code');
    lines.push('2. After editing, TEST each function using the DevConsole API (see below)');
    lines.push('3. If a test fails, fix the implementation and re-test');
    lines.push('4. **IMPORTANT VERIFICATION LOGIC**: When verifying your implementation, beware of state contamination! You MUST perform strict Integration Testing:');
    lines.push('   - `openPanel`: Toggle buttons are usually located in the top header, sidebar, or activity bar. Prefer finding and clicking these native UI buttons over extreme CSS injection hacks if possible.');
    lines.push('   - `listSessions`: If sessions are unmounted when the panel is closed, try to explicitly interact with the UI to open the history/sessions view (e.g., clicking a history icon usually found near the chat header) BEFORE scraping.');
    lines.push('   - `switchSession`: Prove your switch was successful by subsequently calling `readChat` and explicitly checking that the chat context has actually changed.');
    lines.push('');

    // ── DevConsole API for verification ──
    lines.push('## DOM Exploration');
    if (domContext) {
      lines.push('A lightweight DOM snapshot is included above, but you MUST still verify selectors yourself before finalizing the scripts.');
    } else {
      lines.push('No DOM snapshot is included here. You MUST use your command-line tools to discover the IDE structure dynamically.');
    }
    lines.push('');
    lines.push('### 1. Evaluate JS to explore IDE DOM');
    lines.push('Use cURL to run JavaScript inside the IDE:');
    lines.push('```bash');
    lines.push(`curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/cdp/evaluate \\`);
    lines.push(`  -H "Content-Type: application/json" \\`);
    lines.push(`  -d '{"expression": "document.body.innerHTML.substring(0, 1000)", "ideType": "${type}"}'`);
    lines.push('```');
    lines.push('');
    lines.push('### 2. Test your generated function');
    lines.push('Once you save the file, test it by running:');
    lines.push('```bash');
    lines.push(`curl -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/providers/reload`);
    lines.push(`curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/scripts/run -H "Content-Type: application/json" -d '{"script": "readChat", "type": "${type}", "ideType": "${type}"}'`);
    lines.push('```');
    lines.push('');
    lines.push('### Task Workflow');
    lines.push('1. Write bash scripts to `curl` the CDP evaluate API above to find exactly where `.chat-message`, etc., are located.');
    lines.push('2. Iteratively explore until you are confident in your selectors.');
    lines.push('3. Edit the `.js` files using the selectors you discovered.');
    lines.push('4. Reload providers and TEST your script via the API.');
    lines.push('');
    lines.push('### 🔥 Advanced UI Parsing (CRUCIAL for `readChat`)');
    lines.push('Your `readChat` must flawlessly parse complex UI elements (tables, code blocks, tool calls, and AI thoughts). The quality must match the `antigravity` reference.');
    lines.push('To achieve this, you MUST generate a live test scenario:');
    lines.push(`1. Early in your process, send a rich prompt to the IDE using the API:`);
    lines.push(`   \`curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/scripts/run -H "Content-Type: application/json" -d '{"script": "sendMessage", "type": "${type}", "ideType": "${type}", "args": {"message": "Write a python script, draw a markdown table, use a tool, and show your reasoning/thought process"}}'\``);
    lines.push('2. Wait a few seconds for the IDE AI to generate these elements in the UI.');
    lines.push('3. Use CDP evaluate to deeply inspect the DOM structure of the newly generated tables, code blocks, thought blocks, and tool calls.');
    lines.push('4. Ensure `readChat` extracts `content` with precise markdown formatting (especially for tables/code) and assigns correct `kind` tags (`thought`, `tool`, `terminal`).');
    lines.push('');

    // ── Mandatory Integration Test ──
    lines.push('## 🧪 MANDATORY: Status Integration Test');
    lines.push('Before finishing, you MUST run this end-to-end test to verify readChat status transitions work:');
    lines.push('');
    lines.push('### Step 1: Baseline — confirm idle');
    lines.push('```bash');
    lines.push(`curl -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/providers/reload`);
    lines.push(`RESULT=$(curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/scripts/run -H "Content-Type: application/json" -d '{"script": "readChat", "type": "${type}", "ideType": "${type}"}')`);
    lines.push(`echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('result',d); r=json.loads(r) if isinstance(r,str) else r; assert r.get('status')=='idle', f'Expected idle, got {r.get(chr(34)+chr(115)+chr(116)+chr(97)+chr(116)+chr(117)+chr(115)+chr(34))}'; print('Step 1 PASS: status=idle')"`);
    lines.push('```');
    lines.push('');
    lines.push('### Step 2: Send a LONG message that triggers extended generation (10+ seconds)');
    lines.push('```bash');
    lines.push(`curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/scripts/run -H "Content-Type: application/json" -d '{"script": "sendMessage", "type": "${type}", "ideType": "${type}", "args": {"message": "Write an extremely detailed 5000-word essay about the history of artificial intelligence from Alan Turing to 2025. Be very thorough and verbose."}}'`);
    lines.push('sleep 3');
    lines.push('```');
    lines.push('');
    lines.push('### Step 3: Check generating OR completed');
    lines.push('The AI may still be generating OR may have finished already. Either generating or idle is acceptable:');
    lines.push('```bash');
    lines.push(`RESULT=$(curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/scripts/run -H "Content-Type: application/json" -d '{"script": "readChat", "type": "${type}", "ideType": "${type}"}')`);
    lines.push(`echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('result',d); r=json.loads(r) if isinstance(r,str) else r; s=r.get('status'); assert s in ('generating','idle','waiting_approval'), f'Unexpected: {s}'; print(f'Step 3 PASS: status={s}')"`);
    lines.push('```');
    lines.push('');
    lines.push('### Step 4: Wait for completion and verify new message');
    lines.push('```bash');
    lines.push('sleep 10');
    lines.push(`RESULT=$(curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/scripts/run -H "Content-Type: application/json" -d '{"script": "readChat", "type": "${type}", "ideType": "${type}"}')`);
    lines.push(`echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('result',d); r=json.loads(r) if isinstance(r,str) else r; s=r.get('status'); msgs=r.get('messages',[]); assert s=='idle', f'Expected idle, got {s}'; assert len(msgs)>0, 'No messages'; print(f'Step 4 PASS: status={s}, messages={len(msgs)}')"`);
    lines.push('```');
    lines.push('');
    lines.push('If ANY step fails, fix your implementation and re-run the test. Do NOT finish until all 4 steps pass.');
    lines.push('');
    // ── User-provided additional instructions ──
    if (userComment) {
      lines.push('## ⚠️ User Instructions (HIGH PRIORITY)');
      lines.push('The user has provided the following additional instructions. Follow them strictly:');
      lines.push('');
      lines.push(userComment);
      lines.push('');
    }

    lines.push('Start NOW. Do not ask for permission. Explore the DOM -> Code -> Test.');

    return lines.join('\n');
  }

  private buildCliAutoImplPrompt(
    type: string,
    provider: any,
    providerDir: string,
    functions: string[],
    referenceScripts: Record<string, string>,
    userComment?: string,
    referenceType?: string | null,
  ): string {
    const lines: string[] = [];

    lines.push('You are implementing PTY parsing scripts for a CLI provider.');
    lines.push('Be concise. Do NOT explain your reasoning. Edit files directly and verify with the local DevServer.');
    lines.push('');

    lines.push(`# Target: ${provider.name || type} (${type})`);
    lines.push(`Provider directory: \`${providerDir}\``);
    lines.push('Provider category: `cli`');
    lines.push('');

    const funcToFile: Record<string, string> = {
      parseOutput: 'parse_output.js',
      detectStatus: 'detect_status.js',
      parseApproval: 'parse_approval.js',
    };
    const targetFileNames = new Set(functions.map(fn => funcToFile[fn]).filter(Boolean));

    const scriptsDir = path.join(providerDir, 'scripts');
    const latestScriptsDir = this.getLatestScriptVersionDir(scriptsDir);
    if (latestScriptsDir) {
      lines.push(`Scripts version directory: \`${latestScriptsDir}\``);
      lines.push('');

      // Target files: editable
      lines.push('## ✏️ Target Files (EDIT THESE)');
      lines.push('These are the ONLY files you are allowed to modify. Replace TODO or heuristic-only logic with working PTY-aware implementations.');
      lines.push('');
      for (const file of fs.readdirSync(latestScriptsDir)) {
        if (!file.endsWith('.js')) continue;
        if (!targetFileNames.has(file)) continue;
        try {
          const content = fs.readFileSync(path.join(latestScriptsDir, file), 'utf-8');
          lines.push(`### \`${file}\` ✏️ EDIT`);
          lines.push('```javascript');
          lines.push(content);
          lines.push('```');
          lines.push('');
        } catch {
          // ignore
        }
      }

      // Non-target files: reference only
      const refFiles = fs.readdirSync(latestScriptsDir).filter(f => f.endsWith('.js') && !targetFileNames.has(f));
      if (refFiles.length > 0) {
        lines.push('## 🔒 Other Scripts (REFERENCE ONLY — DO NOT EDIT)');
        lines.push('These files are shown for context only. Do NOT modify them under any circumstances.');
        lines.push('');
        for (const file of refFiles) {
          try {
            const content = fs.readFileSync(path.join(latestScriptsDir, file), 'utf-8');
            lines.push(`### \`${file}\` 🔒`);
            lines.push('```javascript');
            lines.push(content);
            lines.push('```');
            lines.push('');
          } catch {
            // ignore
          }
        }
      }
    }



    if (Object.keys(referenceScripts).length > 0) {
      lines.push(`## Reference Implementation (from ${referenceType || 'another CLI'} provider)`);
      lines.push('These are working CLI PTY parser scripts. Reuse the parsing shape and runtime contract, but adapt to the target CLI screen.');
      lines.push('');
      for (const fn of functions) {
        const fileName = funcToFile[fn];
        if (fileName && referenceScripts[fileName]) {
          lines.push(`### ${fn} → \`${fileName}\``);
          lines.push('```javascript');
          lines.push(referenceScripts[fileName]);
          lines.push('```');
          lines.push('');
        }
      }
      if (referenceScripts['scripts.js']) {
        lines.push('### Router → `scripts.js`');
        lines.push('```javascript');
        lines.push(referenceScripts['scripts.js']);
        lines.push('```');
        lines.push('');
      }
    }

    // ── Markdown Guides (Provider Fix) ──
    const docsDir = path.join(providerDir, '../../docs');
    const loadGuide = (name: string) => {
      try {
        const p = path.join(docsDir, name);
        if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
      } catch { /* ignore */ }
      return null;
    };

    const providerGuide = loadGuide('PROVIDER_GUIDE.md');
    if (providerGuide) {
      lines.push('## Documentation: PROVIDER_GUIDE.md');
      lines.push('```markdown');
      lines.push(providerGuide);
      lines.push('```');
      lines.push('');
    }

    lines.push('## Runtime Contract');
    lines.push('The daemon runtime is already implemented in `packages/daemon-core/src/cli-adapters/provider-cli-adapter.ts`.');
    lines.push('Your scripts receive PTY-derived input and must return plain JS objects.');
    lines.push('');
    lines.push('| Function | Input | Return |');
    lines.push('|---|---|---|');
    lines.push('| `parseOutput` | `{ buffer, rawBuffer, recentBuffer, screenText, messages, partialResponse }` | `{ id, status, title, messages, activeModal }` |');
    lines.push('| `detectStatus` | `{ tail, screenText, rawBuffer }` | `idle`, `generating`, `waiting_approval`, or `error` |');
    lines.push('| `parseApproval` | `{ buffer, rawBuffer, tail }` | `{ message, buttons }` or `null` |');
    lines.push('');
    lines.push('## Primary Source of Truth');
    lines.push('The runtime now provides a reliable current-screen snapshot. Treat `screenText` as the primary source of truth for the LIVE visible UI.');
    lines.push('That means:');
    lines.push('- Use `screenText` first for prompt detection, approval UI, status, and visible assistant content.');
    lines.push('- Use `rawBuffer` only as supporting evidence when ANSI/style/cursor cues matter.');
    lines.push('- Use `buffer` only when the visible screen does not contain enough text to recover the latest assistant answer.');
    lines.push('- Do NOT build the parser around stale transcript noise if the current screen already gives the answer.');
    lines.push('');

    lines.push('## Rules');
    lines.push('0. **🚫 SCOPE CONSTRAINT**: You may ONLY edit files marked ✏️ EDIT above. ALL other files are READ-ONLY. Do NOT modify, rewrite, refactor, or "improve" any file not explicitly marked as editable — even if you notice bugs or improvements. No exceptions.');
    lines.push('1. These scripts run in Node.js CommonJS, not in the browser. Do NOT use DOM APIs.');
    lines.push('2. Prefer `screenText` for current visible UI state. It is now the PTY equivalent of a trustworthy live DOM snapshot.');
    lines.push('3. Use `messages` as prior transcript state so redraws do not duplicate old turns on every parse.');
    lines.push('4. Use `partialResponse` for the actively streaming assistant text when status is `generating`.');
    lines.push('5. `detectStatus` must stay lightweight and current-screen-oriented. Prefer the active bottom-of-screen region over stale history.');
    lines.push('6. `parseApproval` should understand the live approval area and return clean button labels from the CURRENT visible modal.');
    lines.push('7. Use `rawBuffer` only when ANSI/control-sequence artifacts or style cues matter. Do not depend on raw escape noise unless necessary.');
    lines.push('8. Keep exports compatible with the existing `scripts.js` router (`module.exports = function ...`).');
    lines.push('9. Do NOT modify ANY file not explicitly marked ✏️ EDIT above. No exceptions — no "tiny supporting changes" to other files.');
    lines.push('10. When the verification API returns `instanceId`, keep using that exact instance for follow-up `send`, `resolve`, `raw`, and `stop` calls. Do not assume type-only routing is safe if multiple sessions exist.');
    lines.push('11. Do NOT repeatedly dump the same target files. Read the target scripts once, reproduce the bug, then move directly to patching.');
    lines.push('12. If the user instructions include concrete screen text, raw PTY snippets, or a specific repro, treat that as the primary acceptance criteria.');
    lines.push('13. After the first successful live repro, stop broad diagnosis. Edit the scripts, reload, and verify. Do not burn tokens on repeated re-inspection without code changes.');
    lines.push('14. If the visible current screen is clean and sufficient, do NOT fall back to complex buffer heuristics. Simpler current-screen parsing is preferred.');
    lines.push('15. Before changing parser logic, verify whether `provider.json` submit/approval behavior (`sendDelayMs`, `approvalKeys`, submit strategy) is the simpler and more correct fix.');
    lines.push('');

    lines.push('## Task');
    lines.push(`Edit files in \`${providerDir}\` to implement: **${functions.join(', ')}**`);
    lines.push('');

    lines.push('## Verification API');
    lines.push('Use the DevServer CLI debug endpoints, not DOM/CDP routes.');
    lines.push('');
    lines.push('### 1. Launch the target CLI');
    lines.push('```bash');
    lines.push(`curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/cli/launch \\`);
    lines.push('  -H "Content-Type: application/json" \\');
    lines.push(`  -d '{"type":"${type}","workingDir":"${providerDir.replace(/\\/g, '\\\\')}"}'`);
    lines.push('```');
    lines.push('');
    lines.push('### 2. Inspect parsed + raw adapter state');
    lines.push('```bash');
    lines.push(`curl -sS http://127.0.0.1:${DEV_SERVER_PORT}/api/cli/debug/${type}`);
    lines.push(`curl -sS http://127.0.0.1:${DEV_SERVER_PORT}/api/cli/trace/${type}`);
    lines.push(`curl -sS http://127.0.0.1:${DEV_SERVER_PORT}/api/cli/status`);
    lines.push('```');
    lines.push('');
    lines.push('The debug payload should be read in this priority order:');
    lines.push('1. `screenText` / current visible state');
    lines.push('2. parsed `status`, `messages`, `activeModal`');
    lines.push('3. `rawBuffer` only for style/control-sequence cues');
    lines.push('4. `buffer` only when the current screen is insufficient');
    lines.push('');
    lines.push('Extract the current `instanceId` from the launch or status response and keep using it below.');
    lines.push('');
    lines.push('### 3. Send a realistic approval-triggering prompt');
    lines.push('```bash');
    lines.push(`curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/cli/send \\`);
    lines.push('  -H "Content-Type: application/json" \\');
    lines.push(`  -d '{"type":"${type}","instanceId":"<INSTANCE_ID>","text":"Create a file at tmp/adhdev_provider_fix_test.py that prints the current working directory and the squares of 1 through 5, then run python3 tmp/adhdev_provider_fix_test.py and tell me the exact output."}'`);
    lines.push('```');
    lines.push('');
    lines.push('### 4. If approval appears, resolve it until the CLI reaches idle');
    lines.push('```bash');
    lines.push(`curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/cli/resolve \\`);
    lines.push('  -H "Content-Type: application/json" \\');
    lines.push(`  -d '{"type":"${type}","instanceId":"<INSTANCE_ID>","buttonIndex":0}'`);
    lines.push(`curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/cli/raw \\`);
    lines.push('  -H "Content-Type: application/json" \\');
    lines.push(`  -d '{"type":"${type}","instanceId":"<INSTANCE_ID>","keys":"1"}'`);
    lines.push('```');
    lines.push('');
    lines.push('Use `resolve` when the parsed modal buttons are correct. Use `raw` when the CLI expects a literal keystroke like `1`, `y`, or Enter. Repeat until idle.');
    lines.push('');
    lines.push('### Patch Discipline');
    lines.push('Once the repro is confirmed, immediately edit the target files. Avoid loops where you keep re-reading long files or re-running the same debug commands without changing code.');
    lines.push('');
    lines.push('### 5. Verify the side effects outside the CLI');
    lines.push('```bash');
    lines.push('test -f tmp/adhdev_provider_fix_test.py');
    lines.push('python3 tmp/adhdev_provider_fix_test.py');
    lines.push('```');
    lines.push('');
    lines.push('### 6. Stop the CLI when finished');
    lines.push('```bash');
    lines.push(`curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/cli/stop \\`);
    lines.push('  -H "Content-Type: application/json" \\');
    lines.push(`  -d '{"type":"${type}","instanceId":"<INSTANCE_ID>"}'`);
    lines.push('```');
    lines.push('');

    lines.push('## Required Validation');
    lines.push('1. Confirm `detectStatus` changes sensibly between startup, generating, approval, and idle.');
    lines.push('2. Confirm `parseOutput` produces a stable transcript without duplicating past turns when the PTY redraws.');
    lines.push('3. Confirm the latest assistant message streams through `partialResponse` while generation is in progress.');
    lines.push('4. Confirm approval parsing returns meaningful button labels when the CLI requests permission.');
    lines.push('5. Confirm the Python file was actually created and executed, not just described in chat text.');
    lines.push('6. Confirm the final assistant transcript includes the exact Python output, including the working directory line and the five square numbers.');
    lines.push('7. Re-run the debug endpoints after edits. Do NOT finish until the parsed result looks correct.');
    lines.push('8. Confirm the parser still works after a redraw or scroll change without duplicating transcript history.');
    lines.push('9. Confirm the implementation prefers current-screen signals over stale history when both are present.');
    lines.push('');

    if (userComment) {
      lines.push('## ⚠️ User Instructions (HIGH PRIORITY)');
      lines.push('The user has provided the following additional instructions. Follow them strictly:');
      lines.push('');
      lines.push(userComment);
      lines.push('');
    }

    lines.push('Start NOW. Launch the CLI, inspect PTY state, edit the scripts, and verify via the CLI debug endpoints.');

    return lines.join('\n');
  }

  private handleAutoImplSSE(type: string, req: http.IncomingMessage, res: http.ServerResponse): void {
    handleAutoImplSSE(this, type, req, res);
  }

  private async handleAutoImplCancel(_type: string, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return handleAutoImplCancel(this, _type, _req, res);
  }

  public sendAutoImplSSE(msg: { event: string; data: any }): void {
    this.autoImplStatus.progress.push(msg);
    const payload = `event: ${msg.event}\ndata: ${JSON.stringify(msg.data)}\n\n`;
    for (const client of this.autoImplSSEClients) {
      try { client.write(payload); } catch { /* ignore */ }
    }
  }

  /**
   * Resolve a CDP manager for DevServer APIs.
   * - Pass full **managerKey** from `GET /api/cdp/targets` when multiple Cursor/VS Code windows are open
   *   (e.g. `cursor_0006DE34…`); short `cursor` only works when it maps to exactly one connected manager.
   * - With `ideType` omitted: only succeeds when exactly one connected manager exists.
   */
  public getCdp(ideType?: string): DaemonCdpManager | null {
    if (ideType) {
      const cdp = findCdpManager(this.cdpManagers, ideType);
      if (cdp) return cdp;
      LOG.warn(
        'DevServer',
        `getCdp: no unique match for '${ideType}', available: [${[...this.cdpManagers.keys()].join(', ')}] — use managerKey from GET /api/cdp/targets`,
      );
      return null;
    }
    const connected = [...this.cdpManagers.entries()].filter(([, m]) => m.isConnected);
    if (connected.length === 1) return connected[0][1];
    if (connected.length === 0) return null;
    LOG.warn(
      'DevServer',
      `getCdp: ideType omitted but ${connected.length} CDP windows — pass managerKey from GET /api/cdp/targets`,
    );
    return null;
  }

  public json(res: http.ServerResponse, status: number, data: any): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
  }

  public async readBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (chunk) => body += chunk);
      req.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve({});
        }
      });
    });
  }

  // ─── CLI Debug Handlers ──────────────────────────────

  /** GET /api/cli/status — list all running CLI/ACP instances with state */
  private async handleCliStatus(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return handleCliStatus(this, _req, res);
  }


  /** POST /api/cli/launch — launch a CLI agent { type, workingDir?, args? } */
  private async handleCliLaunch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return handleCliLaunch(this, req, res);
  }

  /** POST /api/cli/send — send message to a running CLI { type, text } */
  private async handleCliSend(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return handleCliSend(this, req, res);
  }

  /** POST /api/cli/exercise — launch/send/approve/wait helper for provider-fix loops */
  private async handleCliExercise(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return handleCliExercise(this, req, res);
  }

  private async handleCliFixtureCapture(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return handleCliFixtureCapture(this, req, res);
  }

  private async handleCliFixtureReplay(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return handleCliFixtureReplay(this, req, res);
  }

  /** POST /api/cli/stop — stop a running CLI { type } */
  private async handleCliStop(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return handleCliStop(this, req, res);
  }

  /** GET /api/cli/events — SSE stream of CLI status events */
  private handleCliSSE(_req: http.IncomingMessage, res: http.ServerResponse): void {
    handleCliSSE(this, this.cliSSEClients, _req, res);
  }

  public sendCliSSE(data: any): void {
    const msg = `data: ${JSON.stringify({ ...data, timestamp: Date.now() })}\n\n`;
    for (const client of this.cliSSEClients) {
      try { client.write(msg); } catch { /* ignore */ }
    }
  }

  /** GET /api/cli/debug/:type — full internal debug state of a CLI adapter */
  private async handleCliDebug(type: string, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return handleCliDebug(this, type, _req, res);
  }

  /** GET /api/cli/trace/:type — recent CLI trace timeline plus current debug snapshot */
  private async handleCliTrace(type: string, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return handleCliTrace(this, type, _req, res);
  }

  private async handleCliFixtureList(type: string, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return handleCliFixtureList(this, type, _req, res);
  }

  /** POST /api/cli/resolve — resolve an approval modal { type, buttonIndex } */
  private async handleCliResolve(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return handleCliResolve(this, req, res);
  }

  /** POST /api/cli/raw — send raw keystrokes to PTY { type, keys } */
  private async handleCliRaw(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return handleCliRaw(this, req, res);
  }
}
