import type { SessionHostRecord } from '../shared-types.js';

export type SessionHostSurfaceKind = 'live_runtime' | 'recovery_snapshot' | 'inactive_record';

export interface SessionHostSurfaceRecordLike {
    lifecycle?: string | null;
    meta?: Record<string, unknown> | null;
}

const LIVE_LIFECYCLES = new Set(['starting', 'running', 'stopping', 'interrupted']);

export function isSessionHostLiveRuntime(record: SessionHostSurfaceRecordLike | null | undefined): boolean {
    const lifecycle = String(record?.lifecycle || '').trim();
    return LIVE_LIFECYCLES.has(lifecycle);
}

export function getSessionHostRecoveryLabel(meta: Record<string, unknown> | null | undefined): string | null {
    const recoveryState = typeof meta?.runtimeRecoveryState === 'string'
        ? String(meta.runtimeRecoveryState).trim()
        : '';
    if (!recoveryState) return null;
    if (recoveryState === 'auto_resumed') return 'restored after restart';
    if (recoveryState === 'resume_failed') return 'restore failed';
    if (recoveryState === 'host_restart_interrupted') return 'host restart interrupted';
    if (recoveryState === 'orphan_snapshot') return 'snapshot recovered';
    return recoveryState.replace(/_/g, ' ');
}

export function isSessionHostRecoverySnapshot(record: SessionHostSurfaceRecordLike | null | undefined): boolean {
    if (!record) return false;
    if (isSessionHostLiveRuntime(record)) return false;

    const lifecycle = String(record.lifecycle || '').trim();
    if (lifecycle && lifecycle !== 'stopped' && lifecycle !== 'failed') {
        return false;
    }

    const meta = record.meta || undefined;
    if (meta?.restoredFromStorage === true) return true;
    return getSessionHostRecoveryLabel(meta) !== null;
}

export function getSessionHostSurfaceKind(record: SessionHostSurfaceRecordLike | null | undefined): SessionHostSurfaceKind {
    if (isSessionHostLiveRuntime(record)) return 'live_runtime';
    if (isSessionHostRecoverySnapshot(record)) return 'recovery_snapshot';
    return 'inactive_record';
}

export function partitionSessionHostRecords<T extends SessionHostSurfaceRecordLike>(records: T[]): {
    liveRuntimes: T[];
    recoverySnapshots: T[];
    inactiveRecords: T[];
} {
    const liveRuntimes: T[] = [];
    const recoverySnapshots: T[] = [];
    const inactiveRecords: T[] = [];

    for (const record of records) {
        const kind = getSessionHostSurfaceKind(record);
        if (kind === 'live_runtime') {
            liveRuntimes.push(record);
        } else if (kind === 'recovery_snapshot') {
            recoverySnapshots.push(record);
        } else {
            inactiveRecords.push(record);
        }
    }

    return {
        liveRuntimes,
        recoverySnapshots,
        inactiveRecords,
    };
}

export function partitionSessionHostDiagnosticsSessions(
    records: SessionHostRecord[] | null | undefined,
): ReturnType<typeof partitionSessionHostRecords<SessionHostRecord>> {
    return partitionSessionHostRecords(records || []);
}
