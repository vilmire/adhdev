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
 *
 * Loading: only `en` (the fallback) is bundled. The other catalogs are ~250-315 KB
 * of JSON each, so they are fetched on demand through a tiny i18next backend
 * (`lazyLocaleBackend`) — at boot for a non-`en` resolved language, and on every
 * `i18next.changeLanguage()` (useLanguage, the cross-tab `storage` sync, …).
 * i18next only flips `language` and emits `languageChanged` after the catalog has
 * arrived, so a switch never flashes English. For the boot case, hosts render
 * `<I18nReadyGate>` (or await `whenI18nReady()`) so the first paint is already in
 * the chosen language.
 */
import i18next, { type BackendModule, type InitOptions, type ReadCallback } from 'i18next'
import { initReactI18next } from 'react-i18next'

import {
    DEFAULT_LANGUAGE,
    SUPPORTED_LANGUAGES,
    isSupportedLanguage,
    normalizeLanguage,
    type SupportedLanguage,
} from './languages'

import enCommon from './locales/en/common.json'

export const LANG_STORAGE_KEY = 'lang'
export const DEFAULT_NAMESPACE = 'common'

type LocaleCatalog = Record<string, unknown>
type LazyLanguage = Exclude<SupportedLanguage, typeof DEFAULT_LANGUAGE>

/**
 * Dynamic-import loaders for every non-default catalog. Each becomes its own
 * chunk, fetched only when that language is actually used.
 */
const LOCALE_LOADERS: Record<LazyLanguage, () => Promise<{ default: LocaleCatalog }>> = {
    ko: () => import('./locales/ko/common.json'),
    ja: () => import('./locales/ja/common.json'),
    'zh-CN': () => import('./locales/zh-CN/common.json'),
    es: () => import('./locales/es/common.json'),
}

/**
 * Load the `common` catalog for `language`. Resolves `null` for the bundled
 * default and for anything unsupported (i18next then just uses the fallback).
 */
export async function loadLocaleCatalog(language: string): Promise<LocaleCatalog | null> {
    if (!isSupportedLanguage(language) || language === DEFAULT_LANGUAGE) return null
    const mod = await LOCALE_LOADERS[language]()
    return mod.default
}

/**
 * Minimal i18next backend over LOCALE_LOADERS. With `partialBundledLanguages`
 * i18next consults it only for bundles it does not already hold, so the
 * bundled `en` is never re-requested. A failed fetch is reported as an error
 * (i18next retries, then keeps rendering the `en` fallback).
 */
export const lazyLocaleBackend: BackendModule = {
    type: 'backend',
    init() {},
    read(language: string, namespace: string, callback: ReadCallback) {
        if (namespace !== DEFAULT_NAMESPACE) {
            callback(null, {})
            return
        }
        loadLocaleCatalog(language).then(
            (catalog) => callback(null, (catalog ?? {}) as Parameters<ReadCallback>[1]),
            (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), false),
        )
    },
}

/** The i18next init options shared by every host (exported for tests). */
export function createI18nInitOptions(lng: SupportedLanguage): InitOptions {
    return {
        resources: { [DEFAULT_LANGUAGE]: { [DEFAULT_NAMESPACE]: enCommon } },
        // Bundled `en` + backend-loaded everything else.
        partialBundledLanguages: true,
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
    }
}

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

let readyPromise: Promise<void> | null = null
let ready = false

/**
 * Call once on app init (next to initTheme). Idempotent — safe to call from
 * multiple entry points. Returns synchronously; when the resolved language is
 * not `en` its catalog is still in flight — gate the first render on
 * `whenI18nReady()` / `<I18nReadyGate>`.
 */
export function initI18n() {
    if (readyPromise) return i18next

    const lng = resolveInitialLanguage()

    readyPromise = i18next
        .use(lazyLocaleBackend)
        .use(initReactI18next)
        .init(createI18nInitOptions(lng))
        .then(
            () => undefined,
            () => undefined,
        )
        .finally(() => {
            ready = true
        })

    applyDocumentLanguage(lng)

    return i18next
}

/** True once the boot language's catalog is loaded (or failed and fell back). */
export function isI18nReady(): boolean {
    if (ready) return true
    // `en` is bundled, so an `en` boot is ready synchronously — no gate flash.
    return !!readyPromise && i18next.isInitialized && i18next.hasLoadedNamespace(DEFAULT_NAMESPACE)
}

/** Resolves when the boot language's catalog is usable. Never rejects. */
export function whenI18nReady(): Promise<void> {
    if (!readyPromise) initI18n()
    return readyPromise!
}

export { i18next }
