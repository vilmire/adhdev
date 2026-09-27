// The one relative / absolute time formatter set (utils/time.ts). Replaces the
// ad-hoc "5m ago" formatters and hardcoded 'en-US' dates across the dashboard.
import { describe, expect, it } from 'vitest'
import {
    formatAbsoluteTime,
    formatClockTime,
    formatDateLocalized,
    formatElapsedCompact,
    formatRelativeTimeLocalized,
    toEpochMs,
} from '../../src/utils/time'

const NOW = Date.UTC(2026, 8, 27, 12, 0, 0)

describe('formatRelativeTimeLocalized', () => {
    it('is short and follows the given locale', () => {
        expect(formatRelativeTimeLocalized(NOW - 10_000, { now: NOW, locale: 'en' })).toBe('now')
        expect(formatRelativeTimeLocalized(NOW - 5 * 60_000, { now: NOW, locale: 'en' })).toBe('5 min. ago')
        expect(formatRelativeTimeLocalized(NOW - 3 * 3600_000, { now: NOW, locale: 'en' })).toBe('3 hr. ago')
        expect(formatRelativeTimeLocalized(NOW - 86400_000, { now: NOW, locale: 'en' })).toBe('yesterday')
        expect(formatRelativeTimeLocalized(NOW - 5 * 60_000, { now: NOW, locale: 'ko' })).toBe('5분 전')
        expect(formatRelativeTimeLocalized(NOW - 5 * 60_000, { now: NOW, locale: 'ja' })).toBe('5 分前')
    })

    it('falls back to a localized date past a week, and accepts ISO strings', () => {
        const iso = new Date(NOW - 30 * 86400_000).toISOString()
        expect(formatRelativeTimeLocalized(iso, { now: NOW, locale: 'en' })).toBe(formatDateLocalized(iso, { locale: 'en' }))
    })

    it('handles future times (clock skew) as "in …"', () => {
        expect(formatRelativeTimeLocalized(NOW + 5 * 60_000, { now: NOW, locale: 'en' })).toBe('in 5 min.')
    })

    it('returns empty for missing / invalid input', () => {
        expect(formatRelativeTimeLocalized(undefined)).toBe('')
        expect(formatRelativeTimeLocalized('not a date')).toBe('')
        expect(toEpochMs(0)).toBeNull()
    })
})

describe('absolute formatters', () => {
    it('use the UI locale instead of a hardcoded en-US', () => {
        const en = formatAbsoluteTime(NOW, { locale: 'en-US' })
        const ko = formatAbsoluteTime(NOW, { locale: 'ko' })
        expect(en).toMatch(/2026/)
        expect(ko).toMatch(/2026/)
        expect(ko).not.toBe(en)
        expect(formatDateLocalized(NOW, { locale: 'es' })).toMatch(/2026/)
        expect(formatClockTime(NOW, { locale: 'en-US' })).toMatch(/\d{1,2}:\d{2}/)
    })
})

describe('formatElapsedCompact', () => {
    it('keeps the compact runtime shape', () => {
        expect(formatElapsedCompact(45_000)).toBe('45s')
        expect(formatElapsedCompact(12 * 60_000)).toBe('12m')
        expect(formatElapsedCompact((3 * 60 + 5) * 60_000)).toBe('3h 5m')
        expect(formatElapsedCompact((50 * 60) * 60_000)).toBe('2d 2h')
        expect(formatElapsedCompact(undefined)).toBe('')
    })
})
