/**
 * Unified recent activity — machine-facing "pick up where you left off".
 *
 * Unlike cliHistory or workspaceActivity, this is task/session oriented:
 * - one normalized row shape for IDE / CLI / ACP
 * - deduped by kind + providerType + workspace
 * - optionally linked to a live sessionId when known
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
    sessionId?: string | null;
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

export function getRecentSessionSeenAt(config: ADHDevConfig, recentKey: string): number {
    return config.recentSessionReads?.[recentKey] || 0;
}

export function markRecentSessionSeen(
    config: ADHDevConfig,
    recentKey: string,
    seenAt = Date.now(),
): ADHDevConfig {
    const prev = config.recentSessionReads || {};
    const nextSeenAt = Math.max(prev[recentKey] || 0, seenAt);
    return {
        ...config,
        recentSessionReads: {
            ...prev,
            [recentKey]: nextSeenAt,
        },
    };
}
