import React from 'react'
import { cn } from '../../lib/utils'
import { InfoTip } from './InfoTip'

interface PageHeaderProps {
    icon: React.ReactNode
    title: string
    /**
     * Page explanation. Shown as an ⓘ tip beside the title by default; pass
     * `subtitleInline` for short factual subtitles (counts, a repo name).
     */
    subtitle?: React.ReactNode
    subtitleInline?: boolean
    badge?: { text: string; count?: number }
    actions?: React.ReactNode
    className?: string
}

export function PageHeader({ icon, title, subtitle, subtitleInline = false, badge, actions, className }: PageHeaderProps) {
    return (
        <div className={cn("dashboard-header", className)}>
            <div>
                <h1 className="header-title flex items-center gap-2">
                    <span className="flex items-center text-lg">{icon}</span> {title}
                    {subtitle && !subtitleInline && <InfoTip content={subtitle} />}
                    {badge && (
                        <span className="text-3xs font-semibold px-1.5 py-px rounded-full bg-accent/10 text-accent-light">
                            {badge.count !== undefined ? badge.count : ''} {badge.text}
                        </span>
                    )}
                </h1>
                {subtitle && subtitleInline && <div className="header-subtitle mt-1 text-xs text-text-muted">{subtitle}</div>}
            </div>
            {actions && <div className="flex gap-2">{actions}</div>}
        </div>
    )
}

export default PageHeader
