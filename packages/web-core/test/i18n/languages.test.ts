import { describe, expect, it } from 'vitest'
import {
    DEFAULT_LANGUAGE,
    LANGUAGE_OPTIONS,
    SUPPORTED_LANGUAGES,
    isSupportedLanguage,
    normalizeLanguage,
} from '../../src/i18n/languages'

describe('i18n languages', () => {
    it('ships exactly the five supported languages with native labels', () => {
        expect([...SUPPORTED_LANGUAGES]).toEqual(['en', 'ko', 'ja', 'zh-CN', 'es'])
        expect(LANGUAGE_OPTIONS.map((o) => o.code)).toEqual([...SUPPORTED_LANGUAGES])
        expect(LANGUAGE_OPTIONS.every((o) => o.label.length > 0)).toBe(true)
        expect(DEFAULT_LANGUAGE).toBe('en')
    })

    it('recognizes supported language codes only', () => {
        expect(isSupportedLanguage('ko')).toBe(true)
        expect(isSupportedLanguage('zh-CN')).toBe(true)
        expect(isSupportedLanguage('fr')).toBe(false)
        expect(isSupportedLanguage('zh')).toBe(false)
        expect(isSupportedLanguage(null)).toBe(false)
        expect(isSupportedLanguage(42)).toBe(false)
    })

    it('normalizes exact and regional tags to a supported language', () => {
        expect(normalizeLanguage('en')).toBe('en')
        expect(normalizeLanguage('en-US')).toBe('en')
        expect(normalizeLanguage('ko-KR')).toBe('ko')
        expect(normalizeLanguage('ja')).toBe('ja')
        expect(normalizeLanguage('es-419')).toBe('es')
    })

    it('collapses every Chinese variant to zh-CN', () => {
        expect(normalizeLanguage('zh')).toBe('zh-CN')
        expect(normalizeLanguage('zh-CN')).toBe('zh-CN')
        expect(normalizeLanguage('zh-Hans')).toBe('zh-CN')
        expect(normalizeLanguage('zh-TW')).toBe('zh-CN')
        expect(normalizeLanguage('zh_HK')).toBe('zh-CN')
    })

    it('falls back to the default language for unknown / empty input', () => {
        expect(normalizeLanguage('fr-FR')).toBe('en')
        expect(normalizeLanguage('')).toBe('en')
        expect(normalizeLanguage(null)).toBe('en')
        expect(normalizeLanguage(undefined)).toBe('en')
        expect(normalizeLanguage('   ')).toBe('en')
    })
})
