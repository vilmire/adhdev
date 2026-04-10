import type { DaemonState } from './state-store.js';
export interface SavedProviderSessionEntry {
    id: string;
    kind: 'cli' | 'acp';
    providerType: string;
    providerName: string;
    providerSessionId: string;
    workspace?: string | null;
    currentModel?: string;
    title?: string;
    createdAt: number;
    lastUsedAt: number;
}
export declare function buildSavedProviderSessionKey(providerSessionId: string): string;
export declare function upsertSavedProviderSession(state: DaemonState, entry: Omit<SavedProviderSessionEntry, 'id' | 'createdAt' | 'lastUsedAt'> & {
    createdAt?: number;
    lastUsedAt?: number;
}): DaemonState;
export declare function getSavedProviderSessions(state: DaemonState, filters?: {
    providerType?: string;
    kind?: SavedProviderSessionEntry['kind'];
}): SavedProviderSessionEntry[];
