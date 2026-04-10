/**
 * DaemonCliManager — CLI session creation, management, and command handling
 *
 * Separated from adhdev-daemon.ts.
 * CLI cases of createAdapter, startCliSession, stopCliSession, executeDaemonCommand extracted to independent module extract.
 */
import type { ProviderInstanceManager } from '../providers/provider-instance-manager.js';
import { ProviderLoader } from '../providers/provider-loader.js';
import type { ProviderResumeCapability } from '../providers/contracts.js';
import type { CliAdapter } from '../cli-adapter-types.js';
import type { PtyTransportFactory } from '../cli-adapters/pty-transport.js';
import type { SessionRegistry } from '../sessions/registry.js';
export interface CliManagerDeps {
    /** Server connection — injected into adapter */
    getServerConn(): any | null;
    /** P2P — PTY output transmit */
    getP2p(): {
        broadcastSessionOutput(key: string, data: string): void;
    } | null;
    /** StatusReporter callback */
    onStatusChange(): void;
    removeAgentTracking(key: string): void;
    /** InstanceManager — register in CLI unified status */
    getInstanceManager(): ProviderInstanceManager | null;
    getSessionRegistry?(): SessionRegistry | null;
    createPtyTransportFactory?: (params: CliTransportFactoryParams) => PtyTransportFactory | null;
    listHostedCliRuntimes?: () => Promise<HostedCliRuntimeDescriptor[]>;
}
type CommandResult = {
    success: boolean;
    [key: string]: unknown;
};
export interface CliTransportFactoryParams {
    runtimeId: string;
    providerType: string;
    workspace: string;
    cliArgs?: string[];
    providerSessionId?: string;
    attachExisting?: boolean;
}
export interface HostedCliRuntimeDescriptor {
    runtimeId: string;
    runtimeKey?: string;
    displayName?: string;
    workspaceLabel?: string;
    lifecycle?: 'starting' | 'running' | 'stopping' | 'stopped' | 'failed' | 'interrupted';
    recoveryState?: string | null;
    cliType: string;
    workspace: string;
    cliArgs?: string[];
    providerSessionId?: string;
}
export declare function supportsExplicitSessionResume(resume?: ProviderResumeCapability): boolean;
export declare class DaemonCliManager {
    readonly adapters: Map<string, CliAdapter>;
    private deps;
    private providerLoader;
    constructor(deps: CliManagerDeps, providerLoader: ProviderLoader);
    getCliKey(cliType: string, dir: string): string;
    getSessionPresentationMode(sessionId: string): 'terminal' | 'chat' | null;
    isTerminalSession(sessionId: string): boolean;
    private persistRecentActivity;
    private getTransportFactory;
    private createAdapter;
    private startCliExitMonitor;
    private registerCliInstance;
    startSession(cliType: string, workingDir: string, cliArgs?: string[], initialModel?: string, options?: {
        resumeSessionId?: string;
    }): Promise<{
        runtimeSessionId: string;
        providerSessionId?: string;
    }>;
    stopSession(key: string): Promise<void>;
    stopSessionWithMode(key: string, mode: 'hard' | 'save'): Promise<void>;
    shutdownAll(): void;
    detachAll(): void;
    restoreHostedSessions(records?: HostedCliRuntimeDescriptor[]): Promise<number>;
    /**
    * Search for CLI adapter. Priority order:
    * 0. sessionId (UUID direct match)
    * 1. agentType + dir (iteration match)
    * 2. agentType fuzzy match (⚠ returns first match when multiple sessions exist)
    */
    findAdapter(agentType: string, opts?: {
        dir?: string;
        instanceKey?: string;
    }): {
        adapter: CliAdapter;
        key: string;
    } | null;
    private findAdapterBySessionId;
    handleCliCommand(cmd: string, args: any): Promise<CommandResult | null>;
}
export {};
