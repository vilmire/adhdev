/**
 * CDP Manager for ADHDev Daemon
 * 
 * Ported cdp.ts from Extension for Daemon use.
 * vscode dependencies removed — works in pure Node.js environment.
 * 
 * Connects to IDE CDP port (9222, 9333 etc) to:
 * - Execute JS via Runtime.evaluate
 * - Agent webview iframe search & session connection
 * - DOM query
 */

import WebSocket from 'ws';
import * as http from 'http';
import * as fs from 'fs';
import { LOG } from '../logging/logger.js';
import type { CdpTargetFilter } from '../providers/contracts.js';

interface CdpTarget {
    id: string;
    type: string;
    title: string;
    url: string;
    webSocketDebuggerUrl: string;
}

export interface AgentWebviewTarget {
    targetId: string;
    extensionId: string;
    agentType: string;
    url: string;
}


export class DaemonCdpManager {
    private ws: WebSocket | null = null;
    private browserWs: WebSocket | null = null;  // browser-level WS for Target discovery
    private browserMsgId = 10000;
    private browserPending = new Map<number, {
        resolve: (v: any) => void;
        reject: (e: Error) => void;
    }>();
    private msgId = 1;
    private pending = new Map<number, {
        resolve: (v: any) => void;
        reject: (e: Error) => void;
    }>();
    private port: number;
    private _connected = false;
    private _browserConnected = false;
    private targetUrl = '';
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private contexts = new Set<number>();
    private connectPromise: Promise<boolean> | null = null;
    private failureCount = 0;
    private readonly MAX_FAILURES = 5;
    private agentSessions = new Map<string, AgentWebviewTarget>();
    private logFn: (msg: string) => void;
    private extensionProviders: { agentType: string; extensionId: string; extensionIdPattern: RegExp }[] = [];
    private _lastDiscoverSig = '';
    private _targetId: string | null = null;  // Connect to specific targetId (multi-window support)
    private _pageTitle: string = '';          // Connected page title
    private _targetFilter: CdpTargetFilter;   // Provider-configurable target selection
    private _lastDiscoveredTargets?: Set<string>;

    constructor(port = 9333, logFn?: (msg: string) => void, targetId?: string, targetFilter?: CdpTargetFilter) {
        this.port = port;
        this._targetId = targetId || null;
        this._targetFilter = targetFilter || {};
        this.logFn = logFn || ((msg) => {
            LOG.info('CDP', msg);
        });
    }

    /** Set target filter (can be updated after construction) */
    setTargetFilter(filter: CdpTargetFilter): void {
        this._targetFilter = filter;
    }

    /**
     * Check if a page title should be excluded (non-main page).
     * Uses provider-configured titleExcludes, falls back to default pattern.
     */
    private isNonMainTitle(title: string): boolean {
        if (!title) return true;
        const pattern = this._targetFilter.titleExcludes
            || 'extension-output|ADHDev CDP|Debug Console|Output\\s*$|Launchpad';
        return new RegExp(pattern, 'i').test(title);
    }

    /**
     * Check if a page URL matches the main window criteria.
     * Uses provider-configured urlIncludes/urlExcludes.
     */
    private isMainPageUrl(url: string | undefined): boolean {
        if (!url) return true; // no URL filter = accept all
        const { urlIncludes, urlExcludes } = this._targetFilter;
        if (urlIncludes && !url.includes(urlIncludes)) return false;
        if (urlExcludes) {
            for (const exc of urlExcludes) {
                if (url.includes(exc)) return false;
            }
        }
        return true;
    }

 /** Connected page title (includes workspace name) */
    get pageTitle(): string { return this._pageTitle; }

 /** Connected target ID */
    get targetId(): string | null { return this._targetId; }

 /**
 * Query all workbench pages on port (static)
 * Returns multiple entries if multiple IDE windows are open on same port
 */
    static listAllTargets(port: number): Promise<CdpTarget[]> {
        return new Promise((resolve) => {
            const req = http.get(`http://127.0.0.1:${port}/json`, (res) => {
                let data = '';
                res.on('data', (chunk: Buffer) => data += chunk.toString());
                res.on('end', () => {
                    try {
                        const targets: CdpTarget[] = JSON.parse(data);
                        const pages = targets.filter(
                            t => t.type === 'page' && t.webSocketDebuggerUrl
                        );
 // Filter using default target filter (static — no provider filter available)
                        const defaultExclude = /extension-output|ADHDev CDP|Debug Console|Output\s*$|Launchpad/i;
                        const isNonMain = (title: string) => !title || defaultExclude.test(title);
                        const mainPages = pages.filter(t =>
                            !isNonMain(t.title || '') &&
                            t.url?.includes('workbench.html') &&
                            !t.url?.includes('agent')
                        );
                        const fallbackPages = pages.filter(t => !isNonMain(t.title || ''));
                        resolve(mainPages.length > 0 ? mainPages : fallbackPages);
                    } catch { resolve([]); }
                });
            });
            req.on('error', () => resolve([]));
            req.setTimeout(2000, () => { req.destroy(); resolve([]); });
        });
    }

    setPort(port: number): void {
        this.port = port;
        this.log(`[CDP] Port changed to ${port}`);
    }

    getPort(): number { return this.port; }

    private log(msg: string): void {
        this.logFn(msg);
    }

 // ─── Connection Management ───────────────────────────────

    async connect(): Promise<boolean> {
        if (this._connected && this.ws?.readyState === WebSocket.OPEN) return true;
        if (this.connectPromise) return this.connectPromise;
        this.connectPromise = this.doConnect();
        try {
            return await this.connectPromise;
        } finally {
            this.connectPromise = null;
        }
    }

    private async doConnect(): Promise<boolean> {
        try {
            const target = await this.findTarget();
            if (!target) return false;

            this.log(`[CDP] Connecting to: ${target.title} (${target.id}) on port ${this.port}`);
            this.targetUrl = target.webSocketDebuggerUrl;
            const ok = await this.connectToTarget(this.targetUrl);
            if (ok) this.log('[CDP] ✅ Connected');
            return ok;
        } catch (err) {
            this.log(`[CDP] Connection error: ${(err as Error).message}`);
            return false;
        }
    }

    private findTargetOnPort(port: number): Promise<CdpTarget | null> {
        return new Promise((resolve) => {
            const req = http.get(`http://127.0.0.1:${port}/json`, (res) => {
                let data = '';
                res.on('data', (chunk: Buffer) => data += chunk.toString());
                res.on('end', () => {
                    try {
                        const targets: CdpTarget[] = JSON.parse(data);
                        const pages = targets.filter(
                            t => (t.type === 'page' || t.type === 'browser' || t.type === 'Page') && t.webSocketDebuggerUrl
                        );
                        if (pages.length === 0) {
                            resolve(targets.find(t => t.webSocketDebuggerUrl) || null);
                            return;
                        }

 // Exclude non-main tabs
                        const mainPages = pages.filter(t => !this.isNonMainTitle(t.title || ''));
                        const list = mainPages.length > 0 ? mainPages : pages;

                        this.log(`[CDP] pages(${list.length}): ${list.map(t => `"${t.title}"`).join(', ')}`);

 // If targetId is specified, select only matching page
                        if (this._targetId) {
                            const specific = list.find(t => t.id === this._targetId);
                            if (specific) {
                                this._pageTitle = specific.title || '';
                                resolve(specific);
                            } else {
                                this.log(`[CDP] Target ${this._targetId} not found in page list`);
                                resolve(null);
                            }
                            return;
                        }

                        this._pageTitle = list[0]?.title || '';
                        resolve(list[0]);
                    } catch { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
            req.setTimeout(2000, () => { req.destroy(); resolve(null); });
        });
    }

    private async findTarget(): Promise<CdpTarget | null> {
        return this.findTargetOnPort(this.port);
    }

    setExtensionProviders(providers: { agentType: string; extensionId: string; extensionIdPattern: RegExp }[]): void {
        this.extensionProviders = providers;
    }

    private connectToTarget(wsUrl: string): Promise<boolean> {
        return new Promise((resolve) => {
            this.ws = new WebSocket(wsUrl);

            this.ws.on('open', async () => {
                this._connected = true;
                try { await this.sendInternal('Runtime.enable'); } catch { }
 // Also connect Browser-level WS (for discovering agent iframes)
                this.connectBrowserWs().catch(() => { });
                resolve(true);
            });

            this.ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.id && this.pending.has(msg.id)) {
                        const { resolve, reject } = this.pending.get(msg.id)!;
                        this.pending.delete(msg.id);
                        this.failureCount = 0;
                        if (msg.error) reject(new Error(msg.error.message));
                        else resolve(msg.result);
                    } else if (msg.method === 'Runtime.executionContextCreated') {
                        this.contexts.add(msg.params.context.id);
                    } else if (msg.method === 'Runtime.executionContextDestroyed') {
                        this.contexts.delete(msg.params.executionContextId);
                    } else if (msg.method === 'Runtime.executionContextsCleared') {
                        this.contexts.clear();
                    }
                } catch { }
            });

            this.ws.on('close', () => {
                this.log('[CDP] WebSocket closed — scheduling reconnect');
                this._connected = false;
                this._browserConnected = false;
                this.browserWs?.close();
                this.browserWs = null;
                this.connectPromise = null;
                this.scheduleReconnect();
            });

            this.ws.on('error', (err) => {
                this.log(`[CDP] WebSocket error: ${err.message}`);
                this._connected = false;
                resolve(false);
            });
        });
    }

 /** Browser-level CDP connection — needed for Target discovery */
    private async connectBrowserWs(): Promise<void> {
        if (this._browserConnected && this.browserWs?.readyState === WebSocket.OPEN) return;
        try {
            const browserWsUrl = await this.getBrowserWsUrl();
            if (!browserWsUrl) {
                this.log('[CDP] No browser WS URL found');
                return;
            }
            this.log(`[CDP] Connecting browser WS for target discovery...`);
            await new Promise<void>((resolve, reject) => {
                this.browserWs = new WebSocket(browserWsUrl);
                this.browserWs.on('open', async () => {
                    this._browserConnected = true;
                    this.log('[CDP] ✅ Browser WS connected — enabling target discovery');
                    try {
                        await this.sendBrowser('Target.setDiscoverTargets', { discover: true });
                    } catch (e) {
                        this.log(`[CDP] setDiscoverTargets failed: ${(e as Error).message}`);
                    }
                    resolve();
                });
                this.browserWs.on('message', (data) => {
                    try {
                        const msg = JSON.parse(data.toString());
                        if (msg.id && this.browserPending.has(msg.id)) {
                            const { resolve, reject } = this.browserPending.get(msg.id)!;
                            this.browserPending.delete(msg.id);
                            if (msg.error) reject(new Error(msg.error.message));
                            else resolve(msg.result);
                        }
                    } catch { }
                });
                this.browserWs.on('close', () => {
                    this._browserConnected = false;
                    this.browserWs = null;
                });
                this.browserWs.on('error', (err) => {
                    this.log(`[CDP] Browser WS error: ${err.message}`);
                    this._browserConnected = false;
                    reject(err);
                });
            });
        } catch (e) {
            this.log(`[CDP] Browser WS connect failed: ${(e as Error).message}`);
        }
    }

    private getBrowserWsUrl(): Promise<string | null> {
        return new Promise((resolve) => {
            const req = http.get(`http://127.0.0.1:${this.port}/json/version`, (res) => {
                let data = '';
                res.on('data', (chunk: Buffer) => data += chunk.toString());
                res.on('end', () => {
                    try {
                        const info = JSON.parse(data);
                        resolve(info.webSocketDebuggerUrl || null);
                    } catch { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
            req.setTimeout(3000, () => { req.destroy(); resolve(null); });
        });
    }

    private sendBrowser(method: string, params: Record<string, unknown> = {}, timeoutMs = 15000): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.browserWs || !this._browserConnected) return reject(new Error('Browser WS not connected'));
            const id = this.browserMsgId++;
            this.browserPending.set(id, { resolve, reject });
            this.browserWs.send(JSON.stringify({ id, method, params }));
            setTimeout(() => {
                if (this.browserPending.has(id)) {
                    this.browserPending.delete(id);
                    reject(new Error(`Browser CDP timeout: ${method}`));
                }
            }, timeoutMs);
        });
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            if (!this._connected) {
                const ok = await this.connect();
 // Schedule reconnect on connection failure (prevent infinite loop: only when port is alive)
                if (!ok && !this._connected) {
                    this.scheduleReconnect();
                }
            }
        }, 5000);
    }

    disconnect(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.ws?.close();
        this.ws = null;
        this._connected = false;
        this.browserWs?.close();
        this.browserWs = null;
        this._browserConnected = false;
        this.failureCount = 0;
    }

    get isConnected(): boolean {
        return this._connected || this.ws?.readyState === WebSocket.OPEN;
    }

 // ─── CDP Protocol ────────────────────────────────────────

    private sendInternal(method: string, params: Record<string, unknown> = {}, timeoutMs = 15000): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.ws || !this._connected) return reject(new Error('CDP not connected'));
            if (this.ws.readyState !== WebSocket.OPEN) return reject(new Error('WebSocket not open'));

            const id = this.msgId++;
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));

            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    this.failureCount++;
                    if (this.failureCount >= this.MAX_FAILURES) {
                        this.log(`[CDP] Force-disconnecting: ${this.failureCount} timeouts (last: ${method})`);
                        this.disconnect();
                    }
                    reject(new Error(`CDP timeout: ${method}`));
                }
            }, timeoutMs);
        });
    }

    send(method: string, params: Record<string, unknown> = {}, timeoutMs = 15000): Promise<any> {
        return this.sendInternal(method, params, timeoutMs);
    }

    async sendCdpCommand(method: string, params: Record<string, unknown> = {}): Promise<any> {
        return this.sendInternal(method, params);
    }

    async evaluate(expression: string, timeoutMs = 30000): Promise<unknown> {
        try {
            const { result } = await this.sendInternal('Runtime.evaluate', {
                expression,
                returnByValue: true,
                awaitPromise: true,
            }, timeoutMs);
            if (result.subtype === 'error') throw new Error(result.description);
            this.failureCount = 0;
            return result.value;
        } catch (e) {
            const isTimeout = (e as Error).message?.includes('timeout');
            if (isTimeout) throw e;

            for (const ctxId of this.contexts) {
                try {
                    const { result } = await this.sendInternal('Runtime.evaluate', {
                        expression,
                        returnByValue: true,
                        awaitPromise: true,
                        contextId: ctxId,
                    });
                    if (result.subtype === 'error') continue;
                    return result.value;
                } catch { continue; }
            }
            throw e;
        }
    }

    async querySelector(selector: string): Promise<string | null> {
        return await this.evaluate(`
            (() => {
                const el = document.querySelector(${JSON.stringify(selector)});
                return el ? el.outerHTML.substring(0, 2000) : null;
            })()
        `) as string | null;
    }

 /**
 * Input text via CDP protocol then send Enter
 * Used for editors where execCommand does not work (e.g. Lexical).
 * 
 * 1. Find editor by selector, focus + click
 * 2. Insert text via Input.insertText
 * 3. Send Enter via Input.dispatchKeyEvent
 */
    async typeAndSend(selector: string, text: string): Promise<boolean> {
        if (!this.isConnected) return false;

 // Step 1: Focus + get position
        const focusResult = await this.evaluate(`(() => {
            const e = document.querySelector(${JSON.stringify(selector)});
            if (!e) return null;
            e.focus();
            const r = e.getBoundingClientRect();
            return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()`) as string | null;

        if (!focusResult) {
            this.log('[CDP] typeAndSend: selector not found');
            return false;
        }

        const pos = JSON.parse(focusResult);

 // Step 2: Click to ensure focus
        await this.sendInternal('Input.dispatchMouseEvent', {
            type: 'mousePressed', x: Math.round(pos.x), y: Math.round(pos.y),
            button: 'left', clickCount: 1
        });
        await this.sendInternal('Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: Math.round(pos.x), y: Math.round(pos.y),
            button: 'left', clickCount: 1
        });
        await new Promise(r => setTimeout(r, 150));

 // Step 3: Insert text & handle newlines
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].length > 0) {
                await this.sendInternal('Input.insertText', { text: lines[i] });
                await new Promise(r => setTimeout(r, 100));
            }
            if (i < lines.length - 1) {
                await this.sendInternal('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 }); // Shift
                await this.sendInternal('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r', modifiers: 8 });
                await this.sendInternal('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 });
                await new Promise(r => setTimeout(r, 100));
            }
        }
        await new Promise(r => setTimeout(r, 200));

 // Step 4: Press Enter
        await this.sendInternal('Input.dispatchKeyEvent', {
            type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r'
        });
        await this.sendInternal('Input.dispatchKeyEvent', {
            type: 'char', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r'
        });
        await this.sendInternal('Input.dispatchKeyEvent', {
            type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13
        });

        this.log(`[CDP] typeAndSend: sent "${text.substring(0, 50)}..."`);
        return true;
    }

 /**
 * Coordinate-based typeAndSend — for input fields inside webview iframe
 * Receives coordinates directly instead of selector for click+input+Enter
 */
    async typeAndSendAt(x: number, y: number, text: string): Promise<boolean> {
        if (!this.isConnected) return false;

 // Step 1: Click to focus
        await this.sendInternal('Input.dispatchMouseEvent', {
            type: 'mousePressed', x: Math.round(x), y: Math.round(y),
            button: 'left', clickCount: 1
        });
        await this.sendInternal('Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: Math.round(x), y: Math.round(y),
            button: 'left', clickCount: 1
        });
        await new Promise(r => setTimeout(r, 300));

 // Step 2: Select all + delete (remove existing content)
        await this.sendInternal('Input.dispatchKeyEvent', {
            type: 'rawKeyDown', key: 'a', code: 'KeyA',
            windowsVirtualKeyCode: 65, modifiers: 8, // Meta
        });
        await this.sendInternal('Input.dispatchKeyEvent', {
            type: 'keyUp', key: 'a', code: 'KeyA',
            windowsVirtualKeyCode: 65, modifiers: 8,
        });
        await this.sendInternal('Input.dispatchKeyEvent', {
            type: 'rawKeyDown', key: 'Backspace', code: 'Backspace',
            windowsVirtualKeyCode: 8,
        });
        await this.sendInternal('Input.dispatchKeyEvent', {
            type: 'keyUp', key: 'Backspace', code: 'Backspace',
            windowsVirtualKeyCode: 8,
        });
        await new Promise(r => setTimeout(r, 150));

 // Step 3: Insert text & handle newlines
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].length > 0) {
                await this.sendInternal('Input.insertText', { text: lines[i] });
                await new Promise(r => setTimeout(r, 100));
            }
            if (i < lines.length - 1) {
                await this.sendInternal('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 }); // Shift
                await this.sendInternal('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r', modifiers: 8 });
                await this.sendInternal('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 });
                await new Promise(r => setTimeout(r, 100));
            }
        }
        await new Promise(r => setTimeout(r, 200));

 // Step 4: Press Enter
        await this.sendInternal('Input.dispatchKeyEvent', {
            type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r'
        });
        await this.sendInternal('Input.dispatchKeyEvent', {
            type: 'char', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r'
        });
        await this.sendInternal('Input.dispatchKeyEvent', {
            type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13
        });

        this.log(`[CDP] typeAndSendAt(${Math.round(x)},${Math.round(y)}): sent "${text.substring(0, 50)}..."`);
        return true;
    }

 /**
 * Evaluate JS from inside Webview iframe
 * Kiro, PearAI etc Used for IDEs where chat UI is inside webview iframe.
 * 
 * 1. Query Target.getTargets via browser WS → find vscode-webview iframes
 * 2. Target.attachToTarget → session acquire
 * 3. Page.getFrameTree → nested iframe find
 * 4. Page.createIsolatedWorld → contextId acquire
 * 5. Runtime.evaluate → result return
 * 
 * @param expression JS expression to execute
 * @param matchFn webview iframe URL match function (optional, all webview attempt)
 * @returns evaluate result or null
 */
    async evaluateInWebviewFrame(expression: string, matchFn?: (bodyPreview: string) => boolean): Promise<string | null> {
        if (!this._browserConnected) {
            await this.connectBrowserWs().catch(() => { });
        }
        if (!this.browserWs || !this._browserConnected) {
            this.log('[CDP] evaluateInWebviewFrame: no browser WS');
            return null;
        }

        const browserWs = this.browserWs;
        let msgId = this.browserMsgId;

        const sendWs = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> => {
            return new Promise((resolve, reject) => {
                const mid = msgId++;
                this.browserMsgId = msgId;
                const handler = (raw: WebSocket.Data) => {
                    try {
                        const msg = JSON.parse(raw.toString());
                        if (msg.id === mid) {
                            browserWs.removeListener('message', handler);
                            if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                            else resolve(msg.result);
                        }
                    } catch { /* skip non-JSON */ }
                };
                browserWs.on('message', handler);
                const payload: any = { id: mid, method, params };
                if (sessionId) payload.sessionId = sessionId;
                browserWs.send(JSON.stringify(payload));
                setTimeout(() => {
                    browserWs.removeListener('message', handler);
                    reject(new Error(`timeout: ${method}`));
                }, 10000);
            });
        };

        try {
 // 1. Find webview iframe targets
            const { targetInfos } = await sendWs('Target.getTargets');
            const pageWebviewUrls = await this.getCurrentPageWebviewUrls();
            const webviewIframes = (targetInfos || []).filter((t: any) => {
                if (t.type !== 'iframe' || !(t.url || '').includes('vscode-webview')) return false;
                if (pageWebviewUrls.size === 0) return true;
                return pageWebviewUrls.has(t.url || '');
            });

            if (webviewIframes.length === 0) {
                this.log('[CDP] evaluateInWebviewFrame: no webview iframes found');
                return null;
            }

 // 2. Try each webview iframe
            for (const iframe of webviewIframes) {
                let sessionId: string | undefined;
                try {
                    const attached = await sendWs('Target.attachToTarget', {
                        targetId: iframe.targetId, flatten: true,
                    });
                    sessionId = attached.sessionId;

 // 3. Get frame tree (nested iframe)
                    const { frameTree } = await sendWs('Page.getFrameTree', {}, sessionId);
                    const childFrame = frameTree?.childFrames?.[0]?.frame;
                    if (!childFrame) {
                        await sendWs('Target.detachFromTarget', { sessionId }).catch(() => { });
                        continue;
                    }

 // 4. Create isolated world in child frame
                    const { executionContextId } = await sendWs('Page.createIsolatedWorld', {
                        frameId: childFrame.id,
                        worldName: 'adhdev-eval',
                        grantUniveralAccess: true,
                    }, sessionId);

 // 5. If matchFn provided, check body content first
                    if (matchFn) {
                        const checkResult = await sendWs('Runtime.evaluate', {
                            expression: `document.documentElement?.outerHTML?.substring(0, 500000) || ''`,
                            returnByValue: true,
                            contextId: executionContextId,
                        }, sessionId);
                        const bodyText = checkResult?.result?.value || '';
                        if (!matchFn(bodyText)) {
                            await sendWs('Target.detachFromTarget', { sessionId }).catch(() => { });
                            continue;
                        }
                    }

 // 6. Evaluate the expression
                    const result = await sendWs('Runtime.evaluate', {
                        expression,
                        returnByValue: true,
                        awaitPromise: true,
                        contextId: executionContextId,
                    }, sessionId);

                    await sendWs('Target.detachFromTarget', { sessionId }).catch(() => { });

                    const value = result?.result?.value;
                    if (value != null) {
                        const strValue = typeof value === 'string' ? value : JSON.stringify(value);
                        // Let provider script explicitly tell us to skip this iframe and try the next one
                        if (strValue.includes('__adhdev_skip_iframe')) {
                            this.log(`[CDP] evaluateInWebviewFrame: script requested skip in ${iframe.targetId.substring(0, 12)}`);
                            continue;
                        }
                        this.log(`[CDP] evaluateInWebviewFrame: success in ${iframe.targetId.substring(0, 12)}`);
                        return strValue;
                    }
                } catch (e: any) {
                    if (sessionId) {
                        await sendWs('Target.detachFromTarget', { sessionId }).catch(() => { });
                    }
                    this.log(`[CDP] evaluateInWebviewFrame: error in ${iframe.targetId.substring(0, 12)}: ${e.message}`);
                }
            }

            this.log('[CDP] evaluateInWebviewFrame: no matching webview found');
            return null;
        } catch (e: any) {
            this.log(`[CDP] evaluateInWebviewFrame error: ${e.message}`);
            return null;
        }
    }

 // ─── Agent Webview Multi-Session ─────────────────────────

    async discoverAgentWebviews(): Promise<AgentWebviewTarget[]> {
        if (!this.isConnected) return [];

 // Retry connection if no Browser WS
        if (!this._browserConnected) {
            await this.connectBrowserWs().catch(() => { });
        }

        try {
 // Query targets from Browser-level WS (includes iframes)
            let allTargets: any[] = [];
            if (this._browserConnected) {
                const result = await this.sendBrowser('Target.getTargets');
                allTargets = result?.targetInfos || [];
            } else {
 // Page-level query (when no browser WS, iframes may not be visible)
                const result = await this.sendInternal('Target.getTargets');
                allTargets = result?.targetInfos || [];
            }

            const pageWebviewUrls = await this.getCurrentPageWebviewUrls();

            const iframes = allTargets.filter((t: any) => t.type === 'iframe');
            const typeMap = new Map<string, number>();
            for (const t of allTargets) {
                typeMap.set(t.type, (typeMap.get(t.type) || 0) + 1);
            }
            const typeSummary = [...typeMap.entries()].map(([k, v]) => `${k}:${v}`).join(',');
 // Log only on change (called every 5s repeatedly, prevent noise)
            const sig = `${allTargets.length}:${iframes.length}:${typeSummary}`;
            if (sig !== this._lastDiscoverSig) {
                this._lastDiscoverSig = sig;
                this.log(`[CDP] discoverAgentWebviews: ${allTargets.length} total [${typeSummary}], ${iframes.length} iframes (browser=${this._browserConnected})`);
 // Detailed webview target logging also only on change
                for (const t of allTargets) {
                    if (t.type !== 'page' && t.type !== 'worker' && t.type !== 'service_worker') {
                        this.log(`[CDP]   target: type=${t.type} url=${(t.url || '').substring(0, 120)}`);
                    }
                    if ((t.url || '').includes('vscode-webview')) {
                        this.log(`[CDP]   webview: type=${t.type} url=${(t.url || '').substring(0, 150)}`);
                    }
                }
            }

            const agents: AgentWebviewTarget[] = [];
            for (const target of allTargets) {
                if (target.type !== 'iframe') continue;
                const url = target.url || '';
                const hasWebview = url.includes('vscode-webview');
                if (!hasWebview) continue;
                if (pageWebviewUrls.size > 0 && !pageWebviewUrls.has(url)) continue;

                for (const known of this.extensionProviders) {
                    if (known.extensionIdPattern.test(url)) {
                        agents.push({
                            targetId: target.targetId,
                            extensionId: known.extensionId,
                            agentType: known.agentType,
                            url: url,
                        });
                        if (!this._lastDiscoveredTargets?.has(target.targetId)) {
                            this.log(`[CDP] Found agent: ${known.agentType} (${target.targetId})`);
                        }
                        break;
                    }
                }
            }
            
            this._lastDiscoveredTargets = new Set(agents.map(a => a.targetId));
            return agents;
        } catch (e) {
            this.log(`[CDP] discoverAgentWebviews error: ${(e as Error).message}`);
            return [];
        }
    }

    async attachToAgent(target: AgentWebviewTarget): Promise<string | null> {
        if (!this.isConnected) return null;
        for (const [sid, t] of this.agentSessions) {
            if (t.agentType === target.agentType) return sid;
        }
        try {
 // Attach via Browser WS (iframes can only be attached from browser-level)
            const sendFn = this._browserConnected ? this.sendBrowser.bind(this) : this.sendInternal.bind(this);
            const result = await sendFn('Target.attachToTarget', {
                targetId: target.targetId,
                flatten: true,
            });
            const sessionId = result?.sessionId;
            if (sessionId) {
                this.agentSessions.set(sessionId, target);
                this.log(`[CDP] Attached to ${target.agentType}, session=${sessionId.substring(0, 12)}...`);
            }
            return sessionId || null;
        } catch (e) {
            this.log(`[CDP] attach error (${target.agentType}): ${(e as Error).message}`);
            return null;
        }
    }

    async evaluateInSession(sessionId: string, expression: string, timeoutMs = 15000): Promise<unknown> {
 // Flatten mode: if session was opened from same WS, must evaluate via same WS
        const ws = this._browserConnected ? this.browserWs : this.ws;
        const pendingMap = this._browserConnected ? this.browserPending : this.pending;
        const getNextId = () => this._browserConnected ? this.browserMsgId++ : this.msgId++;

        if (!ws || ws.readyState !== WebSocket.OPEN) {
            throw new Error('CDP not connected');
        }

        return new Promise((resolve, reject) => {
            const id = getNextId();
            pendingMap.set(id, {
                resolve: (result: any) => {
                    if (result?.result?.subtype === 'error') {
                        reject(new Error(result.result.description));
                    } else {
                        resolve(result?.result?.value);
                    }
                },
                reject,
            });
            ws.send(JSON.stringify({
                id, sessionId,
                method: 'Runtime.evaluate',
                params: { expression, returnByValue: true, awaitPromise: true },
            }));
            setTimeout(() => {
                if (pendingMap.has(id)) {
                    pendingMap.delete(id);
                    reject(new Error(`CDP agent timeout: ${sessionId.substring(0, 12)}...`));
                }
            }, timeoutMs);
        });
    }

 /**
  * Evaluate inside the child frame of an attached session.
  * Extension webviews have a nested iframe structure:
  *   outer (vscode-webview://) → inner (extension React app)
  * This method navigates into the inner frame using CDP Page.getFrameTree.
  * Falls back to evaluateInSession if no child frame is found.
  */
    async evaluateInSessionFrame(sessionId: string, expression: string, timeoutMs = 15000): Promise<unknown> {
        const ws = this._browserConnected ? this.browserWs : this.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            throw new Error('CDP not connected');
        }

        const sendViaSession = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
            return new Promise((resolve, reject) => {
                const pendingMap = this._browserConnected ? this.browserPending : this.pending;
                const id = this._browserConnected ? this.browserMsgId++ : this.msgId++;
                pendingMap.set(id, { resolve, reject });
                ws.send(JSON.stringify({ id, sessionId, method, params }));
                setTimeout(() => {
                    if (pendingMap.has(id)) {
                        pendingMap.delete(id);
                        reject(new Error(`CDP session timeout: ${method}`));
                    }
                }, timeoutMs);
            });
        };

        try {
            // 1. Get frame tree to find child frame
            const { frameTree } = await sendViaSession('Page.getFrameTree');
            const childFrame = frameTree?.childFrames?.[0]?.frame;

            if (!childFrame) {
                // No child frame — fall back to outer frame evaluation
                return this.evaluateInSession(sessionId, expression, timeoutMs);
            }

            // 2. Create isolated world in the child frame
            const { executionContextId } = await sendViaSession('Page.createIsolatedWorld', {
                frameId: childFrame.id,
                worldName: 'adhdev-agent-eval',
                grantUniveralAccess: true,
            });

            // 3. Evaluate expression in isolated world
            const result = await sendViaSession('Runtime.evaluate', {
                expression,
                returnByValue: true,
                awaitPromise: true,
                contextId: executionContextId,
            });

            if (result?.result?.subtype === 'error') {
                throw new Error(result.result.description);
            }
            return result?.result?.value;
        } catch (e) {
            // On Page.getFrameTree failure, fall back to direct session evaluation
            if ((e as Error).message?.includes('getFrameTree')) {
                return this.evaluateInSession(sessionId, expression, timeoutMs);
            }
            throw e;
        }
    }

    async detachAgent(sessionId: string): Promise<void> {
        try {
            const sendFn = this._browserConnected ? this.sendBrowser.bind(this) : this.sendInternal.bind(this);
            await sendFn('Target.detachFromTarget', { sessionId });
        } catch { }
        this.agentSessions.delete(sessionId);
    }

    async detachAllAgents(): Promise<void> {
        for (const sid of Array.from(this.agentSessions.keys())) {
            await this.detachAgent(sid);
        }
    }

    getAgentSessions(): Map<string, AgentWebviewTarget> {
        return this.agentSessions;
    }

    private async getCurrentPageWebviewUrls(): Promise<Set<string>> {
        if (!this.isConnected) return new Set();
        try {
            const raw = await this.evaluate(
                `JSON.stringify(Array.from(document.querySelectorAll('iframe,webview'))
                    .map((el) => el.src || el.getAttribute('src') || '')
                    .filter((src) => typeof src === 'string' && src.includes('vscode-webview')))`,
                5000,
            );
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (!Array.isArray(parsed)) return new Set();
            return new Set(parsed.filter((src: unknown): src is string => typeof src === 'string' && src.length > 0));
        } catch {
            return new Set();
        }
    }

 // ─── Screenshot ──────────────────────────────────────────

    async captureScreenshot(opts?: { quality?: number }): Promise<Buffer | null> {
        if (!this.isConnected) return null;
        const quality = opts?.quality ?? 20;
        try {
 // Get viewport size for per-clipping pro (avoids HiDPI bloat)
            let clip: any;
            try {
                const metrics = await this.sendInternal('Page.getLayoutMetrics', {}, 3000);
                const vp = metrics?.cssVisualViewport || metrics?.visualViewport;
                if (vp) {
                    clip = {
                        x: 0, y: 0,
                        width: Math.round(vp.clientWidth || vp.width || 1920),
                        height: Math.round(vp.clientHeight || vp.height || 1080),
                        scale: 1,
                    };
                }
            } catch { /* fallback: no clip */ }

            const result = await this.sendInternal('Page.captureScreenshot', {
                format: 'webp',
                quality,
                ...(clip ? { clip } : {}),
                optimizeForSpeed: true,
                captureBeyondViewport: false,
            }, 10000);
            if (result?.data) {
                return Buffer.from(result.data, 'base64');
            }
            return null;
        } catch (e) {
            this.log(`[CDP] Screenshot error: ${(e as Error).message}`);
            return null;
        }
    }
}
