/**
 * Session-host runtime-surface helpers.
 *
 * These classification helpers (live_runtime / recovery_snapshot / inactive_record)
 * are owned by @adhdev/session-host-core as the single source of truth. daemon-core
 * re-exports them so consumers can keep importing from this path while the behavior
 * (including the `record.surfaceKind` short-circuit) stays identical across packages.
 */
export {
    getSessionHostRecoveryLabel,
    getSessionHostSurfaceKind,
    isSessionHostLiveRuntime,
    isSessionHostRecoverySnapshot,
    partitionSessionHostDiagnosticsSessions,
    partitionSessionHostRecords,
} from '@adhdev/session-host-core';
export type {
    SessionHostSurfaceKind,
    SessionHostSurfaceRecordLike,
} from '@adhdev/session-host-core';
