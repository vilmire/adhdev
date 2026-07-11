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

export function NodeHealthBadge({ status }: { status: string }) {
    const config: Record<string, { color: string; label: string; title?: string }> = {
        online: { color: '#22c55e', label: 'Online' },
        dirty: { color: '#f59e0b', label: 'Dirty', title: 'Workspace has uncommitted changes' },
        offline: { color: '#6b7280', label: 'Offline' },
        degraded: { color: '#ef4444', label: 'Degraded', title: 'P2P connection to this node is down or timed out — often transient. Wait and retry, or re-establish the node\'s connection.' },
        enabled: { color: '#22c55e', label: 'Enabled' },
        pending: { color: '#a855f7', label: 'Pending' },
        assigned: { color: '#3b82f6', label: 'Assigned' },
        completed: { color: '#22c55e', label: 'Completed' },
        failed: { color: '#ef4444', label: 'Failed' },
        unknown: { color: '#6b7280', label: 'Unknown' },
    }
    const c = config[status] || { color: '#6b7280', label: status }
    return (
        <span
            className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-md"
            style={{ background: c.color + '15', color: c.color, border: `1px solid ${c.color}25` }}
            title={c.title}
        >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: c.color }} />
            {c.label}
        </span>
    )
}
