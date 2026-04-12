import { useCallback, useEffect, useState } from 'react'

export const TAB_SHORTCUTS_KEY = 'adhdev-tab-shortcuts'

export function readTabShortcuts() {
    try {
        return JSON.parse(localStorage.getItem(TAB_SHORTCUTS_KEY) || '{}') as Record<string, string>
    } catch {
        return {}
    }
}

interface UseTabShortcutsOptions {
    enabled?: boolean
    sortedTabKeys: string[]
    onFocus: () => void
    onSelectTab: (tabKey: string) => void
}

export function useTabShortcuts({ enabled = true, sortedTabKeys, onFocus, onSelectTab }: UseTabShortcutsOptions) {
    const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)
    const [tabShortcuts, setTabShortcuts] = useState<Record<string, string>>(() => readTabShortcuts())
    const [shortcutListening, setShortcutListening] = useState<string | null>(null)

    const encodeShortcut = useCallback((e: KeyboardEvent): string | null => {
        const parts: string[] = []
        if (e.metaKey) parts.push(isMac ? '⌘' : 'Meta')
        if (e.ctrlKey) parts.push('Ctrl')
        if (e.altKey) parts.push(isMac ? '⌥' : 'Alt')
        if (e.shiftKey) parts.push(isMac ? '⇧' : 'Shift')
        if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null
        parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key)
        return parts.join('+')
    }, [isMac])

    const saveShortcuts = useCallback((next: Record<string, string>) => {
        setTabShortcuts(next)
        try {
            localStorage.setItem(TAB_SHORTCUTS_KEY, JSON.stringify(next))
        } catch { /* noop */ }
    }, [])

    useEffect(() => {
        if (!enabled) return
        if (!shortcutListening) return

        const handler = (e: KeyboardEvent) => {
            e.preventDefault()
            e.stopPropagation()
            if (e.key === 'Escape') {
                setShortcutListening(null)
                return
            }

            const combo = encodeShortcut(e)
            if (!combo) return

            const next = { ...tabShortcuts }
            for (const [key, value] of Object.entries(next)) {
                if (value === combo) delete next[key]
            }
            next[shortcutListening] = combo
            saveShortcuts(next)
            setShortcutListening(null)
        }

        window.addEventListener('keydown', handler, true)
        return () => window.removeEventListener('keydown', handler, true)
    }, [enabled, shortcutListening, tabShortcuts, saveShortcuts, encodeShortcut])

    useEffect(() => {
        if (!enabled) return
        const handler = (e: KeyboardEvent) => {
            if (!e.ctrlKey && !e.metaKey && !e.altKey) return

            for (const [tabKey, shortcut] of Object.entries(tabShortcuts)) {
                if (sortedTabKeys.includes(tabKey) && encodeShortcut(e) === shortcut) {
                    e.preventDefault()
                    onFocus()
                    onSelectTab(tabKey)
                    return
                }
            }
        }

        window.addEventListener('keydown', handler)
        return () => window.removeEventListener('keydown', handler)
    }, [enabled, tabShortcuts, sortedTabKeys, onFocus, onSelectTab, encodeShortcut])

    return {
        isMac,
        tabShortcuts,
        shortcutListening,
        setShortcutListening,
        saveShortcuts,
    }
}
