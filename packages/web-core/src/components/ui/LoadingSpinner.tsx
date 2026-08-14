import type { CSSProperties } from 'react'
import { cn } from '../../lib/utils'

export type LoadingSpinnerColor = 'accent' | 'success' | 'muted'

const COLOR_TOKENS: Record<LoadingSpinnerColor, { track: string; head: string }> = {
    accent: { track: '--accent-primary', head: '--accent-primary-light' },
    success: { track: '--status-online', head: '--status-online' },
    muted: { track: '--text-muted', head: '--text-muted' },
}

export interface LoadingSpinnerProps {
    /** Diameter in CSS pixels. */
    size?: number
    /** Ring thickness in CSS pixels. */
    thickness?: number
    /** Semantic token family used for the ring. */
    color?: LoadingSpinnerColor
    className?: string
    /** Supply a label when the spinner itself should be announced. */
    label?: string
}

/** Canonical loading indicator shared by full-page, panel, and inline states. */
export default function LoadingSpinner({
    size = 28,
    thickness = 2.5,
    color = 'accent',
    className,
    label,
}: LoadingSpinnerProps) {
    const tokens = COLOR_TOKENS[color]
    const style: CSSProperties = {
        width: size,
        height: size,
        border: `${thickness}px solid color-mix(in srgb, var(${tokens.track}) 20%, transparent)`,
        borderTopColor: `var(${tokens.head})`,
    }

    return (
        <span
            className={cn('block shrink-0 rounded-full animate-spin', className)}
            style={style}
            role={label ? 'status' : undefined}
            aria-label={label}
            aria-hidden={label ? undefined : true}
        />
    )
}
