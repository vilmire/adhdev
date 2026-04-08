/**
 * Unified recent activity — launcher-facing "pick up where you launched".
 *
 * Unlike live session state, this is launch oriented:
 * - one normalized row shape for IDE / CLI / ACP
 * - deduped by provider session when available, else by kind + providerType + workspace
 * - used only for quick-launch shortcuts
 */

import * as path from 'path';
import type { DaemonState } from './state-store.js';
import { expandPath } from './workspaces.js';

export interface RecentActivityEntry {
    id: string;
    kind: 'ide' | 'cli' | 'acp';
    providerType: string;
    providerName: string;
    providerSessionId?: string;
    workspace?: string | null;
    currentModel?: string;
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
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
        .slice(0, limit);
}

export function getSessionSeenAt(state: DaemonState, sessionId: string): number {
    return state.sessionReads?.[sessionId] || 0;
}

export function getSessionSeenMarker(state: DaemonState, sessionId: string): string {
    return state.sessionReadMarkers?.[sessionId] || '';
}

export function markSessionSeen(
    state: DaemonState,
    sessionId: string,
    seenAt = Date.now(),
    completionMarker?: string | null,
): DaemonState {
    const prev = state.sessionReads || {};
    const nextSeenAt = Math.max(prev[sessionId] || 0, seenAt);
    const prevMarkers = state.sessionReadMarkers || {};
    const nextMarker = typeof completionMarker === 'string' ? completionMarker : '';
    return {
        ...state,
        sessionReads: {
            ...prev,
            [sessionId]: nextSeenAt,
        },
        sessionReadMarkers: nextMarker
            ? {
                ...prevMarkers,
                [sessionId]: nextMarker,
            }
            : prevMarkers,
    };
}
