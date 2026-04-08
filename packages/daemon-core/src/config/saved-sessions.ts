import * as path from 'path';
import type { DaemonState } from './state-store.js';
import { expandPath } from './workspaces.js';

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

const MAX_SAVED_SESSIONS = 500;

function normalizeWorkspace(workspace?: string | null) {
    if (!workspace) return '';
    try {
        return path.resolve(expandPath(workspace));
    } catch {
        return path.resolve(workspace);
    }
}

export function buildSavedProviderSessionKey(providerSessionId: string) {
    return `saved:${providerSessionId.trim()}`;
}

export function upsertSavedProviderSession(
    state: DaemonState,
    entry: Omit<SavedProviderSessionEntry, 'id' | 'createdAt' | 'lastUsedAt'> & { createdAt?: number; lastUsedAt?: number },
): DaemonState {
    const providerSessionId = typeof entry.providerSessionId === 'string' ? entry.providerSessionId.trim() : '';
    if (!providerSessionId) return state;

    const id = buildSavedProviderSessionKey(providerSessionId);
    const existing = (state.savedProviderSessions || []).find(item => item.id === id);
    const nextEntry: SavedProviderSessionEntry = {
        id,
        kind: entry.kind,
        providerType: entry.providerType,
        providerName: entry.providerName,
        providerSessionId,
        workspace: entry.workspace ? normalizeWorkspace(entry.workspace) : undefined,
        currentModel: entry.currentModel,
        title: entry.title,
        createdAt: existing?.createdAt || entry.createdAt || Date.now(),
        lastUsedAt: entry.lastUsedAt || Date.now(),
    };

    const filtered = (state.savedProviderSessions || []).filter(item => item.id !== id);
    return {
        ...state,
        savedProviderSessions: [nextEntry, ...filtered].slice(0, MAX_SAVED_SESSIONS),
    };
}

export function getSavedProviderSessions(
    state: DaemonState,
    filters?: { providerType?: string; kind?: SavedProviderSessionEntry['kind'] },
): SavedProviderSessionEntry[] {
    return [...(state.savedProviderSessions || [])]
        .filter(entry => {
            if (filters?.providerType && entry.providerType !== filters.providerType) return false;
            if (filters?.kind && entry.kind !== filters.kind) return false;
            return true;
        })
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}
