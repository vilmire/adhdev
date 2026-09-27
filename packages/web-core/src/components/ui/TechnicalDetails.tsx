/**
 * TechnicalDetails + CopyButton — where raw identifiers and payloads live.
 *
 * Ids, raw enums and JSON are useful when debugging or filing a report, but
 * they are noise in the default view. This collapsed disclosure keeps them
 * one click away (nothing is lost) and gives every id a Copy button instead
 * of asking the user to select a truncated monospace slice.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'

/** Copy text to the clipboard (async API with a legacy textarea fallback). */
export async function writeClipboard(text: string): Promise<boolean> {
    try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text)
            return true
        }
    } catch {
        // fall through to the legacy path
    }
    try {
        if (typeof document === 'undefined') return false
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(area)
        return ok
    } catch {
        return false
    }
}

export interface CopyButtonProps {
    value: string
    /** Visible label; defaults to the localized "Copy ID". */
    label?: string
    className?: string
}

export function CopyButton({ value, label, className }: CopyButtonProps) {
    const { t } = useTranslation('common')
    const [copied, setCopied] = useState(false)
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
    useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
    return (
        <button
            type="button"
            onClick={async event => {
                event.stopPropagation()
                const ok = await writeClipboard(value)
                if (!ok) return
                setCopied(true)
                if (timer.current) clearTimeout(timer.current)
                timer.current = setTimeout(() => setCopied(false), 1500)
            }}
            title={value}
            aria-label={`${label ?? t('common.copyId')}: ${value}`}
            className={cn(
                'inline-flex shrink-0 items-center rounded-md border border-border-subtle bg-transparent px-1.5 py-0.5 text-3xs font-medium text-text-muted transition-colors hover:border-border-default hover:text-text-primary',
                className,
            )}
        >
            <span aria-live="polite">{copied ? t('common.copied') : (label ?? t('common.copyId'))}</span>
        </button>
    )
}

export interface TechnicalDetailRow {
    label: string
    value: string | null | undefined
    /** Offer a Copy button for this value (ids). Default true. */
    copyable?: boolean
}

export interface TechnicalDetailsProps {
    rows?: TechnicalDetailRow[]
    /** Extra raw content (e.g. a JSON <pre> disclosure). */
    children?: ReactNode
    summary?: string
    className?: string
    /** Classes for the summary line (lets themed surfaces match their muted text). */
    summaryClassName?: string
}

export function TechnicalDetails({ rows = [], children, summary, className, summaryClassName }: TechnicalDetailsProps) {
    const { t } = useTranslation('common')
    const visibleRows = rows.filter(row => typeof row.value === 'string' && row.value)
    if (visibleRows.length === 0 && !children) return null
    return (
        <details className={cn('group text-xs', className)} data-technical-details="">
            <summary className={cn('cursor-pointer select-none list-none text-3xs font-medium uppercase tracking-wide text-text-muted [&::-webkit-details-marker]:hidden', summaryClassName)}>
                <span className="mr-1 inline-block transition-transform group-open:rotate-90" aria-hidden>▸</span>
                {summary ?? t('common.technicalDetails')}
            </summary>
            <div className="mt-2 flex flex-col gap-1.5">
                {visibleRows.map(row => (
                    <div key={row.label} className="flex min-w-0 items-center justify-between gap-2">
                        <span className="shrink-0 text-3xs text-text-muted">{row.label}</span>
                        <span className="flex min-w-0 items-center gap-1.5">
                            <span className="min-w-0 truncate font-mono text-3xs text-text-secondary" title={row.value!}>{row.value}</span>
                            {row.copyable !== false && <CopyButton value={row.value!} />}
                        </span>
                    </div>
                ))}
                {children}
            </div>
        </details>
    )
}

export default TechnicalDetails
