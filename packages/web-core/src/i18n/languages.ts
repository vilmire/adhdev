/**
 * Supported languages for the ADHDev app UI.
 *
 * `en` is the source of truth (all keys defined). Other catalogs may leave keys
 * empty — i18next falls back to `en` via fallbackLng. Native labels are shown in
 * the language switcher so each option is legible to its own speakers.
 */

export const SUPPORTED_LANGUAGES = ['en', 'ko', 'ja', 'zh-CN', 'es'] as const

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

export const DEFAULT_LANGUAGE: SupportedLanguage = 'en'

export interface LanguageOption {
    code: SupportedLanguage
    /** Native-language display label for the switcher. */
    label: string
}

export const LANGUAGE_OPTIONS: LanguageOption[] = [
    { code: 'en', label: 'English' },
    { code: 'ko', label: '한국어' },
    { code: 'ja', label: '日本語' },
    { code: 'zh-CN', label: '中文(简体)' },
    { code: 'es', label: 'Español' },
]

export function isSupportedLanguage(value: unknown): value is SupportedLanguage {
    return typeof value === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(value)
}

/**
 * Map an arbitrary BCP-47 tag (e.g. from navigator.language) onto one of the
 * supported languages. Chinese variants collapse to zh-CN; anything unmatched
 * returns the default (en).
 */
export function normalizeLanguage(raw: string | null | undefined): SupportedLanguage {
    if (!raw) return DEFAULT_LANGUAGE
    const tag = raw.trim().toLowerCase()
    if (!tag) return DEFAULT_LANGUAGE

    // Any Chinese variant → zh-CN (we ship a single simplified catalog for v1).
    if (tag === 'zh' || tag.startsWith('zh-') || tag.startsWith('zh_')) return 'zh-CN'

    const primary = tag.split(/[-_]/)[0]
    if (primary === 'en') return 'en'
    if (primary === 'ko') return 'ko'
    if (primary === 'ja') return 'ja'
    if (primary === 'es') return 'es'

    return DEFAULT_LANGUAGE
}
