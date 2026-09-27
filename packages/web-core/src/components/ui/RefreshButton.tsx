/**
 * RefreshButton — the one "reload this view" control: an icon button that
 * spins while a reload is in flight. Replaces the ad-hoc '↻' / '⟳' glyph
 * buttons so every surface has the same affordance, accessible name and
 * disabled-while-refreshing behaviour.
 */
import type { MouseEventHandler } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { IconRefresh } from '../Icons'

export interface RefreshButtonProps {
    onClick: MouseEventHandler<HTMLButtonElement>
    /** Spins the icon and disables the button. */
    refreshing?: boolean
    disabled?: boolean
    /** Accessible name + hover title. Defaults to the localized "Refresh". */
    label?: string
    /** Icon size in px. Default 14. */
    size?: number
    /** Show the label text next to the icon (default: icon only). */
    showLabel?: boolean
    className?: string
}

export function RefreshButton({ onClick, refreshing = false, disabled = false, label, size = 14, showLabel = false, className }: RefreshButtonProps) {
    const { t } = useTranslation('common')
    const name = label ?? t('common.refresh')
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled || refreshing}
            aria-label={showLabel ? undefined : name}
            aria-busy={refreshing || undefined}
            title={name}
            className={cn(
                'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border-subtle bg-transparent text-text-muted transition-colors',
                'hover:border-border-default hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50',
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent',
                showLabel ? 'px-2.5 py-1 text-xs font-medium' : 'h-8 w-8',
                className,
            )}
        >
            <IconRefresh size={size} className={refreshing ? 'animate-spin' : undefined} />
            {showLabel && <span>{name}</span>}
        </button>
    )
}

export default RefreshButton
