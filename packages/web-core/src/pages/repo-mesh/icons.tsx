import { useTranslation } from 'react-i18next'
import { Tooltip } from '../../components/ui/InfoTip'
import { nodeHealthText } from '../../components/MeshGraph/MeshObservabilitySurface/meshSurfaceHelpers'

export function IconRefresh({ size = 14 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
    )
}

export function IconGitBranch({ size = 14 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
    )
}

export function IconTrash({ size = 14 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
    )
}

export function IconPlus({ size = 14 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
    )
}

const NODE_HEALTH_COLORS: Record<string, string> = {
    online: '#22c55e',
    dirty: '#f59e0b',
    offline: '#6b7280',
    degraded: '#ef4444',
    enabled: '#22c55e',
    pending: '#a855f7',
    assigned: '#3b82f6',
    completed: '#22c55e',
    failed: '#ef4444',
    unknown: '#6b7280',
}

export function NodeHealthBadge({ status }: { status: string }) {
    const { t } = useTranslation('common')
    const color = NODE_HEALTH_COLORS[status] ?? '#6b7280'
    const hint = status === 'degraded' ? t('mesh.nodeHealth.degradedHint') : undefined
    const chip = (
        <span
            className="inline-flex items-center gap-1 text-3xs font-semibold px-2 py-0.5 rounded-md"
            style={{ background: color + '15', color, border: `1px solid ${color}25` }}
        >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
            {nodeHealthText(status, t)}
        </span>
    )
    return hint ? <Tooltip content={hint}>{chip}</Tooltip> : chip
}
