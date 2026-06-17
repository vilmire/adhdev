import React, { useState } from 'react'
import { cn } from '../../lib/utils'

interface SectionProps {
    title?: string
    icon?: React.ReactNode
    description?: string
    accentColor?: string
    className?: string
    /** When true, the section header becomes a toggle that shows/hides the body. */
    collapsible?: boolean
    /** Initial open state for a collapsible section. Ignored when not collapsible. */
    defaultOpen?: boolean
    /** Optional badge/hint rendered next to the title (e.g. "advanced"). */
    badge?: React.ReactNode
    children: React.ReactNode
}

export function Section({ title, icon, description, accentColor, className, collapsible, defaultOpen = true, badge, children }: SectionProps) {
    const [open, setOpen] = useState(defaultOpen)
    const isOpen = collapsible ? open : true

    const header = (title || description) && (
        <div className={cn('flex items-start justify-between gap-3', isOpen && 'mb-4')}>
            <div className="min-w-0">
                {title && (
                    <h3 className="text-base font-semibold text-text-primary flex items-center gap-1.5">
                        {icon && <span>{icon}</span>}
                        <span>{title}</span>
                        {badge}
                    </h3>
                )}
                {description && (
                    <p className="text-[13px] text-text-muted mt-1">{description}</p>
                )}
            </div>
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
            {collapsible && header ? (
                <button
                    type="button"
                    className="w-full bg-transparent border-none p-0 text-left cursor-pointer"
                    onClick={() => setOpen(o => !o)}
                    aria-expanded={isOpen}
                >
                    {header}
                </button>
            ) : (
                header
            )}
            {isOpen && children}
        </div>
    )
}

export default Section
