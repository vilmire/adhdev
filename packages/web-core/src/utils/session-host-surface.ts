export interface SessionHostSurfaceRecordLike {
    lifecycle?: string | null
    meta?: Record<string, unknown> | null
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
