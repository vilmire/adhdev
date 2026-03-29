import React from 'react'
import { cn } from '../../lib/utils'

interface PageHeaderProps {
    icon: React.ReactNode
    title: string
    subtitle?: string
    badge?: { text: string; count?: number }
    actions?: React.ReactNode
    className?: string
}

export function PageHeader({ icon, title, subtitle, badge, actions, className }: PageHeaderProps) {
    return (
        <div className={cn("dashboard-header", className)}>
            <div>
                <h1 className="header-title flex items-center gap-2">
                    <span className="flex items-center text-lg">{icon}</span> {title}
                    {badge && (
                        <span className="text-[10px] font-semibold px-1.5 py-px rounded-full bg-accent/10 text-accent-light">
                            {badge.count !== undefined ? badge.count : ''} {badge.text}
                        </span>
                    )}
                </h1>
                {subtitle && <div className="header-subtitle mt-1 text-xs text-text-muted">{subtitle}</div>}
            </div>
            {actions && <div className="flex gap-2">{actions}</div>}
        </div>
    )
}

export default PageHeader
