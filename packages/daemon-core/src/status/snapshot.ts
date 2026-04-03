/**
 * Shared status snapshot builders.
 *
 * Used by:
 * - DaemonStatusReporter (cloud)
 * - daemon-standalone HTTP/WS status responses
 */

import * as os from 'os';
import { loadConfig } from '../config/config.js';
import { buildRecentActivityKey, getRecentActivity, getRecentSessionSeenAt } from '../config/recent-activity.js';
import { getWorkspaceState } from '../config/workspaces.js';
import { getHostMemorySnapshot } from '../system/host-memory.js';
import { getTerminalBackendRuntimeStatus } from '../cli-adapters/terminal-screen.js';
import { buildSessionEntries, isCdpConnected } from './builders.js';
import type { ProviderState } from '../providers/provider-instance.js';
import type {
    AvailableProviderInfo,
    DetectedIdeInfo,
    RecentSessionBucket,
    RecentSessionEntry,
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
        messages?: Array<{ timestamp?: number | string; receivedAt?: number | string; createdAt?: number | string }> | null
    } | null
}) {
    const lastMessage = session.activeChat?.messages?.at?.(-1);
    if (!lastMessage) return 0;
    return (
        parseMessageTime(lastMessage.timestamp)
        || parseMessageTime(lastMessage.receivedAt)
        || parseMessageTime(lastMessage.createdAt)
        || 0
    );
}

function getSessionLastUsedAt(session: {
    activeChat?: {
        messages?: Array<{ timestamp?: number | string; receivedAt?: number | string; createdAt?: number | string }> | null
    } | null
    lastUpdated?: number
}) {
    return getSessionMessageUpdatedAt(session) || session.lastUpdated || Date.now();
}

function getSessionKind(session: SessionEntry): RecentSessionEntry['kind'] {
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
): { unread: boolean; inboxBucket: RecentSessionBucket } {
    if (status === 'waiting_approval') {
        return { unread: false, inboxBucket: 'needs_attention' };
    }
    if (status === 'generating' || status === 'starting') {
        return { unread: false, inboxBucket: 'working' };
    }
    const unread = hasContentChange && lastUsedAt > lastSeenAt && lastRole !== 'user' && lastRole !== 'human';
    return { unread, inboxBucket: unread ? 'task_complete' : 'idle' };
}

function buildRecentSessions(
    sessions: ReturnType<typeof buildSessionEntries>,
    recentActivity: ReturnType<typeof getRecentActivity>,
    readState: Record<string, number>,
): RecentSessionEntry[] {
    const visibleKeys = new Set<string>();
    const hiddenKeys = new Set<string>();
    const live = sessions
        .filter((session) => !session.surfaceHidden && session.status !== 'stopped')
        .map((session) => {
            const kind = getSessionKind(session);
            const recentKey = buildRecentActivityKey({
                kind,
                providerType: session.providerType,
                workspace: session.workspace,
            });
            const lastSeenAt = readState[recentKey] || 0;
            const lastUsedAt = getSessionLastUsedAt(session);
            const { unread, inboxBucket } = getUnreadState(
                getSessionMessageUpdatedAt(session) > 0,
                session.status,
                lastUsedAt,
                lastSeenAt,
                getLastMessageRole(session),
            );
            return {
                id: session.id,
                recentKey,
                sessionId: session.id,
                providerType: session.providerType,
                providerName: session.providerName,
                kind,
                title: session.activeChat?.title || session.title || session.providerName,
                workspace: session.workspace,
                currentModel: session.currentModel,
                status: session.status,
                lastUsedAt,
                unread,
                lastSeenAt,
                inboxBucket,
                surfaceHidden: false,
            };
        });
    for (const item of live) {
        visibleKeys.add(`${item.kind}:${item.providerType}:${item.workspace || ''}`);
    }
    for (const session of sessions) {
        if (!session.surfaceHidden) continue;
        hiddenKeys.add(`${getSessionKind(session)}:${session.providerType}:${session.workspace || ''}`);
    }
    const persisted = recentActivity
        .filter((item) => {
            const key = `${item.kind}:${item.providerType}:${item.workspace || ''}`;
            return !visibleKeys.has(key) && !hiddenKeys.has(key);
        })
        .map((item) => {
            const lastSeenAt = readState[item.id] || 0;
            const unread = item.lastUsedAt > lastSeenAt;
            return {
                id: item.id,
                recentKey: item.id,
                sessionId: item.sessionId || null,
                providerType: item.providerType,
                providerName: item.providerName,
                kind: item.kind,
                title: item.title || item.providerName,
                workspace: item.workspace,
                currentModel: item.currentModel,
                lastUsedAt: item.lastUsedAt,
                unread,
                lastSeenAt,
                inboxBucket: unread ? 'task_complete' : 'idle' as RecentSessionBucket,
                surfaceHidden: false,
            };
        });

    return [...live, ...persisted]
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
        .slice(0, 12);
}

export function buildStatusSnapshot(options: StatusSnapshotOptions): StatusSnapshot {
    const cfg = loadConfig();
    const wsState = getWorkspaceState(cfg);
    const memSnap = getHostMemorySnapshot();
    const recentActivity = getRecentActivity(cfg, 20);
    const sessions = buildSessionEntries(
        options.allStates,
        options.cdpManagers as Map<string, any>,
    );
    const readState = cfg.recentSessionReads || {};
    for (const session of sessions) {
        const kind = getSessionKind(session);
        const recentKey = buildRecentActivityKey({
            kind,
            providerType: session.providerType,
            workspace: session.workspace,
        });
        const lastSeenAt = getRecentSessionSeenAt(cfg, recentKey);
        const lastUsedAt = getSessionLastUsedAt(session);
        const { unread, inboxBucket } = session.surfaceHidden
            ? { unread: false, inboxBucket: 'idle' as RecentSessionBucket }
            : getUnreadState(
                getSessionMessageUpdatedAt(session) > 0,
                session.status,
                lastUsedAt,
                lastSeenAt,
                getLastMessageRole(session),
            );
        session.recentKey = recentKey;
        session.lastSeenAt = lastSeenAt;
        session.unread = unread;
        session.inboxBucket = inboxBucket;
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
        recentSessions: buildRecentSessions(sessions, recentActivity, readState),
        terminalBackend,
        availableProviders: buildAvailableProviders(options.providerLoader),
    };
}
