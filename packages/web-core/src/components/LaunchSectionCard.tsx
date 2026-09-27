import type { ReactNode } from 'react'
import { InfoTip } from './ui/InfoTip'

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
        <div className="flex min-w-0 items-center gap-1">
          <div className="text-3xs uppercase tracking-[0.08em] text-text-muted">{title}</div>
          {/* Explanations stay one tap away (ⓘ) instead of pre-exposed. */}
          {description && <InfoTip content={description} size={12} />}
        </div>
        {action ? <div className="flex items-center gap-2">{action}</div> : null}
      </div>
      {children ? (
        <div className={action ? `mt-3 ${contentClassName}`.trim() : `mt-2 ${contentClassName}`.trim()}>{children}</div>
      ) : null}
    </div>
  )
}
