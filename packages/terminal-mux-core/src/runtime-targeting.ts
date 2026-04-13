import {
  resolveAttachableRuntimeRecord,
  type SessionHostRecord,
} from '@adhdev/session-host-core';

export function resolveMuxOpenRuntimeRecord(records: SessionHostRecord[], identifier: string): SessionHostRecord {
  return resolveAttachableRuntimeRecord(records, identifier);
}
