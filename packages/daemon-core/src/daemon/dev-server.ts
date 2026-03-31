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
import type { ProviderCategory } from '../providers/contracts.js';
import type { ChildProcess } from 'child_process';
import type { DaemonCdpManager } from '../cdp/manager.js';
import type { ProviderInstanceManager } from '../providers/provider-instance-manager.js';
import type { DaemonCliManager } from '../commands/cli-manager.js';
import { generateTemplate as genScaffoldTemplate, generateFiles as genScaffoldFiles } from './scaffold-template.js';
import { VersionArchive, detectAllVersions } from '../providers/version-archive.js';
import { LOG } from '../logging/logger.js';

export const DEV_SERVER_PORT = 19280;

export class DevServer {
  private server: http.Server | null = null;
  private providerLoader: ProviderLoader;
  private cdpManagers: Map<string, DaemonCdpManager>;
  private instanceManager: ProviderInstanceManager | null;
  private cliManager: DaemonCliManager | null;
  private logFn: (msg: string) => void;
  private sseClients: http.ServerResponse[] = [];
  private watchScriptPath: string | null = null;
  private watchScriptName: string | null = null;
  private watchTimer: NodeJS.Timeout | null = null;

  // Auto-implement state
  private autoImplProcess: ChildProcess | null = null;
  private autoImplSSEClients: http.ServerResponse[] = [];
  private autoImplStatus: { running: boolean; type: string | null; progress: any[] } = { running: false, type: null, progress: [] };

  // CLI debug SSE
  private cliSSEClients: http.ServerResponse[] = [];

  constructor(options: {
    providerLoader: ProviderLoader;
    cdpManagers: Map<string, DaemonCdpManager>;
    instanceManager?: ProviderInstanceManager;
    cliManager?: DaemonCliManager;
    logFn?: (msg: string) => void;
  }) {
    this.providerLoader = options.providerLoader;
    this.cdpManagers = options.cdpManagers;
    this.instanceManager = options.instanceManager || null;
    this.cliManager = options.cliManager || null;
    this.logFn = options.logFn || LOG.forComponent('DevServer').asLogFn();
  }

  private log(msg: string): void {
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
    { method: 'POST', pattern: '/api/cli/resolve',           handler: (q, s) => this.handleCliResolve(q, s) },
    { method: 'POST', pattern: '/api/cli/raw',               handler: (q, s) => this.handleCliRaw(q, s) },
    { method: 'POST', pattern: '/api/cli/stop',              handler: (q, s) => this.handleCliStop(q, s) },
    { method: 'GET',  pattern: '/api/cli/events',            handler: (q, s) => this.handleCliSSE(q, s) },
    { method: 'GET',  pattern: /^\/api\/cli\/debug\/([^/]+)$/, handler: (q, s, p) => this.handleCliDebug(p![0], q, s) },
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
    const providers = this.providerLoader.getAll().map(p => {
      const base: any = {
        type: p.type,
        name: p.name,
        category: p.category,
        icon: (p as any).icon || null,
        displayName: (p as any).displayName || p.name,
      };

      // IDE/Extension specific
      if (p.category === 'ide' || p.category === 'extension') {
        base.scripts = p.scripts ? Object.keys(p.scripts).filter(k => typeof (p.scripts as any)[k] === 'function') : [];
        base.inputMethod = p.inputMethod || null;
        base.inputSelector = (p as any).inputSelector || null;
        base.extensionId = p.extensionId || null;
        base.cdpPorts = (p as any).cdpPorts || [];
      }

      // ACP specific
      if (p.category === 'acp') {
        base.spawn = (p as any).spawn || null;
        base.auth = (p as any).auth || null;
        base.install = (p as any).install || null;
        base.hasSettings = !!(p as any).settings;
        base.settingsCount = (p as any).settings ? Object.keys((p as any).settings).length : 0;
      }

      // CLI specific
      if (p.category === 'cli') {
        base.spawn = (p as any).spawn || null;
        base.install = (p as any).install || null;
      }

      return base;
    });
    this.json(res, 200, { providers, count: providers.length });
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

    const spawn = (provider as any).spawn;
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

  private async handleRunScript(type: string, req: http.IncomingMessage, res: http.ServerResponse, parsedBody?: any): Promise<void> {
    const body = parsedBody || await this.readBody(req);
    const { script: scriptName, params, ideType: scriptIdeType } = body;

    const provider = this.providerLoader.resolve(type);
    if (!provider) {
      this.json(res, 404, { error: `Provider '${type}' not found` });
      return;
    }

    const fn = (provider.scripts as any)?.[scriptName];
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
      // Emulate production CommandHandler behavior
      let scriptCode: string | null = null;
      if (['sendMessage', 'webviewSendMessage', 'switchSession', 'webviewSwitchSession', 'setMode', 'webviewSetMode', 'setModel', 'webviewSetModel'].includes(scriptName)) {
        // Production daemon's getProviderScript always unpacks the object and sends the first value
        const firstVal = params && typeof params === 'object' && Object.keys(params).length > 0 
            ? Object.values(params)[0] 
            : params;
        scriptCode = firstVal !== undefined ? fn(firstVal) : fn();
      } else {
        // Scripts like resolveAction are passed the raw parameters object in production
        scriptCode = params !== undefined ? fn(params) : fn();
      }
      if (!scriptCode) {
        this.json(res, 500, { error: 'Script function returned null' });
        return;
      }
      this.log(`Exec script length: ${scriptCode.length}, first 50 chars: ${scriptCode.slice(0, 50)}...`);

      // Execute based on provider category
      const isWebviewScript = scriptName.toLowerCase().includes('webview');
      let raw: any;
      if (provider.category === 'extension' && !isWebviewScript) {
        // Extension scripts: prefer session frame (agent webview) — matching agent-stream poller behavior
        const sessions = cdp.getAgentSessions();
        let sessionId: string | null = null;
        for (const [sid, target] of sessions) {
          if (target.agentType === type) { sessionId = sid; break; }
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
    const body = await this.readBody(req);
    const { expression, timeout, ideType } = body;
    if (!expression) {
      this.json(res, 400, { error: 'expression required' });
      return;
    }

    const cdp = this.getCdp(ideType);
    if (!cdp && !ideType) {
      LOG.warn('DevServer', 'CDP evaluate without ideType — picked first connected manager');
    }
    if (!cdp?.isConnected) {
      this.json(res, 503, { error: 'No CDP connection available' });
      return;
    }

    try {
      const raw = await cdp.evaluate(expression, timeout || 30000);
      let result = raw;
      if (typeof raw === 'string') {
        try { result = JSON.parse(raw); } catch { /* keep */ }
      }
      this.json(res, 200, { result });
    } catch (e: any) {
      this.json(res, 500, { error: e.message });
    }
  }

  private async handleCdpClick(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const { ideType, x, y } = body;
    if (x == null || y == null) {
      this.json(res, 400, { error: 'x and y coordinates required' });
      return;
    }

    const cdp = this.getCdp(ideType);
    if (!cdp?.isConnected) {
      this.json(res, 503, { error: 'No CDP connection available' });
      return;
    }

    try {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      this.json(res, 200, { success: true, clicked: true, x, y });
    } catch (e: any) {
      this.json(res, 500, { error: e.message });
    }
  }

  private async handleCdpDomQuery(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const { selector, limit = 10, ideType } = body;
    if (!selector) {
      this.json(res, 400, { error: 'selector required' });
      return;
    }

    const cdp = this.getCdp(ideType as string);
    if (!cdp) {
      this.json(res, 503, { error: 'No CDP connection available' });
      return;
    }

    const expr = `(() => {
      try {
        const els = document.querySelectorAll('${selector.replace(/'/g, "\\'")}');
        const results = [];
        for (let i = 0; i < Math.min(els.length, ${limit}); i++) {
          const el = els[i];
          results.push({
            index: i,
            tag: el.tagName?.toLowerCase(),
            id: el.id || null,
            class: el.className && typeof el.className === 'string' ? el.className.trim().slice(0, 200) : null,
            role: el.getAttribute?.('role') || null,
            text: (el.textContent || '').trim().slice(0, 100),
            visible: el.offsetParent !== null || el.offsetWidth > 0,
            rect: (() => { try { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; } catch { return null; } })()
          });
        }
        return JSON.stringify({ total: els.length, results });
      } catch (e) { return JSON.stringify({ error: e.message }); }
    })()`;

    try {
      const raw = await cdp.evaluate(expr, 10000);
      const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
      this.json(res, 200, result);
    } catch (e: any) {
      this.json(res, 500, { error: e.message });
    }
  }

  private async handleScreenshot(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');
    const ideType = url.searchParams.get('ideType') || undefined;
    const cdp = this.getCdp(ideType);
    if (!cdp) {
      this.json(res, 503, { error: 'No CDP connection available' });
      return;
    }

    try {
      // Get viewport metrics before capturing
      let vpW = 0, vpH = 0;
      try {
        const metrics = await cdp.send('Page.getLayoutMetrics', {}, 3000);
        const vp = metrics?.cssVisualViewport || metrics?.visualViewport;
        if (vp) {
          vpW = Math.round(vp.clientWidth || vp.width || 0);
          vpH = Math.round(vp.clientHeight || vp.height || 0);
        }
      } catch { /* ignore */ }

      const buf = await cdp.captureScreenshot();
      if (buf) {
        res.writeHead(200, {
          'Content-Type': 'image/webp',
          'X-Viewport-Width': String(vpW),
          'X-Viewport-Height': String(vpH),
        });
        res.end(buf);
      } else {
        this.json(res, 500, { error: 'Screenshot failed' });
      }
    } catch (e: any) {
      this.json(res, 500, { error: e.message });
    }
  }

  private async handleScriptsRun(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const { type, script: scriptName, params } = body;
    if (!type || !scriptName) {
      this.json(res, 400, { error: 'type and script required' });
      return;
    }
    // Delegate to handleRunScript
    await this.handleRunScript(type, req, res, body);
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
      const providers = this.providerLoader.getAll().map(p => ({
        type: p.type, name: p.name, category: p.category,
      }));
      for (const cdp of this.cdpManagers.values()) {
        if (!cdp.isConnected) {
          (cdp as any)._targetId = null;
        }
      }
      this.json(res, 200, { reloaded: true, providers });
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
      const fn = (provider.scripts as any)?.[this.watchScriptName!];
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
  private findProviderDir(type: string): string | null {
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
    const body = await this.readBody(req);
    const { selector, text } = body;
    if (!selector || typeof selector !== 'string' || !text || typeof text !== 'string') {
      this.json(res, 400, { error: 'selector and text strings required' }); return;
    }
    const cdp = this.getCdp(type);
    if (!cdp) {
      this.json(res, 503, { error: `CDP not connected for '${type}'` }); return;
    }
    try {
      const sent = await cdp.typeAndSend(selector, text);
      this.json(res, 200, { sent });
    } catch (e: any) {
      this.json(res, 500, { error: e.message });
    }
  }

  private async handleTypeAndSendAt(type: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const { x, y, text } = body;
    if (typeof x !== 'number' || typeof y !== 'number' || !text || typeof text !== 'string') {
      this.json(res, 400, { error: 'x, y numbers and text string required' }); return;
    }
    const cdp = this.getCdp(type);
    if (!cdp) {
      this.json(res, 503, { error: `CDP not connected for '${type}'` }); return;
    }
    try {
      const sent = await cdp.typeAndSendAt(x, y, text);
      this.json(res, 200, { sent });
    } catch (e: any) {
      this.json(res, 500, { error: e.message });
    }
  }

  private async handleScriptHints(type: string, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const dir = this.findProviderDir(type);
    if (!dir) { this.json(res, 404, { error: `Provider not found: ${type}` }); return; }

    // Find scripts.js in the provider dir (may be versioned)
    let scriptsPath = '';
    const directScripts = path.join(dir, 'scripts.js');
    if (fs.existsSync(directScripts)) {
      scriptsPath = directScripts;
    } else {
      // Check versioned scripts dirs
      const scriptsDir = path.join(dir, 'scripts');
      if (fs.existsSync(scriptsDir)) {
        const versions = fs.readdirSync(scriptsDir).filter(d => {
          return fs.statSync(path.join(scriptsDir, d)).isDirectory();
        }).sort().reverse();
        for (const ver of versions) {
          const p = path.join(scriptsDir, ver, 'scripts.js');
          if (fs.existsSync(p)) { scriptsPath = p; break; }
        }
      }
    }

    if (!scriptsPath) {
      this.json(res, 200, { hints: {} });
      return;
    }

    try {
      const source = fs.readFileSync(scriptsPath, 'utf-8');
      const hints: Record<string, { template: Record<string, any>; description: string }> = {};

      // Parse exported functions and extract param usage
      const funcRegex = /module\.exports\.(\w+)\s*=\s*function\s+\w+\s*\(params\)/g;
      let match;
      while ((match = funcRegex.exec(source)) !== null) {
        const name = match[1];
        // Find the function body (rough: from match to next module.exports or end)
        const startIdx = match.index;
        const nextFunc = source.indexOf('module.exports.', startIdx + 1);
        const funcBody = source.substring(startIdx, nextFunc > 0 ? nextFunc : source.length);

        const paramFields: Record<string, any> = {};

        // Pattern 1: params?.xxx or params.xxx
        const dotRegex = /params\?\.([a-zA-Z_]+)|params\.([a-zA-Z_]+)/g;
        let dm;
        while ((dm = dotRegex.exec(funcBody)) !== null) {
          const field = dm[1] || dm[2];
          if (field === 'length') continue;
          if (!(field in paramFields)) {
            // Infer type from context
            if (/index|count|port|timeout/i.test(field)) paramFields[field] = 0;
            else if (/action|text|title|message|model|mode|button|name|filter/i.test(field)) paramFields[field] = '';
            else paramFields[field] = '';
          }
        }

        // Pattern 2: typeof params === 'string' ? params : params?.xxx
        const typeofRegex = /typeof params === 'string' \? params : params\?\.([a-zA-Z_]+)/g;
        let tm;
        while ((tm = typeofRegex.exec(funcBody)) !== null) {
          const field = tm[1];
          if (!(field in paramFields)) paramFields[field] = '';
        }

        // Pattern 3: typeof params === 'number' ? params : params?.xxx
        const numRegex = /typeof params === 'number' \? params : params\?\.([a-zA-Z_]+)/g;
        let nm;
        while ((nm = numRegex.exec(funcBody)) !== null) {
          const field = nm[1];
          if (!(field in paramFields)) paramFields[field] = 0;
        }

        // Determine description from function name
        const descriptions: Record<string, string> = {
          readChat: 'No params required',
          sendMessage: 'Text to send to the chat',
          listSessions: 'No params required',
          switchSession: 'Switch by index or title',
          newSession: 'No params required',
          focusEditor: 'No params required',
          openPanel: 'No params required',
          resolveAction: 'Approve/reject action buttons',
          listNotifications: 'Optional message filter',
          dismissNotification: 'Dismiss by index, message, or button',
          listModels: 'No params required',
          setModel: 'Model name to select',
          listModes: 'No params required',
          setMode: 'Mode name to select',
        };

        hints[name] = {
          template: Object.keys(paramFields).length > 0 ? paramFields : {},
          description: descriptions[name] || (Object.keys(paramFields).length > 0 ? 'Params: ' + Object.keys(paramFields).join(', ') : 'No params'),
        };
      }

      this.json(res, 200, { hints });
    } catch (e: any) {
      this.json(res, 500, { error: e.message });
    }
  }

  // ─── Validate provider.json ───
  private async handleValidate(type: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const { content } = body;
    const errors: string[] = [];
    const warnings: string[] = [];
    try {
      const config = typeof content === 'string' ? JSON.parse(content) : content;
      // Required fields
      if (!config.type) errors.push('Missing required field: type');
      if (!config.name) errors.push('Missing required field: name');
      if (!config.category) errors.push('Missing required field: category');
      else if (!['ide', 'extension', 'cli', 'acp'].includes(config.category)) errors.push(`Invalid category: ${config.category}`);
      // Category-specific
      if (config.category === 'ide' || config.category === 'extension') {
        if (!config.cdpPorts || !Array.isArray(config.cdpPorts) || config.cdpPorts.length === 0)
          warnings.push('IDE/Extension providers should have cdpPorts');
        if (config.category === 'extension' && !config.extensionId)
          warnings.push('Extension providers should have extensionId');
      }
      if (config.category === 'acp' || config.category === 'cli') {
        if (!config.spawn) errors.push('ACP/CLI providers must have spawn config');
        else {
          if (!config.spawn.command) errors.push('spawn.command is required');
        }
      }
      // Settings validation
      if (config.settings) {
        for (const [key, val] of Object.entries(config.settings)) {
          const s = val as any;
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
          const conflict = allProviders.find(p => p.type !== type && (p as any).cdpPorts?.includes(port));
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
    const spawn = (provider as any).spawn;
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
    const targets: { ide: string; connected: boolean; port: number }[] = [];
    for (const [ide, cdp] of this.cdpManagers.entries()) {
      targets.push({ ide, connected: cdp.isConnected, port: cdp.getPort() });
    }
    this.json(res, 200, { targets });
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
    const body = await this.readBody(req);
    const { x, y, selector, ideType } = body;
    const cdp = this.getCdp(ideType);
    if (!cdp) { this.json(res, 503, { error: 'No CDP connection' }); return; }

    const selectorArg = selector ? JSON.stringify(selector) : 'null';
    const inspectScript = `(() => {
      function gs(el) {
        if (!el || el === document.body) return 'body';
        if (el.id) return '#' + CSS.escape(el.id);
        let s = el.tagName.toLowerCase();
        if (el.className && typeof el.className === 'string') {
          const cls = el.className.trim().split(/\\s+/).filter(c => c && !c.startsWith('_')).slice(0, 3);
          if (cls.length) s += '.' + cls.map(c => CSS.escape(c)).join('.');
        }
        const p = el.parentElement;
        if (p) {
          const sibs = [...p.children].filter(c => c.tagName === el.tagName);
          if (sibs.length > 1) s += ':nth-child(' + ([...p.children].indexOf(el) + 1) + ')';
        }
        return s;
      }
      function gp(el) {
        const parts = [];
        let c = el;
        while (c && c !== document.documentElement) { parts.unshift(gs(c)); c = c.parentElement; }
        return parts;
      }
      function ni(el) {
        if (!el) return null;
        const tag = el.tagName?.toLowerCase() || '#text';
        const attrs = {};
        if (el.attributes) for (const a of el.attributes) if (a.name !== 'class' && a.name !== 'style') attrs[a.name] = a.value?.substring(0, 200);
        const cls = (el.className && typeof el.className === 'string') ? el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 10) : [];
        const text = el.textContent?.trim().substring(0, 150) || '';
        const dt = [...(el.childNodes||[])].filter(n=>n.nodeType===3).map(n=>n.textContent.trim()).filter(Boolean).join(' ').substring(0,100);
        const cc = el.children?.length || 0;
        const r = el.getBoundingClientRect?.();
        return { tag, cls, attrs, text, directText: dt, childCount: cc, selector: gs(el), fullSelector: gp(el).join(' > '), rect: r ? {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)} : null };
      }
      const sel = ${selectorArg};
      let el = sel ? document.querySelector(sel) : document.elementFromPoint(${x || 0}, ${y || 0});
      if (!el) return JSON.stringify({ error: 'No element found' });
      const info = ni(el);
      const ancestors = [];
      let pp = el.parentElement;
      while (pp && pp !== document.documentElement) {
        ancestors.push({ tag: pp.tagName.toLowerCase(), selector: gs(pp), cls: (pp.className && typeof pp.className === 'string') ? pp.className.trim().split(/\\s+/).slice(0,3) : [] });
        pp = pp.parentElement;
      }
      const children = [...(el.children||[])].slice(0,50).map(c => ni(c));
      return JSON.stringify({ element: info, ancestors: ancestors.reverse(), children });
    })()`;

    try {
      const raw = await cdp.evaluate(inspectScript, 10000);
      let result = raw;
      if (typeof raw === 'string') { try { result = JSON.parse(raw as string); } catch { } }
      this.json(res, 200, result as Record<string, unknown>);
    } catch (e: any) {
      this.json(res, 500, { error: e.message });
    }
  }

  private async handleDomChildren(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const { selector, ideType } = body;
    const cdp = this.getCdp(ideType);
    if (!cdp) { this.json(res, 503, { error: 'No CDP connection' }); return; }
    if (!selector) { this.json(res, 400, { error: 'selector required' }); return; }

    const script = `(() => {
      function gs(el) {
        if (!el || el === document.body) return 'body';
        if (el.id) return '#' + CSS.escape(el.id);
        let s = el.tagName.toLowerCase();
        if (el.className && typeof el.className === 'string') {
          const cls = el.className.trim().split(/\\s+/).filter(c => c && !c.startsWith('_')).slice(0, 3);
          if (cls.length) s += '.' + cls.map(c => CSS.escape(c)).join('.');
        }
        const p = el.parentElement;
        if (p) {
          const sibs = [...p.children].filter(c => c.tagName === el.tagName);
          if (sibs.length > 1) s += ':nth-child(' + ([...p.children].indexOf(el) + 1) + ')';
        }
        return s;
      }
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return JSON.stringify({ error: 'Element not found' });
      const children = [...(el.children||[])].slice(0,100).map(c => {
        const tag = c.tagName?.toLowerCase();
        const cls = (c.className && typeof c.className === 'string') ? c.className.trim().split(/\\s+/).filter(Boolean).slice(0,10) : [];
        const attrs = {};
        for (const a of c.attributes) if (a.name!=='class'&&a.name!=='style') attrs[a.name] = a.value?.substring(0,200);
        const text = c.textContent?.trim().substring(0,150)||'';
        const dt = [...c.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent.trim()).filter(Boolean).join(' ').substring(0,100);
        return { tag, cls, attrs, text, directText: dt, childCount: c.children?.length||0, selector: gs(c) };
      });
      return JSON.stringify({ selector: ${JSON.stringify(selector)}, childCount: el.children?.length||0, children });
    })()`;

    try {
      const raw = await cdp.evaluate(script, 10000);
      let result = raw;
      if (typeof raw === 'string') { try { result = JSON.parse(raw as string); } catch { } }
      this.json(res, 200, result as Record<string, unknown>);
    } catch (e: any) {
      this.json(res, 500, { error: e.message });
    }
  }

  private async handleDomAnalyze(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const { ideType, selector, x, y } = body;
    const cdp = this.getCdp(ideType);
    if (!cdp) { this.json(res, 503, { error: 'No CDP connection' }); return; }

    const selectorArg = selector ? JSON.stringify(selector) : 'null';
    const analyzeScript = `(() => {
      function gs(el) {
        if (!el || el === document.body) return 'body';
        if (el.id) return '#' + CSS.escape(el.id);
        let s = el.tagName.toLowerCase();
        if (el.className && typeof el.className === 'string') {
          const cls = el.className.trim().split(/\\s+/).filter(c => c && !c.startsWith('_')).slice(0, 3);
          if (cls.length) s += '.' + cls.map(c => CSS.escape(c)).join('.');
        }
        return s;
      }
      function fp(el) {
        const parts = [];
        let c = el;
        while (c && c !== document.documentElement) { parts.unshift(gs(c)); c = c.parentElement; }
        return parts.join(' > ');
      }
      function sigOf(el) {
        return el.tagName + '|' + ((el.className && typeof el.className === 'string') ? el.className.trim().split(/\\s+/).filter(c => c && !c.startsWith('_')).sort().join('.') : '');
      }

      // Find target element
      const sel = ${selectorArg};
      let target = sel ? document.querySelector(sel) : document.elementFromPoint(${x || 0}, ${y || 0});
      if (!target) return JSON.stringify({ error: 'Element not found' });

      const result = {
        target: { tag: target.tagName.toLowerCase(), selector: fp(target), text: (target.textContent||'').trim().substring(0, 200) },
        siblingPattern: null,
        ancestorAnalysis: [],
        subtreeTexts: [],
      };

      // 1. Walk UP parents — at each level, find sibling patterns
      let el = target;
      let depth = 0;
      while (el && el !== document.body && depth < 15) {
        const parent = el.parentElement;
        if (!parent) break;

        const mySig = sigOf(el);
        const siblings = [...parent.children].filter(c => sigOf(c) === mySig);
        const totalChildren = parent.children.length;
        const childSel = gs(el).replace(/:nth-child\\(\\d+\\)/, '');
        const parentSel = fp(parent);

        result.ancestorAnalysis.push({
          depth,
          parentTag: parent.tagName.toLowerCase(),
          parentSelector: parentSel,
          totalChildren,
          matchingSiblings: siblings.length,
          childSelector: childSel,
          fullSelector: parentSel + ' > ' + childSel,
        });

        // Best sibling pattern: 3+ matching siblings with text
        if (!result.siblingPattern && siblings.length >= 3) {
          const siblingData = siblings.map((s, i) => {
            const directText = [...s.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).filter(Boolean).join(' ').substring(0, 120);
            const allText = (s.textContent || '').trim().substring(0, 200);
            const childCount = s.children?.length || 0;
            const cls = (s.className && typeof s.className === 'string') ? s.className.trim().split(/\\s+/).filter(Boolean) : [];
            const attrs = {};
            if (s.attributes) for (const a of s.attributes) {
              if (a.name !== 'class' && a.name !== 'style' && a.value) attrs[a.name] = a.value.substring(0, 100);
            }
            return { index: i, directText, allText, childCount, cls, attrs, tag: s.tagName.toLowerCase() };
          });

          // Find common attributes across siblings
          const allAttrs = siblingData.map(s => Object.keys(s.attrs));
          const commonAttrs = allAttrs[0]?.filter(attr => allAttrs.every(a => a.includes(attr))) || [];
          // Find varying attributes (data-*, role, etc)
          const varyingAttrs = {};
          for (const attr of commonAttrs) {
            const values = siblingData.map(s => s.attrs[attr]);
            const unique = [...new Set(values)];
            if (unique.length > 1) varyingAttrs[attr] = unique.slice(0, 5);
          }

          result.siblingPattern = {
            count: siblings.length,
            selector: parentSel + ' > ' + childSel,
            parentSelector: parentSel,
            depthFromTarget: depth,
            siblings: siblingData.slice(0, 30),
            commonAttrs,
            varyingAttrs,
          };
        }

        el = parent;
        depth++;
      }

      // 2. Collect subtree text nodes from target
      const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, null);
      let node;
      while ((node = walker.nextNode()) && result.subtreeTexts.length < 30) {
        const text = node.textContent.trim();
        if (text.length > 2) {
          const parentTag = node.parentElement?.tagName?.toLowerCase() || '';
          const parentCls = (node.parentElement?.className && typeof node.parentElement.className === 'string')
            ? node.parentElement.className.trim().split(/\\s+/).filter(Boolean).slice(0,3).join('.') : '';
          result.subtreeTexts.push({
            text: text.substring(0, 150),
            parentTag,
            parentCls,
            parentSelector: gs(node.parentElement),
          });
        }
      }

      return JSON.stringify(result);
    })()`;

    try {
      const raw = await cdp.evaluate(analyzeScript, 15000);
      let result = raw;
      if (typeof raw === 'string') { try { result = JSON.parse(raw as string); } catch { } }
      this.json(res, 200, result as Record<string, unknown>);
    } catch (e: any) {
      this.json(res, 500, { error: e.message });
    }
  }

  private async handleFindCommon(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const { include, exclude, ideType } = body;
    if (!Array.isArray(include) || include.length === 0) { this.json(res, 400, { error: 'include[] is required' }); return; }
    const cdp = this.getCdp(ideType);
    if (!cdp) { this.json(res, 503, { error: 'No CDP connection' }); return; }

    const script = `(() => {
      const includes = ${JSON.stringify(include)};
      const excludes = ${JSON.stringify(exclude || [])};

      function gs(el) {
        if (!el || el === document.body) return 'body';
        if (el.id) return '#' + CSS.escape(el.id);
        let s = el.tagName.toLowerCase();
        if (el.className && typeof el.className === 'string') {
          const cls = el.className.trim().split(/\\s+/).filter(c => c && !c.startsWith('_')).slice(0, 3);
          if (cls.length) s += '.' + cls.map(c => CSS.escape(c)).join('.');
        }
        return s;
      }
      function fp(el) {
        const parts = [];
        let c = el;
        while (c && c !== document.documentElement) { parts.unshift(gs(c)); c = c.parentElement; }
        return parts.join(' > ');
      }
      function sig(el) {
        return el.tagName + '|' + ((el.className && typeof el.className === 'string') ? el.className.trim() : '');
      }

      // Step 1: For each include, find all matching leaf elements
      const includeMatches = includes.map(text => {
        const lower = text.toLowerCase();
        const found = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
          acceptNode: n => n.textContent.toLowerCase().includes(lower) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
        });
        let node;
        while ((node = walker.nextNode()) && found.length < 5) {
          if (node.parentElement) found.push(node.parentElement);
        }
        return found;
      });

      if (includeMatches.some(m => m.length === 0)) {
        const missing = includes.filter((_, i) => includeMatches[i].length === 0);
        return JSON.stringify({ results: [], message: 'Text not found: ' + missing.join(', ') });
      }

      // Step 2: Find LCA for each combination of include elements
      // For each pair of include[0] element and include[1] element, find their LCA
      // Then within the LCA, find the direct-child subtree branch for each
      const containers = [];
      const seen = new Set();

      function findLCA(el1, el2) {
        const ancestors1 = new Set();
        let c = el1;
        while (c) { ancestors1.add(c); c = c.parentElement; }
        c = el2;
        while (c) { if (ancestors1.has(c)) return c; c = c.parentElement; }
        return document.body;
      }

      function findDirectChildContaining(parent, descendant) {
        let c = descendant;
        while (c && c.parentElement !== parent) c = c.parentElement;
        return c;
      }

      // Try all combinations (first 3 matches per include)
      for (const el1 of includeMatches[0].slice(0, 3)) {
        for (let ii = 1; ii < includeMatches.length; ii++) {
          for (const el2 of includeMatches[ii].slice(0, 3)) {
            if (el1 === el2) continue;
            const lca = findLCA(el1, el2);
            if (!lca || lca === document.body || lca === document.documentElement) continue;

            // Find which direct child of LCA contains each include element
            const child1 = findDirectChildContaining(lca, el1);
            const child2 = findDirectChildContaining(lca, el2);
            if (!child1 || !child2 || child1 === child2) continue;

            const lcaSel = fp(lca);
            if (seen.has(lcaSel)) continue;
            seen.add(lcaSel);

            // Check exclude
            if (excludes.length > 0) {
              const lcaText = (lca.textContent || '').toLowerCase();
              if (excludes.some(ex => lcaText.includes(ex.toLowerCase()))) continue;
            }

            // Are child1 and child2 same tag? (relaxed — ignore classes)
            const tag1 = child1.tagName;
            const tag2 = child2.tagName;

            // Bubble up: walk up from LCA, find the best list container
            // (the one with most repeating same-tag children)
            let container = lca;
            let bestContainer = lca;
            let bestListCount = 0;
            for (let up = 0; up < 10; up++) {
              const p = container.parentElement;
              if (!p || p === document.body || p === document.documentElement) break;
              // Check how many same-tag siblings 'container' has in parent
              const myTag = container.tagName;
              const sibCount = [...p.children].filter(c => c.tagName === myTag).length;
              if (sibCount > bestListCount) {
                bestListCount = sibCount;
                bestContainer = p;
              }
              container = p;
            }
            container = bestListCount >= 3 ? bestContainer : lca;

            const allChildren = [...container.children];
            const childTag = tag1 === tag2 ? tag1 : (allChildren.length > 0 ? allChildren[0].tagName : '');
            const sameTagCount = allChildren.filter(c => c.tagName === childTag).length;
            const isList = sameTagCount >= 3 && sameTagCount >= allChildren.length * 0.4;

            // Gather all same-tag children as list items
            const listItems = isList 
              ? allChildren.filter(c => c.tagName === childTag)
              : allChildren;

            // Filter rendered items (skip virtual scroll placeholders)
            const rendered = listItems.filter(c => (c.innerText || '').trim().length > 0);
            const placeholderCount = listItems.length - rendered.length;

            const containerSel = fp(container);
            if (seen.has(containerSel)) continue;
            seen.add(containerSel);

            const r = container.getBoundingClientRect();
            containers.push({
              selector: containerSel,
              tag: container.tagName.toLowerCase(),
              childCount: allChildren.length,
              listItemCount: listItems.length,
              renderedCount: rendered.length,
              placeholderCount,
              isList,
              rect: { w: Math.round(r.width), h: Math.round(r.height) },
              depth: containerSel.split(' > ').length,
              items: rendered.slice(0, 30).map((el, i) => {
                const fullText = (el.innerText || el.textContent || '').trim();
                // Find snippet around first matched include text
                let text = fullText.substring(0, 200);
                const matched = [];
                for (const inc of includes) {
                  const idx = fullText.toLowerCase().indexOf(inc.toLowerCase());
                  if (idx >= 0) {
                    matched.push(inc);
                    if (matched.length === 1) {
                      // Show snippet around first match
                      const start = Math.max(0, idx - 30);
                      const end = Math.min(fullText.length, idx + inc.length + 80);
                      text = (start > 0 ? '...' : '') + fullText.substring(start, end) + (end < fullText.length ? '...' : '');
                    }
                  }
                }
                return {
                  index: i,
                  tag: el.tagName.toLowerCase(),
                  cls: (el.className && typeof el.className === 'string') ? el.className.trim().split(/\\s+/).slice(0, 2).join(' ') : '',
                  text,
                  matchedIncludes: matched,
                  childCount: el.children.length,
                  h: Math.round(el.getBoundingClientRect().height),
                };
              }),
            });
          }
        }
      }

      // Sort: list containers first (more items = better), then by depth
      containers.sort((a, b) => {
        if (a.isList !== b.isList) return a.isList ? -1 : 1;
        return b.listItemCount - a.listItemCount || b.depth - a.depth;
      });

      return JSON.stringify({
        results: containers.slice(0, 10),
        includeCount: includes.length,
        excludeCount: excludes.length,
      });
    })()`;

    try {
      const raw = await cdp.evaluate(script, 10000);
      let result = raw;
      if (typeof raw === 'string') { try { result = JSON.parse(raw as string); } catch { } }
      this.json(res, 200, result as Record<string, unknown>);
    } catch (e: any) {
      this.json(res, 500, { error: e.message });
    }
  }

  private async handleFindByText(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const { text, ideType, containerSelector } = body;
    if (!text || typeof text !== 'string') { this.json(res, 400, { error: 'text is required' }); return; }
    const cdp = this.getCdp(ideType);
    if (!cdp) { this.json(res, 503, { error: 'No CDP connection' }); return; }

    const containerArg = containerSelector ? JSON.stringify(containerSelector) : 'null';
    const script = `(() => {
      function gs(el) {
        if (!el || el === document.body) return 'body';
        if (el.id) return '#' + CSS.escape(el.id);
        let s = el.tagName.toLowerCase();
        if (el.className && typeof el.className === 'string') {
          const cls = el.className.trim().split(/\\s+/).filter(c => c && !c.startsWith('_')).slice(0, 3);
          if (cls.length) s += '.' + cls.map(c => CSS.escape(c)).join('.');
        }
        return s;
      }
      function fp(el) {
        const parts = [];
        let c = el;
        while (c && c !== document.documentElement) { parts.unshift(gs(c)); c = c.parentElement; }
        return parts.join(' > ');
      }
      function parentSig(el) {
        // Signature: tag+class chain up 3 levels
        const parts = [];
        let c = el;
        for (let i = 0; i < 3 && c; i++) { parts.push(gs(c)); c = c.parentElement; }
        return parts.join(' < ');
      }

      const searchText = ${JSON.stringify(text)}.toLowerCase();
      const container = ${containerArg} ? document.querySelector(${containerArg}) : document.body;
      if (!container) return JSON.stringify({ error: 'Container not found' });

      const matches = [];
      const seen = new Set();

      // Find all text nodes containing the search text
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode: n => n.textContent.toLowerCase().includes(searchText) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
      });
      let node;
      while ((node = walker.nextNode()) && matches.length < 50) {
        // Walk up to find the most specific visible element
        let el = node.parentElement;
        if (!el) continue;

        // Skip hidden elements
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;

        const selector = fp(el);
        if (seen.has(selector)) continue;
        seen.add(selector);

        // Walk up parent chain — record each level's selector + sibling count
        const ancestors = [];
        let cur = el;
        let pLvl = cur.parentElement;
        for (let lvl = 0; lvl < 10 && pLvl && pLvl !== document.body; lvl++) {
          const mySig = cur.tagName + '|' + ((cur.className && typeof cur.className === 'string') ? cur.className.trim().split(/\\s+/).sort().join('.') : '');
          const sibs = [...pLvl.children].filter(c => {
            const sig = c.tagName + '|' + ((c.className && typeof c.className === 'string') ? c.className.trim().split(/\\s+/).sort().join('.') : '');
            return sig === mySig;
          });
          const childSel = gs(cur).replace(/:nth-child\\(\\d+\\)/, '');
          ancestors.push({
            parentSelector: fp(pLvl),
            childSelector: childSel,
            fullSelector: fp(pLvl) + ' > ' + childSel,
            siblingCount: sibs.length,
            parentTag: pLvl.tagName.toLowerCase(),
          });
          cur = pLvl;
          pLvl = pLvl.parentElement;
        }

        const directText = (node.textContent || '').trim().substring(0, 200);
        const allText = (node.parentElement.textContent || '').trim().substring(0, 300);
        const tag = node.parentElement.tagName.toLowerCase();
        const cls = (node.parentElement.className && typeof node.parentElement.className === 'string')
          ? node.parentElement.className.trim().split(/\\s+/).filter(Boolean) : [];

        matches.push({
          selector,
          tag,
          cls,
          directText,
          allText,
          ancestors,
          rect: { w: Math.round(r.width), h: Math.round(r.height) },
          depth: selector.split(' > ').length,
        });
      }

      // Sort: prefer elements with more siblings in ancestry, then fewer depth
      matches.sort((a, b) => {
        const aMax = Math.max(1, ...a.ancestors.map(x => x.siblingCount));
        const bMax = Math.max(1, ...b.ancestors.map(x => x.siblingCount));
        return (bMax - aMax) || (a.depth - b.depth);
      });

      return JSON.stringify({ query: ${JSON.stringify(text)}, matches, total: matches.length });
    })()`;

    try {
      const raw = await cdp.evaluate(script, 10000);
      let result = raw;
      if (typeof raw === 'string') { try { result = JSON.parse(raw as string); } catch { } }
      this.json(res, 200, result as Record<string, unknown>);
    } catch (e: any) {
      this.json(res, 500, { error: e.message });
    }
  }

  // ─── Phase 1: DOM Context API ───

  private async handleDomContext(type: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const { ideType } = body;
    const provider = this.providerLoader.resolve(type);
    if (!provider) { this.json(res, 404, { error: `Provider not found: ${type}` }); return; }

    const cdp = this.getCdp(ideType || type);
    if (!cdp) { this.json(res, 503, { error: 'No CDP connection available. Target IDE must be running with CDP enabled.' }); return; }

    try {
      // 1. Capture screenshot
      let screenshot: string | null = null;
      try {
        const buf = await cdp.captureScreenshot();
        if (buf) screenshot = buf.toString('base64');
      } catch { /* screenshot optional */ }

      // 2. Collect DOM snapshot
      const domScript = `(() => {
        function gs(el) {
          if (!el || el === document.body) return 'body';
          if (el.id) return '#' + CSS.escape(el.id);
          let s = el.tagName.toLowerCase();
          if (el.className && typeof el.className === 'string') {
            const cls = el.className.trim().split(/\\s+/).filter(c => c && !c.startsWith('_')).slice(0, 3);
            if (cls.length) s += '.' + cls.map(c => CSS.escape(c)).join('.');
          }
          return s;
        }
        function fp(el) {
          const parts = [];
          let c = el;
          while (c && c !== document.documentElement) { parts.unshift(gs(c)); c = c.parentElement; }
          return parts.join(' > ');
        }
        function rect(el) {
          try { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }
          catch { return null; }
        }

        const result = { contentEditables: [], chatContainers: [], buttons: [], sidebars: [], dropdowns: [], inputs: [] };

        // Content editables + textareas + inputs
        document.querySelectorAll('[contenteditable], textarea, input[type="text"], input:not([type])').forEach(el => {
          if (el.offsetWidth === 0 && el.offsetHeight === 0) return;
          result.contentEditables.push({
            selector: fp(el),
            tag: el.tagName.toLowerCase(),
            contenteditable: el.getAttribute('contenteditable'),
            role: el.getAttribute('role'),
            ariaLabel: el.getAttribute('aria-label'),
            placeholder: el.getAttribute('placeholder'),
            rect: rect(el),
            visible: el.offsetParent !== null || el.offsetWidth > 0,
          });
        });

        // Chat containers — large divs with scroll
        document.querySelectorAll('div, section, main').forEach(el => {
          const style = getComputedStyle(el);
          const isScrollable = style.overflowY === 'auto' || style.overflowY === 'scroll';
          const r = el.getBoundingClientRect();
          if (!isScrollable || r.height < 200 || r.width < 200) return;
          const childCount = el.children.length;
          if (childCount < 2) return;
          result.chatContainers.push({
            selector: fp(el),
            childCount,
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            hasScrollable: true,
            scrollTop: Math.round(el.scrollTop),
            scrollHeight: Math.round(el.scrollHeight),
          });
        });

        // Buttons
        document.querySelectorAll('button, [role="button"]').forEach(el => {
          if (el.offsetWidth === 0 && el.offsetHeight === 0) return;
          const text = (el.textContent || '').trim().substring(0, 80);
          if (!text && !el.getAttribute('aria-label')) return;
          result.buttons.push({
            text,
            ariaLabel: el.getAttribute('aria-label'),
            selector: fp(el),
            rect: rect(el),
            disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
          });
        });

        // Sidebars — panels on left/right edges
        document.querySelectorAll('[class*="sidebar"], [class*="side-bar"], [class*="panel"], [role="complementary"], [role="navigation"], aside').forEach(el => {
          if (el.offsetWidth === 0 && el.offsetHeight === 0) return;
          const r = el.getBoundingClientRect();
          if (r.width < 50 || r.height < 200) return;
          result.sidebars.push({
            selector: fp(el),
            position: r.x < window.innerWidth / 3 ? 'left' : r.x > window.innerWidth * 2 / 3 ? 'right' : 'center',
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            childCount: el.children.length,
          });
        });

        // Dropdowns — select, popover, menu patterns
        document.querySelectorAll('select, [role="listbox"], [role="menu"], [role="combobox"], [class*="dropdown"], [class*="popover"]').forEach(el => {
          result.dropdowns.push({
            selector: fp(el),
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role'),
            visible: el.offsetParent !== null || el.offsetWidth > 0,
            rect: rect(el),
          });
        });

        return JSON.stringify(result);
      })()`;

      const raw = await cdp.evaluate(domScript, 15000);
      let domSnapshot: any = {};
      if (typeof raw === 'string') { try { domSnapshot = JSON.parse(raw); } catch { domSnapshot = { raw }; } }
      else domSnapshot = raw;

      this.json(res, 200, {
        screenshot: screenshot ? `base64:${screenshot}` : null,
        domSnapshot,
        pageTitle: await cdp.evaluate('document.title', 3000).catch(() => ''),
        pageUrl: await cdp.evaluate('window.location.href', 3000).catch(() => ''),
        providerType: type,
        timestamp: new Date().toISOString(),
      });
    } catch (e: any) {
      this.json(res, 500, { error: `DOM context collection failed: ${e.message}` });
    }
  }

  // ─── Phase 2: Auto-Implement Backend ───

  private getDefaultAutoImplReference(category: string, type: string): string {
    if (category === 'cli') {
      return type === 'codex-cli' ? 'claude-cli' : 'codex-cli';
    }
    return 'antigravity';
  }

  private resolveAutoImplReference(category: string, requestedReference: string | undefined, targetType: string): string | null {
    const desired = requestedReference || this.getDefaultAutoImplReference(category, targetType);
    const ref = this.providerLoader.resolve(desired) || this.providerLoader.getMeta(desired);
    if (ref?.category === category) return desired;

    const all = this.providerLoader.getAll();
    const fallback = all
      .filter((p: any) => p.category === category && p.type !== targetType)
      .sort((a: any, b: any) => String(a.type || '').localeCompare(String(b.type || ''), undefined, { numeric: true, sensitivity: 'base' }))[0];
    return fallback?.type || null;
  }

  private getLatestScriptVersionDir(scriptsDir: string): string | null {
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

    try {
      const providerData = JSON.parse(fs.readFileSync(providerJson, 'utf-8'));
      if (providerData.disableUpstream !== true) {
        providerData.disableUpstream = true;
        fs.writeFileSync(providerJson, JSON.stringify(providerData, null, 2));
      }
    } catch (error) {
      return {
        dir: null,
        reason: `Failed to update provider.json in writable provider directory: ${(error as Error).message}`,
      };
    }

    return { dir: desiredDir };
  }

  private loadAutoImplReferenceScripts(referenceType: string | null): Record<string, string> {
    if (!referenceType) return {};

    const refDir = this.findProviderDir(referenceType);
    if (!refDir || !fs.existsSync(refDir)) return {};

    const referenceScripts: Record<string, string> = {};
    const scriptsDir = path.join(refDir, 'scripts');
    const latestDir = this.getLatestScriptVersionDir(scriptsDir);
    if (!latestDir) return referenceScripts;

    for (const file of fs.readdirSync(latestDir)) {
      if (!file.endsWith('.js')) continue;
      try {
        referenceScripts[file] = fs.readFileSync(path.join(latestDir, file), 'utf-8');
      } catch {
        // ignore broken reference files
      }
    }
    return referenceScripts;
  }

  private async handleAutoImplement(type: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const { agent = 'claude-cli', functions, reference, model, comment, providerDir: requestedProviderDir } = body;
    if (!functions || !Array.isArray(functions) || functions.length === 0) {
      this.json(res, 400, { error: 'functions[] is required (e.g. ["readChat", "sendMessage"])' });
      return;
    }

    if (this.autoImplStatus.running) {
      this.json(res, 409, { error: 'Auto-implement already in progress', type: this.autoImplStatus.type });
      return;
    }

    const provider = this.providerLoader.resolve(type);
    if (!provider) { this.json(res, 404, { error: `Provider not found: ${type}` }); return; }

    const writableProvider = this.resolveAutoImplWritableProviderDir(provider.category, type, requestedProviderDir);
    if (!writableProvider.dir) {
      this.json(res, 409, {
        error: writableProvider.reason || `Auto-implement only writes to the canonical user provider directory for '${type}'.`,
      });
      return;
    }
    const providerDir = writableProvider.dir;

    try {
      // 1. Collect DOM context
      // 1. Skip heavy DOM pre-parsing (Agent will use cURL to explore via CDP!)
      const resolvedReference = this.resolveAutoImplReference(provider.category, reference, type);
      this.sendAutoImplSSE({
        event: 'progress',
        data: {
          function: '_init',
          status: 'analyzing',
          message: provider.category === 'cli'
            ? 'Initializing agent (granting CLI PTY debug access)...'
            : 'Initializing agent (granting DOM access)...'
        }
      });
      const domContext = null;

      // 2. Load reference scripts
      this.sendAutoImplSSE({
        event: 'progress',
        data: {
          function: '_init',
          status: 'loading_reference',
          message: `Loading reference script (${resolvedReference || 'none'})...`
        }
      });

      const referenceScripts = this.loadAutoImplReferenceScripts(resolvedReference);

      // 3. Build the prompt
      const prompt = this.buildAutoImplPrompt(type, provider, providerDir, functions, domContext, referenceScripts, comment, resolvedReference);

      // 4. Write prompt to temp file (avoids shell escaping issues with special chars)
      const tmpDir = path.join(os.tmpdir(), 'adhdev-autoimpl');
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      const promptFile = path.join(tmpDir, `prompt-${type}-${Date.now()}.md`);
      fs.writeFileSync(promptFile, prompt, 'utf-8');
      this.log(`Auto-implement prompt written to ${promptFile} (${prompt.length} chars)`);

      // 5. Determine agent command from provider spawn config
      const agentProvider = this.providerLoader.resolve(agent) || this.providerLoader.getMeta(agent);
      const spawn = (agentProvider as any)?.spawn;
      if (!spawn?.command) {
        try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
        this.json(res, 400, { error: `Agent '${agent}' has no spawn config. Select a CLI provider with a spawn configuration.` });
        return;
      }

      const agentCategory = (agentProvider as any)?.category;

      // ─── ACP Agent: use ACP SDK (JSON-RPC protocol) ───
      if (agentCategory === 'acp') {
        this.sendAutoImplSSE({ event: 'progress', data: { function: '_init', status: 'spawning', message: `Spawning ACP agent: ${spawn.command} ${(spawn.args || []).join(' ')}` } });
        this.autoImplStatus = { running: true, type, progress: [] };

        // Dynamic import ACP SDK
        const { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } = await import('@agentclientprotocol/sdk');
        const { Readable, Writable } = await import('stream');
        const { spawn: spawnFn } = await import('child_process');

        // Add model override to spawn args if specified
        const acpArgs = [...(spawn.args || [])];
        if (model) {
          acpArgs.push('--model', model);
          this.log(`Auto-implement ACP using model: ${model}`);
        }

        const child = spawnFn(spawn.command, acpArgs, {
          cwd: providerDir,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: spawn.shell ?? false,
          env: { ...process.env, ...(spawn.env || {}) },
        });
        this.autoImplProcess = child;

        // stderr → stream to SSE
        child.stderr?.on('data', (d: Buffer) => {
          const chunk = d.toString();
          this.sendAutoImplSSE({ event: 'output', data: { chunk, stream: 'stderr' } });
        });

        // Setup ACP connection via SDK
        const webStdin = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
        const webStdout = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
        const stream = ndJsonStream(webStdin, webStdout);

        const connection = new ClientSideConnection((_agent: any) => ({
          // Auto-approve all tool calls for auto-implement
          requestPermission: async (params: any) => {
            const allowOpt = params.options?.find((o: any) => o.kind === 'allow_once') || params.options?.[0];
            this.sendAutoImplSSE({ event: 'output', data: { chunk: `[ACP] Auto-approved: ${params.toolCall?.title || 'tool call'}\n`, stream: 'stdout' } });
            return { outcome: { outcome: 'selected', optionId: allowOpt?.optionId || '' } };
          },
          sessionUpdate: async (params: any) => {
            const update = params?.update;
            if (!update) return;
            // Stream meaningful output only (skip thought chunks — they're too verbose)
            switch (update.sessionUpdate) {
              case 'agent_message_chunk':
                if (update.content?.text) {
                  this.sendAutoImplSSE({ event: 'output', data: { chunk: update.content.text, stream: 'stdout' } });
                }
                break;
              case 'tool_call':
                this.sendAutoImplSSE({ event: 'output', data: { chunk: `\n🔧 [Tool] ${update.title || 'unknown'}\n`, stream: 'stdout' } });
                break;
              case 'tool_call_update':
                if (update.status === 'completed' || update.status === 'failed') {
                  const label = update.status === 'completed' ? '✅' : '❌';
                  const out = update.rawOutput ? (typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput)) : '';
                  this.sendAutoImplSSE({ event: 'output', data: { chunk: `${label} Result: ${out.slice(0, 1000)}\n`, stream: 'stdout' } });
                }
                break;
              case 'agent_thought_chunk':
                // Skip — too verbose for auto-implement UI
                break;
              default:
                break;
            }
          },
          // Not used for auto-implement
          readTextFile: async () => { throw new Error('not supported'); },
          writeTextFile: async () => { throw new Error('not supported'); },
          createTerminal: async () => { throw new Error('not supported'); },
          terminalOutput: async () => { throw new Error('not supported'); },
          releaseTerminal: async () => { throw new Error('not supported'); },
          waitForTerminalExit: async () => { throw new Error('not supported'); },
          killTerminal: async () => { throw new Error('not supported'); },
        }), stream);

        child.on('exit', (code) => {
          this.autoImplProcess = null;
          this.autoImplStatus.running = false;
          const success = code === 0;
          this.sendAutoImplSSE({ event: 'complete', data: { success, exitCode: code, functions, message: success ? '✅ ACP Auto-implement complete' : `❌ ACP agent exited (code: ${code})` } });
          try { this.providerLoader.reload(); } catch { /* ignore */ }
          try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
          this.log(`Auto-implement (ACP) ${success ? 'completed' : 'failed'}: ${type} (exit: ${code})`);
        });

        // ACP handshake flow (async, runs in background)
        (async () => {
          try {
            this.sendAutoImplSSE({ event: 'progress', data: { function: '_init', status: 'initializing', message: 'ACP initialize...' } });
            await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });

            this.sendAutoImplSSE({ event: 'progress', data: { function: '_init', status: 'session', message: 'Creating ACP session...' } });
            const session = await connection.newSession({ cwd: providerDir, mcpServers: [] });
            const sessionId = session?.sessionId;
            if (!sessionId) throw new Error('No sessionId returned from session/new');

            this.sendAutoImplSSE({ event: 'progress', data: { function: '_init', status: 'prompting', message: `Sending prompt (${prompt.length} chars)...` } });
            await connection.prompt({
              sessionId,
              prompt: [{ type: 'text', text: prompt }],
            });

            this.sendAutoImplSSE({ event: 'progress', data: { function: '_done', status: 'complete', message: '✅ ACP prompt processing complete' } });
          } catch (e: any) {
            this.sendAutoImplSSE({ event: 'output', data: { chunk: `[ACP Error] ${e.message}\n`, stream: 'stderr' } });
            this.log(`Auto-implement ACP error: ${e.message}`);
            // Process exit will trigger the 'complete' SSE event
            if (child.exitCode === null) { child.kill('SIGTERM'); }
          }
        })();

        this.json(res, 202, {
          started: true, type, agent: spawn.command, functions, providerDir,
          message: 'ACP Auto-implement started. Connect to SSE for progress.',
          sseUrl: `/api/providers/${type}/auto-implement/status`,
        });
        return;
      }

      // ─── CLI Agent: stdin pipe approach ───
      const command: string = spawn.command;
      // Strip interactive-only flags for auto-implement (non-interactive mode)
      const interactiveFlags = ['--yolo', '--interactive', '-i'];
      const baseArgs: string[] = [...(spawn.args || [])].filter((a: string) => !interactiveFlags.includes(a));

      // 6. Construct the complete shell command per-agent
      let shellCmd: string;

      if (command === 'claude') {
        // Claude Code: autonomous agent mode (no --print), skip permissions, prompt via meta-prompt
        const args = [...baseArgs, '--dangerously-skip-permissions'];
        if (model) args.push('--model', model);
        const escapedArgs = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
        const metaPrompt = `Read the file at ${promptFile} and follow ALL the instructions. Implement the specific function requested, then test it via CDP curl targeting 127.0.0.1:19280, wait for confirmation of success, and then close. DO NOT start working on other features not listed in the prompt constraint.`;
        shellCmd = `${command} ${escapedArgs} -p "${metaPrompt}"`;
      } else if (command === 'gemini') {
        // Gemini CLI: non-interactive prompt mode
        // We can't use @file syntax (causes Parts object parsing bug) or $(cat) (arg too long).
        // Solution: meta-prompt that tells Gemini to read the instructions file itself.
        const args = [...baseArgs, '-y', '-s', 'false'];
        if (model) args.push('-m', model);
        const escapedArgs = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
        shellCmd = `${command} ${escapedArgs} -p "Read the file at ${promptFile} and follow ALL the instructions in it exactly. Do not ask questions, just execute."`;

      } else if (command === 'codex') {
        const args = ['exec', ...baseArgs];
        if (!args.includes('--dangerously-bypass-approvals-and-sandbox')) {
          args.push('--dangerously-bypass-approvals-and-sandbox');
        }
        if (!args.includes('--skip-git-repo-check')) {
          args.push('--skip-git-repo-check');
        }
        if (model) args.push('--model', model);
        const escapedArgs = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
        const metaPrompt = `Read the file at ${promptFile} and follow ALL instructions strictly. DO NOT spend time exploring the filesystem or other providers. You have full authority to implement ALL required script files and independently test them against 127.0.0.1:19280 via CDP CURL. Upon complete validation of ALL assigned files, print exactly "_PIPELINE_COMPLETE_SIGNAL_" to gracefully close the pipeline. DO NOT WAIT FOR APPROVAL, execute completely autonomously.`;
        shellCmd = `${command} ${escapedArgs} "${metaPrompt}"`;
      } else {
        // Generic fallback: pipe prompt via stdin
        const escapedArgs = baseArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
        shellCmd = `cat '${promptFile}' | ${command} ${escapedArgs}`;
      }

      this.sendAutoImplSSE({ event: 'progress', data: { function: '_init', status: 'spawning', message: `Spawning agent: ${shellCmd.substring(0, 200)}... (prompt: ${prompt.length} chars)` } });

      this.autoImplStatus = { running: true, type, progress: [] };
      const spawnedAt = Date.now();

      let child: any;
      let isPty = false;
      const { spawn: spawnFn } = await import('child_process');
      
      try {
        const pty = require('node-pty');
        this.log(`Auto-implement spawn (PTY): ${shellCmd}`);
        const isWin = os.platform() === 'win32';
        child = pty.spawn(isWin ? 'cmd.exe' : (process.env.SHELL || '/bin/zsh'), [isWin ? '/c' : '-c', shellCmd], {
          name: 'xterm-256color',
          cols: 120,
          rows: 40,
          cwd: providerDir,
          env: { ...process.env, ...(spawn.env || {}) },
        });
        isPty = true;
      } catch (err: any) {
        this.log(`PTY not available, using child_process: ${err.message}`);
        child = spawnFn('sh', ['-c', shellCmd], {
          cwd: providerDir,
          shell: false,
          timeout: 900000,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { 
            ...process.env, 
            ...(spawn.env || {}),
            ...(command === 'gemini' ? { SANDBOX: '1', GEMINI_CLI_NO_RELAUNCH: '1' } : {}),
          },
        });
        child.on('error', (err: Error) => {
          this.log(`Auto-implement spawn error: ${err.message}`);
          this.sendAutoImplSSE({ event: 'output', data: { chunk: `[Spawn Error] ${err.message}\n`, stream: 'stderr' } });
        });
      }

      this.autoImplProcess = child;
      let stdout = '';
      let stderr = '';
      
      let approvalPatterns: RegExp[] = [];
      let approvalKeys: Record<number, string> = { 0: 'y\r' };
      let approvalBuffer = '';
      let lastApprovalTime = 0;
      
      try {
        const { normalizeCliProviderForRuntime } = await import('../cli-adapters/provider-cli-adapter.js');
        const normalized = normalizeCliProviderForRuntime(agentProvider);
        approvalPatterns = normalized.patterns.approval;
        approvalKeys = (agentProvider as any)?.approvalKeys || { 0: 'y\r', 1: 'a\r' };
      } catch (err: any) {
        this.log(`Failed to load approval patterns: ${err.message}`);
      }

      const checkAutoApproval = (chunk: string, writeFn: (s: string) => void) => {
        // Strip ANSI
        const cleanData = chunk.replace(/\x1B\[\d*[A-HJKSTfG]/g, ' ')
            .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
            .replace(/\x1B\][^\x07]*\x07/g, '')
            .replace(/\x1B\][^\x1B]*\x1B\\/g, '')
            .replace(/  +/g, ' ');
            
        approvalBuffer = (approvalBuffer + cleanData).slice(-1500);
        
        // Force exit on completion signal (check cleanData directly to avoid stale buffer echo matches)
        const elapsed = Date.now() - spawnedAt;
        if (elapsed > 15000 && cleanData.includes('_PIPELINE_COMPLETE_SIGNAL_')) {
          this.log(`Agent finished task after ${Math.round(elapsed/1000)}s. Terminating interactive CLI session to unblock pipeline.`);
          this.sendAutoImplSSE({ event: 'output', data: { chunk: `\n[🤖 ADHDev Pipeline] Completion token detected. Proceeding...\n`, stream: 'stdout' } });
          approvalBuffer = '';
          
          try {
            (this.autoImplProcess as any).kill('SIGINT');
          } catch {
            // ignore
          }
          return;
        }
        
        // Use a cooldown to prevent overlapping approval submissions
        if (Date.now() - lastApprovalTime < 2000) return;
        
        if (approvalPatterns.some(p => p.test(approvalBuffer))) {
          // Use 'Always allow' (1) if available, otherwise 'Allow once' (0), otherwise hard fallback to 'a\r' for newer CLIs
          const key = approvalKeys[1] || approvalKeys[0] || 'a\r';
          writeFn(key);
          this.log(`Auto-Implement auto-approved prompt! Sending: ${JSON.stringify(key)}`);
          this.sendAutoImplSSE({ event: 'output', data: { chunk: `\n[🤖 ADHDev Auto-Approve] CLI Action Approved\n`, stream: 'stdout' } });
          approvalBuffer = '';
          lastApprovalTime = Date.now();
        }
      };

      if (isPty) {
        child.onData((data: string) => {
          stdout += data;
          if (data.includes('\x1b[6n')) {
            child.write('\x1b[12;1R');
            this.log('Terminal CPR request (\\x1b[6n) intercepted in PTY, responding with dummy coordinates [12;1R]');
          }
          checkAutoApproval(data, (s) => child.write(s));
          this.sendAutoImplSSE({ event: 'output', data: { chunk: data, stream: 'stdout' } });
        });
        child.onExit(({ exitCode: code }: { exitCode: number }) => {
          this.autoImplProcess = null;
          this.autoImplStatus.running = false;
          const success = code === 0;
          this.sendAutoImplSSE({
            event: 'complete',
            data: { success, exitCode: code, functions, message: success ? '✅ Auto-implement complete' : `❌ Agent exited (code: ${code})` },
          });
          try { this.providerLoader.reload(); } catch { /* ignore */ }
          try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
        });
      } else {
        child.stdout?.on('data', (d: Buffer) => {
          const chunk = d.toString();
          stdout += chunk;
          if (chunk.includes('\x1b[6n')) child.stdin?.write('\x1b[1;1R');
          checkAutoApproval(chunk, (s) => child.stdin?.write(s));
          this.sendAutoImplSSE({ event: 'output', data: { chunk, stream: 'stdout' } });
        });
        child.stderr?.on('data', (d: Buffer) => {
          const chunk = d.toString();
          stderr += chunk;
          checkAutoApproval(chunk, (s) => child.stdin?.write(s));
          this.sendAutoImplSSE({ event: 'output', data: { chunk, stream: 'stderr' } });
        });
        child.on('exit', (code: number) => {
          this.autoImplProcess = null;
          this.autoImplStatus.running = false;
          const success = code === 0;
          this.sendAutoImplSSE({
            event: 'complete',
            data: {
              success,
              exitCode: code,
              functions,
              message: success ? '✅ Auto-implement complete' : `❌ Agent exited (code: ${code})`,
            },
          });
          try { this.providerLoader.reload(); } catch { /* ignore */ }
          try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
          this.log(`Auto-implement ${success ? 'completed' : 'failed'}: ${type} (exit: ${code})`);
        });
      }
      this.json(res, 202, {
        started: true,
        type,
        agent: command,
        functions,
        providerDir,
        message: 'Auto-implement started. Connect to SSE for progress.',
        sseUrl: `/api/providers/${type}/auto-implement/status`,
      });
    } catch (e: any) {
      this.autoImplStatus.running = false;
      this.json(res, 500, { error: `Auto-implement failed: ${e.message}` });
    }
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

    // ── Existing target files (inline, so no reading needed) ──
    lines.push('## Current Target Files');
    lines.push('These are the files you need to EDIT. They contain TODO stubs — replace them with working implementations.');
    lines.push('');

    const scriptsDir = path.join(providerDir, 'scripts');
    const latestScriptsDir = this.getLatestScriptVersionDir(scriptsDir);
    if (latestScriptsDir) {
      lines.push(`Scripts version directory: \`${latestScriptsDir}\``);
      lines.push('');
      for (const file of fs.readdirSync(latestScriptsDir)) {
        if (file.endsWith('.js')) {
          try {
            const content = fs.readFileSync(path.join(latestScriptsDir, file), 'utf-8');
            lines.push(`### \`${file}\``);
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

    // ── Reference implementation ──
    const funcToFile: Record<string, string> = {
      readChat: 'read_chat.js', sendMessage: 'send_message.js',
      resolveAction: 'resolve_action.js', listSessions: 'list_sessions.js',
      listChats: 'list_chats.js', switchSession: 'switch_session.js',
      newSession: 'new_session.js', focusEditor: 'focus_editor.js',
      openPanel: 'open_panel.js', listModels: 'list_models.js',
      listModes: 'list_modes.js', setModel: 'set_model.js', setMode: 'set_mode.js',
    };

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
    lines.push('| readChat | `{ id, status, title, messages: [{role, content, index, kind?, meta?}], inputContent, activeModal }` — optional `kind`: standard, thought, tool, terminal; optional `meta`: e.g. `{ label, isRunning }` for dashboard |');
    lines.push('| sendMessage | `{ sent: false, needsTypeAndSend: true, selector }` |');
    lines.push('| resolveAction | `{ resolved: true/false, clicked? }` |');
    lines.push('| listSessions | `{ sessions: [{ id, title, active, index }] }` |');
    lines.push('| switchSession | `{ switched: true/false }` |');
    lines.push('| newSession | `{ created: true/false }` |');
    lines.push('| listModels | `{ models: [{ name, id }], current }` |');
    lines.push('| setModel | `{ success: true/false }` |');
    lines.push('| listModes | `{ modes: [{ name, id }], current }` |');
    lines.push('| setMode | `{ success: true/false }` |');
    lines.push('| focusEditor | `{ focused: true/false }` |');
    lines.push('| openPanel | `{ opened: true/false }` |');
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

    lines.push('## Current Target Files');
    lines.push('These are the files you need to edit. Replace TODO or heuristic-only logic with working PTY-aware implementations.');
    lines.push('');

    const scriptsDir = path.join(providerDir, 'scripts');
    const latestScriptsDir = this.getLatestScriptVersionDir(scriptsDir);
    if (latestScriptsDir) {
      lines.push(`Scripts version directory: \`${latestScriptsDir}\``);
      lines.push('');
      for (const file of fs.readdirSync(latestScriptsDir)) {
        if (!file.endsWith('.js')) continue;
        try {
          const content = fs.readFileSync(path.join(latestScriptsDir, file), 'utf-8');
          lines.push(`### \`${file}\``);
          lines.push('```javascript');
          lines.push(content);
          lines.push('```');
          lines.push('');
        } catch {
          // ignore
        }
      }
    }

    const funcToFile: Record<string, string> = {
      parseOutput: 'parse_output.js',
      detectStatus: 'detect_status.js',
      parseApproval: 'parse_approval.js',
    };

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

    lines.push('## Rules');
    lines.push('1. These scripts run in Node.js CommonJS, not in the browser. Do NOT use DOM APIs.');
    lines.push('2. Prefer `screenText` for current visible UI state. That is the PTY equivalent of parsing the current IDE DOM.');
    lines.push('3. Use `messages` as prior transcript state so redraws do not duplicate old turns on every parse.');
    lines.push('4. Use `partialResponse` for the actively streaming assistant text when status is `generating`.');
    lines.push('5. `detectStatus` must stay lightweight and tail-based. Do not scan the entire history there.');
    lines.push('6. `parseApproval` should understand the live approval area and return clean button labels.');
    lines.push('7. Use `rawBuffer` only when ANSI/control-sequence artifacts matter. Do not depend on raw escape noise unless necessary.');
    lines.push('8. Keep exports compatible with the existing `scripts.js` router (`module.exports = function ...`).');
    lines.push('9. Do not rewrite unrelated provider config. Only touch the scripts needed for this task unless a tiny supporting change is required.');
    lines.push('10. When the verification API returns `instanceId`, keep using that exact instance for follow-up `send`, `resolve`, `raw`, and `stop` calls. Do not assume type-only routing is safe if multiple sessions exist.');
    lines.push('11. Do NOT repeatedly dump the same target files. Read the target scripts once, reproduce the bug, then move directly to patching.');
    lines.push('12. If the user instructions include concrete screen text, raw PTY snippets, or a specific repro, treat that as the primary acceptance criteria.');
    lines.push('13. After the first successful live repro, stop broad diagnosis. Edit the scripts, reload, and verify. Do not burn tokens on repeated re-inspection without code changes.');
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
    lines.push(`curl -sS http://127.0.0.1:${DEV_SERVER_PORT}/api/cli/status`);
    lines.push('```');
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
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`data: ${JSON.stringify({ type: 'connected', running: this.autoImplStatus.running, providerType: type })}\n\n`);

    // Replay existing progress
    for (const p of this.autoImplStatus.progress) {
      res.write(`event: ${p.event}\ndata: ${JSON.stringify(p.data)}\n\n`);
    }

    this.autoImplSSEClients.push(res);
    req.on('close', () => {
      this.autoImplSSEClients = this.autoImplSSEClients.filter(c => c !== res);
    });
  }

  private handleAutoImplCancel(_type: string, _req: http.IncomingMessage, res: http.ServerResponse): void {
    if (this.autoImplProcess) {
      this.autoImplProcess.kill('SIGTERM');
      setTimeout(() => { if (this.autoImplProcess) this.autoImplProcess.kill('SIGKILL'); }, 3000);
      this.sendAutoImplSSE({ event: 'complete', data: { success: false, exitCode: -1, message: '⛔ Aborted by user' } });
      this.autoImplProcess = null;
      this.autoImplStatus.running = false;
      this.json(res, 200, { cancelled: true });
    } else {
      this.autoImplStatus.running = false;
      this.json(res, 200, { cancelled: false, message: 'No running process' });
    }
  }

  private sendAutoImplSSE(msg: { event: string; data: any }): void {
    this.autoImplStatus.progress.push(msg);
    const payload = `event: ${msg.event}\ndata: ${JSON.stringify(msg.data)}\n\n`;
    for (const client of this.autoImplSSEClients) {
      try { client.write(payload); } catch { /* ignore */ }
    }
  }

  /** Get CDP manager — matching IDE when ideType specified, first connected one otherwise.
   *  DevServer is a debugging tool so first-connected fallback is acceptable,
   *  but callers should pass ideType when possible. */
  private getCdp(ideType?: string): DaemonCdpManager | null {
    if (ideType) {
      const cdp = this.cdpManagers.get(ideType);
      if (cdp?.isConnected) return cdp;
      // Prefix match for multi-window keys
      for (const [k, m] of this.cdpManagers.entries()) {
        if (k.startsWith(ideType + '_') && m.isConnected) return m;
      }
      LOG.warn('DevServer', `getCdp: no manager found for ideType '${ideType}', available: [${[...this.cdpManagers.keys()].join(', ')}]`);
      return null;
    }
    // No ideType — return first connected (dev convenience)
    for (const cdp of this.cdpManagers.values()) {
      if (cdp.isConnected) return cdp;
    }
    return null;
  }

  private json(res: http.ServerResponse, status: number, data: any): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
  }

  private async readBody(req: http.IncomingMessage): Promise<any> {
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
    if (!this.instanceManager) {
      this.json(res, 503, { error: 'InstanceManager not available (daemon not fully initialized)' });
      return;
    }
    const allStates = this.instanceManager.collectAllStates();
    const cliStates = allStates.filter(s => s.category === 'cli' || s.category === 'acp');
    const result = cliStates.map(s => ({
      instanceId: s.instanceId,
      type: s.type,
      name: s.name,
      category: s.category,
      status: s.status,
      mode: s.mode,
      workspace: s.workspace,
      messageCount: s.activeChat?.messages?.length || 0,
      lastMessage: s.activeChat?.messages?.slice(-1)[0] || null,
      activeModal: s.activeChat?.activeModal || null,
      pendingEvents: s.pendingEvents || [],
      currentModel: s.currentModel,
      settings: s.settings,
    }));
    this.json(res, 200, { instances: result, count: result.length });
  }

  private findCliTarget(type?: string, instanceId?: string): any | null {
    if (!this.instanceManager) return null;
    const cliStates = this.instanceManager
      .collectAllStates()
      .filter(s => s.category === 'cli' || s.category === 'acp');
    if (instanceId) return cliStates.find(s => s.instanceId === instanceId) || null;
    if (!type) return cliStates[cliStates.length - 1] || null;
    const matches = cliStates.filter(s => s.type === type);
    return matches[matches.length - 1] || null;
  }

  /** POST /api/cli/launch — launch a CLI agent { type, workingDir?, args? } */
  private async handleCliLaunch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.cliManager) {
      this.json(res, 503, { error: 'CliManager not available' });
      return;
    }
    const body = await this.readBody(req);
    const { type, workingDir, args } = body;
    if (!type) {
      this.json(res, 400, { error: 'type required (e.g. claude-cli, gemini-cli)' });
      return;
    }
    try {
      await this.cliManager.startSession(type, workingDir || process.cwd(), args || []);
      this.json(res, 200, { launched: true, type, workspace: workingDir || process.cwd() });
    } catch (e: any) {
      this.json(res, 500, { error: `Launch failed: ${e.message}` });
    }
  }

  /** POST /api/cli/send — send message to a running CLI { type, text } */
  private async handleCliSend(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.instanceManager) {
      this.json(res, 503, { error: 'InstanceManager not available' });
      return;
    }
    const body = await this.readBody(req);
    const { type, text, instanceId } = body;
    if (!text) {
      this.json(res, 400, { error: 'text required' });
      return;
    }

    const target = this.findCliTarget(type, instanceId);
    if (!target) {
      this.json(res, 404, { error: `No running instance found for: ${type || instanceId}` });
      return;
    }

    try {
      this.instanceManager.sendEvent(target.instanceId, 'send_message', { text });
      this.json(res, 200, { sent: true, type: target.type, instanceId: target.instanceId });
    } catch (e: any) {
      this.json(res, 500, { error: `Send failed: ${e.message}` });
    }
  }

  /** POST /api/cli/stop — stop a running CLI { type } */
  private async handleCliStop(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.instanceManager) {
      this.json(res, 503, { error: 'InstanceManager not available' });
      return;
    }
    const body = await this.readBody(req);
    const { type, instanceId } = body;

    const target = this.findCliTarget(type, instanceId);
    if (!target) {
      this.json(res, 404, { error: `No running instance found for: ${type || instanceId}` });
      return;
    }

    try {
      this.instanceManager.removeInstance(target.instanceId);
      this.json(res, 200, { stopped: true, type: target.type, instanceId: target.instanceId });
    } catch (e: any) {
      this.json(res, 500, { error: `Stop failed: ${e.message}` });
    }
  }

  /** GET /api/cli/events — SSE stream of CLI status events */
  private handleCliSSE(_req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('data: {"type":"connected"}\n\n');
    this.cliSSEClients.push(res);

    // Register event listener if first client + instanceManager available
    if (this.cliSSEClients.length === 1 && this.instanceManager) {
      this.instanceManager.onEvent((event) => {
        this.sendCliSSE(event);
      });
    }

    // Send current state snapshot immediately
    if (this.instanceManager) {
      const allStates = this.instanceManager.collectAllStates();
      const cliStates = allStates.filter(s => s.category === 'cli' || s.category === 'acp');
      for (const s of cliStates) {
        this.sendCliSSE({ event: 'snapshot', providerType: s.type, status: s.status, instanceId: s.instanceId });
      }
    }

    _req.on('close', () => {
      this.cliSSEClients = this.cliSSEClients.filter(c => c !== res);
    });
  }

  private sendCliSSE(data: any): void {
    const msg = `data: ${JSON.stringify({ ...data, timestamp: Date.now() })}\n\n`;
    for (const client of this.cliSSEClients) {
      try { client.write(msg); } catch { /* ignore */ }
    }
  }

  /** GET /api/cli/debug/:type — full internal debug state of a CLI adapter */
  private async handleCliDebug(type: string, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.instanceManager) {
      this.json(res, 503, { error: 'InstanceManager not available' });
      return;
    }

    const target = this.findCliTarget(type);
    if (!target) {
      const allStates = this.instanceManager.collectAllStates();
      this.json(res, 404, { error: `No running instance for: ${type}`, available: allStates.filter(s => s.category === 'cli' || s.category === 'acp').map(s => s.type) });
      return;
    }

    // Get the ProviderInstance and access adapter debug state
    const instance = this.instanceManager.getInstance(target.instanceId) as any;
    if (!instance) {
      this.json(res, 404, { error: `Instance not found: ${target.instanceId}` });
      return;
    }

    try {
      const adapter = instance.getAdapter?.() || instance.adapter;
      if (adapter && typeof adapter.getDebugState === 'function') {
        const debugState = adapter.getDebugState();
        this.json(res, 200, {
          instanceId: target.instanceId,
          providerState: {
            type: target.type,
            name: target.name,
            status: target.status,
            mode: 'mode' in target ? target.mode : undefined,
          },
          debug: debugState,
        });
      } else {
        // Fallback: return what we can from the state
        this.json(res, 200, {
          instanceId: target.instanceId,
          providerState: target,
          debug: null,
          message: 'No debug state available (adapter.getDebugState not found)',
        });
      }
    } catch (e: any) {
      this.json(res, 500, { error: `Debug state failed: ${e.message}` });
    }
  }

  /** POST /api/cli/resolve — resolve an approval modal { type, buttonIndex } */
  private async handleCliResolve(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const { type, buttonIndex, instanceId } = body;
    if (buttonIndex === undefined || buttonIndex === null) {
      this.json(res, 400, { error: 'buttonIndex required (0=Yes, 1=Always, 2=Deny)' });
      return;
    }

    if (!this.cliManager) {
      this.json(res, 503, { error: 'CliManager not available' });
      return;
    }
    if (!this.instanceManager) {
      this.json(res, 503, { error: 'InstanceManager not available' });
      return;
    }

    const target = this.findCliTarget(type, instanceId);
    if (!target) {
      this.json(res, 404, { error: `No running adapter for: ${type || instanceId}` });
      return;
    }

    const instance = this.instanceManager.getInstance(target.instanceId) as any;
    const adapter = instance?.getAdapter?.() || instance?.adapter;
    if (!adapter) {
      this.json(res, 404, { error: `Adapter not found for instance: ${target.instanceId}` });
      return;
    }

    try {
      if (typeof adapter.resolveModal === 'function') {
        adapter.resolveModal(buttonIndex);
        this.json(res, 200, { resolved: true, type: target.type, instanceId: target.instanceId, buttonIndex });
      } else {
        this.json(res, 400, { error: 'resolveModal not available on this adapter' });
      }
    } catch (e: any) {
      this.json(res, 500, { error: `Resolve failed: ${e.message}` });
    }
  }

  /** POST /api/cli/raw — send raw keystrokes to PTY { type, keys } */
  private async handleCliRaw(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const { type, keys, instanceId } = body;
    if (!keys) {
      this.json(res, 400, { error: 'keys required (raw string to send to PTY)' });
      return;
    }

    if (!this.cliManager) {
      this.json(res, 503, { error: 'CliManager not available' });
      return;
    }
    if (!this.instanceManager) {
      this.json(res, 503, { error: 'InstanceManager not available' });
      return;
    }

    const target = this.findCliTarget(type, instanceId);
    if (!target) {
      this.json(res, 404, { error: `No running adapter for: ${type || instanceId}` });
      return;
    }

    const instance = this.instanceManager.getInstance(target.instanceId) as any;
    const adapter = instance?.getAdapter?.() || instance?.adapter;
    if (!adapter) {
      this.json(res, 404, { error: `Adapter not found for instance: ${target.instanceId}` });
      return;
    }

    try {
      if (typeof adapter.writeRaw === 'function') {
        adapter.writeRaw(keys);
        this.json(res, 200, { sent: true, type: target.type, instanceId: target.instanceId, keysLength: keys.length });
      } else {
        this.json(res, 400, { error: 'writeRaw not available on this adapter' });
      }
    } catch (e: any) {
      this.json(res, 500, { error: `Raw send failed: ${e.message}` });
    }
  }
}
