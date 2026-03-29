import React from 'react'
import { cn } from '../../lib/utils'

interface SectionProps {
    title?: string
    icon?: React.ReactNode
    description?: string
    accentColor?: string
    className?: string
    children: React.ReactNode
}

export function Section({ title, icon, description, accentColor, className, children }: SectionProps) {
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
            {(title || description) && (
                <div className="mb-4">
                    {title && (
                        <h3 className="text-base font-semibold text-text-primary">
                            {icon && <span className="mr-1.5">{icon}</span>}{title}
                        </h3>
                    )}
                    {description && (
                        <p className="text-[13px] text-text-muted mt-1">{description}</p>
                    )}
                </div>
            )}
            {children}
        </div>
    )
}

export default Section
