import React from 'react'
import { cn } from '../../lib/utils'

interface EmptyStateProps {
    icon: React.ReactNode
    title: string
    description: string
    action?: React.ReactNode
    className?: string
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
    return (
        <div className={cn(
            "py-16 px-5 text-center bg-bg-glass border-2 border-dashed border-border-subtle rounded-2xl",
            className
        )}>
            <div className="text-5xl mb-4 opacity-50">{icon}</div>
            <h3 className="text-lg font-bold text-text-secondary mb-2">{title}</h3>
            <p className="text-sm text-text-muted max-w-sm mx-auto mb-5 leading-relaxed">
                {description}
            </p>
            {action}
        </div>
    )
}

export default EmptyState
