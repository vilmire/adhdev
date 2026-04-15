/**
 * Unified recent activity — launcher-facing "pick up where you launched".
 *
 * Unlike live session state, this is launch oriented:
 * - one normalized row shape for IDE / CLI / ACP
 * - deduped by provider session when available, else by kind + providerType + workspace
 * - used only for quick-launch shortcuts
 */
import type { ProviderSummaryMetadata } from '../shared-types.js';
import type { DaemonState } from './state-store.js';
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
export declare function buildRecentActivityKey(entry: Pick<RecentActivityEntry, 'kind' | 'providerType' | 'workspace'>): string;
export declare function buildRecentActivityKeyForEntry(entry: Pick<RecentActivityEntry, 'kind' | 'providerType' | 'workspace' | 'providerSessionId'>): string;
export declare function appendRecentActivity(state: DaemonState, entry: Omit<RecentActivityEntry, 'id' | 'lastUsedAt'> & {
    lastUsedAt?: number;
}): DaemonState;
export declare function getRecentActivity(state: DaemonState, limit?: number): RecentActivityEntry[];
export declare function getSessionSeenAt(state: DaemonState, sessionId: string): number;
export declare function getSessionSeenMarker(state: DaemonState, sessionId: string): string;
export declare function markSessionSeen(state: DaemonState, sessionId: string, seenAt?: number, completionMarker?: string | null): DaemonState;
