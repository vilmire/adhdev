/**
 * time.ts — Shared relative time formatting utilities
 *
 * Consolidates `formatRelativeTime` (compact) and `formatRelativeAgo` (verbose)
 * into a single configurable function.
 */

import i18next from 'i18next'

export interface FormatRelativeTimeOptions {
    /** Append suffix (e.g., ' ago') to non-'now' values. Default: '' */
    suffix?: string
    /** Label for very recent times. Default: 'now' */
    nowLabel?: string
    /** Threshold in seconds below which nowLabel is returned. Default: 60 */
    nowThreshold?: number
}

/**
 * Format a timestamp as a relative time string.
 *
 * Default (compact, no suffix): 'now', '5m', '3h', '2d'
 * With suffix=' ago', nowLabel='just now': 'just now', '5m ago', '3h ago'
 */
export function formatRelativeTime(
    timestamp: number,
    options: FormatRelativeTimeOptions = {},
): string {
    if (!timestamp) return ''
    const { suffix = '', nowLabel = 'now', nowThreshold = 60 } = options
    const diffMs = Date.now() - timestamp
    const seconds = Math.floor(diffMs / 1000)
    if (seconds < nowThreshold) return nowLabel
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m${suffix}`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h${suffix}`
    const days = Math.floor(hours / 24)
    if (days < 7) return `${days}d${suffix}`
    return new Date(timestamp).toLocaleDateString()
}

/**
 * Compact relative time (mobile inbox style): 'now', '5m', '3h', '2d', date
 * Drop-in replacement for the previous `formatRelativeTime` in DashboardMobileChatShared.
 */
export const formatRelativeCompact = (timestamp: number) =>
    formatRelativeTime(timestamp)

/**
 * Verbose relative time (machine overview style): 'just now', '5m ago', '3h ago'
 * Drop-in replacement for the previous `formatRelativeAgo` in machine/types.ts.
 */
export const formatRelativeAgo = (timestamp: number) =>
    formatRelativeTime(timestamp, { suffix: ' ago', nowLabel: 'just now', nowThreshold: 45 })

// ─── Locale-aware formatting (the single implementation) ────────────────────
// Every user-visible timestamp goes through these so the language follows the
// dashboard's selected locale instead of a hardcoded 'en-US' or the browser
// default. Relative text is short ("5 min. ago"); the exact time belongs in a
// tooltip (see components/ui/RelativeTime.tsx).


export type TimeInput = number | string | Date | null | undefined

/** Parse a timestamp input into epoch ms; null when missing/invalid. */
export function toEpochMs(input: TimeInput): number | null {
    if (input === null || input === undefined || input === '') return null
    const ms = input instanceof Date ? input.getTime() : typeof input === 'number' ? input : Date.parse(input)
    return Number.isFinite(ms) && ms > 0 ? ms : null
}

/** The dashboard's active UI locale (i18next), falling back to the runtime default. */
export function resolveUiLocale(explicit?: string): string | undefined {
    if (explicit) return explicit
    const lang = i18next?.resolvedLanguage || i18next?.language
    return lang && lang !== 'cimode' ? lang : undefined
}

export interface LocalizedTimeOptions {
    locale?: string
    /** Reference "now" (tests). */
    now?: number
}

/**
 * Localized relative time: "now", "5 min. ago", "3 hr. ago", "yesterday",
 * then a localized date past 7 days. Future times read "in 5 min.".
 */
export function formatRelativeTimeLocalized(input: TimeInput, options: LocalizedTimeOptions = {}): string {
    const ms = toEpochMs(input)
    if (ms === null) return ''
    const locale = resolveUiLocale(options.locale)
    const now = options.now ?? Date.now()
    const diffSec = Math.round((ms - now) / 1000)
    const abs = Math.abs(diffSec)
    let rtf: Intl.RelativeTimeFormat
    try {
        rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' })
    } catch {
        rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' })
    }
    if (abs < 45) return rtf.format(0, 'second')
    if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute')
    if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour')
    if (abs < 7 * 86400) return rtf.format(Math.round(diffSec / 86400), 'day')
    return formatDateLocalized(ms, { locale })
}

function safeDateTimeFormat(locale: string | undefined, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
    try {
        return new Intl.DateTimeFormat(locale, opts)
    } catch {
        return new Intl.DateTimeFormat(undefined, opts)
    }
}

/** Exact localized date + time ("Sep 27, 2026, 10:41 AM" / "2026. 9. 27. 오전 10:41"). */
export function formatAbsoluteTime(input: TimeInput, options: { locale?: string; seconds?: boolean } = {}): string {
    const ms = toEpochMs(input)
    if (ms === null) return ''
    const fmt = safeDateTimeFormat(resolveUiLocale(options.locale), {
        dateStyle: 'medium',
        timeStyle: options.seconds ? 'medium' : 'short',
    })
    return fmt.format(ms)
}

/** Localized calendar date only ("Sep 27, 2026"). */
export function formatDateLocalized(input: TimeInput, options: { locale?: string } = {}): string {
    const ms = toEpochMs(input)
    if (ms === null) return ''
    return safeDateTimeFormat(resolveUiLocale(options.locale), { dateStyle: 'medium' }).format(ms)
}

/** Localized wall-clock time only ("10:41 AM" / "오전 10:41"). */
export function formatClockTime(input: TimeInput, options: { locale?: string; seconds?: boolean } = {}): string {
    const ms = toEpochMs(input)
    if (ms === null) return ''
    return safeDateTimeFormat(resolveUiLocale(options.locale), { timeStyle: options.seconds ? 'medium' : 'short' }).format(ms)
}

/**
 * Compact elapsed duration ("45s", "12m", "3h 5m", "2d 4h"). Numbers + unit
 * letters read the same in every supported locale, so this stays unlocalized.
 */
export function formatElapsedCompact(ms: number | null | undefined): string {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
    const seconds = Math.floor(ms / 1000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    if (hours < 48) return `${hours}h ${minutes % 60}m`
    const days = Math.floor(hours / 24)
    return `${days}d ${hours % 24}h`
}

function formatUnit(value: number, unit: 'second' | 'minute' | 'hour' | 'day', locale: string | undefined): string {
    try {
        return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short' }).format(value)
    } catch {
        return `${value}${unit[0]}`
    }
}

/**
 * Localized elapsed duration for sentences ("45 sec", "12 min", "3 hr 5 min" /
 * "45초", "12분", "3시간 5분"). Input is milliseconds.
 */
export function formatDurationLocalized(ms: number | null | undefined, options: { locale?: string } = {}): string {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
    const locale = resolveUiLocale(options.locale)
    const seconds = Math.round(ms / 1000)
    if (seconds < 60) return formatUnit(seconds, 'second', locale)
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return formatUnit(minutes, 'minute', locale)
    const hours = Math.floor(minutes / 60)
    if (hours < 48) {
        const rest = minutes % 60
        return rest ? `${formatUnit(hours, 'hour', locale)} ${formatUnit(rest, 'minute', locale)}` : formatUnit(hours, 'hour', locale)
    }
    const days = Math.floor(hours / 24)
    const restHours = hours % 24
    return restHours ? `${formatUnit(days, 'day', locale)} ${formatUnit(restHours, 'hour', locale)}` : formatUnit(days, 'day', locale)
}
