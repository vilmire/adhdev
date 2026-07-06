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
    /** Current notification dismissal ids keyed by stable session target */
    sessionNotificationDismissals: Record<string, string>;
    /** Current notification unread override ids keyed by stable session target */
    sessionNotificationUnreadOverrides: Record<string, string>;
    /**
     * Resolved provider-native conversation id for a live session, keyed by the
     * ADHDev/mesh session id. Persisted so it survives a daemon restart: a
     * provider whose on-disk store is keyed by an internally-generated id it
     * never exposes on the CLI (antigravity — no --session-id) can then exact-bind
     * its conversation .db after restart instead of re-running the mtime/recency
     * heuristic, which drops the store once idle and collapses read_chat to the
     * PTY parse (user echo only, assistant tail lost). Mirrors the in-memory read
     * pin (chat-commands-read lastBoundProviderSessionIdByMeshSession).
     */
    sessionProviderSessionPins: Record<string, string>;
}

const DEFAULT_STATE: DaemonState = {
    recentActivity: [],
    savedProviderSessions: [],
    sessionReads: {},
    sessionReadMarkers: {},
    sessionNotificationDismissals: {},
    sessionNotificationUnreadOverrides: {},
    sessionProviderSessionPins: {},
};

function isPlainObject(value: unknown): value is Record<string, any> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getStatePath(): string {
    return join(getConfigDir(), 'state.json');
}

function normalizeState(raw: unknown): DaemonState {
    const parsed = isPlainObject(raw) ? raw : {};

    const recentActivity = (Array.isArray(parsed.recentActivity) ? parsed.recentActivity : [])
        .filter((entry): entry is RecentActivityEntry => {
            if (!isPlainObject(entry)) return false;
            if (typeof entry.providerSessionId === 'string' && !entry.providerSessionId.trim()) return false;
            return true;
        });

    const savedProviderSessions = (Array.isArray(parsed.savedProviderSessions) ? parsed.savedProviderSessions : [])
        .filter((entry): entry is SavedProviderSessionEntry => {
            if (!isPlainObject(entry)) return false;
            return typeof entry.providerSessionId === 'string' && !!entry.providerSessionId.trim();
        });

    const sessionReads = Object.fromEntries(
        Object.entries(isPlainObject(parsed.sessionReads) ? parsed.sessionReads : {})
            .filter(([, value]) => typeof value === 'number' && Number.isFinite(value as number))
    );
    const sessionReadMarkers = Object.fromEntries(
        Object.entries(isPlainObject(parsed.sessionReadMarkers) ? parsed.sessionReadMarkers : {})
            .filter(([, value]) => typeof value === 'string')
    );
    const sessionNotificationDismissals = Object.fromEntries(
        Object.entries(isPlainObject(parsed.sessionNotificationDismissals) ? parsed.sessionNotificationDismissals : {})
            .filter(([, value]) => typeof value === 'string' && value.length > 0)
    );
    const sessionNotificationUnreadOverrides = Object.fromEntries(
        Object.entries(isPlainObject(parsed.sessionNotificationUnreadOverrides) ? parsed.sessionNotificationUnreadOverrides : {})
            .filter(([, value]) => typeof value === 'string' && value.length > 0)
    );
    const sessionProviderSessionPins = Object.fromEntries(
        Object.entries(isPlainObject(parsed.sessionProviderSessionPins) ? parsed.sessionProviderSessionPins : {})
            .filter(([key, value]) => typeof key === 'string' && key.length > 0 && typeof value === 'string' && value.length > 0)
    );

    return {
        recentActivity,
        savedProviderSessions,
        sessionReads,
        sessionReadMarkers,
        sessionNotificationDismissals,
        sessionNotificationUnreadOverrides,
        sessionProviderSessionPins,
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

/**
 * Load the full persisted session→provider-conversation pin map (sessionId →
 * provider-native conversation id). Survives daemon restart. Empty object when
 * none recorded or the state file is unreadable.
 */
export function loadPersistedProviderSessionPins(): Record<string, string> {
    return { ...loadState().sessionProviderSessionPins };
}

/**
 * Persist one session→provider-conversation pin. Load-mutate-save against the
 * on-disk state so it survives a daemon restart; a no-op when the value already
 * matches (avoids rewriting state.json on every read). Never clears a pin with an
 * empty value.
 */
export function recordPersistedProviderSessionPin(sessionId: string, providerSessionId: string): void {
    const key = typeof sessionId === 'string' ? sessionId.trim() : '';
    const value = typeof providerSessionId === 'string' ? providerSessionId.trim() : '';
    if (!key || !value) return;
    const state = loadState();
    if (state.sessionProviderSessionPins[key] === value) return;
    saveState({
        ...state,
        sessionProviderSessionPins: { ...state.sessionProviderSessionPins, [key]: value },
    });
}

/**
 * Test-only: drop all persisted session→provider-conversation pins from disk.
 * Used by tests that assert a clean "no pin" state so a sibling test's write to
 * the shared per-process ADHDEV_CONFIG_DIR does not leak in.
 */
export function clearPersistedProviderSessionPins(): void {
    const state = loadState();
    if (Object.keys(state.sessionProviderSessionPins).length === 0) return;
    saveState({ ...state, sessionProviderSessionPins: {} });
}
