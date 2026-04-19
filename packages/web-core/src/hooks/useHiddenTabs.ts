/**
 * useHiddenTabs — Persist hidden conversation targets in localStorage.
 *
 * Policy:
 * - hidden/unhidden is a device-local dashboard preference, not shared product state
 * - storage uses stable conversation identity where possible
 *   (provider/session) instead of transient runtime tab ids
 * - runtime views check lookup keys against the stored hidden-key set so the
 *   same conversation stays hidden across session/tab churn on this device
 */
import { useState, useCallback } from 'react';
import type { ConversationTarget } from '../components/dashboard/conversation-identity'
import { buildConversationLookupKeys, buildConversationTargetKey } from '../components/dashboard/conversation-identity'

const STORAGE_KEY = 'adhdev_hiddenTabs';

function loadHidden(): Set<string> {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return new Set(JSON.parse(raw));
    } catch { /* noop */ }
    return new Set();
}

function saveHidden(set: Set<string>): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
    } catch { /* noop */ }
}

export function getHiddenConversationStorageKey(target: ConversationTarget): string {
    return buildConversationTargetKey(target)
}

export function isConversationHidden(hiddenTabs: Set<string>, target: ConversationTarget): boolean {
    return buildConversationLookupKeys(target).some((key) => hiddenTabs.has(key))
}

export function useHiddenTabs() {
    const [hiddenTabs, setHiddenTabs] = useState<Set<string>>(loadHidden);

    /** Toggle a single tab's visibility */
    const toggleTab = useCallback((targetKey: string) => {
        setHiddenTabs(prev => {
            const next = new Set(prev);
            if (next.has(targetKey)) next.delete(targetKey);
            else next.add(targetKey);
            saveHidden(next);
            return next;
        });
    }, []);

    /** Hide a tab */
    const hideTab = useCallback((targetKey: string) => {
        setHiddenTabs(prev => {
            if (prev.has(targetKey)) return prev;
            const next = new Set(prev);
            next.add(targetKey);
            saveHidden(next);
            return next;
        });
    }, []);

    /** Show a tab */
    const showTab = useCallback((targetKey: string) => {
        setHiddenTabs(prev => {
            if (!prev.has(targetKey)) return prev;
            const next = new Set(prev);
            next.delete(targetKey);
            saveHidden(next);
            return next;
        });
    }, []);

    /** Show all hidden tabs */
    const showAllTabs = useCallback(() => {
        setHiddenTabs(prev => {
            if (prev.size === 0) return prev;
            const next = new Set<string>();
            saveHidden(next);
            return next;
        });
    }, []);

    /** Hide all tabs belonging to a specific daemon */
    const hideAllForDaemon = useCallback((_daemonId: string, targetKeys: string[]) => {
        setHiddenTabs(prev => {
            const next = new Set(prev);
            for (const key of targetKeys) next.add(key);
            saveHidden(next);
            return next;
        });
    }, []);

    /** Show all tabs belonging to a specific daemon */
    const showAllForDaemon = useCallback((_daemonId: string, targetKeys: string[]) => {
        setHiddenTabs(prev => {
            const next = new Set(prev);
            for (const key of targetKeys) next.delete(key);
            saveHidden(next);
            return next;
        });
    }, []);

    const isHidden = useCallback((target: ConversationTarget) => isConversationHidden(hiddenTabs, target), [hiddenTabs]);

    return { hiddenTabs, toggleTab, hideTab, showTab, showAllTabs, hideAllForDaemon, showAllForDaemon, isHidden };
}
