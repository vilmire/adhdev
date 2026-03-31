/**
 * DaemonCommandHandler — unified command routing for CDP & CLI
 *
 * Routes incoming commands (from server WS, P2P, or local WS) to
 * the correct CDP manager or CLI adapter.
 *
 * Key concepts:
 *   - extractIdeType(): determines target IDE from _targetInstance
 *   - getCdp(): returns the DaemonCdpManager for current command
 *   - getProvider(): returns the ProviderModule for current command
 *   - handle(): main entry point, sets context then dispatches
 */

import type { DaemonCdpManager } from '../cdp/manager.js';
import { CdpDomHandlers } from '../cdp/devtools.js';
import { findCdpManager } from '../status/builders.js';
import { ProviderLoader } from '../providers/provider-loader.js';
import type { ProviderInstanceManager } from '../providers/provider-instance-manager.js';
import type { ProviderModule } from '../providers/contracts.js';
import type { DaemonAgentStreamManager } from '../agent-stream/index.js';
import { loadConfig } from '../config/config.js';
import { ChatHistoryWriter } from '../config/chat-history.js';
import { LOG } from '../logging/logger.js';

// Sub-module imports
import * as Chat from './chat-commands.js';
import * as Cdp from './cdp-commands.js';
import * as Stream from './stream-commands.js';
import * as WorkspaceCmd from './workspace-commands.js';
import { getWorkspaceState } from '../config/workspaces.js';
import { getWorkspaceActivity } from '../config/workspace-activity.js';

export interface CommandResult {
    success: boolean;
    [key: string]: unknown;
}

export interface CommandContext {
    cdpManagers: Map<string, DaemonCdpManager>;
    ideType: string;
    adapters: Map<string, any>;
    providerLoader?: ProviderLoader;
    /** ProviderInstanceManager — for runtime settings propagation */
    instanceManager?: ProviderInstanceManager;
    /** UUID instanceId → CDP manager key (ideType) mapping */
    instanceIdMap?: Map<string, string>;
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
    getCliAdapter(type?: string): any | null;
    readonly currentIdeType: string | undefined;
    readonly currentProviderType: string | undefined;
    readonly agentStream: DaemonAgentStreamManager | null;
    readonly ctx: CommandContext;
    readonly historyWriter: ChatHistoryWriter;
}

export class DaemonCommandHandler implements CommandHelpers {
    private _ctx: CommandContext;
    private _agentStream: DaemonAgentStreamManager | null = null;
    private domHandlers: CdpDomHandlers;
    private _historyWriter: ChatHistoryWriter;

    /** Current IDE type extracted from command args (per-request) */
    private _currentIdeType: string | undefined;
    /** Current provider type — agentType priority, ideType use */
    private _currentProviderType: string | undefined;

    constructor(ctx: CommandContext) {
        this._ctx = ctx;
        this.domHandlers = new CdpDomHandlers((ideType?) => this.getCdp(ideType));
        this._historyWriter = new ChatHistoryWriter();
    }

    // ─── CommandHelpers implementation ─────────────────

    get ctx(): CommandContext { return this._ctx; }
    get agentStream(): DaemonAgentStreamManager | null { return this._agentStream; }
    get historyWriter(): ChatHistoryWriter { return this._historyWriter; }
    get currentIdeType(): string | undefined { return this._currentIdeType; }
    get currentProviderType(): string | undefined { return this._currentProviderType; }

    /** Get CDP manager for a specific ideType or managerKey.
     * Supports exact match, multi-window prefix match, and instanceIdMap UUID lookup.
     * Returns null if no match — never falls back to another IDE. */
    getCdp(ideType?: string): DaemonCdpManager | null {
        const key = ideType || this._currentIdeType;
        if (!key) return null;
        // 1. Try instanceIdMap (UUID → managerKey)
        const resolved = this._ctx.instanceIdMap?.get(key) || key;
        // 2. Use findCdpManager (exact + prefix match)
        const m = findCdpManager(this._ctx.cdpManagers, resolved);
        if (m?.isConnected) return m;
        return null;
    }

    /**
     * Get provider module — _currentProviderType (agentType priority) use.
     */
    getProvider(overrideType?: string): ProviderModule | undefined {
        const key = overrideType || this._currentProviderType || this._currentIdeType;
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
            const fn = (provider.scripts as any)[scriptName];
            if (typeof fn === 'function') {
                const firstVal = params ? Object.values(params)[0] : undefined;
                const script = firstVal ? fn(firstVal) : fn();
                if (script) return script;
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
            let sessionId = this.getExtensionSessionId(provider, this._currentIdeType);
            if (!sessionId && this._agentStream && this._currentIdeType) {
                await this._agentStream.switchActiveAgent(cdp, this._currentIdeType, provider.type);
                await this._agentStream.syncAgentSessions(cdp, this._currentIdeType);
                sessionId = this.getExtensionSessionId(provider, this._currentIdeType);
            }
            if (!sessionId) return null;
            const result = await cdp.evaluateInSessionFrame(sessionId, script, timeout);
            return { result, category: 'extension' };
        }

        // IDE (default): evaluate in main window
        const result = await cdp.evaluate(script, timeout);
        return { result, category: provider?.category || 'ide' };
    }

    /** CLI adapter search */
    getCliAdapter(type?: string): any | null {
        const target = type || this._currentIdeType;
        if (!target || !this._ctx.adapters) return null;
        // Normalize composite transport IDs:
        //   standalone_xxx:cli:<uuid> -> <uuid>
        //   daemon:acp:<uuid>         -> <uuid>
        let normalizedTarget = target;
        const colonIdx = normalizedTarget.lastIndexOf(':');
        if (colonIdx >= 0) normalizedTarget = normalizedTarget.substring(colonIdx + 1);

        const direct = this._ctx.adapters.get(normalizedTarget);
        if (direct) return direct;

        for (const [key, adapter] of this._ctx.adapters.entries()) {
            if (
                (adapter as any).cliType === target
                || (adapter as any).cliType === normalizedTarget
                || key === normalizedTarget
                || key.startsWith(target)
                || key.startsWith(normalizedTarget)
            ) {
                return adapter;
            }
        }
        return null;
    }

    // ─── Private helpers ──────────────────────────────

    private getExtensionSessionId(provider: ProviderModule, scopeKey?: string): string | null {
        if (provider.category !== 'extension' || !this._agentStream || !scopeKey) return null;
        const managed = this._agentStream.getManagedAgent(provider.type, scopeKey);
        return managed?.sessionId || null;
    }

    private resolveManagerKeyFromInstanceId(instanceId: string): string | undefined {
        const mapped = this._ctx.instanceIdMap?.get(instanceId);
        if (mapped) return mapped;

        const entries = (this._ctx.instanceManager as any)?.instances?.entries?.();
        if (!entries) return undefined;

        for (const [instanceKey, instance] of entries as Iterable<[string, any]>) {
            if (typeof instanceKey !== 'string' || !instanceKey.startsWith('ide:')) continue;

            if (typeof instance?.getInstanceId === 'function' && instance.getInstanceId() === instanceId) {
                const managerKey = instanceKey.slice(4);
                this._ctx.instanceIdMap?.set(instanceId, managerKey);
                return managerKey;
            }

            if (typeof instance?.getExtensionInstances === 'function') {
                for (const ext of instance.getExtensionInstances() || []) {
                    if (typeof ext?.getInstanceId === 'function' && ext.getInstanceId() === instanceId) {
                        const managerKey = instanceKey.slice(4);
                        this._ctx.instanceIdMap?.set(instanceId, managerKey);
                        return managerKey;
                    }
                }
            }
        }

        return undefined;
    }

    /** Extract ideType from _targetInstance or explicit ideType */
    private extractIdeType(args: any): string | undefined {
        // Also accept explicit ideType from args (P2P input, agentType for extensions)
        if (args?.ideType) {
            // UUID → managerKey via instanceIdMap (P2P sends UUID instance IDs)
            const mappedKey = this.resolveManagerKeyFromInstanceId(args.ideType);
            if (mappedKey) {
                return mappedKey;
            }
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

        if (args?._targetInstance) {
            let raw = args._targetInstance as string;
            const ideMatch = raw.match(/:ide:(.+)$/);
            const cliMatch = raw.match(/:cli:(.+)$/);
            const acpMatch = raw.match(/:acp:(.+)$/);
            if (ideMatch) raw = ideMatch[1];
            else if (cliMatch) raw = cliMatch[1];
            else if (acpMatch) raw = acpMatch[1];

            const mappedKey = this.resolveManagerKeyFromInstanceId(raw);
            if (mappedKey) {
                return mappedKey;
            }

            // Direct CDP manager key match (e.g. "cursor", "cursor_remote_vs")
            if (this._ctx.cdpManagers.has(raw)) {
                return raw;
            }

            // Prefix match for multi-window keys
            const found = findCdpManager(this._ctx.cdpManagers, raw);
            if (found) {
                for (const [k, m] of this._ctx.cdpManagers.entries()) {
                    if (m === found) return k;
                }
            }

            // Fallback removed: returning first-connected CDP was the root cause of
            // input routing to wrong IDE (e.g. screenshot shows Cursor but input goes
            // to Antigravity). If no match is found, return undefined so the caller
            // gets an explicit error rather than silently routing to the wrong IDE.

            // Legacy: strip trailing _N suffix (e.g. "cursor_1" → "cursor")
            const lastUnderscore = raw.lastIndexOf('_');
            if (lastUnderscore > 0) {
                const stripped = raw.substring(0, lastUnderscore);
                if (this._ctx.cdpManagers.has(stripped)) return stripped;
            }
            return raw;
        }
        return undefined;
    }

    setAgentStreamManager(manager: DaemonAgentStreamManager): void {
        this._agentStream = manager;
    }

    // ─── Command Dispatcher ──────────────────────────

    async handle(cmd: string, args: any): Promise<CommandResult> {
        // Per-request: extract target IDE/provider type from args
        this._currentIdeType = this.extractIdeType(args);
        this._currentProviderType = args?.agentType || args?.providerType || this._currentIdeType;

        // Commands without ideType CDP silently fail (prevent P2P retry spam)
        if (!this._currentIdeType && !this._currentProviderType) {
            const cdpCommands = ['send_chat', 'read_chat', 'list_chats', 'new_chat', 'switch_chat', 'set_mode', 'change_model', 'set_thought_level', 'resolve_action'];
            if (cdpCommands.includes(cmd)) {
                return { success: false, error: 'No ideType specified — cannot route command' };
            }
        }

        try {
            return await this.dispatch(cmd, args);
        } catch (e: any) {
            LOG.error('Command', `[${cmd}] Unhandled error: ${e?.message || e}`);
            return { success: false, error: `Internal error: ${e?.message || 'unknown'}` };
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

            // ─── VSCode API commands (not available) ────
            case 'vscode_command_exec':
            case 'execute_vscode_command': {
                const resolvedCmd = args?.commandId || args?.command;
                if (resolvedCmd === 'adhdev.captureCdpScreenshot') {
                    return Cdp.handleScreenshot(this, args);
                }
                return { success: false, error: `VSCode command not available: ${resolvedCmd || cmd}` };
            }
            // ─── Workspace cmds ──────────────
            case 'get_recent_workspaces': return this.handleGetRecentWorkspaces(args);
            case 'get_cli_history': {
                const config = loadConfig();
                return { success: true, history: config.cliHistory || [] };
            }

            case 'workspace_list': return WorkspaceCmd.handleWorkspaceList();
            case 'workspace_add': return WorkspaceCmd.handleWorkspaceAdd(args);
            case 'workspace_remove': return WorkspaceCmd.handleWorkspaceRemove(args);
            case 'workspace_set_default':
            case 'workspace_set_active':
                return WorkspaceCmd.handleWorkspaceSetDefault(args);

            // ─── Script manage ───────────────────
            case 'refresh_scripts': return this.handleRefreshScripts(args);

            // ─── Stream commands (stream-commands.ts) ───────────
            case 'agent_stream_switch': return Stream.handleAgentStreamSwitch(this, args);
            case 'agent_stream_read': return Stream.handleAgentStreamRead(this, args);
            case 'agent_stream_send': return Stream.handleAgentStreamSend(this, args);
            case 'agent_stream_resolve': return Stream.handleAgentStreamResolve(this, args);
            case 'agent_stream_new': return Stream.handleAgentStreamNew(this, args);
            case 'agent_stream_list_chats': return Stream.handleAgentStreamListChats(this, args);
            case 'agent_stream_switch_session': return Stream.handleAgentStreamSwitchSession(this, args);
            case 'agent_stream_focus': return Stream.handleAgentStreamFocus(this, args);

            // ─── PTY Raw I/O (stream-commands.ts) ─────────
            case 'pty_input': return Stream.handlePtyInput(this, args);
            case 'pty_resize': return Stream.handlePtyResize(this, args);

            // ─── Provider Settings (stream-commands.ts) ──────────
            case 'get_provider_settings': return Stream.handleGetProviderSettings(this, args);
            case 'set_provider_setting': return Stream.handleSetProviderSetting(this, args);

            // ─── IDE Extension Settings (stream-commands.ts) ──────────
            case 'get_ide_extensions': return Stream.handleGetIdeExtensions(this, args);
            case 'set_ide_extension': return Stream.handleSetIdeExtension(this, args);

            // ─── Extension Model / Mode Control (stream-commands.ts) ──────────
            case 'list_extension_models': return Stream.handleExtensionScript(this, args, 'listModels');
            case 'set_extension_model': return Stream.handleExtensionScript(this, args, 'setModel');
            case 'list_extension_modes': return Stream.handleExtensionScript(this, args, 'listModes');
            case 'set_extension_mode': return Stream.handleExtensionScript(this, args, 'setMode');

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

    private async handleGetRecentWorkspaces(_args: any): Promise<CommandResult> {
        const config = loadConfig();
        const cliRecent = config.recentCliWorkspaces || [];
        const ws = getWorkspaceState(config);
        return {
            success: true,
            result: cliRecent,
            workspaces: ws.workspaces,
            defaultWorkspaceId: ws.defaultWorkspaceId,
            defaultWorkspacePath: ws.defaultWorkspacePath,
            activity: getWorkspaceActivity(config, 25),
        };
    }

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
