/**
 * Shared status snapshot builders.
 *
 * Used by:
 * - DaemonStatusReporter (cloud)
 * - daemon-standalone HTTP/WS status responses
 */

import * as os from 'os';
import { loadConfig } from '../config/config.js';
import { loadState } from '../config/state-store.js';
import { getRecentActivity, getSessionSeenAt, getSessionSeenMarker } from '../config/recent-activity.js';
import { getWorkspaceState } from '../config/workspaces.js';
import { getHostMemorySnapshot } from '../system/host-memory.js';
import { getTerminalBackendRuntimeStatus } from '../cli-adapters/terminal-screen.js';
import { LOG } from '../logging/logger.js';
import { buildSessionEntries, isCdpConnected } from './builders.js';
import type { ProviderState } from '../providers/provider-instance.js';
import type {
    AvailableProviderInfo,
    DetectedIdeInfo,
    RecentLaunchEntry,
    RecentSessionBucket,
    SessionEntry,
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

const READ_DEBUG_ENABLED = process.argv.includes('--dev') || process.env.ADHDEV_READ_DEBUG === '1';

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

function parseMessageTime(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
}

function getSessionMessageUpdatedAt(session: {
    activeChat?: {
        messages?: Array<{ receivedAt?: number | string }> | null
    } | null
}) {
    const lastMessage = session.activeChat?.messages?.at?.(-1);
    if (!lastMessage) return 0;
    return parseMessageTime(lastMessage.receivedAt) || 0;
}

export function getSessionCompletionMarker(session: {
    activeChat?: {
        messages?: Array<{
            role?: string;
            id?: string;
            index?: number;
            receivedAt?: number | string;
            _turnKey?: string;
        }> | null
    } | null
}) {
    const lastMessage = session.activeChat?.messages?.at?.(-1) as any;
    if (!lastMessage) return '';
    const role = typeof lastMessage.role === 'string' ? lastMessage.role : '';
    if (role === 'user' || role === 'human' || role === 'system') return '';
    if (typeof lastMessage._turnKey === 'string' && lastMessage._turnKey) return `turn:${lastMessage._turnKey}`;
    if (typeof lastMessage.id === 'string' && lastMessage.id) return `id:${lastMessage.id}`;
    if (typeof lastMessage.index === 'number' && Number.isFinite(lastMessage.index)) return `idx:${lastMessage.index}`;
    const timestamp = parseMessageTime(lastMessage.receivedAt);
    return timestamp > 0 ? `ts:${timestamp}` : '';
}

function getSessionLastUsedAt(session: {
    activeChat?: {
        messages?: Array<{ receivedAt?: number | string }> | null
    } | null
    lastUpdated?: number
}) {
    return getSessionMessageUpdatedAt(session) || session.lastUpdated || Date.now();
}

function getSessionKind(session: SessionEntry): RecentLaunchEntry['kind'] {
    return session.transport === 'cdp-page' || session.transport === 'cdp-webview'
        ? 'ide'
        : session.transport === 'acp'
            ? 'acp'
            : 'cli';
}

function getLastMessageRole(session: { activeChat?: { messages?: Array<{ role?: string }> | null } | null }): string {
    const role = session.activeChat?.messages?.at?.(-1)?.role;
    return typeof role === 'string' ? role : '';
}

function getUnreadState(
    hasContentChange: boolean,
    status: SessionEntry['status'] | undefined,
    lastUsedAt: number,
    lastSeenAt: number,
    lastRole: string,
    completionMarker: string,
    seenCompletionMarker: string,
): { unread: boolean; inboxBucket: RecentSessionBucket } {
    if (status === 'waiting_approval') {
        return { unread: false, inboxBucket: 'needs_attention' };
    }
    if (status === 'generating' || status === 'starting') {
        return { unread: false, inboxBucket: 'working' };
    }
    const unread = completionMarker
        ? completionMarker !== seenCompletionMarker
        : hasContentChange && lastUsedAt > lastSeenAt && lastRole !== 'user' && lastRole !== 'human' && lastRole !== 'system';
    return { unread, inboxBucket: unread ? 'task_complete' : 'idle' };
}

function buildRecentLaunches(
    recentActivity: ReturnType<typeof getRecentActivity>,
): RecentLaunchEntry[] {
    return recentActivity
        .map((item) => ({
            id: item.id,
            providerType: item.providerType,
            providerName: item.providerName,
            kind: item.kind,
            providerSessionId: item.providerSessionId,
            title: item.title || item.providerName,
            workspace: item.workspace,
            currentModel: item.currentModel,
            lastLaunchedAt: item.lastUsedAt,
        }))
        .sort((a, b) => b.lastLaunchedAt - a.lastLaunchedAt)
        .slice(0, 12);
}

export function buildStatusSnapshot(options: StatusSnapshotOptions): StatusSnapshot {
    const cfg = loadConfig();
    const state = loadState();
    const wsState = getWorkspaceState(cfg);
    const memSnap = getHostMemorySnapshot();
    const recentActivity = getRecentActivity(state, 20);
    const sessions = buildSessionEntries(
        options.allStates,
        options.cdpManagers as Map<string, any>,
    );
    for (const session of sessions) {
        const lastSeenAt = getSessionSeenAt(state, session.id);
        const seenCompletionMarker = getSessionSeenMarker(state, session.id);
        const lastUsedAt = getSessionLastUsedAt(session);
        const completionMarker = getSessionCompletionMarker(session);
        const { unread, inboxBucket } = session.surfaceHidden
            ? { unread: false, inboxBucket: 'idle' as RecentSessionBucket }
            : getUnreadState(
                getSessionMessageUpdatedAt(session) > 0,
                session.status,
                lastUsedAt,
                lastSeenAt,
                getLastMessageRole(session),
                completionMarker,
                seenCompletionMarker,
            );
        session.lastSeenAt = lastSeenAt;
        session.unread = unread;
        session.inboxBucket = inboxBucket;
        if (READ_DEBUG_ENABLED && (session.unread || session.inboxBucket !== 'idle' || session.providerType.includes('codex'))) {
            LOG.info(
                'RecentRead',
                `snapshot session id=${session.id} provider=${session.providerType} status=${String(session.status || '')} bucket=${inboxBucket} unread=${String(unread)} lastSeenAt=${lastSeenAt} completionMarker=${completionMarker || '-'} seenMarker=${seenCompletionMarker || '-'} lastUpdated=${String(session.lastUpdated || 0)} lastUsedAt=${lastUsedAt} lastRole=${getLastMessageRole(session)} msgUpdatedAt=${getSessionMessageUpdatedAt(session)}`,
            );
        }
    }
    const terminalBackend = getTerminalBackendRuntimeStatus();

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
        terminalSizingMode: cfg.terminalSizingMode || 'measured',
        recentLaunches: buildRecentLaunches(recentActivity),
        terminalBackend,
        availableProviders: buildAvailableProviders(options.providerLoader),
    };
}
