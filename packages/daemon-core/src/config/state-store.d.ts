/**
 * ADHDev State Store — Runtime state persistence
 *
 * Separates volatile runtime state (sessions, activity, read markers)
 * from static configuration (config.json).
 *
 * State is stored in ~/.adhdev/state.json
 */
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
/**
 * Load runtime state from disk
 */
export declare function loadState(): DaemonState;
/**
 * Save runtime state to disk
 */
export declare function saveState(state: DaemonState): void;
/**
 * Reset runtime state
 */
export declare function resetState(): void;
