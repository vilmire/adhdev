/**
 * DaemonCommandHandler — unified command routing for CDP & CLI
 *
 * Routes incoming commands (from server WS, P2P, or local WS) to
 * the correct CDP manager or CLI adapter.
 *
 * Key concepts:
 *   - extractIdeType(): determines target IDE from targetSessionId or ideType
 *   - getCdp(): returns the DaemonCdpManager for current command
 *   - getProvider(): returns the ProviderModule for current command
 *   - handle(): main entry point, sets context then dispatches
 */

import type { DaemonCdpManager } from '../cdp/manager.js';
import { CdpDomHandlers } from '../cdp/devtools.js';
import { findCdpManager } from '../status/builders.js';
import { ProviderLoader } from '../providers/provider-loader.js';
import type { ProviderInstanceManager } from '../providers/provider-instance-manager.js';
import type { ProviderModule, ProviderScripts } from '../providers/contracts.js';
import type { DaemonAgentStreamManager } from '../agent-stream/index.js';
import type { CliAdapter } from '../cli-adapter-types.js';
import { loadConfig } from '../config/config.js';
import { ChatHistoryWriter } from '../config/chat-history.js';
import type { SessionRegistry, SessionRuntimeTarget } from '../sessions/registry.js';
import { reconcileIdeRuntimeSessions } from '../sessions/reconcile.js';
import { LOG } from '../logging/logger.js';
import { resolveLegacyProviderScript, type LegacyStringScript } from './provider-script-resolver.js';

// Sub-module imports
import * as Chat from './chat-commands.js';
import * as Cdp from './cdp-commands.js';
import * as Stream from './stream-commands.js';
import * as WorkspaceCmd from './workspace-commands.js';
import { getWorkspaceState } from '../config/workspaces.js';

export interface CommandResult {
    success: boolean;
    [key: string]: unknown;
}

export interface CommandContext {
    cdpManagers: Map<string, DaemonCdpManager>;
    ideType: string;
    adapters: Map<string, CliAdapter>;
    providerLoader?: ProviderLoader;
    /** ProviderInstanceManager — for runtime settings propagation */
    instanceManager?: ProviderInstanceManager;
    sessionRegistry?: SessionRegistry;
    onProviderSettingChanged?: (providerType: string, key: string, value: any) => Promise<void> | void;
    onProviderSourceConfigChanged?: () => Promise<void> | void;
}

/**
 * Shared helpers interface — passed to sub-module command functions
 * for accessing CDP, providers, agent streams, and other handler-owned state.
 */
export interface CommandHelpers {
    getCdp(ideType?: string): DaemonCdpManager | null;
    getProvider(overrideType?: string): ProviderModule | undefined;
    getProviderScript(scriptName: string, params?: Record<string, string>, ideType?: string): string | null;
    evaluateProviderScript(scriptName: string, params?: Record<string, string>, timeout?: number): Promise<{ result: any; category: string } | null>;
    getCliAdapter(type?: string): CliAdapter | null;
    readonly currentManagerKey: string | undefined;
    readonly currentIdeType: string | undefined;
    readonly currentProviderType: string | undefined;
    readonly currentSession: SessionRuntimeTarget | undefined;
    readonly agentStream: DaemonAgentStreamManager | null;
    readonly ctx: CommandContext;
    readonly historyWriter: ChatHistoryWriter;
}

const COMMAND_DEBUG_LEVELS = new Set([
    'read_chat',
    'pty_input',
    'pty_resize',
    'cdp_eval',
    'cdp_batch',
    'cdp_dom_query',
    'cdp_dom_dump',
    'cdp_dom_debug',
]);

function logAtLevel(level: 'debug' | 'info' | 'warn' | 'error', category: string, message: string): void {
    switch (level) {
        case 'debug':
            LOG.debug(category, message);
            return;
        case 'warn':
            LOG.warn(category, message);
            return;
        case 'error':
            LOG.error(category, message);
            return;
        default:
            LOG.info(category, message);
    }
}

function getCommandLogLevel(cmd: string): 'debug' | 'info' {
    return COMMAND_DEBUG_LEVELS.has(cmd) ? 'debug' : 'info';
}

function summarizeLogValue(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') {
        const normalized = value.replace(/\s+/g, ' ').trim();
        if (!normalized) return '""';
        if (normalized.length <= 80) return JSON.stringify(normalized);
        return `${JSON.stringify(normalized.slice(0, 80))}…(${normalized.length} chars)`;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return `[${value.length} items]`;
    if (typeof value === 'object') return '{...}';
    return String(value);
}

function summarizeCommandArgs(args: any): string {
    if (!args || typeof args !== 'object') return '-';

    const preferredKeys = [
        'targetSessionId',
        'providerType',
        'agentType',
        'ideType',
        'model',
        'mode',
        'action',
        'button',
        'key',
        'force',
        'offset',
        'limit',
        'cols',
        'rows',
        'path',
        'command',
        'commandId',
        'workspace',
        'dir',
        'url',
        'text',
        'message',
        'data',
        'value',
    ];

    const entries: string[] = [];
    for (const key of preferredKeys) {
        if (!(key in args) || args[key] === undefined) continue;
        const value =
            key === 'text' || key === 'message'
                ? `${String(args[key] || '').length} chars`
                : key === 'data'
                    ? `${String(args[key] || '').length} chars`
                    : summarizeLogValue(args[key]);
        entries.push(`${key}=${value}`);
    }

    return entries.length ? entries.join(' ') : '{...}';
}

export class DaemonCommandHandler implements CommandHelpers {
    private _ctx: CommandContext;
    private _agentStream: DaemonAgentStreamManager | null = null;
    private domHandlers: CdpDomHandlers;
    private _historyWriter: ChatHistoryWriter;

    /** Current request route context */
    private _currentRoute: {
        session?: SessionRuntimeTarget;
        managerKey?: string;
        providerType?: string;
        sessionLookupFailed?: boolean;
    } = {};

    constructor(ctx: CommandContext) {
        this._ctx = ctx;
        this.domHandlers = new CdpDomHandlers((ideType?) => this.getCdp(ideType));
        this._historyWriter = new ChatHistoryWriter();
    }

    // ─── CommandHelpers implementation ─────────────────

    get ctx(): CommandContext { return this._ctx; }
    get agentStream(): DaemonAgentStreamManager | null { return this._agentStream; }
    get historyWriter(): ChatHistoryWriter { return this._historyWriter; }
    get currentManagerKey(): string | undefined { return this._currentRoute.managerKey; }
    get currentIdeType(): string | undefined { return this._currentRoute.managerKey; }
    get currentProviderType(): string | undefined { return this._currentRoute.providerType; }
    get currentSession(): SessionRuntimeTarget | undefined { return this._currentRoute.session; }

    /** Get CDP manager for a specific session or manager key. */
    getCdp(ideType?: string): DaemonCdpManager | null {
        const requested = ideType || this._currentRoute.session?.sessionId || this._currentRoute.managerKey;
        if (!requested) return null;
        const session = this._ctx.sessionRegistry?.get(requested);
        const managerKey = session?.cdpManagerKey || requested;
        const m = findCdpManager(this._ctx.cdpManagers, managerKey);
        if (m?.isConnected) return m;
        return null;
    }

    /**
     * Get provider module — _currentProviderType (agentType priority) use.
     */
    getProvider(overrideType?: string): ProviderModule | undefined {
        const key = overrideType || this._currentRoute.providerType || this._currentRoute.session?.providerType || this._currentRoute.managerKey;
        if (!key || !this._ctx.providerLoader) return undefined;
        const result = this._ctx.providerLoader.resolve(key);
        if (result) return result;
        const baseType = key.split('_')[0];
        if (baseType !== key) return this._ctx.providerLoader.resolve(baseType);
        return undefined;
    }

    /** Get a provider script by name from ProviderLoader. */
    getProviderScript(scriptName: string, params?: Record<string, string>, ideType?: string): string | null {
        const provider = this.getProvider(ideType);
        if (provider?.scripts) {
            const fn = provider.scripts[scriptName];
            if (typeof fn === 'function') {
                return resolveLegacyProviderScript(fn as LegacyStringScript, scriptName, params);
            }
        }
        return null;
    }

    /**
     * per-category CDP script execute:
     * IDE → cdp.evaluate(script) (main window)
     * Extension → cdp.evaluateInSession(sessionId, script) (webview)
     */
    async evaluateProviderScript(
        scriptName: string,
        params?: Record<string, string>,
        timeout = 30000,
    ): Promise<{ result: any; category: string } | null> {
        const provider = this.getProvider();
        const script = this.getProviderScript(scriptName, params);
        if (!script) return null;

        const cdp = this.getCdp();
        if (!cdp?.isConnected) return null;

        // Extension: evaluateInSession
        if (provider?.category === 'extension') {
            let sessionId: string | null = this._currentRoute.session?.sessionId || null;
            if (!sessionId && this._currentRoute.session?.parentSessionId) {
                sessionId = this._agentStream?.resolveSessionForAgent(this._currentRoute.session.parentSessionId, provider.type) || null;
            }
            if (sessionId && this._agentStream) {
                const target = this._ctx.sessionRegistry?.get(sessionId);
                if (target?.parentSessionId) {
                    await this._agentStream.setActiveSession(cdp, target.parentSessionId, sessionId);
                    await this._agentStream.syncActiveSession(cdp, target.parentSessionId);
                }
            }
            if (!sessionId) return null;
            const managed = this._agentStream?.getManagedSession(sessionId);
            const cdpSessionId = managed?.cdpSessionId;
            if (!cdpSessionId) return null;
            const result = await cdp.evaluateInSessionFrame(cdpSessionId, script, timeout);
            return { result, category: 'extension' };
        }

        // IDE (default): evaluate in main window
        const result = await cdp.evaluate(script, timeout);
        return { result, category: provider?.category || 'ide' };
    }

    /** CLI adapter search */
    getCliAdapter(type?: string): CliAdapter | null {
        const target = type || this._currentRoute.session?.sessionId || this._currentRoute.providerType || this._currentRoute.managerKey;
        if (!target || !this._ctx.adapters) return null;
        const session = this._ctx.sessionRegistry?.get(target);
        if (session?.adapterKey) {
            return this._ctx.adapters.get(session.adapterKey) || null;
        }
        return this._ctx.adapters.get(target) || null;
    }

    // ─── Private helpers ──────────────────────────────

    private inferProviderType(key: string | undefined): string | undefined {
        if (!key) return undefined;
        const session = this._ctx.sessionRegistry?.get(key);
        if (session?.providerType) return session.providerType;
        return key.split('_')[0];
    }

    private resolveRoute(args: any): { session?: SessionRuntimeTarget; managerKey?: string; providerType?: string; sessionLookupFailed?: boolean } {
        const targetSessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : '';
        let session = targetSessionId ? this._ctx.sessionRegistry?.get(targetSessionId) : undefined;
        if (targetSessionId && !session) {
            reconcileIdeRuntimeSessions(this._ctx.instanceManager, this._ctx.sessionRegistry);
            session = this._ctx.sessionRegistry?.get(targetSessionId);
        }
        const sessionLookupFailed = !!targetSessionId && !session;

        const managerKey = this.extractIdeType(args, sessionLookupFailed);
        let providerType: string | undefined;

        if (!sessionLookupFailed) {
            providerType =
                session?.providerType
                || args?.agentType
                || args?.providerType
                || this.inferProviderType(managerKey);
        }

        return { session, managerKey, providerType, sessionLookupFailed };
    }

    /** Extract CDP scope key from target session or explicit ideType */
    private extractIdeType(args: any, sessionLookupFailed = false): string | undefined {
        if (args?.targetSessionId) {
            const target = this._ctx.sessionRegistry?.get(args.targetSessionId);
            if (target?.cdpManagerKey) return target.cdpManagerKey;
            if (this._ctx.cdpManagers.has(args.targetSessionId)) return args.targetSessionId;
            if (sessionLookupFailed) return undefined;
        }

        // Also accept explicit ideType from args (P2P input, agentType for extensions)
        if (args?.ideType) {
            const target = this._ctx.sessionRegistry?.get(args.ideType);
            if (target?.cdpManagerKey) return target.cdpManagerKey;
            // Exact match first
            if (this._ctx.cdpManagers.has(args.ideType)) {
                return args.ideType;
            }
            // Prefix match for multi-window (e.g. "cursor" matches "cursor_remote_vs")
            const found = findCdpManager(this._ctx.cdpManagers, args.ideType);
            if (found) {
                // Return the actual key so getCdp() finds it
                for (const [k, m] of this._ctx.cdpManagers.entries()) {
                    if (m === found) return k;
                }
            }
        }

        return undefined;
    }

    private logCommandStart(cmd: string, args: any): void {
        const routeBits = [
            this._currentRoute.session?.sessionId ? `session=${this._currentRoute.session.sessionId}` : '',
            this._currentRoute.managerKey ? `manager=${this._currentRoute.managerKey}` : '',
            this._currentRoute.providerType ? `provider=${this._currentRoute.providerType}` : '',
        ].filter(Boolean).join(' ');
        const summary = summarizeCommandArgs(args);
        logAtLevel(
            getCommandLogLevel(cmd),
            'Command',
            `[${cmd}] start${routeBits ? ` ${routeBits}` : ''} args=${summary}`,
        );
    }

    private logCommandEnd(cmd: string, result: CommandResult, startedAt: number): void {
        const durationMs = Date.now() - startedAt;
        const parts = [`[${cmd}] end`, `success=${result.success}`, `duration=${durationMs}ms`];
        if (typeof result.error === 'string' && result.error) {
            parts.push(`error=${JSON.stringify(result.error)}`);
        }
        const level = result.success ? getCommandLogLevel(cmd) : 'warn';
        logAtLevel(level, 'Command', parts.join(' '));
    }

    setAgentStreamManager(manager: DaemonAgentStreamManager): void {
        this._agentStream = manager;
    }

    // ─── Command Dispatcher ──────────────────────────

    async handle(cmd: string, args: any): Promise<CommandResult> {
        // Per-request: extract target session / CDP scope / provider type from args
        this._currentRoute = this.resolveRoute(args);
        const startedAt = Date.now();
        this.logCommandStart(cmd, args);

        const sessionScopedCommands = new Set([
            'read_chat',
            'send_chat',
            'list_chats',
            'new_chat',
            'switch_chat',
            'set_mode',
            'change_model',
            'set_thought_level',
            'resolve_action',
            'select_session',
            'open_panel',
            'pty_input',
            'pty_resize',
            'invoke_provider_script',
        ]);

        if (this._currentRoute.sessionLookupFailed && sessionScopedCommands.has(cmd)) {
            const result = {
                success: false,
                error: `Live session not found for targetSessionId: ${String(args?.targetSessionId || '').trim() || 'unknown'}`,
            };
            this.logCommandEnd(cmd, result, startedAt);
            return result;
        }

        // Commands without ideType CDP silently fail (prevent P2P retry spam)
        let result: CommandResult;
        if (!this._currentRoute.session && !this._currentRoute.managerKey && !this._currentRoute.providerType) {
            const cdpCommands = ['send_chat', 'read_chat', 'list_chats', 'new_chat', 'switch_chat', 'set_mode', 'change_model', 'set_thought_level', 'resolve_action'];
            if (cdpCommands.includes(cmd)) {
                result = { success: false, error: 'No targetSessionId specified — cannot route command' };
                this.logCommandEnd(cmd, result, startedAt);
                return result;
            }
        }

        try {
            result = await this.dispatch(cmd, args);
            this.logCommandEnd(cmd, result, startedAt);
            return result;
        } catch (e: any) {
            LOG.error('Command', `[${cmd}] Unhandled error: ${e?.message || e}`);
            result = { success: false, error: `Internal error: ${e?.message || 'unknown'}` };
            this.logCommandEnd(cmd, result, startedAt);
            return result;
        }
    }

    private async dispatch(cmd: string, args: any): Promise<CommandResult> {
        switch (cmd) {
            // ─── Chat commands (chat-commands.ts) ───────────────
            case 'read_chat': return Chat.handleReadChat(this, args);
            case 'chat_history': return Chat.handleChatHistory(this, args);
            case 'send_chat': return Chat.handleSendChat(this, args);
            case 'list_chats': return Chat.handleListChats(this, args);
            case 'new_chat': return Chat.handleNewChat(this, args);
            case 'switch_chat': return Chat.handleSwitchChat(this, args);
            case 'set_mode': return Chat.handleSetMode(this, args);
            case 'change_model': return Chat.handleChangeModel(this, args);
            case 'set_thought_level': return Chat.handleSetThoughtLevel(this, args);
            case 'resolve_action': return Chat.handleResolveAction(this, args);

            // ─── CDP commands (cdp-commands.ts) ───────────────
            case 'cdp_eval': return Cdp.handleCdpEval(this, args);
            case 'cdp_screenshot':
            case 'screenshot': return Cdp.handleScreenshot(this, args);
            case 'cdp_command_exec': return Cdp.handleCdpCommand(this, args);
            case 'cdp_batch': return Cdp.handleCdpBatch(this, args);
            case 'cdp_remote_action': return Cdp.handleCdpRemoteAction(this, args);
            case 'cdp_discover_agents': return Cdp.handleDiscoverAgents(this, args);
            case 'cdp_dom_dump': return this.domHandlers.handleDomDump(args);
            case 'cdp_dom_query': return this.domHandlers.handleDomQuery(args);
            case 'cdp_dom_debug': return this.domHandlers.handleDomDebug(args);

            // ─── File commands (cdp-commands.ts) ──────────────
            case 'file_read': return Cdp.handleFileRead(this, args);
            case 'file_write': return Cdp.handleFileWrite(this, args);
            case 'file_list': return Cdp.handleFileList(this, args);
            case 'file_list_browse': return Cdp.handleFileListBrowse(this, args);

            // ─── Workspace cmds ──────────────
            case 'workspace_list': return WorkspaceCmd.handleWorkspaceList();
            case 'workspace_add': return WorkspaceCmd.handleWorkspaceAdd(args);
            case 'workspace_remove': return WorkspaceCmd.handleWorkspaceRemove(args);
            case 'workspace_set_default':
                return WorkspaceCmd.handleWorkspaceSetDefault(args);

            // ─── Script manage ───────────────────
            case 'refresh_scripts': return this.handleRefreshScripts(args);

            // ─── Stream commands (stream-commands.ts) ───────────
            case 'select_session': return Stream.handleSelectSession(this, args);
            case 'open_panel': return Stream.handleOpenPanel(this, args);

            // ─── PTY Raw I/O (stream-commands.ts) ─────────
            case 'pty_input': return Stream.handlePtyInput(this, args);
            case 'pty_resize': return Stream.handlePtyResize(this, args);

            // ─── Provider Settings (stream-commands.ts) ──────────
            case 'get_provider_settings': return Stream.handleGetProviderSettings(this, args);
            case 'set_provider_setting': return Stream.handleSetProviderSetting(this, args);
            case 'get_provider_source_config': return Stream.handleGetProviderSourceConfig(this, args);
            case 'set_provider_source_config': return Stream.handleSetProviderSourceConfig(this, args);

            // ─── IDE Extension Settings (stream-commands.ts) ──────────
            case 'get_ide_extensions': return Stream.handleGetIdeExtensions(this, args);
            case 'set_ide_extension': return Stream.handleSetIdeExtension(this, args);

            // ─── Provider control execution (stream-commands.ts) ──────────
            case 'invoke_provider_script': return Stream.handleProviderScript(this, args);

            // ─── Provider Auto-Fix / Clone (DevServer proxy) ──────────
            case 'provider_auto_fix': return this.proxyDevServerPost(args, 'auto-implement');
            case 'provider_auto_fix_cancel': return this.proxyDevServerPost(args, 'auto-implement/cancel');
            case 'provider_auto_fix_status': return this.proxyDevServerGet(args, 'auto-implement/status');
            case 'provider_clone': return this.proxyDevServerScaffold(args);

            default:
                return { success: false, error: `Unknown command: ${cmd}` };
        }
    }

    // ─── Misc (kept in handler — too small to extract) ───────

    private async handleRefreshScripts(_args: any): Promise<CommandResult> {
        if (this._ctx.providerLoader) {
            await this._ctx.providerLoader.fetchLatest().catch(() => {});
            this._ctx.providerLoader.reload();
            return { success: true };
        }
        return { success: false, error: 'ProviderLoader not initialized' };
    }

    // ─── DevServer HTTP proxy helpers ─────────────────
    // These bridge WS commands to the DevServer REST API (localhost:19280)

    private async proxyDevServerPost(args: any, endpoint: string): Promise<CommandResult> {
        const { providerType, ...body } = args || {};
        if (!providerType) return { success: false, error: 'providerType required' };
        try {
            const http = await import('http');
            const postData = JSON.stringify(body);
            const result = await new Promise<any>((resolve, reject) => {
                const req = http.request({
                    hostname: '127.0.0.1', port: 19280,
                    path: `/api/providers/${providerType}/${endpoint}`,
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
                }, (res) => {
                    let data = '';
                    res.on('data', (chunk: Buffer) => data += chunk);
                    res.on('end', () => {
                        try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); }
                    });
                });
                req.on('error', reject);
                req.write(postData);
                req.end();
            });
            return { success: true, ...result };
        } catch (e: any) {
            return { success: false, error: `DevServer unreachable: ${e.message}. Start daemon with --dev flag.` };
        }
    }

    private async proxyDevServerGet(args: any, endpoint: string): Promise<CommandResult> {
        const { providerType } = args || {};
        if (!providerType) return { success: false, error: 'providerType required' };
        try {
            const http = await import('http');
            const result = await new Promise<any>((resolve, reject) => {
                http.get(`http://127.0.0.1:19280/api/providers/${providerType}/${endpoint}`, (res) => {
                    let data = '';
                    res.on('data', (chunk: Buffer) => data += chunk);
                    res.on('end', () => {
                        try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); }
                    });
                }).on('error', reject);
            });
            return { success: true, ...result };
        } catch (e: any) {
            return { success: false, error: `DevServer unreachable: ${e.message}. Start daemon with --dev flag.` };
        }
    }

    private async proxyDevServerScaffold(args: any): Promise<CommandResult> {
        try {
            const http = await import('http');
            const postData = JSON.stringify(args || {});
            const result = await new Promise<any>((resolve, reject) => {
                const req = http.request({
                    hostname: '127.0.0.1', port: 19280,
                    path: '/api/scaffold',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
                }, (res) => {
                    let data = '';
                    res.on('data', (chunk: Buffer) => data += chunk);
                    res.on('end', () => {
                        try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); }
                    });
                });
                req.on('error', reject);
                req.write(postData);
                req.end();
            });
            return { success: true, ...result };
        } catch (e: any) {
            return { success: false, error: `DevServer unreachable: ${e.message}. Start daemon with --dev flag.` };
        }
    }
}
