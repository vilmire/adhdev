/**
 * On-demand expansion of a truncated tool bubble.
 *
 * The parser (`native-history-executor.ts` `projectToolBlock`) summarises tool
 * activity aggressively — call args are capped at `TOOL_CALL_SUMMARY_MAX` and
 * results at `TOOL_RESULT_SUMMARY_MAX` — and the full text is never carried on
 * any transcript payload. That is the right default: tool results are routinely
 * multi-kilobyte, most are never read, and shipping them on every read_chat
 * would inflate the transcript for nothing.
 *
 * This module is the escape hatch. Given the content-free
 * `NativeHistoryToolBlockRef` the parser stamped onto the truncated bubble, it
 * re-reads THAT block from the native-history source and returns the
 * untruncated call args and result.
 *
 * ── Fail closed, always ─────────────────────────────────────────────────────
 * `recordIndex`/`blockIndex` are positions in a file that the agent is still
 * appending to (and that providers rotate or rewrite). A position alone is
 * therefore NOT a safe address: if the transcript changed between the read that
 * produced the ref and this expand request, the same indices can name a
 * completely different tool's output. Returning that would be worse than
 * returning nothing — the reader would have no way to tell they were shown the
 * wrong command's result.
 *
 * So `sourceMtimeMs` travels with the ref as a freshness seal, and every
 * mismatch is refused with a typed reason instead of resolved. The caller gets
 * `{ ok: false, reason: 'source_changed' }` and can re-read the transcript to
 * obtain fresh refs. This is the whole reason the ref addresses a source
 * location rather than a re-derived ordinal.
 */

import {
    compileRecordShapes,
    executeNativeHistory,
    jsonPathGet,
    stringifyContent,
    type NativeHistoryInput,
} from './native-history-executor.js';
import {
    DEFAULT_TOOL_CALL_TYPES,
    DEFAULT_TOOL_RESULT_TYPES,
    TOOL_CALL_SUMMARY_MAX,
    TOOL_RESULT_SUMMARY_MAX,
} from './native-history-tool-blocks.js';
import type { NativeHistoryToolBlockRef } from './native-history-types.js';
import { readJsonlLines } from './native-history-jsonl-cache.js';
import type { NativeHistoryConfig, NativeHistoryToolMap } from './types.js';

/** Why an expand could not be served. Never "here is a best guess". */
export type ToolBlockExpandFailure =
    /** The spec has no declarative native-history source to re-read. */
    | 'unsupported_source'
    /** The transcript could not be resolved/read at all right now. */
    | 'source_unavailable'
    /**
     * The source changed since the ref was minted (mtime seal broken), so the
     * indices in the ref can no longer be trusted to name the same block.
     */
    | 'source_changed'
    /** The ref points past the end of the record/block array. */
    | 'block_not_found'
    /** The addressed position exists but is not a tool call/result block. */
    | 'not_a_tool_block';

export interface ToolBlockExpandOk {
    ok: true;
    /** Tool name for a call block; absent for a result block. */
    toolName?: string;
    /** Untruncated call arguments, when the block is a tool call. */
    callArgs?: string;
    /** Untruncated result body, when the block is a tool result. */
    result?: string;
    /**
     * Whether the full text actually exceeds the summary cap. False means the
     * bubble was already complete — the caller can say so rather than rendering
     * an "expanded" view identical to the collapsed one.
     */
    truncated: boolean;
}

export interface ToolBlockExpandErr {
    ok: false;
    reason: ToolBlockExpandFailure;
}

export type ToolBlockExpandResult = ToolBlockExpandOk | ToolBlockExpandErr;

function isValidRef(ref: unknown): ref is NativeHistoryToolBlockRef {
    if (!ref || typeof ref !== 'object') return false;
    const r = ref as Record<string, unknown>;
    return Number.isFinite(r.sourceMtimeMs)
        && Number.isInteger(r.recordIndex)
        && Number.isInteger(r.blockIndex)
        && (r.recordIndex as number) >= 0
        && (r.blockIndex as number) >= -1;
}

/**
 * Re-read one tool block at full length.
 *
 * Resolution deliberately goes back through `executeNativeHistory` rather than
 * re-deriving a path: session→file attribution is non-trivial (pins, claims,
 * sidecar workspaces, fail-closed ambiguity) and duplicating it here would let
 * the two paths disagree about WHICH transcript a session maps to — the same
 * class of silent mis-addressing the mtime seal exists to prevent.
 */
export function expandToolBlock(
    cfg: NativeHistoryConfig | undefined,
    input: NativeHistoryInput,
    ref: unknown,
): ToolBlockExpandResult {
    if (!isValidRef(ref)) return { ok: false, reason: 'block_not_found' };
    // Only the declarative jsonl source exposes stable record indices. sqlite
    // stores re-run their session query per read and script overrides are
    // opaque, so neither can honour a positional ref; refuse rather than
    // resolve an index whose meaning we cannot guarantee.
    if (cfg?.source?.kind !== 'jsonl') return { ok: false, reason: 'unsupported_source' };
    const src = cfg.source;

    let resolved;
    try {
        resolved = executeNativeHistory(cfg, input);
    } catch {
        return { ok: false, reason: 'source_unavailable' };
    }
    if (!resolved?.sourcePath) return { ok: false, reason: 'source_unavailable' };

    // ── The seal ───────────────────────────────────────────────────────────
    // Compared BEFORE the record is touched. An appended-to, rotated, or
    // rewritten transcript fails here, so a shifted index can never be read as
    // if it still named the requested block.
    if (resolved.sourceMtimeMs !== ref.sourceMtimeMs) {
        return { ok: false, reason: 'source_changed' };
    }

    let lines: any[];
    try {
        lines = readJsonlLines(resolved.sourcePath);
    } catch {
        return { ok: false, reason: 'source_unavailable' };
    }
    if (ref.recordIndex >= lines.length) return { ok: false, reason: 'block_not_found' };
    const record = lines[ref.recordIndex];
    if (record == null || typeof record !== 'object') return { ok: false, reason: 'block_not_found' };

    // Resolve the record's shape with the parser's own matcher: a multi-shape
    // (`records[]`) store maps content and tools differently per record type,
    // so reading the top-level map here could name the wrong field entirely.
    const shape = compileRecordShapes(src).pick(record);
    const tmap = shape?.map.tools;
    if (!tmap) return { ok: false, reason: 'unsupported_source' };

    // blockIndex -1 addresses the record itself (codex's record-level tool
    // shape); otherwise index into the record's content array exactly as the
    // parser did when it minted the ref.
    let block: any;
    if (ref.blockIndex === -1) {
        block = record;
    } else {
        const contentRaw = jsonPathGet(record, shape.map.content);
        if (!Array.isArray(contentRaw)) return { ok: false, reason: 'block_not_found' };
        if (ref.blockIndex >= contentRaw.length) return { ok: false, reason: 'block_not_found' };
        block = contentRaw[ref.blockIndex];
    }
    if (block == null || typeof block !== 'object') return { ok: false, reason: 'block_not_found' };

    return readToolBlock(block, tmap);
}

/**
 * Project one already-addressed block to its untruncated form. Mirrors
 * `projectToolBlock`'s type detection exactly — same map keys, same defaults —
 * but keeps the full text instead of calling `oneLine`.
 */
function readToolBlock(block: any, tmap: NativeHistoryToolMap): ToolBlockExpandResult {
    const typeVal = String(jsonPathGet(block, tmap.block_type || '$.type') ?? '');
    if (!typeVal) return { ok: false, reason: 'not_a_tool_block' };
    const callTypes = tmap.call_types ?? DEFAULT_TOOL_CALL_TYPES;
    const resultTypes = tmap.result_types ?? DEFAULT_TOOL_RESULT_TYPES;

    if (callTypes.includes(typeVal)) {
        const toolName = String(jsonPathGet(block, tmap.call_name || '$.name') ?? 'tool').trim() || 'tool';
        const callArgs = stringifyContent(jsonPathGet(block, tmap.call_args || '$.input'));
        return {
            ok: true,
            toolName,
            callArgs,
            // Measured on the same whitespace-flattened text the parser caps,
            // so "truncated" here means exactly what it meant there.
            truncated: flatLength(callArgs) > TOOL_CALL_SUMMARY_MAX,
        };
    }
    if (resultTypes.includes(typeVal)) {
        const result = stringifyContent(jsonPathGet(block, tmap.result_content || '$.content'));
        return {
            ok: true,
            result,
            truncated: flatLength(result) > TOOL_RESULT_SUMMARY_MAX,
        };
    }
    return { ok: false, reason: 'not_a_tool_block' };
}

function flatLength(s: string): number {
    return s.replace(/\s+/g, ' ').trim().length;
}
