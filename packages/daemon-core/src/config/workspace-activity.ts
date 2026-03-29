/**
 * Recent workspace activity — quick "pick up where you left off" (daemon-local).
 */

import * as path from 'path';
import type { ADHDevConfig } from './config.js';
import { expandPath } from './workspaces.js';

export interface WorkspaceActivityEntry {
    path: string;
    lastUsedAt: number;
    /** `active` legacy — same meaning as default */
    kind?: 'ide' | 'cli' | 'acp' | 'default' | 'active';
    /** IDE id or CLI/ACP provider type */
    agentType?: string;
}

const MAX_ACTIVITY = 30;

export function normWorkspacePath(p: string): string {
    try {
        return path.resolve(expandPath(p));
    } catch {
        return path.resolve(p);
    }
}

/**
 * Append or bump a path to the front of recent activity (returns new config object).
 */
export function appendWorkspaceActivity(
    config: ADHDevConfig,
    rawPath: string,
    meta?: { kind?: WorkspaceActivityEntry['kind']; agentType?: string },
): ADHDevConfig {
    const abs = normWorkspacePath(rawPath);
    if (!abs) return config;

    const prev = config.recentWorkspaceActivity || [];
    const filtered = prev.filter(e => normWorkspacePath(e.path) !== abs);
    const entry: WorkspaceActivityEntry = {
        path: abs,
        lastUsedAt: Date.now(),
        kind: meta?.kind,
        agentType: meta?.agentType,
    };
    const recentWorkspaceActivity = [entry, ...filtered].slice(0, MAX_ACTIVITY);
    return { ...config, recentWorkspaceActivity };
}

export function getWorkspaceActivity(config: ADHDevConfig, limit = 20): WorkspaceActivityEntry[] {
    const list = [...(config.recentWorkspaceActivity || [])];
    list.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    return list.slice(0, limit);
}

export function removeActivityForPath(config: ADHDevConfig, rawPath: string): ADHDevConfig {
    const n = normWorkspacePath(rawPath);
    return {
        ...config,
        recentWorkspaceActivity: (config.recentWorkspaceActivity || []).filter(
            e => normWorkspacePath(e.path) !== n,
        ),
    };
}
