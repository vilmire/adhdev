import React, { useState } from 'react'
import { cn } from '../../lib/utils'
import { InfoTip } from './InfoTip'

interface SectionProps {
    title?: string
    icon?: React.ReactNode
    /**
     * Supporting explanation. Rendered as an ⓘ tip next to the title by
     * default (details on demand); set `descriptionInline` only when the text
     * must be read before acting (e.g. a security warning).
     */
    description?: React.ReactNode
    /** Force the description to render as visible text under the title. */
    descriptionInline?: boolean
    accentColor?: string
    className?: string
    /** When true, the section header becomes a toggle that shows/hides the body. */
    collapsible?: boolean
    /** Initial open state for a collapsible section. Ignored when not collapsible. */
    defaultOpen?: boolean
    /** Optional badge/hint rendered next to the title (e.g. "advanced"). */
    badge?: React.ReactNode
    /** Optional control on the right of the header (e.g. a Refresh button). */
    action?: React.ReactNode
    children: React.ReactNode
}

export function Section({ title, icon, description, descriptionInline = false, accentColor, className, collapsible, defaultOpen = true, badge, action, children }: SectionProps) {
    const [open, setOpen] = useState(defaultOpen)
    const isOpen = collapsible ? open : true

    const toggle = () => setOpen(o => !o)
    const titleInner = (
        <>
            {icon && <span>{icon}</span>}
            <span>{title}</span>
        </>
    )

    // In collapsible mode the title is the toggle button, and the ⓘ tip / badge
    // sit BESIDE it (never inside it — a button inside a button is invalid and
    // would swallow the tip's click). The whole row stays clickable.
    const header = (title || description || action) && (
        <div
            className={cn('flex items-start justify-between gap-3', isOpen && 'mb-4', collapsible && 'cursor-pointer')}
            onClick={collapsible ? toggle : undefined}
        >
            <div className="min-w-0">
                {title && (
                    <h3 className="text-base font-semibold text-text-primary flex items-center gap-1.5">
                        {collapsible ? (
                            <button
                                type="button"
                                className="inline-flex items-center gap-1.5 bg-transparent border-none p-0 text-left font-semibold text-text-primary cursor-pointer"
                                onClick={event => { event.stopPropagation(); toggle() }}
                                aria-expanded={isOpen}
                            >
                                {titleInner}
                            </button>
                        ) : titleInner}
                        {description && !descriptionInline && (
                            <span onClick={event => event.stopPropagation()} className="inline-flex">
                                <InfoTip content={description} />
                            </span>
                        )}
                        {badge}
                    </h3>
                )}
                {description && (descriptionInline || !title) && (
                    <p className="text-xxs text-text-muted mt-1">{description}</p>
                )}
            </div>
            {action && (
                <div className="flex shrink-0 items-center gap-2" onClick={event => event.stopPropagation()}>
                    {action}
                </div>
            )}
            {collapsible && (
                <span
                    className={cn(
                        'mt-0.5 shrink-0 text-text-muted transition-transform select-none',
                        isOpen ? 'rotate-90' : 'rotate-0',
                    )}
                    aria-hidden
                >
                    ▸
                </span>
            )}
        </div>
    )

    return (
        <div
            className={cn(
                "bg-bg-card border border-border-subtle rounded-2xl p-5 backdrop-blur-xl transition-all",
                "hover:border-border-default hover:shadow-glow",
                accentColor && "border-l-[3px]",
                className
            )}
            style={accentColor ? { borderLeftColor: accentColor } : undefined}
        >
            {header}
            {isOpen && children}
        </div>
    )
}

export default Section
