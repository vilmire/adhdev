/**
 * Standalone HTTP API — auth, preferences, provider REST, mux / runtime SSE,
 * `/api/v1/command`, static dashboard files.
 *
 * Moved out of index.ts (wiring-unification B5, pure move + rewiring): the
 * server class keeps the process / WS lifecycle, this class keeps the request
 * surface and the auth state it guards. Every command now enters through the
 * host runtime (`deps.executeCommand` → `hostRuntime.execute`), so the provider
 * REST routes gain the same topic invalidation as the WS / command paths (C11).
 */

import type { IncomingMessage, ServerResponse } from 'http';
import * as path from 'path';
import * as fs from 'fs';
import type { StatusResponse } from '@adhdev/daemon-core';
import type { SessionHostClient, SessionHostEvent } from '@adhdev/session-host-core';
import {
  AdhMuxControlClient,
  getWorkspaceSocketInfo,
  getWorkspaceState,
  requestWorkspaceControl,
  type AdhMuxControlEvent,
} from '@adhdev/terminal-mux-control/api';
import {
  handleRawTerminalHttpRequest,
  isRawTerminalApiPath,
  type RawTerminalHttpService,
} from './raw-terminal-http.js';
import {
  handleInteractivePromptHttpRequest,
  isInteractivePromptApiPath,
  type InteractivePromptHttpService,
} from './interactive-prompt-http.js';
import { normalizeCommandEnvelope } from './standalone-command-envelope.js';
import {
  getStandalonePasswordConfigPath,
  loadStandaloneBindHostPreference,
  loadStandaloneFontPreferences,
  saveStandaloneBindHostPreference,
  saveStandaloneFontPreferences,
  createPasswordRecord,
  verifyPassword,
  loadStandalonePasswordConfig,
  saveStandalonePasswordConfig,
  clearStandalonePasswordConfig,
  shouldWarnForPublicUnauthenticatedHost,
  parseCookies,
  buildSessionCookie,
  buildClearedSessionCookie,
  StandaloneSessionStore,
  isStandaloneRequestAuthenticated,
  type StandalonePasswordConfig,
} from './standalone-auth.js';

export interface StandaloneHttpDeps {
  /** Components are up (the provider REST routes answer 503 before that). */
  isReady(): boolean;
  getStatus(): StatusResponse;
  /** `hostRuntime.execute(type, payload, 'standalone')`. */
  executeCommand(type: string, payload: Record<string, unknown>): Promise<any>;
  rawTerminalService(): RawTerminalHttpService;
  interactivePromptService(): InteractivePromptHttpService;
  isCliSession(sessionId: string): boolean;
  createSessionHostClient(): Promise<SessionHostClient>;
}

export class StandaloneHttpApi {
  authToken: string | null = null;
  passwordConfigPath = getStandalonePasswordConfigPath();
  passwordConfig: StandalonePasswordConfig | null = null;
  authSessions = new StandaloneSessionStore();
  listenHost = '127.0.0.1';

  constructor(private readonly deps: StandaloneHttpDeps) {}

  /** Token auth (opt-in) and the persisted password config. */
  configureAuth(token: string | null): void {
    this.authToken = token;
    this.passwordConfig = loadStandalonePasswordConfig(this.passwordConfigPath);
  }

  hasPasswordAuth(): boolean {
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

  isRequestAuthenticated(req: IncomingMessage, rawUrl: string): boolean {
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
    return this.isAllowedOrigin(req);
  }

  /**
   * Allow same-origin requests, requests without an Origin header (curl, native
   * fetches that omit it), and the well-known dashboard dev origins on
   * loopback. Cross-origin browser requests from arbitrary websites are
   * rejected — this is what blocks the no-auth-default exploitation reported
   * by external researchers where a malicious page reads /api/v1/status or
   * fires /api/v1/command on the locally-bound daemon.
   */
  isAllowedOrigin(req: IncomingMessage): boolean {
    const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
    if (!originHeader) return true;
    try {
      const origin = new URL(originHeader);
      const host = req.headers.host || '';
      if (origin.host === host) return true;
      const hostname = (origin.hostname || '').toLowerCase();
      const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
      // Vite dev server (3000) and our own served dashboard ports we know
      // about. Only honor when the request is coming TO a loopback bind.
      if (isLoopback && (this.listenHost === '127.0.0.1' || this.listenHost === 'localhost' || this.listenHost === '::1' || this.listenHost === '0.0.0.0')) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private originHeaderFor(req: IncomingMessage): string | null {
    const o = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
    return o || null;
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

  handle(
    req: IncomingMessage,
    res: import('http').ServerResponse,
    publicDir?: string
  ): void {
    const url = req.url || '/';
    const method = req.method || 'GET';

    // CORS — only advertise the request's own origin when allowed. Defaulting
    // to '*' let any website read /api/v1/status and POST commands to the
    // locally-bound daemon (reported by an external researcher; reproduced).
    const requestOrigin = this.originHeaderFor(req);
    const originAllowed = this.isAllowedOrigin(req);
    if (requestOrigin) {
      res.setHeader('Vary', 'Origin');
      if (originAllowed) {
        res.setHeader('Access-Control-Allow-Origin', requestOrigin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }
    } else {
      // No-Origin requests (curl, native http clients) — no need to echo.
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (method === 'OPTIONS') {
      if (requestOrigin && !originAllowed) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Cross-origin request rejected.' }));
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }
    // Reject cross-origin actual requests outright. GET/HEAD with an Origin
    // header is browser-issued so this catches the simple-request bypass.
    if (requestOrigin && !originAllowed) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Cross-origin request rejected.' }));
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
      const standaloneFontPreferences = loadStandaloneFontPreferences();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        standaloneBindHost: configuredBindHost,
        currentBindHost: this.listenHost,
        standaloneFontPreferences,
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
        const savedHost = Object.prototype.hasOwnProperty.call(body || {}, 'standaloneBindHost')
          ? saveStandaloneBindHostPreference(body?.standaloneBindHost === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1')
          : loadStandaloneBindHostPreference();
        const savedFontPreferences = Object.prototype.hasOwnProperty.call(body || {}, 'standaloneFontPreferences')
          ? saveStandaloneFontPreferences(body?.standaloneFontPreferences)
          : loadStandaloneFontPreferences();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          standaloneBindHost: savedHost,
          currentBindHost: this.listenHost,
          standaloneFontPreferences: savedFontPreferences,
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

    if (isRawTerminalApiPath(parsedUrl.pathname)) {
      void handleRawTerminalHttpRequest({
        req,
        res,
        parsedUrl,
        service: this.deps.rawTerminalService(),
      }).catch((error: any) => {
        if (res.headersSent) return;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error?.message || String(error) }));
      });
      return;
    }

    if (isInteractivePromptApiPath(parsedUrl.pathname)) {
      void handleInteractivePromptHttpRequest({
        req,
        res,
        parsedUrl,
        service: this.deps.interactivePromptService(),
      }).catch((error: any) => {
        if (res.headersSent) return;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error?.message || String(error) }));
      });
      return;
    }

    if (apiPath === '/status' && method === 'GET') {
      const status = this.deps.getStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
      return;
    }

    // ─── Provider management REST (curl-friendly testing) ───────
    // GET  /api/v1/providers/catalog      → registry catalog via the daemon's resolver (onboarding)
    // GET  /api/v1/providers/installed    → list installed providers + versions
    // GET  /api/v1/providers/updates      → check_provider_updates (READ-ONLY: pins vs registry)
    // POST /api/v1/providers/activate     → activate_provider_updates (moves the pointer)
    // POST /api/v1/providers/rollback     → body: { providerType } (local flip to previous)
    // POST /api/v1/providers/install      → body: { type, category?, version? }
    // POST /api/v1/providers/uninstall    → body: { type, category }
    if (apiPath?.startsWith('/providers/')) {
      const subPath = apiPath.slice('/providers'.length);
      if (!this.deps.isReady()) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'router not initialized' }));
        return;
      }
      void (async () => {
        try {
          let cmdType: string | null = null;
          let body: Record<string, unknown> = {};
          if (subPath === '/installed' && method === 'GET') {
            cmdType = 'list_installed_providers';
          } else if ((subPath === '/catalog' || subPath.startsWith('/catalog?')) && method === 'GET') {
            // apiPath keeps the query string (url.slice), so a parameterized
            // catalog call arrives as '/catalog?...' — match both forms.
            // Registry catalog via the daemon's registry RESOLVER — the
            // onboarding dialog must never call the vendor registry directly
            // (self-hosted daemons point the resolver elsewhere).
            cmdType = 'registry_catalog';
            const q = parsedUrl.searchParams;
            body = {
              ...(q.get('sort') ? { sort: q.get('sort') } : {}),
              ...(q.get('limit') ? { limit: Number(q.get('limit')) } : {}),
            };
          } else if (subPath === '/updates' && method === 'GET') {
            cmdType = 'check_provider_updates';
          } else if (subPath === '/activate' && method === 'POST') {
            // The pointer flip. It lives behind POST because it changes what
            // this daemon loads; GET /updates is now purely a report.
            cmdType = 'activate_provider_updates';
            body = await this.readJsonBody(req).catch(() => ({}));
          } else if (subPath === '/rollback' && method === 'POST') {
            cmdType = 'rollback_provider_update';
            body = await this.readJsonBody(req).catch(() => ({}));
          } else if (subPath === '/install' && method === 'POST') {
            cmdType = 'install_provider_manifest';
            body = await this.readJsonBody(req).catch(() => ({}));
          } else if (subPath === '/uninstall' && method === 'POST') {
            cmdType = 'uninstall_provider_manifest';
            body = await this.readJsonBody(req).catch(() => ({}));
          }
          if (!cmdType) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'unknown provider endpoint' }));
            return;
          }
          const result = await this.deps.executeCommand(cmdType, body);
          const ok = (result as { success?: boolean })?.success !== false;
          res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e?.message ?? String(e) }));
        }
      })();
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
        if (!this.deps.isCliSession(sessionId)) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'CLI session runtime unavailable', code: 'CLI_RUNTIME_UNAVAILABLE' }));
          return;
        }
        void (async () => {
          const client = await this.deps.createSessionHostClient();
          try {
            const sinceSeqParam = parsedUrl.searchParams.get('sinceSeq');
            const sinceSeqValue = sinceSeqParam === null ? undefined : Number(sinceSeqParam);
            const sinceSeq = typeof sinceSeqValue === 'number' && Number.isFinite(sinceSeqValue) ? sinceSeqValue : undefined;
            const snapshot = await client.request<{ seq: number; text: string; truncated: boolean; cols?: number; rows?: number }>({
              type: 'get_snapshot',
              payload: { sessionId, sinceSeq },
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
          const { type, payload } = normalizeCommandEnvelope(parsed);
          const result = await this.deps.executeCommand(type, payload || {});
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
    if (!this.deps.isCliSession(sessionId)) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'CLI session runtime unavailable', code: 'CLI_RUNTIME_UNAVAILABLE' }));
      return;
    }

    const client = await this.deps.createSessionHostClient();

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
      if (!this.deps.isCliSession(sessionId)) return;
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
}
