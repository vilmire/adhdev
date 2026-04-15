import type { ReactNode } from 'react'

export interface LaunchSectionCardProps {
  title: string
  description?: string
  action?: ReactNode
  children?: ReactNode
  className?: string
  contentClassName?: string
}

export default function LaunchSectionCard({
  title,
  description,
  action,
  children,
  className = '',
  contentClassName = '',
}: LaunchSectionCardProps) {
  return (
    <div className={`rounded-xl border border-border-subtle bg-bg-primary px-4 py-3 ${className}`.trim()}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted">{title}</div>
          {description && (
            <div className="text-xs text-text-secondary mt-1">{description}</div>
          )}
        </div>
        {action ? <div className="flex items-center gap-2">{action}</div> : null}
      </div>
      {children ? (
        <div className={description || action ? `mt-3 ${contentClassName}`.trim() : contentClassName}>{children}</div>
      ) : null}
    </div>
  )
}
