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

/** Session status union (used by SessionEntry.status, legacy recent-launch metadata, etc.) */
export type SessionStatus = 'idle' | 'generating' | 'waiting_approval' | 'error' | 'stopped' | 'starting' | 'panel_hidden' | 'not_monitored' | 'disconnected';

/** Inbox bucket categories for recent sessions */
export type RecentSessionBucket = 'needs_attention' | 'working' | 'task_complete' | 'idle';

/** Terminal backend status */
export interface TerminalBackendStatus {
    backend: 'xterm' | 'ghostty-vt';
    preference: 'auto' | 'xterm' | 'ghostty-vt';
    ghosttyAvailable: boolean;
}
