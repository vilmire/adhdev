import { useContext, type ReactNode } from 'react'
import { MeshGraphThemeContext } from './meshSurfaceTheme'

export function Badge({ label, tone = 'default', className, title }: { label: string; tone?: 'default' | 'good' | 'warn' | 'danger' | 'info'; className?: string; title?: string }) {
    const meshTheme = useContext(MeshGraphThemeContext)
    // `leading-none` is deliberate: `text-[10px]` is an arbitrary Tailwind value, which
    // sets font-size ONLY — the chip would otherwise inherit whatever line-height its
    // container has (text-xs=1rem in Overview rows, leading-5=1.25rem in Tasks rows), so
    // the same chip rendered at different heights per context and its pill border drifted
    // against sibling text and the row border. Pinning line-height makes chip height a
    // function of padding alone. `align-middle` centers the inline box on the parent's
    // text instead of sitting on the baseline (which left a descender gap below).
    // `pr` > `pl` compensates for tracking, which also applies after the last glyph and
    // otherwise makes the label look shifted left inside its own border.
    return <span title={title} className={`rounded-full border pl-2 pr-[calc(0.5rem-0.16em)] py-0.5 text-[10px] leading-none align-middle uppercase tracking-[0.16em] ${meshTheme.badge(tone)}${className ? ` ${className}` : ''}`}>{label}</span>
}

export function Row({ label, value }: { label: string; value: ReactNode }) {
    const meshTheme = useContext(MeshGraphThemeContext)
    return (
        <div className={meshTheme.rowClass}>
            <span className={meshTheme.rowLabelClass}>{label}</span>
            <span className={meshTheme.rowValueClass}>{value}</span>
        </div>
    )
}
