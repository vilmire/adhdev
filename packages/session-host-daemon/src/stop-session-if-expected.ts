/** Re-export host-side cleanup CAS helpers from the shared contract package. */
export {
  hostBootIdFromStartedAt,
  resolveHostBootId,
  refuseCleanupExpectedStop,
  refuseCleanupExpectedDelete,
} from '@adhdev/session-host-core';
