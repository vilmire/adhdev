/**
 * Unified recent activity — launcher-facing "pick up where you launched".
 *
 * Unlike live session state, this is launch oriented:
 * - one normalized row shape for IDE / CLI / ACP
 * - deduped by kind + providerType + workspace
 * - used only for quick-launch shortcuts
 */

import * as path from 'path';
import type { ADHDevConfig } from './config.js';
import { expandPath } from './workspaces.js';

export interface RecentActivityEntry {
    id: string;
    kind: 'ide' | 'cli' | 'acp';
    providerType: string;
    providerName: string;
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

export function appendRecentActivity(
    config: ADHDevConfig,
    entry: Omit<RecentActivityEntry, 'id' | 'lastUsedAt'> & { lastUsedAt?: number },
): ADHDevConfig {
    const nextEntry: RecentActivityEntry = {
        ...entry,
        workspace: entry.workspace ? normalizeWorkspace(entry.workspace) : undefined,
        id: buildRecentActivityKey(entry),
        lastUsedAt: entry.lastUsedAt || Date.now(),
    };

    const filtered = (config.recentActivity || []).filter((item) => item.id !== nextEntry.id);
    return {
        ...config,
        recentActivity: [nextEntry, ...filtered].slice(0, MAX_ACTIVITY),
    };
}

export function getRecentActivity(config: ADHDevConfig, limit = 20): RecentActivityEntry[] {
    return [...(config.recentActivity || [])]
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
        .slice(0, limit);
}

export function getSessionSeenAt(config: ADHDevConfig, sessionId: string): number {
    return config.sessionReads?.[sessionId] || 0;
}

export function getSessionSeenMarker(config: ADHDevConfig, sessionId: string): string {
    return config.sessionReadMarkers?.[sessionId] || '';
}

export function markSessionSeen(
    config: ADHDevConfig,
    sessionId: string,
    seenAt = Date.now(),
    completionMarker?: string | null,
): ADHDevConfig {
    const prev = config.sessionReads || {};
    const nextSeenAt = Math.max(prev[sessionId] || 0, seenAt);
    const prevMarkers = config.sessionReadMarkers || {};
    const nextMarker = typeof completionMarker === 'string' ? completionMarker : '';
    return {
        ...config,
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
