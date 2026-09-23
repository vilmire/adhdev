/**
 * ADHDev Shared Types — Additional cross-package type definitions
 *
 * Extracted common sub-types previously inlined across multiple packages.
 * Separated from shared-types.ts due to rollup-dts bundling constraints.
 *
 * IMPORTANT: This file must remain runtime-free (types only).
 */

/** Runtime terminal write-owner descriptor */
export interface RuntimeWriteOwner {
    clientId: string;
    ownerType: 'agent' | 'user';
}

/** Runtime attached client descriptor */
export interface RuntimeAttachedClient {
    clientId: string;
    type: 'daemon' | 'web' | 'local-terminal';
    readOnly: boolean;
}

/**
 * Session status union (SessionEntry.status, recent-launch metadata, …) and the
 * recent-session inbox bucket. Wiring-unification A1: the canonical declaration
 * is mesh-shared's `session-status.ts` (SESSION_STATUSES / RECENT_SESSION_BUCKETS);
 * this file only re-exports it so existing import paths keep resolving.
 */
export type { SessionStatus, RecentSessionBucket } from '@adhdev/mesh-shared';

/** Terminal backend status */
export interface TerminalBackendStatus {
    backend: 'ghostty-vt';
}
