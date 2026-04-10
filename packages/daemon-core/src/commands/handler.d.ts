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
import { ProviderLoader } from '../providers/provider-loader.js';
import type { ProviderInstanceManager } from '../providers/provider-instance-manager.js';
import type { ProviderModule } from '../providers/contracts.js';
import type { DaemonAgentStreamManager } from '../agent-stream/index.js';
import type { CliAdapter } from '../cli-adapter-types.js';
import { ChatHistoryWriter } from '../config/chat-history.js';
import type { SessionRegistry, SessionRuntimeTarget } from '../sessions/registry.js';
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
}
/**
 * Shared helpers interface — passed to sub-module command functions
 * for accessing CDP, providers, agent streams, and other handler-owned state.
 */
export interface CommandHelpers {
    getCdp(ideType?: string): DaemonCdpManager | null;
    getProvider(overrideType?: string): ProviderModule | undefined;
    getProviderScript(scriptName: string, params?: Record<string, string>, ideType?: string): string | null;
    evaluateProviderScript(scriptName: string, params?: Record<string, string>, timeout?: number): Promise<{
        result: any;
        category: string;
    } | null>;
    getCliAdapter(type?: string): CliAdapter | null;
    readonly currentManagerKey: string | undefined;
    readonly currentIdeType: string | undefined;
    readonly currentProviderType: string | undefined;
    readonly currentSession: SessionRuntimeTarget | undefined;
    readonly agentStream: DaemonAgentStreamManager | null;
    readonly ctx: CommandContext;
    readonly historyWriter: ChatHistoryWriter;
}
export declare class DaemonCommandHandler implements CommandHelpers {
    private _ctx;
    private _agentStream;
    private domHandlers;
    private _historyWriter;
    /** Current request route context */
    private _currentRoute;
    constructor(ctx: CommandContext);
    get ctx(): CommandContext;
    get agentStream(): DaemonAgentStreamManager | null;
    get historyWriter(): ChatHistoryWriter;
    get currentManagerKey(): string | undefined;
    get currentIdeType(): string | undefined;
    get currentProviderType(): string | undefined;
    get currentSession(): SessionRuntimeTarget | undefined;
    /** Get CDP manager for a specific session or manager key. */
    getCdp(ideType?: string): DaemonCdpManager | null;
    /**
     * Get provider module — _currentProviderType (agentType priority) use.
     */
    getProvider(overrideType?: string): ProviderModule | undefined;
    /** Get a provider script by name from ProviderLoader. */
    getProviderScript(scriptName: string, params?: Record<string, string>, ideType?: string): string | null;
    /**
     * per-category CDP script execute:
     * IDE → cdp.evaluate(script) (main window)
     * Extension → cdp.evaluateInSession(sessionId, script) (webview)
     */
    evaluateProviderScript(scriptName: string, params?: Record<string, string>, timeout?: number): Promise<{
        result: any;
        category: string;
    } | null>;
    /** CLI adapter search */
    getCliAdapter(type?: string): CliAdapter | null;
    private inferProviderType;
    private resolveRoute;
    /** Extract CDP scope key from target session or explicit ideType */
    private extractIdeType;
    private logCommandStart;
    private logCommandEnd;
    setAgentStreamManager(manager: DaemonAgentStreamManager): void;
    handle(cmd: string, args: any): Promise<CommandResult>;
    private dispatch;
    private handleRefreshScripts;
    private proxyDevServerPost;
    private proxyDevServerGet;
    private proxyDevServerScaffold;
}
