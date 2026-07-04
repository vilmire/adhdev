import type {
  SessionBufferSnapshot,
  SessionHostRecord,
  SessionHostRequest,
} from '@adhdev/session-host-core';

export function getRequestSessionId(request: SessionHostRequest): string | undefined {
  const payload = (request as { payload?: Record<string, unknown> }).payload;
  return typeof payload?.sessionId === 'string' ? payload.sessionId : undefined;
}

export function getRequestClientId(request: SessionHostRequest): string | undefined {
  const payload = (request as { payload?: Record<string, unknown> }).payload;
  return typeof payload?.clientId === 'string' ? payload.clientId : undefined;
}

// Merges the registry buffer snapshot with the live runtime's rendered viewport
// text. For incremental reads (sinceSeq provided) the buffer snapshot is
// authoritative and the runtime viewport is not overlaid.
export function mergeRuntimeSnapshot(
  base: SessionBufferSnapshot,
  record: SessionHostRecord | null | undefined,
  opts: { sinceSeq?: number; runtimeText: string },
): SessionBufferSnapshot {
  const cols = typeof record?.meta?.sessionHostCols === 'number' ? (record.meta.sessionHostCols as number) : 80;
  const rows = typeof record?.meta?.sessionHostRows === 'number' ? (record.meta.sessionHostRows as number) : 24;
  if (typeof opts.sinceSeq === 'number' || !opts.runtimeText) {
    return {
      ...base,
      cols,
      rows,
    };
  }
  return {
    ...base,
    text: opts.runtimeText,
    truncated: false,
    cols,
    rows,
  };
}
