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
const THEME_EVENT = 'adhdev:themechange'

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

function applyThemeToDom(theme: Theme) {
    if (typeof document === 'undefined') return
    document.documentElement.setAttribute('data-theme', theme)
    document.documentElement.style.colorScheme = theme
}

function emitThemeChange(preference: ThemePreference, theme: Theme) {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { preference, theme } }))
}

/** Call on app init to restore persisted general theme */
export function initTheme() {
    const preference = getStoredPreference()
    const theme = resolveTheme(preference)
    applyThemeToDom(theme)
    emitThemeChange(preference, theme)
}

export function useTheme() {
    const [preference, setPreferenceState] = useState<ThemePreference>(getStoredPreference)
    const [theme, setThemeState] = useState<Theme>(() => resolveTheme(getStoredPreference()))

    // Apply theme to DOM
    useEffect(() => {
        applyThemeToDom(theme)
    }, [theme])

    // Listen for system theme changes when preference is 'system'
    useEffect(() => {
        const mql = window.matchMedia('(prefers-color-scheme: light)')
        const handler = (e: MediaQueryListEvent) => {
            if (preference === 'system') {
                const nextTheme = e.matches ? 'light' : 'dark'
                setThemeState(nextTheme)
                emitThemeChange('system', nextTheme)
            }
        }
        mql.addEventListener('change', handler)
        return () => mql.removeEventListener('change', handler)
    }, [preference])

    // Keep all hook instances in sync within the same tab and across tabs.
    useEffect(() => {
        const handleThemeEvent = (event: Event) => {
            const detail = (event as CustomEvent<{ preference?: ThemePreference; theme?: Theme }>).detail || {}
            const nextPreference = detail.preference
            const nextTheme = detail.theme
            if (nextPreference === 'dark' || nextPreference === 'light' || nextPreference === 'system') {
                setPreferenceState(nextPreference)
            } else {
                setPreferenceState(getStoredPreference())
            }
            if (nextTheme === 'dark' || nextTheme === 'light') {
                setThemeState(nextTheme)
            } else {
                setThemeState(resolveTheme(getStoredPreference()))
            }
        }
        const handleStorage = (event: StorageEvent) => {
            if (event.key !== 'theme') return
            const nextPreference = getStoredPreference()
            const nextTheme = resolveTheme(nextPreference)
            setPreferenceState(nextPreference)
            setThemeState(nextTheme)
        }
        window.addEventListener(THEME_EVENT, handleThemeEvent as EventListener)
        window.addEventListener('storage', handleStorage)
        return () => {
            window.removeEventListener(THEME_EVENT, handleThemeEvent as EventListener)
            window.removeEventListener('storage', handleStorage)
        }
    }, [])

    const setPreference = useCallback((p: ThemePreference) => {
        const nextTheme = resolveTheme(p)
        setPreferenceState(p)
        setThemeState(nextTheme)
        try { localStorage.setItem('theme', p) } catch { /* noop */ }
        emitThemeChange(p, nextTheme)
    }, [])

    // Cycle: dark → light → system → dark
    const cycleTheme = useCallback(() => {
        setPreferenceState(prev => {
            const next: ThemePreference = prev === 'dark' ? 'light' : prev === 'light' ? 'system' : 'dark'
            const nextTheme = resolveTheme(next)
            setThemeState(nextTheme)
            try { localStorage.setItem('theme', next) } catch { /* noop */ }
            emitThemeChange(next, nextTheme)
            return next
        })
    }, [])

    return { theme, preference, setPreference, cycleTheme, isDark: theme === 'dark' }
}
