/**
 * Machine-page quota chip — shared by Overview, Fleet grid, and provider-row.
 *
 * Uses the shared InfoTip Tooltip (hover / keyboard focus / mobile tap) so a
 * bare HTML `title=` is never the only reset-time access path. Tooltip body is
 * assembled by describeQuotaChipTooltip (kind hint + absolute local reset +
 * relative remaining, or explicit unknown).
 */
import { Tooltip } from '../../components/ui/InfoTip'
import {
    describeQuotaChipTooltip,
    shortQuotaChipLabel,
    type QuotaDisplayChip,
    type QuotaTextFormatter,
    ENGLISH_QUOTA_TEXT,
} from '../../utils/quota-format'

const TONE_CLASS: Record<string, string> = {
    good: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/25',
    warn: 'bg-amber-500/10 text-amber-500 border-amber-500/25',
    danger: 'bg-red-500/10 text-red-500 border-red-500/25',
    default: 'bg-white/5 text-text-secondary border-white/10',
    info: 'bg-blue-500/10 text-blue-500 border-blue-500/25',
}

export interface MachineQuotaChipProps {
    chip: QuotaDisplayChip
    /** Localized kind hint (session/weekly/bucket/…); first tooltip line. */
    kindHint: string
    /** Visible text; defaults to the full model label. Fleet passes a short form. */
    label?: string
    fmt?: QuotaTextFormatter
    now?: number
    locale?: string
    /** Extra classes on the visible pill (provider-row uses a bordered denser style). */
    className?: string
    /** Stop parent row/header click when the tooltip is tapped. */
    stopPropagation?: boolean
}

export function MachineQuotaChip({
    chip,
    kindHint,
    label,
    fmt = ENGLISH_QUOTA_TEXT,
    now = Date.now(),
    locale,
    className,
    stopPropagation = false,
}: MachineQuotaChipProps) {
    const tooltip = describeQuotaChipTooltip(chip, kindHint, now, fmt, locale)
    const visible = label ?? chip.label
    const tone = TONE_CLASS[chip.tone] ?? TONE_CLASS.default
    return (
        <Tooltip content={tooltip}>
            <span
                data-machine-quota-chip={chip.key}
                data-quota-hint={chip.hint}
                className={`inline-flex min-h-5 min-w-[2.5rem] items-center justify-center whitespace-nowrap rounded-full border px-1.5 py-0.5 text-3xs font-medium ${tone}${className ? ` ${className}` : ''}`}
                onClick={stopPropagation ? (event) => { event.preventDefault(); event.stopPropagation() } : undefined}
                onPointerUp={stopPropagation ? (event) => { event.stopPropagation() } : undefined}
            >
                {visible}
            </span>
        </Tooltip>
    )
}

/** Re-export for Fleet cells that already compute the short label themselves. */
export { shortQuotaChipLabel }
