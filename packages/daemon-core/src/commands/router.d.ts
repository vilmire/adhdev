/**
 * DaemonCommandRouter — Unified command routing for daemon-level commands
 *
 * Unified command routing for daemon-level commands.
 *
 * Routing flow:
 *   1. Daemon-level commands (launch_ide, stop_ide, restart_ide, etc.) → handled here
 *   2. CLI/ACP commands → delegated to cliManager
 *   3. Everything else → delegated to commandHandler.handle()
 */
import { DaemonCdpManager } from '../cdp/manager.js';
import { DaemonCommandHandler } from './handler.js';
import { DaemonCliManager } from './cli-manager.js';
import type { ProviderLoader } from '../providers/provider-loader.js';
import type { ProviderInstanceManager } from '../providers/provider-instance-manager.js';
import { SessionRegistry } from '../sessions/registry.js';
export interface SessionHostControlPlane {
    getDiagnostics(payload?: {
        includeSessions?: boolean;
        limit?: number;
    }): Promise<any>;
    listSessions(): Promise<any[]>;
    stopSession(sessionId: string): Promise<any>;
    resumeSession(sessionId: string): Promise<any>;
    restartSession(sessionId: string): Promise<any>;
    sendSignal(sessionId: string, signal: string): Promise<any>;
    forceDetachClient(sessionId: string, clientId: string): Promise<any>;
    pruneDuplicateSessions(payload?: {
        providerType?: string;
        workspace?: string;
        dryRun?: boolean;
    }): Promise<any>;
    acquireWrite(payload: {
        sessionId: string;
        clientId: string;
        ownerType: 'agent' | 'user';
        force?: boolean;
    }): Promise<any>;
    releaseWrite(payload: {
        sessionId: string;
        clientId: string;
    }): Promise<any>;
}
export interface CommandRouterDeps {
    commandHandler: DaemonCommandHandler;
    cliManager: DaemonCliManager;
    cdpManagers: Map<string, DaemonCdpManager>;
    providerLoader: ProviderLoader;
    instanceManager: ProviderInstanceManager;
    /** Reference to detected IDEs array (mutable — router updates it) */
    detectedIdes: {
        value: any[];
    };
    sessionRegistry: SessionRegistry;
    /** Callback for CDP manager creation after launch_ide */
    onCdpManagerCreated?: (ideType: string, manager: DaemonCdpManager) => void;
    /** Callback after IDE connected (e.g., startAgentStreamPolling) */
    onIdeConnected?: () => void;
    /** Callback after status change (stop_ide, restart) */
    onStatusChange?: () => void;
    /** Callback after chat-related commands */
    onPostChatCommand?: () => void;
    /** Get a connected CDP manager (for agent stream reset check) */
    getCdpLogFn?: (ideType: string) => (msg: string) => void;
    /** Package name for upgrade detection ('adhdev' or '@adhdev/daemon-standalone') */
    packageName?: string;
    /** Session host control plane */
    sessionHostControl?: SessionHostControlPlane | null;
}
export interface CommandRouterResult {
    success: boolean;
    [key: string]: unknown;
}
export declare class DaemonCommandRouter {
    private deps;
    constructor(deps: CommandRouterDeps);
    /**
     * Unified command routing.
     * Returns result for all commands:
     *   1. Daemon-level commands (launch_ide, stop_ide, etc.)
     *   2. CLI commands (launch_cli, stop_cli, agent_command)
     *   3. DaemonCommandHandler delegation (CDP/agent-stream/file commands)
     *
     * @param cmd Command name
     * @param args Command arguments
     * @param source Log source ('ws' | 'p2p' | 'standalone' | etc.)
     */
    execute(cmd: string, args: any, source?: string): Promise<CommandRouterResult>;
    /**
     * Daemon-level command execution (IDE start/stop/restart, CLI, detect, logs).
     * Returns null if not handled at this level → caller delegates to CommandHandler.
     */
    private executeDaemonCommand;
    /**
     * IDE stop: CDP disconnect + InstanceManager cleanup + optionally kill OS process
     */
    private stopIde;
}
