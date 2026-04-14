export interface SessionHostSurfaceRecordLike {
    lifecycle?: string | null
    meta?: Record<string, unknown> | null
}

export type SessionHostSurfaceSection = 'live' | 'recovery' | 'inactive'

export interface SessionHostAvailabilityBadge {
    label: string
    toneClass: string
}

export function getSessionHostAvailabilityBadge(options: {
    diagnostics?: unknown
    loading?: boolean
    refreshing?: boolean
    error?: string | null
}): SessionHostAvailabilityBadge {
    if (options.diagnostics) {
        return {
            label: 'Managed',
            toneClass: 'bg-green-500/[0.08] text-green-500',
        }
    }
    if (options.loading || options.refreshing) {
        return {
            label: 'Checking…',
            toneClass: 'bg-sky-500/[0.08] text-sky-400',
        }
    }
    if (options.error) {
        return {
            label: 'Diagnostics issue',
            toneClass: 'bg-amber-500/[0.08] text-amber-400',
        }
    }
    return {
        label: 'Unavailable',
        toneClass: 'bg-red-500/[0.08] text-red-400',
    }
}

export function getSessionHostRecoveryLabel(meta: Record<string, unknown> | null | undefined): string | null {
    const recoveryState = typeof meta?.runtimeRecoveryState === 'string'
        ? String(meta.runtimeRecoveryState).trim()
        : ''
    if (!recoveryState) return null
    if (recoveryState === 'auto_resumed') return 'restored after restart'
    if (recoveryState === 'resume_failed') return 'restore failed'
    if (recoveryState === 'host_restart_interrupted') return 'host restart interrupted'
    if (recoveryState === 'orphan_snapshot') return 'snapshot recovered'
    return recoveryState.replace(/_/g, ' ')
}

export function partitionSessionHostRecords<T extends SessionHostSurfaceRecordLike>(records: T[]): {
    liveRuntimes: T[]
    recoverySnapshots: T[]
    inactiveRecords: T[]
} {
    const liveRuntimes: T[] = []
    const recoverySnapshots: T[] = []
    const inactiveRecords: T[] = []

    for (const record of records || []) {
        const lifecycle = String(record?.lifecycle || '').trim()
        const recoveryLabel = getSessionHostRecoveryLabel(record?.meta || undefined)
        const restoredFromStorage = record?.meta?.restoredFromStorage === true
        if (['starting', 'running', 'stopping', 'interrupted'].includes(lifecycle)) {
            liveRuntimes.push(record)
        } else if ((lifecycle === 'stopped' || lifecycle === 'failed') && (restoredFromStorage || recoveryLabel)) {
            recoverySnapshots.push(record)
        } else {
            inactiveRecords.push(record)
        }
    }

    return {
        liveRuntimes,
        recoverySnapshots,
        inactiveRecords,
    }
}

export function getSessionHostNextActionLabel(section: SessionHostSurfaceSection): string {
    if (section === 'live') return 'Attach'
    if (section === 'recovery') return 'Recover'
    return 'Restart'
}

export function getSessionHostSectionHint(section: SessionHostSurfaceSection): string {
    if (section === 'live') {
        return 'These runtimes are live now and are the only attachable targets.'
    }
    if (section === 'recovery') {
        return 'These records were restored from session-host state and are not live attach targets until you explicitly recover or restart them.'
    }
    return 'These inactive records are shown for reference and usually need restart before they are useful again.'
}
