/**
 * useLanguage — Shared language hook, mirroring useTheme.
 *
 * Reads/persists localStorage('lang'), drives i18next.changeLanguage, updates
 * <html lang>, and broadcasts an `adhdev:langchange` CustomEvent so every hook
 * instance (and other tabs, via the `storage` event) stays in sync.
 */
import { useCallback, useEffect, useState } from 'react'

import {
    LANG_STORAGE_KEY,
    applyDocumentLanguage,
    i18next,
    resolveInitialLanguage,
} from './config'
import { isSupportedLanguage, type SupportedLanguage } from './languages'

const LANG_EVENT = 'adhdev:langchange'

function getCurrentLanguage(): SupportedLanguage {
    const active = i18next.language
    if (isSupportedLanguage(active)) return active
    return resolveInitialLanguage()
}

function emitLangChange(language: SupportedLanguage) {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent(LANG_EVENT, { detail: { language } }))
}

export function useLanguage() {
    const [language, setLanguageState] = useState<SupportedLanguage>(getCurrentLanguage)

    // Keep local state in sync with i18next, other hook instances, and other tabs.
    useEffect(() => {
        const handleI18nChange = (next: string) => {
            if (isSupportedLanguage(next)) setLanguageState(next)
        }
        const handleLangEvent = (event: Event) => {
            const detail = (event as CustomEvent<{ language?: string }>).detail || {}
            if (isSupportedLanguage(detail.language)) setLanguageState(detail.language)
        }
        const handleStorage = (event: StorageEvent) => {
            if (event.key !== LANG_STORAGE_KEY) return
            const next = event.newValue
            if (isSupportedLanguage(next) && next !== i18next.language) {
                void i18next.changeLanguage(next)
                applyDocumentLanguage(next)
            }
        }

        i18next.on('languageChanged', handleI18nChange)
        window.addEventListener(LANG_EVENT, handleLangEvent as EventListener)
        window.addEventListener('storage', handleStorage)
        return () => {
            i18next.off('languageChanged', handleI18nChange)
            window.removeEventListener(LANG_EVENT, handleLangEvent as EventListener)
            window.removeEventListener('storage', handleStorage)
        }
    }, [])

    const setLanguage = useCallback((next: SupportedLanguage) => {
        if (!isSupportedLanguage(next)) return
        setLanguageState(next)
        try {
            localStorage.setItem(LANG_STORAGE_KEY, next)
        } catch {
            /* noop */
        }
        void i18next.changeLanguage(next)
        applyDocumentLanguage(next)
        emitLangChange(next)
    }, [])

    return { language, setLanguage }
}
