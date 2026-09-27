/**
 * @adhdev/web-core i18n — shared catalog + boot + hooks.
 *
 * Consumers call initI18n() on app init (next to initTheme), use useLanguage()
 * to read/switch the active language, and drop <LanguageSelector /> into a header
 * or sidebar. The `common` catalog is owned here and shared by cloud + standalone.
 */
export {
    initI18n,
    whenI18nReady,
    isI18nReady,
    loadLocaleCatalog,
    i18next,
    getStoredLanguage,
    resolveInitialLanguage,
    applyDocumentLanguage,
    LANG_STORAGE_KEY,
    DEFAULT_NAMESPACE,
} from './config'
export { useLanguage } from './useLanguage'
export { I18nReadyGate } from './I18nReadyGate'
export type { I18nReadyGateProps } from './I18nReadyGate'
export {
    SUPPORTED_LANGUAGES,
    DEFAULT_LANGUAGE,
    LANGUAGE_OPTIONS,
    isSupportedLanguage,
    normalizeLanguage,
} from './languages'
export type { SupportedLanguage, LanguageOption } from './languages'
