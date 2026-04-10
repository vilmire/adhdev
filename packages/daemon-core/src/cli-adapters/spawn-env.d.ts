/**
 * Re-export spawn environment utilities from @adhdev/session-host-core.
 *
 * The canonical implementation lives in session-host-core so that both
 * daemon-core and session-host-daemon can share it. This file exists
 * to keep the import path short within daemon-core consumers.
 */
export { sanitizeSpawnEnv, applyTerminalColorEnv, ensureNodePtySpawnHelperPermissions, } from '@adhdev/session-host-core';
