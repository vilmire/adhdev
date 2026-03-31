/**
 * Shared status snapshot builders.
 *
 * Used by:
 * - DaemonStatusReporter (cloud)
 * - daemon-standalone HTTP/WS status responses
 */

import * as os from 'os';
import { loadConfig } from '../config/config.js';
import { getWorkspaceState } from '../config/workspaces.js';
import { getWorkspaceActivity } from '../config/workspace-activity.js';
import { getHostMemorySnapshot } from '../system/host-memory.js';
import { buildSessionEntries, isCdpConnected } from './builders.js';
import type { ProviderState } from '../providers/provider-instance.js';
import type {
    AvailableProviderInfo,
    DetectedIdeInfo,
    StatusReportPayload,
} from '../shared-types.js';

export interface StatusSnapshotOptions {
    allStates: ProviderState[];
    cdpManagers: Map<string, unknown>;
    providerLoader: {
        getAll(): Array<{
            type: string;
            icon?: string;
            displayName?: string;
            category: 'ide' | 'extension' | 'cli' | 'acp';
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

function buildDetectedIdeInfos(
    detectedIdes: StatusSnapshotOptions['detectedIdes'],
    cdpManagers: StatusSnapshotOptions['cdpManagers'],
): DetectedIdeInfo[] {
    return detectedIdes
        .filter((ide) => ide.installed !== false)
        .map((ide) => ({
            id: ide.id,
            type: ide.id,
            name: ide.displayName || ide.name || ide.id,
            running: isCdpConnected(cdpManagers as Map<string, any>, ide.id),
            ...(ide.path ? { path: ide.path } : {}),
        }));
}

function buildAvailableProviders(
    providerLoader: StatusSnapshotOptions['providerLoader'],
): AvailableProviderInfo[] {
    return providerLoader.getAll().map((provider) => ({
        type: provider.type,
        name: provider.displayName || provider.type,
        displayName: provider.displayName || provider.type,
        icon: provider.icon || '💻',
        category: provider.category,
    }));
}

export function buildStatusSnapshot(options: StatusSnapshotOptions): StatusSnapshot {
    const cfg = loadConfig();
    const wsState = getWorkspaceState(cfg);
    const memSnap = getHostMemorySnapshot();
    const sessions = buildSessionEntries(
        options.allStates,
        options.cdpManagers as Map<string, any>,
    );

    return {
        instanceId: options.instanceId,
        version: options.version,
        daemonMode: options.daemonMode,
        machine: {
            hostname: os.hostname(),
            platform: os.platform(),
            arch: os.arch(),
            cpus: os.cpus().length,
            totalMem: memSnap.totalMem,
            freeMem: memSnap.freeMem,
            availableMem: memSnap.availableMem,
            loadavg: os.loadavg(),
            uptime: os.uptime(),
            release: os.release(),
        },
        machineNickname: options.machineNickname ?? cfg.machineNickname ?? null,
        timestamp: options.timestamp ?? Date.now(),
        detectedIdes: buildDetectedIdeInfos(options.detectedIdes, options.cdpManagers),
        ...(options.p2p ? { p2p: options.p2p } : {}),
        sessions,
        workspaces: wsState.workspaces,
        defaultWorkspaceId: wsState.defaultWorkspaceId,
        defaultWorkspacePath: wsState.defaultWorkspacePath,
        workspaceActivity: getWorkspaceActivity(cfg, 15),
        availableProviders: buildAvailableProviders(options.providerLoader),
    };
}
