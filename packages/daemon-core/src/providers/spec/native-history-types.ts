/**
 * Message shapes emitted by the native-history executor.
 *
 * Split out of `native-history-executor.ts` so the tool-block modules
 * (`native-history-tool-blocks.ts`, `tool-block-expand.ts`) can name these
 * types without importing the executor itself, which would close an import
 * cycle. Types only — no runtime code belongs here.
 */

/**
 * Content-free address of one tool block inside its native-history source.
 *
 * Why this exists: tool call args are capped at `TOOL_CALL_SUMMARY_MAX` and
 * results at `TOOL_RESULT_SUMMARY_MAX` (see `native-history-tool-blocks.ts`),
 * and the full text is never carried anywhere — `NativeHistoryMessage.content`
 * is the only text field, so the untruncated body simply does not reach the
 * dashboard. Rather than widen every transcript payload with text nobody
 * usually reads, this ref lets a reader ask the daemon to re-read exactly this
 * block on demand (see `expand_tool_block`).
 *
 * Every field is an integer. There is no text, no path, and no hash of content
 * here, which is what makes the ref safe to carry on the replicated transcript
 * wire (`seqscribe/transcript-projection.ts`) where content-derived identity —
 * notably `providerUnitKey` — is deliberately excluded.
 *
 * `sourceMtimeMs` is the freshness seal, not just an address component: an
 * expand request that carries a stale mtime is refused outright rather than
 * resolved against shifted indices, so a rotated or rewritten transcript can
 * never return a DIFFERENT tool's output under the requested ref.
 */
export interface NativeHistoryToolBlockRef {
    /** mtime of the source file at parse time — the fail-closed freshness seal. */
    sourceMtimeMs: number;
    /** 0-based index of the record within the source (jsonl line / sqlite row). */
    recordIndex: number;
    /**
     * 0-based index of the tool block within the record's content array, or
     * -1 when the record ITSELF is the tool block (codex's record-level shape,
     * which has no content array to index into).
     */
    blockIndex: number;
}

export interface NativeHistoryMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    receivedAt: number;
    kind?: string;
    workspace?: string;
    /**
     * Present only on `kind:'tool'` bubbles whose summary was truncated —
     * absent when the block already fits, so a reader can tell "nothing more to
     * fetch" from "not addressable" without a round trip.
     */
    toolBlockRef?: NativeHistoryToolBlockRef;
}
