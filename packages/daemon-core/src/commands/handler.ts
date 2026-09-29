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
import type { ProviderModule } from '../providers/contracts.js';
import type { DaemonAgentStreamManager } from '../agent-stream/index.js';
import type { CliAdapter } from '../cli-adapter-types.js';
import type { SessionInputService } from '../sessions/session-input-service.js';
import { getConfigDir } from '../config/config.js';
import { ChatHistoryWriter } from '../config/chat-history.js';
import type { SessionRegistry, SessionRuntimeTarget } from '../sessions/registry.js';
import { reconcileIdeRuntimeSessions } from '../sessions/reconcile.js';
import { LOG } from '../logging/logger.js';
import { resolveLegacyProviderScript, type LegacyStringScript } from './provider-script-resolver.js';
import { MANUAL_ATTENDANCE_COMMANDS, MANUAL_ATTENDANCE_PASSIVE_VIEW_COMMANDS } from '../providers/manual-attendance.js';

import type { GitCommandServices } from '../git/git-commands.js';
import type { CommandSpec } from './command-registry.js';
import { gitSpecs, handlerSpecs } from './handler-specs.js';
import { handleListProviderAvailability, handleInstallProviderManifest, handleListInstalledProviders, handleRegistryCatalog, handleCheckProviderUpdates, handleActivateProviderUpdates, handleRollbackProviderUpdate, handleAddProviderSource, handleRemoveProviderSource, handleListProviderSources, handleSetActiveProviderSource } from './handler-provider-catalog.js';

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
    /** Agent-stream manager for IDE extension sessions (B4: constructor value, no late setter). */
    agentStreamManager?: DaemonAgentStreamManager | null;
    /**
     * The daemon's ONE send funnel (wiring-unification D2) —
     * `DaemonCliManager.input`. `send_chat` / `cancel_queued_chat` submit through
     * it so dashboard sends share the `messageId` dedupe with mesh dispatch and
     * turn-ledger notices. Absent → the chat handlers build a handler-local one.
     */
    sessionInput?: SessionInputService;
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

// Exported for tests: the hotpath-command log level is a pure function of the
// command name, so a test can assert "read_chat never reaches the default info
// stream" by calling this instead of grepping the COMMAND_DEBUG_LEVELS literal.
export function getCommandLogLevel(cmd: string): 'debug' | 'info' {
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

let handlerCommandSpecsByName: Map<string, CommandSpec> | undefined;

/** Handler/git spec by name (built on first use — the spec modules sit in an import cycle with this file). */
function handlerCommandSpec(cmd: string): CommandSpec | undefined {
    if (!handlerCommandSpecsByName) {
        handlerCommandSpecsByName = new Map<string, CommandSpec>([...handlerSpecs, ...gitSpecs].map((spec) => [spec.name, spec]));
    }
    return handlerCommandSpecsByName.get(cmd);
}

export class DaemonCommandHandler implements CommandHelpers {
    _ctx: CommandContext;
    private _agentStream: DaemonAgentStreamManager | null = null;
    readonly domHandlers: CdpDomHandlers;
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
        this._agentStream = ctx.agentStreamManager ?? null;
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

    private resolveRoute(args: any, spec?: CommandSpec): { session?: SessionRuntimeTarget; managerKey?: string; providerType?: string; sessionLookupFailed?: boolean } {
        const targetSessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : '';
        let session = targetSessionId ? this._ctx.sessionRegistry?.get(targetSessionId) : undefined;
        if (targetSessionId && !session) {
            reconcileIdeRuntimeSessions(this._ctx.instanceManager, this._ctx.sessionRegistry);
            session = this._ctx.sessionRegistry?.get(targetSessionId);
        }
        if (targetSessionId && !session && spec?.session?.allowInactiveHistory === true) {
            session = this.exitedCliSessionFromAdapter(targetSessionId);
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

    /**
     * PTY-exit window (wiring-unification B4): `port.exited` removes a CLI
     * session from the registry immediately, but cli-manager keeps its adapter
     * (with the final screen / transcript state) until auto-clean. A
     * history-capable read (`allowInactiveHistory`: read_chat,
     * get_chat_debug_bundle) addressed at such a session is resolved through
     * that adapter — provider type and workspace come from it — so the dashboard
     * and the transcript projection's final pull still get the transcript.
     * Once auto-clean drops the adapter, the ordinary history fallback applies.
     */
    private exitedCliSessionFromAdapter(sessionId: string): SessionRuntimeTarget | undefined {
        const adapter = this._ctx.adapters?.get(sessionId);
        if (!adapter?.cliType) return undefined;
        return {
            sessionId,
            parentSessionId: null,
            providerType: adapter.cliType,
            transport: 'pty',
            adapterKey: sessionId,
            instanceKey: sessionId,
            ...(adapter.workingDir ? { workspace: adapter.workingDir } : {}),
        };
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

    /**
     * Run a handler-family or git command by name — for in-process callers that
     * address the handler directly instead of going through the router. Unknown
     * names answer `Unknown command`, exactly as a router miss does.
     */
    async handle(cmd: string, args: any): Promise<CommandResult> {
        const spec = handlerCommandSpec(cmd);
        return spec ? this.handleSpec(spec, args) : this.rejectUnknown(cmd, args);
    }

    /** A command no spec defines: resolve the route (for the log line) and refuse it. */
    async rejectUnknown(cmd: string, args: any): Promise<CommandResult> {
        this._currentRoute = this.resolveRoute(args);
        const startedAt = Date.now();
        this.logCommandStart(cmd, args);
        this.noteManualAttendanceIfApplicable(cmd, args);
        const result: CommandResult = { success: false, error: `Unknown command: ${cmd}` };
        this.logCommandEnd(cmd, result, startedAt);
        return result;
    }

    /**
     * Run a `handler`- or `git`-family spec: resolve the per-request route,
     * stamp manual attendance, apply the spec's `session` pre-checks, then run.
     */
    async handleSpec(spec: CommandSpec, args: any): Promise<CommandResult> {
        const cmd = spec.name;
        // Per-request: extract target session / CDP scope / provider type from args
        this._currentRoute = this.resolveRoute(args, spec);
        const startedAt = Date.now();
        this.logCommandStart(cmd, args);
        this.noteManualAttendanceIfApplicable(cmd, args);
        let result: CommandResult;

        if (spec.family === 'git') {
            result = await (spec as CommandSpec<'git'>).run(this._ctx.gitCommandServices, args);
            this.logCommandEnd(cmd, result, startedAt);
            return result;
        }
        if (spec.family !== 'handler') {
            throw new Error(`command '${cmd}' is a ${spec.family}-family command, not a handler command`);
        }

        const session = spec.session;
        // allowInactiveHistory commands can serve historical transcript data even when
        // the live session record is gone (stopped/destroyed). Allow the fallback when
        // the provider type is known and any session identity hint is present: an
        // explicit providerSessionId/historySessionId, or the targetSessionId itself
        // (which getHistorySessionId already uses as a fallback history key).
        const allowsInactiveHistoryFallback =
            session?.allowInactiveHistory === true
            && !!this._currentRoute.providerType
            && (
                (typeof args?.providerSessionId === 'string' && args.providerSessionId.trim().length > 0)
                || (typeof args?.historySessionId === 'string' && args.historySessionId.trim().length > 0)
                || (typeof args?.targetSessionId === 'string' && args.targetSessionId.trim().length > 0)
            );

        if (this._currentRoute.sessionLookupFailed && session?.scope === 'required' && !allowsInactiveHistoryFallback) {
            const result = {
                success: false,
                error: `Live session not found for targetSessionId: ${String(args?.targetSessionId || '').trim() || 'unknown'}`,
            };
            this.logCommandEnd(cmd, result, startedAt);
            return result;
        }

        // Commands without ideType CDP silently fail (prevent P2P retry spam)
        if (session?.requireRoute && !this._currentRoute.session && !this._currentRoute.managerKey && !this._currentRoute.providerType) {
            result = { success: false, error: 'No targetSessionId specified — cannot route command' };
            this.logCommandEnd(cmd, result, startedAt);
            return result;
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
            result = await (spec as CommandSpec<'handler'>).run(this, args);
            this.logCommandEnd(cmd, result, startedAt);
            return result;
        } catch (e: any) {
            LOG.error('Command', `[${cmd}] Unhandled error: ${e?.message || e}`);
            result = { success: false, error: `Internal error: ${e?.message || 'unknown'}` };
            this.logCommandEnd(cmd, result, startedAt);
            return result;
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
    async handleRefreshScripts(_args: any): Promise<CommandResult> {
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
    handleListProviderAvailability(_args: any): CommandResult { return handleListProviderAvailability(this, _args); }

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
    getUpstreamInstallRoot(): string {
        const path = require('path') as typeof import('path');
        return path.join(getConfigDir(), 'providers', '.upstream');
    }
    handleInstallProviderManifest(args: any): Promise<CommandResult> { return handleInstallProviderManifest(this, args); }

    /**
     * Uninstall a provider: deactivate its verified CHANNEL-STORE pointer (the
     * layer install_provider_manifest actually writes to) and remove any legacy
     * `.upstream/{category}/{type}/` dir. Refuses to touch anything outside the
     * upstream root. 'not installed' only when NEITHER layer held the provider.
     * Used by onboarding to opt out of a provider the user doesn't want; the
     * dashboard no longer exposes a per-provider uninstall button (external
     * sources are removed as a whole via remove_provider_source).
     */
    async handleUninstallProviderManifest(args: any): Promise<CommandResult> {
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

            // Two install layers must BOTH be considered (fragmentation audit):
            // install activates via the verified CHANNEL STORE, while only legacy
            // installs materialized an `.upstream/{category}/{type}` dir. The old
            // early-return on a missing dir made uninstall of a channel-activated
            // provider report 'not installed' and never reach the store
            // deactivation — success:true with the provider still active.
            const hadUpstreamDir = fs.existsSync(targetDir);
            if (hadUpstreamDir) {
                fs.rmSync(targetDir, { recursive: true, force: true });
            }

            // Drop any verified channel activation for this type so an
            // uninstalled provider does not keep loading from the
            // content-addressed store. Local pointer removal — no network.
            let channelDeactivated = false;
            try {
                channelDeactivated = this._ctx.providerLoader?.deactivateVerifiedChannel?.(type) === true;
            } catch { /* best-effort — any upstream-dir removal above already happened */ }

            if (!hadUpstreamDir && !channelDeactivated) {
                return { success: false, error: 'not installed' };
            }

            if (this._ctx.providerLoader) {
                this._ctx.providerLoader.reload();
                this._ctx.providerLoader.registerToDetector();
            }

            return {
                success: true,
                removed: { type, category, ...(hadUpstreamDir ? { path: targetDir } : {}) },
                channelDeactivated,
            };
        } catch (e: any) {
            return { success: false, error: `uninstall failed: ${e?.message || e}` };
        }
    }
    handleListInstalledProviders(_args: any): CommandResult { return handleListInstalledProviders(this, _args); }
    handleRegistryCatalog(args: any): Promise<CommandResult> { return handleRegistryCatalog(this, args); }
    handleCheckProviderUpdates(_args: any): Promise<CommandResult> { return handleCheckProviderUpdates(this, _args); }
    handleActivateProviderUpdates(args: any): Promise<CommandResult> { return handleActivateProviderUpdates(this, args); }
    handleRollbackProviderUpdate(args: any): Promise<CommandResult> { return handleRollbackProviderUpdate(this, args); }
    handleAddProviderSource(args: any): Promise<CommandResult> { return handleAddProviderSource(this, args); }
    handleRemoveProviderSource(args: any): Promise<CommandResult> { return handleRemoveProviderSource(this, args); }
    handleListProviderSources(_args: any): CommandResult { return handleListProviderSources(this, _args); }
    handleSetActiveProviderSource(args: any): CommandResult { return handleSetActiveProviderSource(this, args); }

    // ─── DevServer HTTP proxy helpers ─────────────────
    // These bridge WS commands to the DevServer REST API (localhost:19280)

    async proxyDevServerPost(args: any, endpoint: string): Promise<CommandResult> {
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

    async proxyDevServerGet(args: any, endpoint: string): Promise<CommandResult> {
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

    async proxyDevServerScaffold(args: any): Promise<CommandResult> {
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
