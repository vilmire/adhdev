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
import type { GitCompactSummary } from '../git/git-types.js';
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
    getGitSummaryForWorkspace?: (workspace: string) => GitCompactSummary | null | undefined;
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

export function buildAvailableProviders(
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
        meshCoordinator?: AvailableProviderInfo['meshCoordinator'];
        _sourceTrust?: AvailableProviderInfo['trust'];
        _sourceLayer?: AvailableProviderInfo['sourceLayer'];
        _sourceName?: string | null;
        providerVersion?: string;
        binary?: string;
        status?: string;
        details?: string;
        links?: Record<string, string>;
        modelOptions?: string[];
        thinkingLevelOptions?: string[];
    }> = providerLoader.getAvailableProviderInfos?.() || providerLoader.getAll();
    // Trust helpers come from daemon-core; resolve them lazily so the
    // status snapshot path stays loadable in older bundles that don't
    // ship provider-trust yet.
    let describeTrust: (trust: AvailableProviderInfo['trust']) => string = () => '';
    let requiresConfirmation: (trust: AvailableProviderInfo['trust']) => boolean = () => false;
    try {
        const mod = require('../providers/provider-trust.js') as typeof import('../providers/provider-trust.js');
        describeTrust = mod.describeTrust as typeof describeTrust;
        requiresConfirmation = mod.requiresConfirmation as typeof requiresConfirmation;
    } catch { /* enrichment only */ }
    return providers.map((provider) => {
        const trust = (provider as any)._sourceTrust as AvailableProviderInfo['trust'] | undefined;
        const sourceLayer = (provider as any)._sourceLayer as AvailableProviderInfo['sourceLayer'] | undefined;
        const sourceName = (provider as any)._sourceName as string | null | undefined;
        return {
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
            ...(provider.meshCoordinator !== undefined ? { meshCoordinator: provider.meshCoordinator } : {}),
            ...(trust ? {
                trust,
                trustDescription: describeTrust(trust),
                requiresConfirmation: requiresConfirmation(trust),
            } : {}),
            ...(sourceLayer ? { sourceLayer } : {}),
            ...(sourceName ? { sourceName } : {}),
            ...(provider.providerVersion ? { providerVersion: provider.providerVersion } : {}),
            ...(Array.isArray(provider.modelOptions) && provider.modelOptions.length ? { modelOptions: provider.modelOptions } : {}),
            ...(Array.isArray(provider.thinkingLevelOptions) && provider.thinkingLevelOptions.length ? { thinkingLevelOptions: provider.thinkingLevelOptions } : {}),
            ...(provider.binary ? { binary: provider.binary } : {}),
            ...(provider.status ? { status: provider.status } : {}),
            ...(provider.details ? { details: provider.details } : {}),
            ...(provider.links ? { links: provider.links } : {}),
        };
    });
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

/**
 * Resolve the last user-visible (non-system) message for a session as a preview.
 *
 * Exported so the cloud coordinator can derive a preview for a LOCAL mesh-owned
 * worktree session directly from the real provider instance it hosts. A REMOTE
 * worker session has no local instance (its preview rides the completion event's
 * finalSummary — see resolveMeshSurfacedSessionPreview), but a LOCAL coordinator
 * IS the worker, so its hosted instance's transcript holds the assistant reply and
 * this is the source of truth for that case.
 */
export function getLastDisplayMessage(session: {
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
            kind?: string;
        }> | null
    } | null
}) {
    const messages = session.activeChat?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return '';
    // Walk backwards until we find an assistant message that's not a tool call,
    // or a user/human message (which ends the turn). System messages and tool
    // messages don't gate "task completion" — they can't be acknowledged
    // independently and rotate too aggressively for marker-based bell clearing.
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i];
        const role = typeof m?.role === 'string' ? m.role : '';
        const kind = typeof m?.kind === 'string' ? m.kind : '';
        if (role === 'user' || role === 'human') return '';
        if (role === 'system') continue;
        if (kind === 'tool') continue;
        if (typeof m._turnKey === 'string' && m._turnKey) return `turn:${m._turnKey}`;
        if (typeof m.id === 'string' && m.id) return `id:${m.id}`;
        if (typeof m.index === 'number' && Number.isFinite(m.index)) return `idx:${m.index}`;
        const timestamp = getMessageEventTime(m);
        return timestamp > 0 ? `ts:${timestamp}` : '';
    }
    return '';
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
    // Read-state resolution:
    // - When provider supplies a `completionMarker`, prefer marker-equality.
    //   But if `seenCompletionMarker` hasn't been recorded yet (legacy/transition
    //   case), fall back to timestamp comparison so a stale marker doesn't keep
    //   the bell lit after the user already viewed the conversation.
    // - When there is no completionMarker, use timestamp + role guard.
    // - Trailing `assistant.tool` turns no longer count as unread on their own
    //   — the human can't acknowledge a tool call separately from the answer,
    //   so they'd be stuck with a perpetually unread badge.
    const ignorableTrailingRoles = lastRole === 'user' || lastRole === 'human' || lastRole === 'system' || lastRole === 'tool';
    const unread = completionMarker
        ? (seenCompletionMarker
            ? completionMarker !== seenCompletionMarker
            : hasContentChange && lastUsedAt > lastSeenAt && !ignorableTrailingRoles)
        : hasContentChange && lastUsedAt > lastSeenAt && !ignorableTrailingRoles;
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
        {
            profile: 'full',
            getGitSummaryForWorkspace: options.getGitSummaryForWorkspace,
        },
    );
    const sessions = profile === 'full'
        ? unreadSourceSessions
        : profile === 'live'
            ? unreadSourceSessions.map(projectLiveSessionFromFull)
            : buildSessionEntries(
                options.allStates,
                options.cdpManagers,
                {
                    profile,
                    getGitSummaryForWorkspace: options.getGitSummaryForWorkspace,
                },
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
