/**
 * time.ts — Shared relative time formatting utilities
 *
 * Consolidates `formatRelativeTime` (compact) and `formatRelativeAgo` (verbose)
 * into a single configurable function.
 */

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
