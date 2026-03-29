import React from 'react'
import { cn } from '../../lib/utils'

type AlertVariant = 'error' | 'warning' | 'success' | 'info'

interface AlertBannerProps {
    variant: AlertVariant
    children: React.ReactNode
    onDismiss?: () => void
    className?: string
}

const VARIANT_STYLES: Record<AlertVariant, string> = {
    error: 'bg-red-500/10 border-red-500/30 text-red-400',
    warning: 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400',
    success: 'bg-green-500/10 border-green-500/30 text-green-400',
    info: 'bg-indigo-500/10 border-indigo-500/30 text-indigo-400',
}

const VARIANT_ICONS: Record<AlertVariant, string> = {
    error: '⚠️',
    warning: '🧪',
    success: '✅',
    info: '💡',
}

export function AlertBanner({ variant, children, onDismiss, className }: AlertBannerProps) {
    return (
        <div className={cn(
            "flex items-center justify-between gap-3 px-4 py-3 rounded-xl border text-[13px]",
            VARIANT_STYLES[variant],
            className
        )}>
            <div className="flex items-center gap-2">
                <span>{VARIANT_ICONS[variant]}</span>
                <span>{children}</span>
            </div>
            {onDismiss && (
                <button
                    onClick={onDismiss}
                    className="cursor-pointer border-none bg-transparent text-current text-base opacity-70 hover:opacity-100 transition-opacity"
                >
                    ✕
                </button>
            )}
        </div>
    )
}

export default AlertBanner
