import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'
import { PageHeader } from './PageHeader'

interface AppPageProps {
    icon: ReactNode
    title: string
    subtitle?: string
    badge?: { text: string; count?: number }
    actions?: ReactNode
    widthClassName?: string
    contentClassName?: string
    children: ReactNode
}

export default function AppPage({
    icon,
    title,
    subtitle,
    badge,
    actions,
    widthClassName = 'max-w-6xl',
    contentClassName,
    children,
}: AppPageProps) {
    return (
        <div className="flex flex-col h-full">
            <PageHeader icon={icon} title={title} subtitle={subtitle} badge={badge} actions={actions} />
            <div className="page-content">
                <div className={cn('mx-auto flex w-full flex-col gap-4', widthClassName, contentClassName)}>
                    {children}
                </div>
            </div>
        </div>
    )
}
