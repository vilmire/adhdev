/**
 * RelativeTime — short localized relative time ("5 min. ago") with the exact
 * localized date/time one hover/tap away (Tooltip), rendered as <time>.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatAbsoluteTime, formatRelativeTimeLocalized, toEpochMs, type TimeInput } from '../../utils/time'
import { Tooltip } from './InfoTip'

export interface RelativeTimeProps {
    value: TimeInput
    /** Re-render every 30s so "now" ages naturally. Default true. */
    live?: boolean
    /** Rendered when the value is missing/invalid. Default nothing. */
    fallback?: string
    className?: string
}

export function RelativeTime({ value, live = true, fallback = '', className }: RelativeTimeProps) {
    const { i18n } = useTranslation('common')
    const [, setTick] = useState(0)
    const ms = toEpochMs(value)
    useEffect(() => {
        if (!live || ms === null || typeof window === 'undefined') return
        const handle = window.setInterval(() => setTick(n => n + 1), 30_000)
        return () => window.clearInterval(handle)
    }, [live, ms])
    if (ms === null) return fallback ? <span className={className}>{fallback}</span> : null
    const locale = i18n?.resolvedLanguage || i18n?.language
    return (
        <Tooltip content={formatAbsoluteTime(ms, { locale, seconds: true })}>
            <time dateTime={new Date(ms).toISOString()} className={className}>
                {formatRelativeTimeLocalized(ms, { locale })}
            </time>
        </Tooltip>
    )
}

export default RelativeTime
