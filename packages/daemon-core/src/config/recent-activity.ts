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
    for (const key of readKeys) {
        nextSessionReads[key] = Math.max(prev[key] || 0, seenAt);
        if (nextMarker) nextSessionReadMarkers[key] = nextMarker;
    }
    return {
        ...state,
        sessionReads: nextSessionReads,
        sessionReadMarkers: nextMarker ? nextSessionReadMarkers : prevMarkers,
    };
}
