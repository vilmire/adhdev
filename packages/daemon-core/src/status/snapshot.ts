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
import { getRecentActivity, getSessionSeenAt, getSessionSeenMarker, getSessionNotificationDismissal, getSessionNotificationUnreadOverride, applySessionNotificationOverlay, getSessionCurrentNotificationId } from '../config/recent-activity.js';
import { getWorkspaceState } from '../config/workspaces.js';
import { getHostMemorySnapshot } from '../system/host-memory.js';
import { getTerminalBackendRuntimeStatus } from '../cli-adapters/terminal-screen.js';
import { LOG } from '../logging/logger.js';
import type { DaemonCdpManager } from '../cdp/manager.js';
import { buildSessionEntries, isCdpConnected, type SessionEntryProfile } from './builders.js';
import { LIVE_STATUS_ACTIVE_CHAT_OPTIONS, normalizeActiveChatData } from './normalize.js';
import type { ProviderState } from '../providers/provider-instance.js';
import type {
    AvailableProviderInfo,
    DetectedIdeInfo,
    MachineInfo,
    RecentLaunchEntry,
    RecentSessionBucket,
    SessionEntry,
    StatusReportPayload,
} from '../shared-types.js';

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
            enabled?: boolean;
            machineStatus?: 'disabled' | 'enabled_unchecked' | 'not_detected' | 'detected';
            lastDetection?: AvailableProviderInfo['lastDetection'];
            lastVerification?: AvailableProviderInfo['lastVerification'];
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
    timestamp?: number;
    p2p?: StatusReportPayload['p2p'];
    machineNickname?: string | null;
    profile?: SessionEntryProfile;
}

export type StatusSnapshot = StatusReportPayload;

const READ_DEBUG_ENABLED = process.argv.includes('--dev') || process.env.ADHDEV_READ_DEBUG === '1';
const recentReadDebugSignatureBySession = new Map<string, string>();

export interface RecentReadDebugSnapshot {
    sessionId: string;
    providerType: string;
    status: string;
    inboxBucket: RecentSessionBucket;
    unread: boolean;
    lastSeenAt: number;
    completionMarker: string;
    seenCompletionMarker: string;
    lastUpdated: number;
    lastUsedAt: number;
    lastRole: string;
    messageUpdatedAt: number;
}

function buildRecentReadDebugSignature(snapshot: RecentReadDebugSnapshot): string {
    return [
        snapshot.providerType,
        snapshot.status,
        snapshot.inboxBucket,
        snapshot.unread ? '1' : '0',
        String(snapshot.lastSeenAt),
        snapshot.completionMarker,
        snapshot.seenCompletionMarker,
        String(snapshot.lastUpdated),
        String(snapshot.lastUsedAt),
        snapshot.lastRole,
        String(snapshot.messageUpdatedAt),
    ].join('|');
}

export function shouldEmitRecentReadDebugLog(
    cache: Map<string, string>,
    snapshot: RecentReadDebugSnapshot,
): boolean {
    const nextSignature = buildRecentReadDebugSignature(snapshot);
    const previousSignature = cache.get(snapshot.sessionId);
    if (previousSignature === nextSignature) return false;
    cache.set(snapshot.sessionId, nextSignature);
    return true;
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
            running: isCdpConnected(cdpManagers, ide.id),
            ...(ide.path ? { path: ide.path } : {}),
        }));
}

function buildAvailableProviders(
    providerLoader: StatusSnapshotOptions['providerLoader'],
): AvailableProviderInfo[] {
    const providers: Array<{
        type: string;
        icon?: string;
        displayName?: string;
        category: 'ide' | 'extension' | 'cli' | 'acp';
        installed?: boolean;
        detectedPath?: string | null;
        enabled?: boolean;
        machineStatus?: 'disabled' | 'enabled_unchecked' | 'not_detected' | 'detected';
        lastDetection?: AvailableProviderInfo['lastDetection'];
        lastVerification?: AvailableProviderInfo['lastVerification'];
    }> = providerLoader.getAvailableProviderInfos?.() || providerLoader.getAll();
    return providers.map((provider) => ({
        type: provider.type,
        name: provider.displayName || provider.type,
        displayName: provider.displayName || provider.type,
        icon: provider.icon || '💻',
        category: provider.category,
        ...(provider.installed !== undefined ? { installed: provider.installed } : {}),
        ...(provider.detectedPath !== undefined ? { detectedPath: provider.detectedPath } : {}),
        ...(provider.enabled !== undefined ? { enabled: provider.enabled } : {}),
        ...(provider.machineStatus !== undefined ? { machineStatus: provider.machineStatus } : {}),
        ...(provider.lastDetection !== undefined ? { lastDetection: provider.lastDetection } : {}),
        ...(provider.lastVerification !== undefined ? { lastVerification: provider.lastVerification } : {}),
    }));
}

export function buildMachineInfo(profile: 'full' | 'live' | 'metadata' = 'full'): MachineInfo {
    const base: MachineInfo = {
        hostname: os.hostname(),
        platform: os.platform(),
    };

    if (profile === 'live') {
        return base;
    }

    if (profile === 'metadata') {
        const memSnap = getHostMemorySnapshot();
        return {
            ...base,
            arch: os.arch(),
            cpus: os.cpus().length,
            totalMem: memSnap.totalMem,
            release: os.release(),
        };
    }

    const memSnap = getHostMemorySnapshot();
    return {
        ...base,
        arch: os.arch(),
        cpus: os.cpus().length,
        totalMem: memSnap.totalMem,
        freeMem: memSnap.freeMem,
        availableMem: memSnap.availableMem,
        loadavg: os.loadavg(),
        uptime: os.uptime(),
        release: os.release(),
    };
}

function parseMessageTime(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
}

function getMessageEventTime(message: { receivedAt?: unknown; timestamp?: unknown } | null | undefined): number {
    return parseMessageTime(message?.receivedAt) || parseMessageTime(message?.timestamp) || 0;
}

function stringifyPreviewContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((block) => {
            if (typeof block === 'string') return block;
            if (block && typeof block === 'object' && 'text' in block) {
                return String((block as { text?: unknown }).text || '');
            }
            return '';
        }).join(' ');
    }
    if (content && typeof content === 'object' && 'text' in content) {
        return String((content as { text?: unknown }).text || '');
    }
    return String(content || '');
}

function normalizePreviewText(content: unknown): string {
    return stringifyPreviewContent(content)
        .replace(/\s+/g, ' ')
        .trim();
}

function clampPreviewText(value: string, maxChars = 120): string {
    if (value.length <= maxChars) return value;
    if (maxChars <= 1) return value.slice(0, maxChars);
    return `${value.slice(0, maxChars - 1)}…`;
}

function simplePreviewHash(value: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < value.length; i += 1) {
        h ^= value.charCodeAt(i);
        h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16);
}

function getLastDisplayMessage(session: {
    activeChat?: {
        messages?: Array<{
            role?: string;
            content?: unknown;
            receivedAt?: number | string;
            timestamp?: number | string;
        }> | null
    } | null
}) {
    const messages = session.activeChat?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return null;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const candidate = messages[i];
        const role = typeof candidate?.role === 'string' ? candidate.role : '';
        if (role === 'system') continue;
        const preview = clampPreviewText(normalizePreviewText(candidate?.content));
        if (!preview) continue;
        return {
            role,
            preview,
            receivedAt: getMessageEventTime(candidate),
            hash: simplePreviewHash(`${role}:${preview}`),
        };
    }
    return null;
}

export { getSessionCurrentNotificationId, applySessionNotificationOverlay } from '../config/recent-activity.js';

function getSessionMessageUpdatedAt(session: {
    activeChat?: {
        messages?: Array<{ receivedAt?: number | string; timestamp?: number | string }> | null
    } | null
}) {
    const lastMessage = session.activeChat?.messages?.at?.(-1);
    if (!lastMessage) return 0;
    return getMessageEventTime(lastMessage);
}

export function getSessionCompletionMarker(session: {
    activeChat?: {
        messages?: Array<{
            role?: string;
            id?: string;
            index?: number;
            receivedAt?: number | string;
            timestamp?: number | string;
            _turnKey?: string;
        }> | null
    } | null
}) {
    const lastMessage = session.activeChat?.messages?.at?.(-1);
    if (!lastMessage) return '';
    const role = typeof lastMessage.role === 'string' ? lastMessage.role : '';
    if (role === 'user' || role === 'human' || role === 'system') return '';
    if (typeof lastMessage._turnKey === 'string' && lastMessage._turnKey) return `turn:${lastMessage._turnKey}`;
    if (typeof lastMessage.id === 'string' && lastMessage.id) return `id:${lastMessage.id}`;
    if (typeof lastMessage.index === 'number' && Number.isFinite(lastMessage.index)) return `idx:${lastMessage.index}`;
    const timestamp = getMessageEventTime(lastMessage);
    return timestamp > 0 ? `ts:${timestamp}` : '';
}

function getSessionLastUsedAt(session: {
    activeChat?: {
        messages?: Array<{ receivedAt?: number | string; timestamp?: number | string }> | null
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
    return getLastDisplayMessage(session)?.role || '';
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

function projectLiveSessionFromFull(session: SessionEntry): SessionEntry {
    const {
        capabilities: _capabilities,
        controlValues: _controlValues,
        providerControls: _providerControls,
        ...rest
    } = session as SessionEntry & Record<string, unknown>;
    return {
        ...rest,
        activeChat: normalizeActiveChatData(session.activeChat as any, LIVE_STATUS_ACTIVE_CHAT_OPTIONS),
    } as SessionEntry;
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
            summaryMetadata: item.summaryMetadata,
            lastLaunchedAt: item.lastUsedAt,
        }))
        .sort((a, b) => b.lastLaunchedAt - a.lastLaunchedAt)
        .slice(0, 12);
}

export function buildStatusSnapshot(options: StatusSnapshotOptions): StatusSnapshot {
    const profile = options.profile || 'full';
    const cfg = loadConfig();
    const state = loadState();
    const wsState = getWorkspaceState(cfg);
    const recentActivity = getRecentActivity(state, 20);
    const unreadSourceSessions = buildSessionEntries(
        options.allStates,
        options.cdpManagers,
        { profile: 'full' },
    );
    const sessions = profile === 'full'
        ? unreadSourceSessions
        : profile === 'live'
            ? unreadSourceSessions.map(projectLiveSessionFromFull)
            : buildSessionEntries(
                options.allStates,
                options.cdpManagers,
                { profile },
            );
    const sessionsById = new Map(sessions.map((session) => [session.id, session]));
    for (const sourceSession of unreadSourceSessions) {
        const session = sessionsById.get(sourceSession.id);
        if (!session) continue;
        const lastSeenAt = getSessionSeenAt(state, sourceSession.id, sourceSession.providerSessionId);
        const seenCompletionMarker = getSessionSeenMarker(state, sourceSession.id, sourceSession.providerSessionId);
        const lastUsedAt = getSessionLastUsedAt(sourceSession);
        const completionMarker = getSessionCompletionMarker(sourceSession);
        const { unread, inboxBucket } = sourceSession.surfaceHidden
            ? { unread: false, inboxBucket: 'idle' as RecentSessionBucket }
            : getUnreadState(
                getSessionMessageUpdatedAt(sourceSession) > 0,
                sourceSession.status,
                lastUsedAt,
                lastSeenAt,
                getLastMessageRole(sourceSession),
                completionMarker,
                seenCompletionMarker,
            );
        const { unread: overlayUnread, inboxBucket: overlayInboxBucket } = applySessionNotificationOverlay({
            id: sourceSession.id,
            providerSessionId: sourceSession.providerSessionId,
            status: sourceSession.status,
            unread,
            inboxBucket,
            lastMessageHash: sourceSession.lastMessageHash,
            lastMessageAt: sourceSession.lastMessageAt,
            lastUpdated: sourceSession.lastUpdated,
        }, {
            dismissedNotificationId: getSessionNotificationDismissal(state, sourceSession.id, sourceSession.providerSessionId),
            unreadNotificationId: getSessionNotificationUnreadOverride(state, sourceSession.id, sourceSession.providerSessionId),
        });
        session.lastSeenAt = lastSeenAt;
        session.unread = overlayUnread;
        session.inboxBucket = overlayInboxBucket;
        session.completionMarker = completionMarker;
        session.seenCompletionMarker = seenCompletionMarker;
        if (READ_DEBUG_ENABLED && (session.unread || session.inboxBucket !== 'idle' || session.providerType.includes('codex'))) {
            const recentReadSnapshot: RecentReadDebugSnapshot = {
                sessionId: session.id,
                providerType: session.providerType,
                status: String(session.status || ''),
                inboxBucket,
                unread,
                lastSeenAt,
                completionMarker: completionMarker || '-',
                seenCompletionMarker: seenCompletionMarker || '-',
                lastUpdated: Number(session.lastUpdated || 0),
                lastUsedAt,
                lastRole: getLastMessageRole(sourceSession),
                messageUpdatedAt: getSessionMessageUpdatedAt(sourceSession),
            };
            if (!shouldEmitRecentReadDebugLog(recentReadDebugSignatureBySession, recentReadSnapshot)) continue;
            LOG.info(
                'RecentRead',
                `snapshot session id=${recentReadSnapshot.sessionId} provider=${recentReadSnapshot.providerType} status=${recentReadSnapshot.status} bucket=${recentReadSnapshot.inboxBucket} unread=${String(recentReadSnapshot.unread)} lastSeenAt=${recentReadSnapshot.lastSeenAt} completionMarker=${recentReadSnapshot.completionMarker} seenMarker=${recentReadSnapshot.seenCompletionMarker} lastUpdated=${String(recentReadSnapshot.lastUpdated)} lastUsedAt=${recentReadSnapshot.lastUsedAt} lastRole=${recentReadSnapshot.lastRole} msgUpdatedAt=${recentReadSnapshot.messageUpdatedAt}`,
            );
        }
        const lastDisplayMessage = getLastDisplayMessage(sourceSession);
        if (lastDisplayMessage) {
            session.lastMessagePreview = lastDisplayMessage.preview;
            session.lastMessageRole = lastDisplayMessage.role;
            if (lastDisplayMessage.receivedAt > 0) session.lastMessageAt = lastDisplayMessage.receivedAt;
            session.lastMessageHash = lastDisplayMessage.hash;
        }
    }
    const includeMachineMetadata = profile !== 'live';
    const terminalBackend = includeMachineMetadata
        ? getTerminalBackendRuntimeStatus()
        : undefined;

    return {
        instanceId: options.instanceId,
        ...(includeMachineMetadata ? { version: options.version } : {}),
        machine: buildMachineInfo(profile),
        ...(includeMachineMetadata ? { machineNickname: options.machineNickname ?? cfg.machineNickname ?? null } : {}),
        timestamp: options.timestamp ?? Date.now(),
        ...(options.p2p ? { p2p: options.p2p } : {}),
        sessions,
        ...(terminalBackend ? { terminalBackend } : {}),
        ...(includeMachineMetadata && {
            detectedIdes: buildDetectedIdeInfos(options.detectedIdes, options.cdpManagers),
            workspaces: wsState.workspaces,
            defaultWorkspaceId: wsState.defaultWorkspaceId,
            defaultWorkspacePath: wsState.defaultWorkspacePath,
            terminalSizingMode: cfg.terminalSizingMode || 'measured',
            recentLaunches: buildRecentLaunches(recentActivity),
            availableProviders: buildAvailableProviders(options.providerLoader),
        }),
    };
}
