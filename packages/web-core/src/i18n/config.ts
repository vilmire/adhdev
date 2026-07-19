/**
 * i18next configuration for the ADHDev app UI.
 *
 * Mirrors the useTheme boot pattern: the initial language is resolved from
 * localStorage('lang') first, then navigator.language (normalized to a supported
 * language), then falls back to `en`. `en` is the source of truth; other catalogs
 * may leave keys empty and fall back to `en` via fallbackLng.
 *
 * The catalog is owned here in web-core and shared by web-cloud and web-standalone.
 * Namespaces start with a single `common` ns; add more as strings are extracted.
 */
import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'

import {
    DEFAULT_LANGUAGE,
    SUPPORTED_LANGUAGES,
    isSupportedLanguage,
    normalizeLanguage,
    type SupportedLanguage,
} from './languages'

import enCommon from './locales/en/common.json'
import koCommon from './locales/ko/common.json'
import jaCommon from './locales/ja/common.json'
import zhCNCommon from './locales/zh-CN/common.json'
import esCommon from './locales/es/common.json'

export const LANG_STORAGE_KEY = 'lang'
export const DEFAULT_NAMESPACE = 'common'

const resources = {
    en: { common: enCommon },
    ko: { common: koCommon },
    ja: { common: jaCommon },
    'zh-CN': { common: zhCNCommon },
    es: { common: esCommon },
} as const

/** Read the persisted language choice, if any. */
export function getStoredLanguage(): SupportedLanguage | null {
    try {
        const v = localStorage.getItem(LANG_STORAGE_KEY)
        if (isSupportedLanguage(v)) return v
    } catch {
        /* noop */
    }
    return null
}

/**
 * Resolve the language to boot with: stored choice → normalized navigator
 * language → default (en).
 */
export function resolveInitialLanguage(): SupportedLanguage {
    const stored = getStoredLanguage()
    if (stored) return stored
    if (typeof navigator !== 'undefined') {
        return normalizeLanguage(navigator.language)
    }
    return DEFAULT_LANGUAGE
}

/** Reflect the active language onto <html lang="…"> for a11y / SEO. */
export function applyDocumentLanguage(lang: string) {
    if (typeof document === 'undefined') return
    document.documentElement.setAttribute('lang', lang)
}

let initialized = false

/**
 * Call once on app init (next to initTheme). Idempotent — safe to call from
 * multiple entry points.
 */
export function initI18n() {
    if (initialized) return i18next
    initialized = true

    const lng = resolveInitialLanguage()

    i18next.use(initReactI18next).init({
        resources,
        lng,
        fallbackLng: DEFAULT_LANGUAGE,
        supportedLngs: SUPPORTED_LANGUAGES as unknown as string[],
        ns: [DEFAULT_NAMESPACE],
        defaultNS: DEFAULT_NAMESPACE,
        interpolation: { escapeValue: false },
        // Empty catalog strings should fall back to `en`, not render "".
        returnEmptyString: false,
        react: {
            // <Trans> renders these HTML tags directly instead of leaking the
            // literal markup. react-i18next's default set is
            // ['br','strong','i','p']; we add 'em' so <em> emphasis in any
            // translated string (e.g. the landing hero subtitle) renders as
            // real emphasis without each call-site having to pass
            // `components={{ em: <em/> }}`.
            transKeepBasicHtmlNodesFor: ['br', 'strong', 'i', 'p', 'em'],
        },
    })

    applyDocumentLanguage(lng)

    return i18next
}

export { i18next }
