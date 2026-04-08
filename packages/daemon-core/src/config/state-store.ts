/**
 * ADHDev State Store — Runtime state persistence
 *
 * Separates volatile runtime state (sessions, activity, read markers)
 * from static configuration (config.json).
 *
 * State is stored in ~/.adhdev/state.json
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getConfigDir } from './config.js';
import type { RecentActivityEntry } from './recent-activity.js';
import type { SavedProviderSessionEntry } from './saved-sessions.js';

export interface DaemonState {
    /** Unified recent activity across IDE / CLI / ACP launch flows */
    recentActivity: RecentActivityEntry[];
    /** Persistent resume-capable provider sessions keyed by providerSessionId */
    savedProviderSessions: SavedProviderSessionEntry[];
    /** Last seen timestamps for live sessions, keyed by sessionId */
    sessionReads: Record<string, number>;
    /** Last seen completion marker for live sessions, keyed by sessionId */
    sessionReadMarkers: Record<string, string>;
}

const DEFAULT_STATE: DaemonState = {
    recentActivity: [],
    savedProviderSessions: [],
    sessionReads: {},
    sessionReadMarkers: {},
};

function isPlainObject(value: unknown): value is Record<string, any> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getStatePath(): string {
    return join(getConfigDir(), 'state.json');
}

function normalizeState(raw: unknown): DaemonState {
    const parsed = isPlainObject(raw) ? raw : {};

    const sessionReads = Object.fromEntries(
        Object.entries(isPlainObject(parsed.sessionReads) ? parsed.sessionReads : {})
            .filter(([, value]) => typeof value === 'number' && Number.isFinite(value as number))
    );
    const sessionReadMarkers = Object.fromEntries(
        Object.entries(isPlainObject(parsed.sessionReadMarkers) ? parsed.sessionReadMarkers : {})
            .filter(([, value]) => typeof value === 'string')
    );

    return {
        recentActivity: Array.isArray(parsed.recentActivity) ? parsed.recentActivity as RecentActivityEntry[] : [],
        savedProviderSessions: Array.isArray(parsed.savedProviderSessions) ? parsed.savedProviderSessions as SavedProviderSessionEntry[] : [],
        sessionReads,
        sessionReadMarkers,
    };
}

/**
 * Load runtime state from disk
 */
export function loadState(): DaemonState {
    const statePath = getStatePath();

    if (!existsSync(statePath)) {
        return { ...DEFAULT_STATE };
    }

    try {
        const raw = readFileSync(statePath, 'utf-8');
        return normalizeState(JSON.parse(raw));
    } catch {
        return { ...DEFAULT_STATE };
    }
}

/**
 * Save runtime state to disk
 */
export function saveState(state: DaemonState): void {
    const statePath = getStatePath();
    const normalized = normalizeState(state);
    writeFileSync(statePath, JSON.stringify(normalized, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

/**
 * Reset runtime state
 */
export function resetState(): void {
    saveState({ ...DEFAULT_STATE });
}
