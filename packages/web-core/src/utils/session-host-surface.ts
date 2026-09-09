import type { TFunction } from 'i18next'

type T = TFunction

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
    t?: T
}): SessionHostAvailabilityBadge {
    const { t } = options
    if (options.diagnostics) {
        return {
            label: t ? t('sessionHostSurface.managed') : 'Managed',
            toneClass: 'bg-green-500/[0.08] text-green-500',
        }
    }
    if (options.loading || options.refreshing) {
        return {
            label: t ? t('sessionHostSurface.checking') : 'Checking…',
            toneClass: 'bg-sky-500/[0.08] text-sky-400',
        }
    }
    if (options.error) {
        return {
            label: t ? t('sessionHostSurface.diagnosticsIssue') : 'Diagnostics issue',
            toneClass: 'bg-amber-500/[0.08] text-amber-400',
        }
    }
    return {
        label: t ? t('sessionHostSurface.unavailable') : 'Unavailable',
        toneClass: 'bg-red-500/[0.08] text-red-400',
    }
}

export function getSessionHostRecoveryLabel(meta: Record<string, unknown> | null | undefined, t?: T): string | null {
    const recoveryState = typeof meta?.runtimeRecoveryState === 'string'
        ? String(meta.runtimeRecoveryState).trim()
        : ''
    if (!recoveryState) return null
    if (recoveryState === 'auto_resumed') return t ? t('sessionHostSurface.restoredAfterRestart') : 'restored after restart'
    if (recoveryState === 'resume_failed') return t ? t('sessionHostSurface.restoreFailed') : 'restore failed'
    if (recoveryState === 'host_restart_interrupted') return t ? t('sessionHostSurface.hostRestartInterrupted') : 'host restart interrupted'
    if (recoveryState === 'orphan_snapshot') return t ? t('sessionHostSurface.snapshotRecovered') : 'snapshot recovered'
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

export function getSessionHostNextActionLabel(section: SessionHostSurfaceSection, t?: T): string {
    if (section === 'live') return t ? t('sessionHostSurface.attach') : 'Attach'
    if (section === 'recovery') return t ? t('sessionHostSurface.recover') : 'Recover'
    return t ? t('sessionHostSurface.restart') : 'Restart'
}

export function getSessionHostSectionHint(section: SessionHostSurfaceSection, t?: T): string {
    if (section === 'live') {
        return t ? t('sessionHostSurface.hintLive') : 'These runtimes are live now and are the only attachable targets.'
    }
    if (section === 'recovery') {
        return t
            ? t('sessionHostSurface.hintRecovery')
            : 'These records were restored from session-host state and are not live attach targets until you explicitly recover or restart them.'
    }
    return t
        ? t('sessionHostSurface.hintInactive')
        : 'These inactive records are shown for reference and usually need restart before they are useful again.'
}

const SESSION_HOST_LIFECYCLE_LABEL_KEYS: Record<string, string> = {
    starting: 'sessionHostSurface.lifecycleStarting',
    running: 'sessionHostSurface.lifecycleRunning',
    stopping: 'sessionHostSurface.lifecycleStopping',
    stopped: 'sessionHostSurface.lifecycleStopped',
    failed: 'sessionHostSurface.lifecycleFailed',
    interrupted: 'sessionHostSurface.lifecycleInterrupted',
}

const SESSION_HOST_LIFECYCLE_LABEL_FALLBACKS: Record<string, string> = {
    starting: 'Starting',
    running: 'Running',
    stopping: 'Stopping',
    stopped: 'Stopped',
    failed: 'Failed',
    interrupted: 'Interrupted',
}

export function getSessionHostLifecycleLabel(lifecycle: string, t?: T): string {
    const key = SESSION_HOST_LIFECYCLE_LABEL_KEYS[lifecycle]
    if (!key) return lifecycle
    return t ? t(key) : (SESSION_HOST_LIFECYCLE_LABEL_FALLBACKS[lifecycle] ?? lifecycle)
}
