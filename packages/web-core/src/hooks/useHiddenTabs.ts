/**
 * useHiddenTabs — Persist hidden tab keys in localStorage.
 *
 * Allows users to hide specific IDE/CLI/ACP tabs from the dashboard
 * so they can focus on active work. Hidden tabs are stored as a Set
 * of tabKey strings in localStorage under 'adhdev_hiddenTabs'.
 */
import { useState, useCallback } from 'react';

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

export function useHiddenTabs() {
    const [hiddenTabs, setHiddenTabs] = useState<Set<string>>(loadHidden);

    /** Toggle a single tab's visibility */
    const toggleTab = useCallback((tabKey: string) => {
        setHiddenTabs(prev => {
            const next = new Set(prev);
            if (next.has(tabKey)) next.delete(tabKey);
            else next.add(tabKey);
            saveHidden(next);
            return next;
        });
    }, []);

    /** Hide a tab */
    const hideTab = useCallback((tabKey: string) => {
        setHiddenTabs(prev => {
            if (prev.has(tabKey)) return prev;
            const next = new Set(prev);
            next.add(tabKey);
            saveHidden(next);
            return next;
        });
    }, []);

    /** Show a tab */
    const showTab = useCallback((tabKey: string) => {
        setHiddenTabs(prev => {
            if (!prev.has(tabKey)) return prev;
            const next = new Set(prev);
            next.delete(tabKey);
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
    const hideAllForDaemon = useCallback((_daemonId: string, tabKeys: string[]) => {
        setHiddenTabs(prev => {
            const next = new Set(prev);
            for (const k of tabKeys) next.add(k);
            saveHidden(next);
            return next;
        });
    }, []);

    /** Show all tabs belonging to a specific daemon */
    const showAllForDaemon = useCallback((_daemonId: string, tabKeys: string[]) => {
        setHiddenTabs(prev => {
            const next = new Set(prev);
            for (const k of tabKeys) next.delete(k);
            saveHidden(next);
            return next;
        });
    }, []);

    const isHidden = useCallback((tabKey: string) => hiddenTabs.has(tabKey), [hiddenTabs]);

    return { hiddenTabs, toggleTab, hideTab, showTab, showAllTabs, hideAllForDaemon, showAllForDaemon, isHidden };
}
