import { cn } from '../../lib/utils'

type StatusType = 'online' | 'idle' | 'busy' | 'error' | 'offline'

interface StatusBadgeProps {
    status: StatusType
    label?: string
    className?: string
}

const STATUS_STYLES: Record<StatusType, string> = {
    online: 'bg-green-500/10 text-green-400 border-green-500/30',
    idle: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30',
    busy: 'bg-orange-500/10 text-orange-400 border-orange-500/30',
    error: 'bg-red-500/10 text-red-400 border-red-500/30',
    offline: 'bg-gray-500/10 text-text-secondary border-gray-500/30',
}

const STATUS_DOT_COLORS: Record<StatusType, string> = {
    online: 'bg-green-500',
    idle: 'bg-yellow-500',
    busy: 'bg-orange-500',
    error: 'bg-red-500',
    offline: 'bg-gray-500',
}

export function StatusBadge({ status, label, className }: StatusBadgeProps) {
    const displayLabel = label || status

    return (
        <span className={cn(
            "inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border",
            STATUS_STYLES[status],
            className
        )}>
            <span className={cn(
                "w-2 h-2 rounded-full animate-[pulse-dot_2s_ease-in-out_infinite]",
                STATUS_DOT_COLORS[status]
            )} />
            {displayLabel}
        </span>
    )
}

export default StatusBadge
