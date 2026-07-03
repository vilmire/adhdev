import { useContext, type ReactNode } from 'react'
import { MeshGraphThemeContext } from './meshSurfaceTheme'

export function Badge({ label, tone = 'default', className, title }: { label: string; tone?: 'default' | 'good' | 'warn' | 'danger' | 'info'; className?: string; title?: string }) {
    const meshTheme = useContext(MeshGraphThemeContext)
    return <span title={title} className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] ${meshTheme.badge(tone)}${className ? ` ${className}` : ''}`}>{label}</span>
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
