import { useContext, type ReactNode } from 'react'
import { MeshGraphThemeContext } from './meshSurfaceTheme'
import { Tooltip } from '../../ui/InfoTip'

export function Badge({ label, tone = 'default', className, title }: { label: string; tone?: 'default' | 'good' | 'warn' | 'danger' | 'info'; className?: string; title?: string }) {
    const meshTheme = useContext(MeshGraphThemeContext)
    // The app's chip: sentence case, fixed h-5 height with centred content
    // (`inline-flex items-center leading-none`), so a Badge lines up with its
    // neighbours in any row regardless of the container's line-height. Tone
    // colours the text + thin border only (meshTheme.badge); no uppercase
    // tracking, no tinted fill.
    const chip = <span className={`inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-full border px-2 align-middle text-3xs font-medium leading-none ${meshTheme.badge(tone)}${className ? ` ${className}` : ''}`}>{label}</span>
    // A hint rides in the shared Tooltip (hover, focus AND tap) instead of a
    // mouse-only native title.
    return title ? <Tooltip content={title}>{chip}</Tooltip> : chip
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
