/**
 * DaemonAgentStreamManager — manage agent streams (ported for Daemon)
 *
 * Agent stream manager for extension data collection.
 * All vscode dependencies removed — pure Node.js environment.
 *
 * Panel focus is delegated to Extension via IPC.
 * CDP session management uses DaemonCdpManager directly.
 */
import { DaemonCdpManager, AgentWebviewTarget } from '../cdp/manager.js';
import { ProviderLoader } from '../providers/provider-loader.js';
import { SessionRegistry } from '../sessions/registry.js';
import type { IAgentStreamAdapter, AgentStreamState, AgentChatListItem } from './types.js';
export interface ManagedAgent {
    adapter: IAgentStreamAdapter;
    runtimeSessionId: string;
    parentSessionId: string;
    cdpSessionId: string;
    target: AgentWebviewTarget;
    lastState: AgentStreamState | null;
    lastError: string | null;
    lastHiddenCheckTime: number;
}
export declare class DaemonAgentStreamManager {
    private readonly sessionRegistry?;
    private adaptersByType;
    private managedBySessionId;
    private enabled;
    private logFn;
    private lastDiscoveryTimeByParent;
    private discoveryIntervalMsByParent;
    private activeSessionIdByParent;
    constructor(logFn?: (msg: string) => void, providerLoader?: ProviderLoader, sessionRegistry?: SessionRegistry);
    setEnabled(enabled: boolean): void;
    get isEnabled(): boolean;
    getActiveSessionId(parentSessionId: string): string | null;
    private isRecoverableSessionError;
    private getSessionTarget;
    resetParentSession(parentSessionId: string): void;
    /** Panel focus based on provider.js focusPanel or extensionId (currently no-op) */
    ensureSessionPanelOpen(_sessionId: string): Promise<void>;
    setActiveSession(cdp: DaemonCdpManager, parentSessionId: string, sessionId: string | null): Promise<void>;
    private resolveSessionIdForTarget;
    private getStateError;
    private connectManagedSession;
    /** Agent webview discovery + session connection */
    syncActiveSession(cdp: DaemonCdpManager, parentSessionId: string): Promise<void>;
    /** Collect active extension session state */
    collectActiveSession(cdp: DaemonCdpManager, parentSessionId: string): Promise<AgentStreamState | null>;
    sendToSession(cdp: DaemonCdpManager, sessionId: string, text: string): Promise<boolean>;
    resolveSessionAction(cdp: DaemonCdpManager, sessionId: string, action: 'approve' | 'reject', button?: string): Promise<boolean>;
    newSession(cdp: DaemonCdpManager, sessionId: string): Promise<boolean>;
    listSessionChats(cdp: DaemonCdpManager, sessionId: string): Promise<AgentChatListItem[]>;
    switchConversation(cdp: DaemonCdpManager, sessionId: string, conversationId: string): Promise<boolean>;
    focusSession(cdp: DaemonCdpManager, sessionId: string): Promise<boolean>;
    getConnectedSessions(parentSessionId?: string): string[];
    getManagedSession(sessionId: string): ManagedAgent | undefined;
    dispose(cdpManagers: Map<string, DaemonCdpManager>): Promise<void>;
    resolveSessionForAgent(parentSessionId: string, agentType: string): string | null;
}
