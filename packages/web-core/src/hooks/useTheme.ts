/**
 * useTheme — Shared theme hook for dark/light/system mode.
 *
 * Reads from localStorage('theme') — 'dark' | 'light' | 'system'.
 * Default is dark so the first-run product surface matches the landing palette.
 * Sets data-theme attribute on <html> and persists choice.
 */
import { useState, useEffect, useCallback } from 'react'

export type ThemePreference = 'dark' | 'light' | 'system'
export type Theme = 'dark' | 'light'

function getSystemTheme(): Theme {
    if (typeof window === 'undefined') return 'dark'
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function getStoredPreference(): ThemePreference {
    try {
        const v = localStorage.getItem('theme')
        if (v === 'dark' || v === 'light' || v === 'system') return v
    } catch { /* noop */ }
    return 'system'
}

function resolveTheme(pref: ThemePreference): Theme {
    return pref === 'system' ? getSystemTheme() : pref
}

/** Call on app init to restore persisted general theme */
export function initTheme() {
    if (typeof document === 'undefined') return
    document.documentElement.setAttribute('data-theme', resolveTheme(getStoredPreference()))
}

export function useTheme() {
    const [preference, setPreferenceState] = useState<ThemePreference>(getStoredPreference)
    const [theme, setThemeState] = useState<Theme>(() => resolveTheme(getStoredPreference()))

    // Apply theme to DOM
    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme)
    }, [theme])

    // Listen for system theme changes when preference is 'system'
    useEffect(() => {
        const mql = window.matchMedia('(prefers-color-scheme: light)')
        const handler = (e: MediaQueryListEvent) => {
            if (preference === 'system') {
                setThemeState(e.matches ? 'light' : 'dark')
            }
        }
        mql.addEventListener('change', handler)
        return () => mql.removeEventListener('change', handler)
    }, [preference])

    const setPreference = useCallback((p: ThemePreference) => {
        setPreferenceState(p)
        setThemeState(resolveTheme(p))
        try { localStorage.setItem('theme', p) } catch { /* noop */ }
    }, [])

    // Cycle: dark → light → system → dark
    const cycleTheme = useCallback(() => {
        setPreferenceState(prev => {
            const next: ThemePreference = prev === 'dark' ? 'light' : prev === 'light' ? 'system' : 'dark'
            setThemeState(resolveTheme(next))
            try { localStorage.setItem('theme', next) } catch { /* noop */ }
            return next
        })
    }, [])

    return { theme, preference, setPreference, cycleTheme, isDark: theme === 'dark' }
}
