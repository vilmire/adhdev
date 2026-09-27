import React from 'react'
import { cn } from '../../lib/utils'
import { InfoTip } from './InfoTip'

export type EmptyStateVariant = 'default' | 'compact'

interface EmptyStateProps {
    icon?: React.ReactNode
    title: string
    /**
     * Optional supporting sentence. `default` shows it under the title;
     * `compact` keeps one line and moves it into an ⓘ tip.
     */
    description?: React.ReactNode
    action?: React.ReactNode
    className?: string
    /**
     * `default` — large dashed card for an empty page.
     * `compact` — one muted row for an empty list/section inside a card.
     */
    variant?: EmptyStateVariant
}

export function EmptyState({ icon, title, description, action, className, variant = 'default' }: EmptyStateProps) {
    if (variant === 'compact') {
        return (
            <div
                className={cn(
                    'flex flex-wrap items-center justify-center gap-2 rounded-xl border border-dashed border-border-subtle px-4 py-5 text-center text-xs text-text-muted',
                    className,
                )}
            >
                {icon && <span className="flex items-center opacity-60" aria-hidden>{icon}</span>}
                <span className="font-medium text-text-secondary">{title}</span>
                {description ? <InfoTip content={description} /> : null}
                {action}
            </div>
        )
    }
    return (
        <div className={cn(
            "py-16 px-5 text-center bg-bg-glass border-2 border-dashed border-border-subtle rounded-2xl",
            className
        )}>
            {icon && <div className="text-5xl mb-4 opacity-50">{icon}</div>}
            <h3 className="text-lg font-bold text-text-secondary mb-2">{title}</h3>
            {description ? (
                <p className="text-sm text-text-muted max-w-sm mx-auto mb-5 leading-relaxed">
                    {description}
                </p>
            ) : <div className="mb-3" />}
            {action}
        </div>
    )
}

export default EmptyState
