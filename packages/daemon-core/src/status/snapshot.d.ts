/**
 * Shared status snapshot builders.
 *
 * Used by:
 * - DaemonStatusReporter (cloud)
 * - daemon-standalone HTTP/WS status responses
 */
import type { DaemonCdpManager } from '../cdp/manager.js';
import type { ProviderState } from '../providers/provider-instance.js';
import type { AvailableProviderInfo, StatusReportPayload } from '../shared-types.js';
export interface StatusSnapshotOptions {
    allStates: ProviderState[];
    cdpManagers: Map<string, DaemonCdpManager>;
    providerLoader: {
        getAll(): Array<{
            type: string;
            icon?: string;
            displayName?: string;
            category: 'ide' | 'extension' | 'cli' | 'acp';
        }>;
        getAvailableProviderInfos?: () => Array<{
            type: string;
            icon?: string;
            displayName?: string;
            category: 'ide' | 'extension' | 'cli' | 'acp';
            installed?: boolean;
            detectedPath?: string | null;
        }>;
    };
    detectedIdes: Array<{
        id: string;
        name?: string;
        displayName?: string;
        installed?: boolean;
        path?: string;
    }>;
    instanceId: string;
    version: string;
    daemonMode: boolean;
    timestamp?: number;
    p2p?: StatusReportPayload['p2p'];
    machineNickname?: string | null;
}
export interface StatusSnapshot extends StatusReportPayload {
    availableProviders: AvailableProviderInfo[];
}
export declare function getSessionCompletionMarker(session: {
    activeChat?: {
        messages?: Array<{
            role?: string;
            id?: string;
            index?: number;
            receivedAt?: number | string;
            _turnKey?: string;
        }> | null;
    } | null;
}): string;
export declare function buildStatusSnapshot(options: StatusSnapshotOptions): StatusSnapshot;
