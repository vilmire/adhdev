/**
 * ProgressBar — shared progress bar component
 *
 * Used for CPU/MEM display in Machines Fleet, MachineDetail, Dashboard, etc.
 * Unifies compact mode (MiniBar) and detail mode (ProgressBar).
 */

interface ProgressBarProps {
    value: number
    max: number
    label: string
    color?: string
    /** Detail text (shown only in detail mode) */
    detail?: string
    /** If true, mini size (for fleet overview) */
    compact?: boolean
}

export default function ProgressBar({
    value, max, label, color = '#8b5cf6', detail, compact = false,
}: ProgressBarProps) {
    const pct = max > 0 ? Math.min(Math.round((value / max) * 100), 100) : 0
    const barColor = pct > 85 ? '#ef4444' : pct > 60 ? 'var(--status-warning)' : color

    if (compact) {
        return (
            <div className="flex-1">
                <div className="flex justify-between mb-0.5">
                    <span className="text-[9px] text-text-muted uppercase tracking-wide font-semibold">{label}</span>
                    <span className="text-[10px] text-text-secondary font-semibold">{pct}%</span>
                </div>
                <div className="h-1 bg-white/[0.04] rounded-sm overflow-hidden">
                    <div
                        className="h-full rounded-sm transition-[width] duration-500"
                        style={{ width: `${pct}%`, background: barColor }}
                    />
                </div>
            </div>
        )
    }

    return (
        <div className="flex-1">
            <div className="flex justify-between mb-1.5">
                <span className="text-[11px] text-text-secondary font-medium">{label}</span>
                <span className="text-[13px] text-text-primary font-bold">{pct}%</span>
            </div>
            <div className="h-1.5 bg-white/[0.04] rounded-sm overflow-hidden">
                <div
                    className="h-full rounded-sm transition-[width] duration-[600ms]"
                    style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${barColor}, ${barColor}cc)` }}
                />
            </div>
            {detail && <div className="text-[10px] text-text-muted mt-0.5">{detail}</div>}
        </div>
    )
}
