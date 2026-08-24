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
import { loadConfig, getConfigDir } from '../config/config.js';
import { resolveRegistryBaseUrl } from '../config/registry-resolver.js';
import { ChatHistoryWriter } from '../config/chat-history.js';
import type { SessionRegistry, SessionRuntimeTarget } from '../sessions/registry.js';
import { reconcileIdeRuntimeSessions } from '../sessions/reconcile.js';
import { LOG } from '../logging/logger.js';
import { resolveLegacyProviderScript, type LegacyStringScript } from './provider-script-resolver.js';
import { sha256Hex } from '../system/hash.js';
import { MANUAL_ATTENDANCE_COMMANDS, MANUAL_ATTENDANCE_PASSIVE_VIEW_COMMANDS } from '../providers/manual-attendance.js';

// Sub-module imports
import * as Chat from './chat-commands.js';
import * as Cdp from './cdp-commands.js';
import * as Stream from './stream-commands.js';
import * as WorkspaceCmd from './workspace-commands.js';
import { getWorkspaceState } from '../config/workspaces.js';
import { handleGitCommand, isGitCommandName, type GitCommandServices } from '../git/git-commands.js';

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
    gitCommandServices?: GitCommandServices;
    /** Fired synchronously before send_chat is dispatched; fire-and-forget for callers */
    onBeforeSendChat?: (params: { workspace: string; sessionId: string }) => void;
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
        let providerType: string | undefined = args?.agentType || args?.providerType;

        if (!sessionLookupFailed) {
            providerType =
                session?.providerType
                || providerType
                || this.inferProviderType(managerKey);
        } else if (!providerType) {
            providerType = this.inferProviderType(managerKey);
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

    /**
     * When a command in the manual-attendance set arrives for a session this
     * daemon hosts, stamp the live instance so auto-approve holds while the user
     * drives the session by hand. Provider-common: the signal is the command
     * (foreground select_session / open_panel, controlbar invoke_provider_script
     * / set_mode / change_model / set_thought_level, manual resolve_action,
     * pty_input), never any CLI-specific modal text — so it works identically for
     * every CLI/ACP provider. send_chat is deliberately excluded because a
     * coordinator delegating a task to a worker also uses send_chat; counting it
     * would wrongly suppress the worker's delegated auto-approve. For a remote
     * mesh worker session the controlbar commands are forwarded to the owning
     * worker daemon, which runs this same hook there, so attendance is recorded
     * on the daemon that actually hosts the instance.
     */
    private noteManualAttendanceIfApplicable(cmd: string, args: any): void {
        if (!MANUAL_ATTENDANCE_COMMANDS.has(cmd)) return;
        // Passive view-only actions (select_session / open_panel) attend a
        // foreground session but NOT a delegated worker — the instance decides.
        const passive = MANUAL_ATTENDANCE_PASSIVE_VIEW_COMMANDS.has(cmd);
        const sessionId = this._currentRoute.session?.sessionId
            || (typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : '');
        if (!sessionId) return;
        const session = this._ctx.sessionRegistry?.get(sessionId);
        const instanceKey = session?.adapterKey || session?.instanceKey || sessionId;
        const instance = this._ctx.instanceManager?.getInstance(instanceKey) as
            { noteManualInteraction?: (now?: number, opts?: { passive?: boolean }) => void } | undefined;
        try {
            instance?.noteManualInteraction?.(undefined, { passive });
        } catch {
            // attendance is best-effort — never block command dispatch
        }
    }

    // ─── Command Dispatcher ──────────────────────────

    async handle(cmd: string, args: any): Promise<CommandResult> {
        // Per-request: extract target session / CDP scope / provider type from args
        this._currentRoute = this.resolveRoute(args);
        const startedAt = Date.now();
        this.logCommandStart(cmd, args);
        this.noteManualAttendanceIfApplicable(cmd, args);
        let result: CommandResult;

        if (isGitCommandName(cmd)) {
            result = await handleGitCommand(cmd, args, this._ctx.gitCommandServices);
            this.logCommandEnd(cmd, result, startedAt);
            return result;
        }

        const sessionScopedCommands = new Set([
            'read_chat',
            'get_chat_debug_bundle',
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

        // read_chat and get_chat_debug_bundle can serve historical transcript data even
        // when the live session record is gone (stopped/destroyed). Allow the fallback
        // when the provider type is known and any session identity hint is present:
        // an explicit providerSessionId/historySessionId, or the targetSessionId itself
        // (which getHistorySessionId already uses as a fallback history key).
        const isReadOrDebugCmd = cmd === 'read_chat' || cmd === 'get_chat_debug_bundle';
        const allowsInactiveReadChatFallback =
            isReadOrDebugCmd
            && !!this._currentRoute.providerType
            && (
                (typeof args?.providerSessionId === 'string' && args.providerSessionId.trim().length > 0)
                || (typeof args?.historySessionId === 'string' && args.historySessionId.trim().length > 0)
                || (typeof args?.targetSessionId === 'string' && args.targetSessionId.trim().length > 0)
            );

        if (this._currentRoute.sessionLookupFailed && sessionScopedCommands.has(cmd) && !allowsInactiveReadChatFallback) {
            const result = {
                success: false,
                error: `Live session not found for targetSessionId: ${String(args?.targetSessionId || '').trim() || 'unknown'}`,
            };
            this.logCommandEnd(cmd, result, startedAt);
            return result;
        }

        // Commands without ideType CDP silently fail (prevent P2P retry spam)
        if (!this._currentRoute.session && !this._currentRoute.managerKey && !this._currentRoute.providerType) {
            const cdpCommands = ['send_chat', 'read_chat', 'list_chats', 'new_chat', 'switch_chat', 'set_mode', 'change_model', 'set_thought_level', 'resolve_action'];
            if (cdpCommands.includes(cmd)) {
                result = { success: false, error: 'No targetSessionId specified — cannot route command' };
                this.logCommandEnd(cmd, result, startedAt);
                return result;
            }
        }

        if (cmd === 'send_chat' && this._ctx.onBeforeSendChat) {
            const sessionId = this._currentRoute.session?.sessionId;
            const workspace = sessionId
                ? (this._ctx.instanceManager?.getInstance(sessionId) as any)?.getState?.()?.workspace
                : undefined;
            if (workspace && sessionId) {
                try {
                    this._ctx.onBeforeSendChat({ workspace, sessionId });
                } catch {
                    // hook must not block send_chat
                }
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
            case 'get_chat_debug_bundle': return Chat.handleGetChatDebugBundle(this, args);
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
            case 'list_provider_availability': return this.handleListProviderAvailability(args);
            case 'install_provider_manifest': return this.handleInstallProviderManifest(args);
            case 'uninstall_provider_manifest': return this.handleUninstallProviderManifest(args);
            case 'check_provider_updates': return this.handleCheckProviderUpdates(args);
            case 'activate_provider_updates': return this.handleActivateProviderUpdates(args);
            case 'rollback_provider_update': return this.handleRollbackProviderUpdate(args);
            case 'list_installed_providers': return this.handleListInstalledProviders(args);
            case 'add_provider_source': return this.handleAddProviderSource(args);
            case 'remove_provider_source': return this.handleRemoveProviderSource(args);
            case 'list_provider_sources': return this.handleListProviderSources(args);
            case 'set_active_provider_source': return this.handleSetActiveProviderSource(args);

            // ─── Stream commands (stream-commands.ts) ───────────
            case 'select_session': return Stream.handleSelectSession(this, args);
            case 'open_panel': return Stream.handleOpenPanel(this, args);

            // ─── PTY Raw I/O (stream-commands.ts) ─────────
            case 'pty_input': return Stream.handlePtyInput(this, args);
            case 'pty_resize': return Stream.handlePtyResize(this, args);
            // ─── MESH-READ-TERMINAL (feature 2): raw viewport read ──────────
            case 'read_terminal': return Stream.handleReadTerminal(this, args);
            // ─── MESH-SEND-KEYS (feature 3): structured key injection ────────
            case 'send_keys': return Stream.handleSendKeys(this, args);

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

    /**
     * Reload providers from disk. Does NOT pull from the registry — the user
     * controls installs explicitly via install_provider_manifest. To upgrade
     * an installed provider, call install_provider_manifest again with the
     * desired version (or with no version to pick up the latest from
     * registry), or use check_provider_updates to see what is out of date.
     */
    private async handleRefreshScripts(_args: any): Promise<CommandResult> {
        if (this._ctx.providerLoader) {
            this._ctx.providerLoader.reload();
            this._ctx.providerLoader.registerToDetector();
            const refreshedInstances = this._ctx.instanceManager
                ? this._ctx.instanceManager.refreshProviderDefinitions((providerType) => this._ctx.providerLoader!.resolve(providerType))
                : 0;
            const providers = this._ctx.providerLoader.getAll().map((provider) => ({
                type: provider.type,
                name: provider.name,
                category: provider.category,
            }));
            return { success: true, refreshedInstances, providers };
        }
        return { success: false, error: 'ProviderLoader not initialized' };
    }

    /**
     * Return per-provider availability so the dashboard's provider catalog
     * can show "Installed" badges. Reuses the existing detection state from
     * ProviderLoader.getMachineProviderStatus() — no probing is triggered.
     */
    private handleListProviderAvailability(_args: any): CommandResult {
        if (!this._ctx.providerLoader) {
            return { success: false, error: 'ProviderLoader not initialized' };
        }
        const { describeTrust, requiresConfirmation } =
            require('../providers/provider-trust.js') as typeof import('../providers/provider-trust.js');
        const loader = this._ctx.providerLoader;
        const items = loader.getAll().map((provider) => {
            const machineConfig = loader.getMachineProviderConfig(provider.type);
            const lastDetection = machineConfig.lastDetection;
            const trust = (provider as any)._sourceTrust ?? 'trusted';
            const layer = (provider as any)._sourceLayer ?? 'upstream';
            const sourceName = (provider as any)._sourceName ?? null;
            return {
                type: provider.type,
                // Expose manifest aliases so thin clients (MCP launch_session) can
                // resolve an alias to the canonical type + category locally instead
                // of guessing the launch route from the type string's suffix.
                aliases: Array.isArray(provider.aliases) ? provider.aliases : [],
                category: provider.category,
                status: loader.getMachineProviderStatus(provider.type),
                installed: lastDetection?.ok === true,
                detectedPath: lastDetection?.path ?? null,
                checkedAt: lastDetection?.checkedAt ?? null,
                trust,
                trustDescription: describeTrust(trust),
                requiresConfirmation: requiresConfirmation(trust),
                sourceLayer: layer,
                sourceName,
            };
        });
        return { success: true, providers: items };
    }

    /**
     * Compute the *upstream cache root*. install_provider_manifest writes
     * official-registry manifests here so the daemon's standard upstream
     * layer picks them up — no special handling needed at load time, and
     * the manifests inherit the official-trust badge instead of the
     * untrusted-external one.
     *
     * Resolved through the instance config dir (matches
     * ProviderLoader.upstreamDir) so a preview/standalone instance seeds its
     * own upstream cache and never writes into another instance's store.
     */
    private getUpstreamInstallRoot(): string {
        const path = require('path') as typeof import('path');
        return path.join(getConfigDir(), 'providers', '.upstream');
    }

    /**
     * Install (activate) a provider from the VERIFIED CHANNEL.
     *
     * CHANNEL-FIRST INSTALL (M-PROVIDER-DIST-UNIFY, 2026-08-10): this used to
     * download a single manifest JSON via the legacy registry shape and write
     * it into providers/.upstream — a path that 404s for channel-only
     * publications (the live kimi miss: published post-bootstrap, invisible
     * to every targeted sync AND uninstallable from the dashboard) and that
     * could not carry script bytes without a follow-up GitHub raw pull. The
     * verified channel bundle IS the full provider tree (scripts included,
     * digest-verified, atomic pointer flip, rollback), so installing a new
     * type is just a targeted channel sync — and the activation pointer then
     * keeps the type in every future sync's target set, so no .upstream
     * write is needed as an intent record.
     *
     * Args: { type: string, version?: string } (category accepted and
     * ignored — legacy REST callers send it). The verified channel serves
     * exactly ONE version per channel: a version request that does not match
     * the channel entry fails closed instead of pretending to honor it.
     */
    private async handleInstallProviderManifest(args: any): Promise<CommandResult> {
        const loader = this._ctx.providerLoader;
        if (!loader) {
            return { success: false, error: 'ProviderLoader not initialized' };
        }
        const type = typeof args?.type === 'string' ? args.type.trim() : '';
        if (!type) return { success: false, error: 'type is required' };
        // Defense in depth: reject any obvious path-traversal in the type.
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(type)) {
            return { success: false, error: 'invalid type' };
        }
        const requestedVersion = typeof args?.version === 'string' && args.version.trim()
            ? args.version.trim()
            : null;

        const report = await loader.syncVerifiedChannel({ extraTargetTypes: [type] });
        const activatedNow = report.activated.some((a) => a.providerType === type);
        const active = loader.listVerifiedChannelPins().get(type)?.active ?? null;

        if (!active) {
            const skip = report.skipped.find((s: any) => s?.entry?.providerType === type);
            const err = report.errors.find((e) => e.providerType === type) ?? report.errors[0];
            return {
                success: false,
                code: 'channel_install_failed',
                error: skip?.reason
                    || err?.message
                    || `provider "${type}" is not activatable on channel "${loader.channel}" (not published, or no verified artifact)`,
            };
        }
        if (requestedVersion && active.providerVersion !== requestedVersion) {
            return {
                success: false,
                code: 'channel_version_mismatch',
                error: `verified channel "${loader.channel}" serves ${type}@${active.providerVersion}; version "${requestedVersion}" is not addressable — the channel carries exactly one version per channel`,
            };
        }
        // syncVerifiedChannel already reloaded manifests on activation; refresh
        // detection so a freshly installed provider resolves detected/not_detected
        // instead of sitting unchecked.
        loader.registerToDetector();
        return {
            success: true,
            installed: {
                type,
                category: active.category,
                version: active.providerVersion,
                digest: active.digest,
                channel: loader.channel,
                alreadyInstalled: !activatedNow,
            },
        };
    }

    /**
     * Remove a provider manifest from the upstream cache root
     * (~/.adhdev/providers/.upstream/{category}/{type}/). Refuses to touch
     * anything outside that root. Used by onboarding to opt out of a
     * provider the user doesn't want; the dashboard no longer exposes a
     * per-provider uninstall button (external sources are removed as a
     * whole via remove_provider_source).
     */
    private async handleUninstallProviderManifest(args: any): Promise<CommandResult> {
        const type = typeof args?.type === 'string' ? args.type : '';
        const category = typeof args?.category === 'string' ? args.category : '';
        if (!type || !category) return { success: false, error: 'type and category are required' };
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(type)) {
            return { success: false, error: 'invalid type' };
        }
        if (!['cli', 'ide', 'extension', 'acp'].includes(category)) {
            return { success: false, error: `unknown category: ${category}` };
        }

        const fs = require('fs') as typeof import('fs');
        const path = require('path') as typeof import('path');

        try {
            const installRoot = this.getUpstreamInstallRoot();
            const installRootResolved = path.resolve(installRoot);
            const targetDir = path.resolve(path.join(installRoot, category, type));

            if (!targetDir.startsWith(installRootResolved + path.sep)) {
                return { success: false, error: 'refusing to delete outside upstream root' };
            }
            if (!fs.existsSync(targetDir)) {
                return { success: false, error: 'not installed' };
            }

            fs.rmSync(targetDir, { recursive: true, force: true });

            // Also drop any verified channel activation for this type so an
            // uninstalled provider does not keep loading from the
            // content-addressed store. Local pointer removal — no network.
            try {
                this._ctx.providerLoader?.deactivateVerifiedChannel?.(type);
            } catch { /* best-effort — uninstall of the upstream dir already succeeded */ }

            if (this._ctx.providerLoader) {
                this._ctx.providerLoader.reload();
                this._ctx.providerLoader.registerToDetector();
            }

            return { success: true, removed: { type, category, path: targetDir } };
        } catch (e: any) {
            return { success: false, error: `uninstall failed: ${e?.message || e}` };
        }
    }

    /**
     * Return everything currently installed in the upstream cache with its
     * version. This is the "what does this daemon have" answer used both by
     * the UI and by the update checker.
     */
    private handleListInstalledProviders(_args: any): CommandResult {
        const fs = require('fs') as typeof import('fs');
        const path = require('path') as typeof import('path');

        const installRoot = this.getUpstreamInstallRoot();
        if (!fs.existsSync(installRoot)) return { success: true, providers: [] };

        const CATEGORIES = ['cli', 'ide', 'extension', 'acp'] as const;
        const items: Array<{
            type: string;
            category: string;
            version: string;
            path: string;
            modelOptions?: string[];
            thinkingLevelOptions?: string[];
        }> = [];

        for (const category of CATEGORIES) {
            const categoryDir = path.join(installRoot, category);
            if (!fs.existsSync(categoryDir)) continue;
            let entries: string[];
            try { entries = fs.readdirSync(categoryDir); } catch { continue; }
            for (const type of entries) {
                // v1 manifest takes precedence over v0 when both are present.
                const v1Path = path.join(categoryDir, type, 'provider.v1.json');
                const v0Path = path.join(categoryDir, type, 'provider.json');
                const manifestPath = fs.existsSync(v1Path) ? v1Path : (fs.existsSync(v0Path) ? v0Path : null);
                if (!manifestPath) continue;
                try {
                    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
                    // Surface the manifest's advisory model / thinking-level lists so
                    // consumers of this endpoint (standalone New-session dialog, mesh
                    // node slot editor) get the same provider-specific dropdowns the
                    // status-snapshot path already carries — otherwise every provider
                    // (codex included) falls back to a free-text Model field.
                    const modelOptions = Array.isArray(m.modelOptions)
                        ? m.modelOptions.filter((x: unknown): x is string => typeof x === 'string' && !!x.trim())
                        : [];
                    const thinkingLevelOptions = Array.isArray(m.thinkingLevelOptions)
                        ? m.thinkingLevelOptions.filter((x: unknown): x is string => typeof x === 'string' && !!x.trim())
                        : [];
                    items.push({
                        type,
                        category,
                        version: typeof m.providerVersion === 'string' ? m.providerVersion : '0.0.0',
                        path: manifestPath,
                        ...(modelOptions.length ? { modelOptions } : {}),
                        ...(thinkingLevelOptions.length ? { thinkingLevelOptions } : {}),
                    });
                } catch {
                    // Corrupt manifest — skip but don't fail the whole listing.
                }
            }
        }
        return { success: true, providers: items };
    }

    /**
     * Report, for each installed provider, what this daemon is actually
     * PINNED to and what the registry currently offers.
     *
     * READ-ONLY. It used to end by calling syncVerifiedChannel(), i.e. it
     * downloaded, verified AND ACTIVATED — a command named `check` that moved
     * the pointer, reachable over `GET /api/v1/providers/updates`, so a plain
     * GET mutated state. Activation now lives in `activate_provider_updates`.
     *
     * It also compared the wrong number. `.upstream` holds the installed
     * manifest, but the daemon loads the pinned store object, and those
     * diverge by design (the pin only advances on an explicit activation).
     * Reporting `.upstream` described a machine that was not the one running:
     * with `.upstream` at 1.0.3 and the pin at 1.0.0 it said "up to date"
     * while the daemon ran the older spec. `activeVersion` is now the pin.
     *
     * `installedVersion` is kept as an alias of the pin so existing readers
     * do not silently flip meaning; it is the number that decides behaviour.
     *
     * Returns { providers: [{ type, category, activeVersion, installedVersion,
     *   upstreamVersion, latestVersion, updateAvailable, stale, digest,
     *   activatedAt, previousVersion, error? }] }
     */
    private async handleCheckProviderUpdates(_args: any): Promise<CommandResult> {
        const installed = this.handleListInstalledProviders({});
        if (!installed.success) return installed;

        const https = require('https') as typeof import('https');
        const cfg = loadConfig();
        const REGISTRY = resolveRegistryBaseUrl(cfg.registryUrl, process.env, cfg.serverUrl);

        function fetchJson(url: string): Promise<any> {
            return new Promise((resolve, reject) => {
                const req = https.get(url, { headers: { 'User-Agent': 'adhdev-daemon', 'Accept': 'application/json' }, timeout: 10000 }, (res) => {
                    if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
                    const chunks: Buffer[] = [];
                    res.on('data', (c: Buffer) => chunks.push(c));
                    res.on('end', () => {
                        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
                        catch (e) { reject(e); }
                    });
                });
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            });
        }

        const installedList = (installed as unknown as { providers: Array<{ type: string; category: string; version: string }> }).providers;
        // The pin is what the daemon loads; `.upstream` is only what is on
        // disk. Where a provider has no pin (channel store empty/disabled),
        // fall back to the upstream version so the row is still meaningful.
        const pins = this._ctx.providerLoader?.listVerifiedChannelPins?.() ?? new Map();
        // Staleness must be judged against the SAME channel the loader pins
        // from (channel/runtime.ts sends ?channel= on its listing for the same
        // reason). Without it, a preview-channel daemon compared its preview
        // pin against the stable row and mis-reported staleness both ways.
        const channel = this._ctx.providerLoader?.channel ?? 'stable';
        const checks = await Promise.all(
            installedList.map(async (p) => {
                const pin = pins.get(p.type);
                const activeVersion = pin?.active?.providerVersion ?? p.version;
                const base = {
                    type: p.type,
                    category: p.category,
                    activeVersion,
                    // Alias of the pin: this is the version that decides
                    // behaviour, which is what a field named "installed" is
                    // read as. `upstreamVersion` carries the on-disk manifest.
                    installedVersion: activeVersion,
                    upstreamVersion: p.version,
                    digest: pin?.active?.digest ?? null,
                    activatedAt: pin?.active?.activatedAt ?? null,
                    previousVersion: pin?.previous?.providerVersion ?? null,
                };
                try {
                    const remote = await fetchJson(`${REGISTRY}/providers/${encodeURIComponent(p.type)}?channel=${encodeURIComponent(channel)}`);
                    const latestVersion = String(remote?.version ?? '');
                    const stale = latestVersion !== '' && latestVersion !== activeVersion;
                    return { ...base, latestVersion, updateAvailable: stale, stale };
                } catch (e: any) {
                    return {
                        ...base,
                        latestVersion: null,
                        updateAvailable: false,
                        stale: false,
                        error: e?.message ?? String(e),
                    };
                }
            })
        );

        // NO sync here. Activation moved to `activate_provider_updates` so
        // this command — and the GET that exposes it — cannot change state.
        // `channelSync: null` is kept so existing readers of the field see a
        // shape they already handle rather than an absent key.
        //
        // channelStaleness: one extra READ-ONLY channel listing so the caller
        // also learns about channel types this machine has never activated
        // nor installed (newTypes — the kimi class, invisible in the
        // installed-set rows above). Refreshes the badge snapshot as a side
        // effect of the same read; still zero pointer writes.
        let channelStaleness: unknown = null;
        try {
            channelStaleness = await this._ctx.providerLoader?.checkVerifiedChannelStaleness?.() ?? null;
        } catch { /* read-only extra — rows above are still valid without it */ }
        return { success: true, providers: checks, channelSync: null, channelStaleness };
    }

    /**
     * Download, verify and ACTIVATE the newest channel objects: the pointer
     * flip that `check_provider_updates` used to perform as a side effect.
     *
     * Deliberately explicit and deliberately not automatic. The pin design is
     * intentional (content-addressed store, atomic pointer flip, retention,
     * last-known-good, rollback as a local flip) and boot stays network-free.
     * This command is the user saying "now".
     *
     * Fail-closed: on any registry/transport/digest failure nothing is
     * activated and the last-known-good objects keep loading.
     *
     * Args: { types?: string[] } — optional provider types unioned into the
     * sync target set. This is how a NEVER-activated channel type is
     * installed from the dashboard (kimi class): the default target set is
     * pins+installed, which by construction cannot contain a type published
     * after this machine's bootstrap.
     */
    private async handleActivateProviderUpdates(args: any): Promise<CommandResult> {
        const typesRaw = Array.isArray(args?.types) ? args.types : [];
        const types: string[] = [];
        for (const candidate of typesRaw) {
            const type = typeof candidate === 'string' ? candidate.trim() : '';
            if (!type) continue;
            if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(type)) {
                return { success: false, error: `invalid type: ${String(candidate).slice(0, 80)}` };
            }
            types.push(type);
        }
        const before = this._ctx.providerLoader?.listVerifiedChannelPins?.() ?? new Map();
        let channelSync: unknown = null;
        try {
            channelSync = await this._ctx.providerLoader?.syncVerifiedChannel?.(
                types.length > 0 ? { extraTargetTypes: types } : undefined,
            ) ?? null;
        } catch (e: any) {
            return { success: false, error: e?.message ?? String(e) };
        }
        const after = this._ctx.providerLoader?.listVerifiedChannelPins?.() ?? new Map();

        // Report what actually moved. "The sync succeeded" and "this machine
        // now runs a different spec" are different statements, and the second
        // is the one the caller needs — that gap is what hid the kimi fix.
        const activated: Array<{ type: string; from: string | null; to: string }> = [];
        for (const [type, pointer] of after) {
            const wasVersion = before.get(type)?.active?.providerVersion ?? null;
            const nowVersion = pointer.active?.providerVersion;
            if (nowVersion && wasVersion !== nowVersion) {
                activated.push({ type, from: wasVersion, to: nowVersion });
            }
        }
        return { success: true, activated, channelSync };
    }

    /**
     * Flip a provider back to its previously activated object.
     *
     * Purely local — the previous object is still in the content-addressed
     * store, so this needs no network and works when the registry is down.
     * That is the point of keeping last-known-good, and it was already
     * implemented on the loader but reachable from nowhere.
     *
     * Args: { providerType: string }
     */
    private async handleRollbackProviderUpdate(args: any): Promise<CommandResult> {
        const providerType = typeof args?.providerType === 'string' ? args.providerType.trim() : '';
        if (!providerType) return { success: false, error: 'providerType required' };

        const digest = this._ctx.providerLoader?.rollbackVerifiedChannel?.(providerType) ?? null;
        if (!digest) {
            // No previous activation to return to. Not an error the user can
            // act on by retrying, so say which case it is.
            return { success: false, error: `no rollback target for ${providerType}` };
        }
        const pin = this._ctx.providerLoader?.listVerifiedChannelPins?.()?.get(providerType);
        return {
            success: true,
            providerType,
            digest,
            activeVersion: pin?.active?.providerVersion ?? null,
            previousVersion: pin?.previous?.providerVersion ?? null,
        };
    }

    // ─── External provider sources (3rd-party git URLs) ──────────────

    /**
     * Register a new external provider source. The daemon clones the repo
     * to ~/.adhdev/external/<name>/, walks it once to detect provided
     * types, and surfaces any conflicts with already-installed types so
     * the dashboard can ask the user how to resolve them.
     *
     * Args: { url: string, ref?: string, name?: string }
     *   - url: https://, git@, or any git-cloneable URL
     *   - ref: branch/tag/commit (default "main")
     *   - name: short identifier (default derived from URL)
     *
     * Returns: { source, providers, conflicts }
     *   - conflicts: list of types this new source provides that another
     *     source already exposes. UI uses this to prompt for active-source
     *     selection before the load takes effect.
     */
    private async handleAddProviderSource(args: any): Promise<CommandResult> {
        const url = typeof args?.url === 'string' ? args.url.trim() : '';
        if (!url) return { success: false, error: 'url is required' };
        const ref = typeof args?.ref === 'string' && args.ref.trim() ? args.ref.trim() : 'main';

        // Defense in depth against argv flag-smuggling: reject anything that
        // looks like a git option in either positional. The `--` end-of-options
        // sentinel below catches accidental cases, but rejecting early gives
        // a clear error message and stops obviously malicious inputs from
        // even touching git.
        if (url.startsWith('-')) return { success: false, error: 'url must not start with "-"' };
        if (ref.startsWith('-')) return { success: false, error: 'ref must not start with "-"' };
        // Whitelist the protocols we'll forward to git. Anything else
        // (file://, ext-protocol-handlers, …) is refused outright.
        if (!/^(https?:\/\/|git@[a-z0-9._-]+:)[a-z0-9._@:/~\-]+$/i.test(url)) {
            return { success: false, error: 'url must be https://… or git@host:… and contain only URL-safe characters' };
        }
        // Refs are git refnames — letters, digits, slashes, dots, underscores,
        // dashes. Rejects e.g. spaces, semicolons, backticks, shell metas.
        if (!/^[A-Za-z0-9._/-]+$/.test(ref)) {
            return { success: false, error: 'ref must contain only [A-Za-z0-9._/-]' };
        }

        const ext = require('../providers/external-sources.js') as typeof import('../providers/external-sources.js');
        const requestedName = typeof args?.name === 'string' && args.name.trim() ? args.name.trim() : ext.deriveSourceName(url);
        if (!/^@[a-z0-9_-]+$/i.test(requestedName)) {
            return { success: false, error: 'name must match @[a-z0-9_-]+' };
        }

        const fs = require('node:fs') as typeof import('node:fs');
        const path = require('node:path') as typeof import('node:path');
        const { spawnSync } = require('node:child_process') as typeof import('node:child_process');

        const file = ext.loadExternalSources();
        if (file.sources.some(s => s.name === requestedName)) {
            return { success: false, error: `source name "${requestedName}" is already registered` };
        }
        if (file.sources.some(s => s.url === url && s.ref === ref)) {
            return { success: false, error: `source url+ref already registered (use a different name to track another ref)` };
        }

        const sourceDir = path.join(ext.externalRoot(), requestedName);
        if (!fs.existsSync(ext.externalRoot())) fs.mkdirSync(ext.externalRoot(), { recursive: true });
        if (fs.existsSync(sourceDir)) {
            return { success: false, error: `directory already exists: ${sourceDir} (rename or remove first)` };
        }

        // `--` sentinel after the option list so any future regex-bypassing
        // url that *did* start with `-` would still be treated as a path
        // by git rather than an option.
        const clone = spawnSync('git', ['clone', '--depth=1', '--branch', ref, '--', url, sourceDir], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 60_000,
        });
        if (clone.status !== 0) {
            try { fs.rmSync(sourceDir, { recursive: true, force: true }); } catch { /* best-effort */ }
            return { success: false, error: `git clone failed: ${(clone.stderr || clone.stdout || '').trim() || 'unknown error'}` };
        }

        const source: import('../providers/external-sources.js').ExternalSource = {
            name: requestedName,
            url,
            ref,
            addedAt: new Date().toISOString(),
        };
        ext.saveExternalSources({ schema: 1, sources: [...file.sources, source] });

        // Detect type-level conflicts with what's already on disk after this clone.
        const inventory = ext.inventoryExternalSources();
        const conflicts: { category: string; type: string; sources: string[] }[] = [];
        const newEntry = inventory.find(e => e.sourceName === requestedName);
        if (newEntry) {
            for (const [category, types] of Object.entries(newEntry.providers)) {
                for (const type of types) {
                    const sources = ext.sourcesProviding(category, type);
                    if (sources.length > 1) conflicts.push({ category, type, sources });
                }
            }
        }

        // Hot-reload so the daemon picks up the new providers immediately.
        if (this._ctx.providerLoader) {
            this._ctx.providerLoader.reload();
            this._ctx.providerLoader.registerToDetector();
        }

        return {
            success: true,
            source,
            providers: newEntry?.providers ?? {},
            conflicts,
        };
    }

    /**
     * Remove a registered external source. Deletes the clone directory and
     * any active-source entry pointing to it.
     *
     * Args: { name: string }
     */
    private async handleRemoveProviderSource(args: any): Promise<CommandResult> {
        const name = typeof args?.name === 'string' ? args.name.trim() : '';
        if (!name) return { success: false, error: 'name is required' };
        const ext = require('../providers/external-sources.js') as typeof import('../providers/external-sources.js');

        const fs = require('node:fs') as typeof import('node:fs');
        const path = require('node:path') as typeof import('node:path');
        const file = ext.loadExternalSources();
        const match = file.sources.find(s => s.name === name);
        if (!match) return { success: false, error: `source "${name}" not registered` };

        const sourceDir = path.join(ext.externalRoot(), name);
        if (fs.existsSync(sourceDir)) {
            try { fs.rmSync(sourceDir, { recursive: true, force: true }); }
            catch (e: any) { return { success: false, error: `failed to delete ${sourceDir}: ${e?.message || e}` }; }
        }

        ext.saveExternalSources({
            schema: 1,
            sources: file.sources.filter(s => s.name !== name),
        });

        // Drop any active-source entries that pointed at this source.
        const active = ext.loadProvidersActive();
        const filteredActive: Record<string, string> = {};
        for (const [type, src] of Object.entries(active.active)) {
            if (src !== name) filteredActive[type] = src;
        }
        ext.saveProvidersActive({ schema: 1, active: filteredActive });

        if (this._ctx.providerLoader) {
            this._ctx.providerLoader.reload();
            this._ctx.providerLoader.registerToDetector();
        }

        return { success: true, removed: { name } };
    }

    /**
     * List registered external sources + each source's currently installed
     * providers + the active selection for any conflicting types. Used by
     * the dashboard's "Sources" tab.
     */
    private handleListProviderSources(_args: any): CommandResult {
        const ext = require('../providers/external-sources.js') as typeof import('../providers/external-sources.js');
        const file = ext.loadExternalSources();
        const inventory = ext.inventoryExternalSources();
        const active = ext.loadProvidersActive();

        // Build a per-source view + flag types that have ambiguity.
        const sources = file.sources.map(s => {
            const inv = inventory.find(e => e.sourceName === s.name);
            return {
                ...s,
                providers: inv?.providers ?? {},
            };
        });

        // Compute conflicts globally — any type provided by ≥ 2 sources.
        const conflictMap = new Map<string, { category: string; sources: string[] }>();
        for (const inv of inventory) {
            for (const [category, types] of Object.entries(inv.providers)) {
                for (const type of types) {
                    const candidates = ext.sourcesProviding(category, type);
                    if (candidates.length > 1 && !conflictMap.has(type)) {
                        conflictMap.set(type, { category, sources: candidates });
                    }
                }
            }
        }
        const conflicts = [...conflictMap.entries()].map(([type, info]) => ({
            type,
            category: info.category,
            candidates: info.sources,
            active: active.active[type] ?? null,
        }));

        return { success: true, sources, conflicts };
    }

    /**
     * Pick which source's copy of a conflicting provider type is active.
     * Other sources' copies stay on disk but the loader ignores them.
     *
     * Args: { type: string, sourceName: string }
     */
    private handleSetActiveProviderSource(args: any): CommandResult {
        const type = typeof args?.type === 'string' ? args.type.trim() : '';
        const sourceName = typeof args?.sourceName === 'string' ? args.sourceName.trim() : '';
        if (!type || !sourceName) return { success: false, error: 'type and sourceName are required' };
        const ext = require('../providers/external-sources.js') as typeof import('../providers/external-sources.js');

        // Validate: the source must actually provide that type.
        const inventory = ext.inventoryExternalSources();
        const entry = inventory.find(e => e.sourceName === sourceName);
        if (!entry) return { success: false, error: `source "${sourceName}" not found` };
        const provided = Object.values(entry.providers).some(types => types.includes(type));
        if (!provided) return { success: false, error: `source "${sourceName}" does not provide type "${type}"` };

        const active = ext.loadProvidersActive();
        active.active[type] = sourceName;
        ext.saveProvidersActive(active);

        if (this._ctx.providerLoader) {
            this._ctx.providerLoader.reload();
            this._ctx.providerLoader.registerToDetector();
        }

        return { success: true, type, sourceName };
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
