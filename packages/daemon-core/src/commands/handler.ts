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

    // ─── Command Dispatcher ──────────────────────────

    async handle(cmd: string, args: any): Promise<CommandResult> {
        // Per-request: extract target session / CDP scope / provider type from args
        this._currentRoute = this.resolveRoute(args);
        const startedAt = Date.now();
        this.logCommandStart(cmd, args);
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
     * Path matches ProviderLoader.upstreamDir but we recompute it from
     * homedir() so this method stays usable in dev where userDir can
     * point at a sibling git checkout.
     */
    private getUpstreamInstallRoot(): string {
        const os = require('os') as typeof import('os');
        const path = require('path') as typeof import('path');
        return path.join(os.homedir(), '.adhdev', 'providers', '.upstream');
    }

    /**
     * Download a single provider manifest from the registry and write it to
     * ~/.adhdev/providers/.upstream/{category}/{type}/provider.json.
     *
     * Used by standalone onboarding to seed the upstream cache with the
     * default provider set on first launch. Verifies SHA-256 checksum
     * against the registry meta before persisting. Refuses to write
     * outside the upstream root.
     *
     * Args: { type: string, category?: string, version?: string }
     * If category/version are omitted, looks up the latest from the registry.
     */
    private async handleInstallProviderManifest(args: any): Promise<CommandResult> {
        if (!this._ctx.providerLoader) {
            return { success: false, error: 'ProviderLoader not initialized' };
        }
        const type = typeof args?.type === 'string' ? args.type : '';
        if (!type) return { success: false, error: 'type is required' };
        // Defense in depth: reject any obvious path-traversal in the type.
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(type)) {
            return { success: false, error: 'invalid type' };
        }

        const https = require('https') as typeof import('https');
        const fs = require('fs') as typeof import('fs');
        const path = require('path') as typeof import('path');
        const crypto = require('crypto') as typeof import('crypto');
        const REGISTRY = 'https://api.adhf.dev/api/v1/registry';

        function fetchText(url: string, timeoutMs: number): Promise<string> {
            return new Promise((resolve, reject) => {
                const req = https.get(url, { headers: { 'User-Agent': 'adhdev-daemon', 'Accept': 'application/json' }, timeout: timeoutMs }, (res) => {
                    if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
                    const chunks: Buffer[] = [];
                    res.on('data', (c: Buffer) => chunks.push(c));
                    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
                });
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            });
        }

        try {
            // 1. Look up provider metadata so we know the expected category, version, checksum.
            const metaBody = await fetchText(`${REGISTRY}/providers/${encodeURIComponent(type)}`, 10000);
            const meta = JSON.parse(metaBody) as { type: string; category: string; version: string; checksum: string };
            const category = typeof args?.category === 'string' ? args.category : meta.category;
            const version = typeof args?.version === 'string' ? args.version : meta.version;

            // Defense in depth on category as well — only known categories.
            if (!['cli', 'ide', 'extension', 'acp'].includes(category)) {
                return { success: false, error: `unknown category: ${category}` };
            }

            // 2. Download the manifest body.
            const manifestBody = await fetchText(
                `${REGISTRY}/providers/${encodeURIComponent(type)}/${encodeURIComponent(version)}/download`,
                30000
            );

            // 3. Verify checksum.
            const actualChecksum = crypto.createHash('sha256').update(manifestBody, 'utf-8').digest('hex');
            if (actualChecksum !== meta.checksum) {
                return { success: false, error: `checksum mismatch: expected ${meta.checksum}, got ${actualChecksum}` };
            }

            // 4. Write to the upstream cache root, NOT to ProviderLoader.getUserDir():
            //    in dev, userDir points at the sibling adhdev-providers git checkout.
            const installRoot = this.getUpstreamInstallRoot();
            const installRootResolved = path.resolve(installRoot);
            const targetDir = path.resolve(path.join(installRoot, category, type));
            if (!targetDir.startsWith(installRootResolved + path.sep)) {
                return { success: false, error: 'install path escaped upstream root' };
            }
            fs.mkdirSync(targetDir, { recursive: true });
            // v1 vs v0 manifest selection — v1 manifests carry an SDK
            // $schema URL or v1-only keys (tui, overrides-as-object,
            // source, canonicalHistory). The loader prefers
            // provider.v1.json when both exist, so writing v1 manifests
            // under the v0 name would shadow them. Detect and write to
            // the right file.
            let manifestProbe: Record<string, any> = {};
            try { manifestProbe = JSON.parse(manifestBody) as Record<string, any>; } catch { /* validation below */ }
            const isV1 = typeof manifestProbe?.$schema === 'string' && manifestProbe.$schema.includes('/v1/')
                || (manifestProbe?.overrides && typeof manifestProbe.overrides === 'object' && !Array.isArray(manifestProbe.overrides))
                || !!manifestProbe?.tui;

            // Reject v1 manifests that don't match the schema at install
            // time so the daemon never persists a known-bad manifest.
            // The provider-loader keeps a permissive warn-only behavior
            // for manifests already on disk, but the install path is the
            // right place to fail fast.
            if (isV1 && manifestProbe?.category === 'cli') {
                try {
                    const { validateCliProviderManifest, formatManifestValidationIssues } =
                        require('../providers/sdk/v1/validators/manifest.js') as typeof import('../providers/sdk/v1/validators/manifest.js');
                    const validation = validateCliProviderManifest(manifestProbe);
                    if (!validation.ok) {
                        return {
                            success: false,
                            error: `manifest failed v1 schema validation:\n${formatManifestValidationIssues(validation.issues)}`,
                            validationIssues: validation.issues,
                        };
                    }
                } catch (e: any) {
                    // Validator load failure shouldn't block install — log
                    // and continue. The loader's warn-only path will
                    // surface the same issue at boot if it's real.
                    LOG.warn('Command', `[install_provider_manifest] schema validator unavailable: ${e?.message || e}`);
                }
            }

            const targetFile = isV1 ? 'provider.v1.json' : 'provider.json';
            const targetPath = path.join(targetDir, targetFile);
            fs.writeFileSync(targetPath, manifestBody, 'utf-8');

            // 5. If the manifest declares a `source` GitHub repo, fetch the
            //    script directories listed in the manifest (defaultScriptDir +
            //    each compatibility[].scriptDir). Extended-tier providers
            //    bundle their override JS this way — the registry intentionally
            //    only stores the manifest JSON, not the script bytes, so a
            //    third-party can publish a manifest pointing at their own fork
            //    without pushing files into our R2 bucket.
            const manifestJson = JSON.parse(manifestBody) as Record<string, any>;
            const scriptFetch = await this.fetchProviderSources(
                manifestJson,
                category,
                type,
                targetDir,
            );

            // Hot-reload so the daemon picks up the new manifest.
            this._ctx.providerLoader.reload();
            this._ctx.providerLoader.registerToDetector();

            return {
                success: true,
                installed: {
                    type, category, version, checksum: actualChecksum, path: targetPath,
                    scriptsFetched: scriptFetch.fetchedCount,
                    scriptSource: scriptFetch.source,
                    scriptErrors: scriptFetch.errors,
                },
            };
        } catch (e: any) {
            return { success: false, error: `install failed: ${e?.message || e}` };
        }
    }

    /**
     * If `manifest.source = { type:'github', repo, ref, subdir? }` is set,
     * walk each script directory the manifest references and download every
     * file from the public GitHub raw endpoint. Returns a small summary so
     * the caller can report what was fetched.
     *
     * Best-effort: failures don't reject the install — the manifest itself is
     * usable for declarative-only providers, and the user still gets a clear
     * error string back if a needed script is missing.
     */
    private async fetchProviderSources(
        manifest: Record<string, any>,
        category: string,
        type: string,
        targetDir: string,
    ): Promise<{ fetchedCount: number; source: string | null; errors: string[] }> {
        const errors: string[] = [];
        const source = manifest?.source;
        if (!source || source.type !== 'github' || typeof source.repo !== 'string' || typeof source.ref !== 'string') {
            return { fetchedCount: 0, source: null, errors };
        }

        // Collect every script directory the manifest references. v1 manifests
        // use `defaultScriptDir` and `compatibility[].scriptDir`. We also pull
        // any override path's directory (e.g. overrides.detectStatus.path =
        // "scripts/v1/detect_status.js" → fetch the scripts/v1/ directory too).
        const scriptDirs = new Set<string>();
        if (typeof manifest.defaultScriptDir === 'string') scriptDirs.add(manifest.defaultScriptDir);
        if (Array.isArray(manifest.compatibility)) {
            for (const c of manifest.compatibility) {
                if (typeof c?.scriptDir === 'string') scriptDirs.add(c.scriptDir);
                // Spec-driven providers (claude/codex/agy/…) point at a
                // single specs/<version>.json instead of a scriptDir.
                // The whole specs/ directory needs to come down so the
                // spec adapter can resolve the file at runtime — without
                // this, install_provider_manifest leaves the marketplace
                // copy spec-less and provider-loader falls back to the
                // legacy tui-based ProviderCliAdapter.
                if (typeof c?.spec === 'string' && c.spec.includes('/')) {
                    const dir = c.spec.substring(0, c.spec.lastIndexOf('/'));
                    if (dir) scriptDirs.add(dir);
                }
            }
        }
        if (manifest.overrides && typeof manifest.overrides === 'object' && !Array.isArray(manifest.overrides)) {
            for (const override of Object.values(manifest.overrides) as Array<Record<string, unknown>>) {
                const overridePath = override?.path;
                if (typeof overridePath === 'string' && overridePath.includes('/')) {
                    const dir = overridePath.substring(0, overridePath.lastIndexOf('/'));
                    if (dir) scriptDirs.add(dir);
                }
            }
        }
        if (scriptDirs.size === 0) {
            return { fetchedCount: 0, source: `${source.repo}@${source.ref}`, errors };
        }

        const subdir: string = typeof source.subdir === 'string' && source.subdir.length > 0
            ? source.subdir
            : `${category}/${type}`;
        const repo: string = source.repo;
        const ref: string = source.ref;

        const https = require('https') as typeof import('https');
        const fs = require('fs') as typeof import('fs');
        const path = require('path') as typeof import('path');

        function fetchJson(url: string, timeoutMs: number): Promise<any> {
            return new Promise((resolve, reject) => {
                const req = https.get(url, {
                    headers: { 'User-Agent': 'adhdev-daemon', 'Accept': 'application/vnd.github+json' },
                    timeout: timeoutMs,
                }, (res) => {
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

        function fetchBinary(url: string, timeoutMs: number): Promise<Buffer> {
            return new Promise((resolve, reject) => {
                const req = https.get(url, {
                    headers: { 'User-Agent': 'adhdev-daemon' },
                    timeout: timeoutMs,
                }, (res) => {
                    // Raw endpoint redirects through codeload — follow the redirect.
                    if (res.statusCode === 301 || res.statusCode === 302) {
                        if (res.headers.location) {
                            return fetchBinary(res.headers.location, timeoutMs).then(resolve, reject);
                        }
                    }
                    if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
                    const chunks: Buffer[] = [];
                    res.on('data', (c: Buffer) => chunks.push(c));
                    res.on('end', () => resolve(Buffer.concat(chunks)));
                });
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            });
        }

        let fetchedCount = 0;

        // The shared helpers directory (cli/_shared/) is referenced by most
        // CLI providers via `require('../../../_shared/...')`. Fetch it once
        // alongside the provider's own scripts so node's require resolution
        // succeeds at runtime. Best-effort — silent if the source repo has no
        // _shared dir (e.g. ACP-only repos).
        const sharedDirRel = `${category}/_shared`;
        const sharedTargetDir = path.resolve(path.join(targetDir, '../_shared'));
        const installRootResolved = path.resolve(path.join(targetDir, '../..'));
        if (sharedTargetDir.startsWith(installRootResolved + path.sep)) {
            const sharedStack: string[] = [sharedDirRel];
            while (sharedStack.length) {
                const relDir = sharedStack.pop()!;
                const apiUrl = `https://api.github.com/repos/${repo}/contents/${encodeURI(relDir)}?ref=${encodeURIComponent(ref)}`;
                let entries: Array<{ type: string; path: string; name: string; download_url: string | null }>;
                try {
                    entries = await fetchJson(apiUrl, 15000);
                } catch (e: any) {
                    // Silent: _shared may not exist on third-party repos
                    if (relDir === sharedDirRel) break;
                    errors.push(`list shared ${relDir}: ${e?.message ?? e}`);
                    continue;
                }
                if (!Array.isArray(entries)) continue;
                for (const entry of entries) {
                    if (entry.type === 'dir') { sharedStack.push(entry.path); continue; }
                    if (entry.type !== 'file' || !entry.download_url) continue;
                    try {
                        const body = await fetchBinary(entry.download_url, 30000);
                        // entry.path is like 'cli/_shared/foo.js' — strip 'cli/_shared/' prefix
                        const relInside = entry.path.startsWith(sharedDirRel + '/')
                            ? entry.path.slice(sharedDirRel.length + 1)
                            : entry.path;
                        const outPath = path.resolve(path.join(sharedTargetDir, relInside));
                        if (!outPath.startsWith(path.resolve(sharedTargetDir) + path.sep)) continue;
                        fs.mkdirSync(path.dirname(outPath), { recursive: true });
                        fs.writeFileSync(outPath, body);
                        fetchedCount++;
                    } catch (e: any) {
                        errors.push(`fetch shared ${entry.path}: ${e?.message ?? e}`);
                    }
                }
            }
        }

        for (const scriptDir of scriptDirs) {
            // GitHub Contents API returns the file list under the dir. We
            // recurse into subdirectories so e.g. scripts/v1/helpers/foo.js is
            // captured too.
            const stack: string[] = [`${subdir}/${scriptDir}`];
            while (stack.length) {
                const relDir = stack.pop()!;
                const apiUrl = `https://api.github.com/repos/${repo}/contents/${encodeURI(relDir)}?ref=${encodeURIComponent(ref)}`;
                let entries: Array<{ type: string; path: string; name: string; download_url: string | null }>;
                try {
                    entries = await fetchJson(apiUrl, 15000);
                } catch (e: any) {
                    errors.push(`list ${relDir}: ${e?.message ?? e}`);
                    continue;
                }
                if (!Array.isArray(entries)) {
                    errors.push(`list ${relDir}: unexpected response shape`);
                    continue;
                }
                for (const entry of entries) {
                    if (entry.type === 'dir') {
                        stack.push(entry.path);
                        continue;
                    }
                    if (entry.type !== 'file' || !entry.download_url) continue;
                    try {
                        const body = await fetchBinary(entry.download_url, 30000);
                        // entry.path is relative to repo root → strip the repo subdir prefix
                        // so the path inside targetDir matches the layout the loader expects.
                        const relInsideProvider = entry.path.startsWith(subdir + '/')
                            ? entry.path.slice(subdir.length + 1)
                            : entry.path;
                        const outPath = path.resolve(path.join(targetDir, relInsideProvider));
                        // Path-traversal guard.
                        if (!outPath.startsWith(path.resolve(targetDir) + path.sep)) {
                            errors.push(`refusing to write outside targetDir: ${entry.path}`);
                            continue;
                        }
                        fs.mkdirSync(path.dirname(outPath), { recursive: true });
                        fs.writeFileSync(outPath, body);
                        fetchedCount++;
                    } catch (e: any) {
                        errors.push(`fetch ${entry.path}: ${e?.message ?? e}`);
                    }
                }
            }
        }

        return { fetchedCount, source: `${repo}@${ref}`, errors };
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
        const items: Array<{ type: string; category: string; version: string; path: string }> = [];

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
                    items.push({
                        type,
                        category,
                        version: typeof m.providerVersion === 'string' ? m.providerVersion : '0.0.0',
                        path: manifestPath,
                    });
                } catch {
                    // Corrupt manifest — skip but don't fail the whole listing.
                }
            }
        }
        return { success: true, providers: items };
    }

    /**
     * For each installed provider, ask the registry for its current latest
     * version and report whether an update is available. The user can then
     * call install_provider_manifest to upgrade (it overwrites the file).
     *
     * Returns { providers: [{ type, category, installedVersion, latestVersion,
     *   updateAvailable, error? }] }
     */
    private async handleCheckProviderUpdates(_args: any): Promise<CommandResult> {
        const installed = this.handleListInstalledProviders({});
        if (!installed.success) return installed;

        const https = require('https') as typeof import('https');
        const REGISTRY = 'https://api.adhf.dev/api/v1/registry';

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
        const checks = await Promise.all(
            installedList.map(async (p) => {
                try {
                    const remote = await fetchJson(`${REGISTRY}/providers/${encodeURIComponent(p.type)}`);
                    const latestVersion = String(remote?.version ?? '');
                    return {
                        type: p.type,
                        category: p.category,
                        installedVersion: p.version,
                        latestVersion,
                        updateAvailable: latestVersion !== '' && latestVersion !== p.version,
                    };
                } catch (e: any) {
                    return {
                        type: p.type,
                        category: p.category,
                        installedVersion: p.version,
                        latestVersion: null,
                        updateAvailable: false,
                        error: e?.message ?? String(e),
                    };
                }
            })
        );

        return { success: true, providers: checks };
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
