/**
 * DaemonStatusReporter — status collect & transmit (StatusReport / P2P / StatusEvent)
 *
 * Collect status from ProviderInstanceManager → assemble payload → transmit
 * Each Instance manages its own status/transition. This module only assembles + transmits.
 */
import type { DaemonCdpManager } from '../cdp/manager.js';
import type { ProviderState } from '../providers/provider-instance.js';
export interface StatusReporterDeps {
    serverConn: {
        isConnected(): boolean;
        sendMessage(type: string, data: any): void;
        getUserPlan(): string;
    } | null;
    cdpManagers: Map<string, DaemonCdpManager>;
    p2p: {
        isConnected: boolean;
        isAvailable: boolean;
        connectionState: string;
        connectedPeerCount: number;
        screenshotActive: boolean;
        sendStatus(data: any): void;
    } | null;
    providerLoader: {
        resolve(type: string): any;
        getAll(): any[];
    };
    detectedIdes: any[];
    instanceId: string;
    daemonVersion?: string;
    instanceManager: {
        collectAllStates(): ProviderState[];
        collectStatesByCategory(cat: string): ProviderState[];
    };
    getScreenshotUsage?: () => {
        dailyUsedMinutes: number;
        dailyBudgetMinutes: number;
        budgetExhausted: boolean;
    } | null;
}
export declare class DaemonStatusReporter {
    private deps;
    private log;
    private lastStatusSentAt;
    private statusPendingThrottle;
    private lastP2PStatusHash;
    private lastStatusSummary;
    private statusTimer;
    private p2pTimer;
    constructor(deps: StatusReporterDeps, opts?: {
        logFn?: (msg: string) => void;
    });
    startReporting(): void;
    stopReporting(): void;
    onStatusChange(): void;
    throttledReport(): void;
    emitStatusEvent(event: Record<string, unknown>): void;
    removeAgentTracking(_key: string): void;
    updateAgentStreams(_ideType: string, _streams: any[]): void;
    /** Reset P2P dedup hash — forces next send to transmit even if content unchanged */
    resetP2PHash(): void;
    private ts;
    private summarizeLargePayloadSessions;
    sendUnifiedStatusReport(opts?: {
        p2pOnly?: boolean;
    }): Promise<void>;
    private sendP2PPayload;
    private simpleHash;
}
