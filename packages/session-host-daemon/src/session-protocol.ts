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
      text: withReplayResyncPreamble(base.text, opts.sinceSeq),
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

/** Erase the whole screen and home the cursor. */
const REPLAY_RESYNC_PREAMBLE = '\x1b[2J\x1b[H';

/**
 * TRIM-BOUNDARY defence, paired with `SessionRingBuffer`'s head repair.
 *
 * `sinceSeq: 0` ("Load older terminal output") takes the raw ring-buffer
 * branch above, so the browser xterm parses bytes that begin wherever eviction
 * happened to cut. The buffer now strips a torn *prefix*, but it cannot
 * conjure back state that was evicted rather than damaged: when the cut lands
 * after the session's opening `\x1b[2J\x1b[H`, the retained head is perfectly
 * well-formed text and no repair at that layer applies, yet the receiving
 * terminal was never told to clear or home. Output then lands wherever the
 * cursor already was, which is the large blank band at the top of the reported
 * screenshot.
 *
 * So put the terminal into a known state before replaying into it. This is
 * only correct for a from-scratch replay: an incremental `sinceSeq: N` read is
 * a delta appended to what the client already shows, and clearing there would
 * erase the scrollback the client is extending. `sinceSeq: 0` is the
 * "give me everything you still have" request, and `undefined` reaches this
 * branch only when the runtime viewport was unavailable — a full read too.
 */
function withReplayResyncPreamble(text: string, sinceSeq?: number): string {
  if (typeof sinceSeq === 'number' && sinceSeq > 0) return text;
  if (!text) return text;
  if (text.startsWith(REPLAY_RESYNC_PREAMBLE)) return text;
  return `${REPLAY_RESYNC_PREAMBLE}${text}`;
}
