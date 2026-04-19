/**
 * Unified recent activity — launcher-facing "pick up where you launched".
 *
 * Unlike live session state, this is launch oriented:
 * - one normalized row shape for IDE / CLI / ACP
 * - deduped by provider session when available, else by kind + providerType + workspace
 * - used only for quick-launch shortcuts
 */

import * as path from 'path';
import type { ProviderSummaryMetadata } from '../shared-types.js';
import type { RecentSessionBucket, SessionEntry } from '../shared-types.js';
import type { DaemonState } from './state-store.js';
import { expandPath } from './workspaces.js';
import { normalizePersistedSummaryMetadata } from '../providers/summary-metadata.js';

export interface RecentActivityEntry {
    id: string;
    kind: 'ide' | 'cli' | 'acp';
    providerType: string;
    providerName: string;
    providerSessionId?: string;
    workspace?: string | null;
    summaryMetadata?: ProviderSummaryMetadata;
    title?: string;
    lastUsedAt: number;
}

const MAX_ACTIVITY = 30;

function normalizeWorkspace(workspace?: string | null) {
    if (!workspace) return '';
    try {
        return path.resolve(expandPath(workspace));
    } catch {
        return path.resolve(workspace);
    }
}

export function buildRecentActivityKey(entry: Pick<RecentActivityEntry, 'kind' | 'providerType' | 'workspace'>) {
    return `${entry.kind}:${entry.providerType}:${normalizeWorkspace(entry.workspace)}`;
}

export function buildRecentActivityKeyForEntry(
    entry: Pick<RecentActivityEntry, 'kind' | 'providerType' | 'workspace' | 'providerSessionId'>,
) {
    const providerSessionId = typeof entry.providerSessionId === 'string' ? entry.providerSessionId.trim() : '';
    if (providerSessionId) {
        return `${entry.kind}:${entry.providerType}:session:${providerSessionId}`;
    }
    return buildRecentActivityKey(entry);
}

export function appendRecentActivity(
    state: DaemonState,
    entry: Omit<RecentActivityEntry, 'id' | 'lastUsedAt'> & { lastUsedAt?: number },
): DaemonState {
    const nextEntry: RecentActivityEntry = {
        ...entry,
        workspace: entry.workspace ? normalizeWorkspace(entry.workspace) : undefined,
        summaryMetadata: normalizePersistedSummaryMetadata({
            summaryMetadata: entry.summaryMetadata,
        }),
        id: buildRecentActivityKeyForEntry(entry),
        lastUsedAt: entry.lastUsedAt || Date.now(),
    };

    const filtered = (state.recentActivity || []).filter((item) => item.id !== nextEntry.id);
    return {
        ...state,
        recentActivity: [nextEntry, ...filtered].slice(0, MAX_ACTIVITY),
    };
}

export function getRecentActivity(state: DaemonState, limit = 20): RecentActivityEntry[] {
    return [...(state.recentActivity || [])]
        .map(entry => ({
            ...entry,
            summaryMetadata: normalizePersistedSummaryMetadata({
                summaryMetadata: entry.summaryMetadata,
            }),
        }))
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
        .slice(0, limit);
}

export function buildSessionReadStateKey(sessionId: string, providerSessionId?: string | null): string {
    const normalizedProviderSessionId = typeof providerSessionId === 'string' ? providerSessionId.trim() : '';
    if (normalizedProviderSessionId) return `provider:${normalizedProviderSessionId}`;
    return sessionId;
}

export function getSessionSeenAt(state: DaemonState, sessionId: string, providerSessionId?: string | null): number {
    const providerKey = buildSessionReadStateKey(sessionId, providerSessionId);
    return state.sessionReads?.[providerKey] || state.sessionReads?.[sessionId] || 0;
}

export function getSessionSeenMarker(state: DaemonState, sessionId: string, providerSessionId?: string | null): string {
    const providerKey = buildSessionReadStateKey(sessionId, providerSessionId);
    return state.sessionReadMarkers?.[providerKey] || state.sessionReadMarkers?.[sessionId] || '';
}

export function getSessionNotificationDismissal(state: DaemonState, sessionId: string, providerSessionId?: string | null): string {
    const providerKey = buildSessionReadStateKey(sessionId, providerSessionId);
    return state.sessionNotificationDismissals?.[providerKey] || state.sessionNotificationDismissals?.[sessionId] || '';
}

export function getSessionNotificationUnreadOverride(state: DaemonState, sessionId: string, providerSessionId?: string | null): string {
    const providerKey = buildSessionReadStateKey(sessionId, providerSessionId);
    return state.sessionNotificationUnreadOverrides?.[providerKey] || state.sessionNotificationUnreadOverrides?.[sessionId] || '';
}

export function dismissSessionNotification(
    state: DaemonState,
    sessionId: string,
    notificationId: string,
    providerSessionId?: string | null,
): DaemonState {
    const dismissalId = String(notificationId || '').trim();
    if (!dismissalId) return state;
    const dismissalKeys = Array.from(new Set([
        sessionId,
        buildSessionReadStateKey(sessionId, providerSessionId),
    ].filter(Boolean)));
    const nextSessionNotificationDismissals = { ...(state.sessionNotificationDismissals || {}) };
    const nextSessionNotificationUnreadOverrides = { ...(state.sessionNotificationUnreadOverrides || {}) };
    for (const key of dismissalKeys) {
        nextSessionNotificationDismissals[key] = dismissalId;
        delete nextSessionNotificationUnreadOverrides[key];
    }
    return {
        ...state,
        sessionNotificationDismissals: nextSessionNotificationDismissals,
        sessionNotificationUnreadOverrides: nextSessionNotificationUnreadOverrides,
    };
}

export function markSessionNotificationUnread(
    state: DaemonState,
    sessionId: string,
    notificationId: string,
    providerSessionId?: string | null,
): DaemonState {
    const unreadId = String(notificationId || '').trim();
    if (!unreadId) return state;
    const unreadKeys = Array.from(new Set([
        sessionId,
        buildSessionReadStateKey(sessionId, providerSessionId),
    ].filter(Boolean)));
    const nextSessionNotificationDismissals = { ...(state.sessionNotificationDismissals || {}) };
    const nextSessionNotificationUnreadOverrides = { ...(state.sessionNotificationUnreadOverrides || {}) };
    for (const key of unreadKeys) {
        nextSessionNotificationUnreadOverrides[key] = unreadId;
        delete nextSessionNotificationDismissals[key];
    }
    return {
        ...state,
        sessionNotificationDismissals: nextSessionNotificationDismissals,
        sessionNotificationUnreadOverrides: nextSessionNotificationUnreadOverrides,
    };
}

export function getSessionNotificationTargetValue(session: Pick<SessionEntry, 'id' | 'providerSessionId'>): string {
    const providerSessionId = typeof session.providerSessionId === 'string' ? session.providerSessionId.trim() : '';
    return providerSessionId || session.id;
}

export function getSessionCurrentNotificationId(session: Pick<SessionEntry, 'id' | 'providerSessionId' | 'inboxBucket' | 'unread' | 'lastMessageHash' | 'lastMessageAt' | 'lastUpdated' | 'status'>): string {
    const inboxBucket = session.inboxBucket || 'idle';
    const isNeedsAttention = inboxBucket === 'needs_attention' || session.status === 'waiting_approval';
    const isTaskComplete = inboxBucket === 'task_complete' && !!session.unread;
    const type = isNeedsAttention ? 'needs_attention' : isTaskComplete ? 'task_complete' : '';
    if (!type) return '';
    const target = getSessionNotificationTargetValue(session);
    const lastMessageHash = typeof session.lastMessageHash === 'string' ? session.lastMessageHash : '';
    const timestamp = Number(session.lastMessageAt || session.lastUpdated || 0);
    return [type, target, lastMessageHash, String(timestamp)].join('|');
}

export function applySessionNotificationOverlay(
    session: Pick<SessionEntry, 'id' | 'providerSessionId' | 'inboxBucket' | 'unread' | 'lastMessageHash' | 'lastMessageAt' | 'lastUpdated' | 'status'>,
    overlay: { dismissedNotificationId?: string | null; unreadNotificationId?: string | null },
): { unread: boolean; inboxBucket: RecentSessionBucket } {
    const currentNotificationId = getSessionCurrentNotificationId(session);
    const taskCompleteNotificationId = (() => {
        const target = getSessionNotificationTargetValue(session);
        const lastMessageHash = typeof session.lastMessageHash === 'string' ? session.lastMessageHash : '';
        const timestamp = Number(session.lastMessageAt || session.lastUpdated || 0);
        if (!target || !lastMessageHash || !timestamp) return '';
        return ['task_complete', target, lastMessageHash, String(timestamp)].join('|');
    })();
    const dismissedNotificationId = typeof overlay.dismissedNotificationId === 'string' ? overlay.dismissedNotificationId.trim() : '';
    const unreadNotificationId = typeof overlay.unreadNotificationId === 'string' ? overlay.unreadNotificationId.trim() : '';
    if (
        unreadNotificationId
        && (currentNotificationId === unreadNotificationId || taskCompleteNotificationId === unreadNotificationId)
    ) {
        const forcedInboxBucket = session.inboxBucket === 'needs_attention' || session.status === 'waiting_approval'
            ? 'needs_attention'
            : 'task_complete';
        return {
            unread: true,
            inboxBucket: forcedInboxBucket,
        };
    }
    if (!currentNotificationId || !dismissedNotificationId || currentNotificationId !== dismissedNotificationId) {
        return {
            unread: !!session.unread,
            inboxBucket: session.inboxBucket || 'idle',
        };
    }
    return {
        unread: false,
        inboxBucket: 'idle',
    };
}

export function markSessionSeen(
    state: DaemonState,
    sessionId: string,
    seenAt = Date.now(),
    completionMarker?: string | null,
    providerSessionId?: string | null,
): DaemonState {
    const prev = state.sessionReads || {};
    const prevMarkers = state.sessionReadMarkers || {};
    const nextMarker = typeof completionMarker === 'string' ? completionMarker : '';
    const readKeys = Array.from(new Set([
        sessionId,
        buildSessionReadStateKey(sessionId, providerSessionId),
    ].filter(Boolean)));
    const nextSessionReads = { ...prev };
    const nextSessionReadMarkers = { ...prevMarkers };
    const nextSessionNotificationDismissals = { ...(state.sessionNotificationDismissals || {}) };
    const nextSessionNotificationUnreadOverrides = { ...(state.sessionNotificationUnreadOverrides || {}) };
    for (const key of readKeys) {
        nextSessionReads[key] = Math.max(prev[key] || 0, seenAt);
        if (nextMarker) nextSessionReadMarkers[key] = nextMarker;
        delete nextSessionNotificationDismissals[key];
        delete nextSessionNotificationUnreadOverrides[key];
    }
    return {
        ...state,
        sessionReads: nextSessionReads,
        sessionReadMarkers: nextMarker ? nextSessionReadMarkers : prevMarkers,
        sessionNotificationDismissals: nextSessionNotificationDismissals,
        sessionNotificationUnreadOverrides: nextSessionNotificationUnreadOverrides,
    };
}
