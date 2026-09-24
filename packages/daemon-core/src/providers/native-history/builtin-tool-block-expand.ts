/**
 * On-demand expansion of a tool bubble minted by a BUILT-IN reader.
 *
 * The declarative counterpart lives in `spec/tool-block-expand.ts` and resolves
 * refs through the spec's `tools` map. Built-in readers have no such map — they
 * parse their provider's on-disk format in hand-written code — so each one
 * re-reads its own block here, using the same parsing rules that minted the
 * ref. That symmetry is the whole safety argument: a ref is an index into a
 * specific parser's record array, and only that parser can be trusted to
 * reproduce the array it indexed.
 *
 * ── Which readers participate ───────────────────────────────────────────────
 * Only the three whose store is a positional JSONL file that actually holds
 * more text than the bubble shows:
 *
 *   claude-cli  ~/.claude/projects/**\/<uuid>.jsonl     (tool_use / tool_result
 *               blocks inside `message.content[]` — blockIndex addresses the
 *               array position)
 *   codex-cli   ~/.codex/sessions/**\/rollout-*.jsonl   (each tool call/output
 *               is its OWN record — blockIndex is -1)
 *   grok-cli    ~/.grok/sessions/<cwd>/<uuid>/chat_history.jsonl (ditto, -1)
 *
 * Plus `antigravity-cli`, whose live store is a per-conversation SQLite db
 * (conversations/<uuid>.db) rather than a JSONL file. It still qualifies: the
 * ref's `recordIndex` is the step's `idx` PRIMARY KEY — append-only, so it
 * never renumbers the way a re-run session query would — and `blockIndex` is
 * the call's position in the model step (or -1 for a result row). The reader
 * resolves it by key (`readAntigravityToolBlockAt`) instead of by array
 * position. (Its legacy brain-transcript path carries content in FULL and
 * never stamps a ref, so nothing there reaches this resolver.)
 *
 * `hermes-cli` is deliberately absent, and this is a measured decision rather
 * than an omission: it reads a shared SQLite `state.db` and emits every row as
 * `kind:'standard'` — it produces no tool bubbles at all, so there is nothing
 * to expand. A sqlite row there also has no stable key across reads (the
 * session query re-runs and the cluster walk can change membership). It
 * returns `unsupported_source`, which is a truthful answer the dashboard can
 * render as "no more to fetch" rather than a broken button.
 *
 * OSS code (AGPL-3.0). Must not import from packages/ (proprietary).
 */

import { createNativeHistoryDispatcher, type NativeHistoryInput, type ReaderId } from './dispatcher.js';
import {
    TOOL_CALL_SUMMARY_MAX,
    TOOL_RESULT_SUMMARY_MAX,
} from '../spec/native-history-tool-blocks.js';
import type { NativeHistoryToolBlockRef } from '../spec/native-history-types.js';
import type { ToolBlockExpandResult } from '../spec/tool-block-expand.js';
import { statMtimeMs } from './fs-utils.js';
import { readClaudeRecords, readClaudeToolBlockAt } from './claude-cli-transcript.js';
import { readCodexRecords, readCodexToolBlockAt } from './codex-cli-transcript.js';
import { readGrokRecords, readGrokToolBlockAt } from './grok-cli-transcript.js';
import { readAntigravityToolBlockAt } from './antigravity-cli-transcript.js';

/** One addressed block, already read at full length. */
interface RawToolBlock {
    toolName?: string;
    callArgs?: string;
    result?: string;
}

/**
 * Re-read one built-in-reader tool block at full length.
 *
 * Resolution goes back through the reader's own dispatcher rather than
 * re-deriving a path: session→file attribution is non-trivial for every one of
 * these providers (claude scans project dirs, codex has a sticky runtime
 * binding and a timeboxed search, grok url-encodes the cwd) and duplicating it
 * here would let the expand path bind a DIFFERENT file than the read that
 * minted the ref — silently returning another session's tool output.
 */
export function expandBuiltinReaderToolBlock(
    reader: string,
    input: NativeHistoryInput,
    ref: NativeHistoryToolBlockRef,
): ToolBlockExpandResult {
    if (reader !== 'claude-cli' && reader !== 'codex-cli' && reader !== 'grok-cli' && reader !== 'antigravity-cli') {
        // hermes — see the module header. Nothing to expand.
        return { ok: false, reason: 'unsupported_source' };
    }

    let sourcePath: string;
    try {
        const resolved = createNativeHistoryDispatcher(reader as ReaderId)(input);
        if (!resolved?.sourcePath) return { ok: false, reason: 'source_unavailable' };
        sourcePath = resolved.sourcePath;
    } catch {
        return { ok: false, reason: 'source_unavailable' };
    }

    // ── The seal ───────────────────────────────────────────────────────────
    // Checked BEFORE any record is touched, and re-stat'ed here rather than
    // taken from the dispatcher result so it reflects the file as it is right
    // now. A transcript the agent appended to since the ref was minted fails
    // here, so a shifted index can never be read as if it still named the
    // requested block.
    const currentMtimeMs = statMtimeMs(sourcePath);
    if (!(currentMtimeMs > 0)) return { ok: false, reason: 'source_unavailable' };
    if (currentMtimeMs !== ref.sourceMtimeMs) return { ok: false, reason: 'source_changed' };

    let block: RawToolBlock | null;
    if (reader === 'antigravity-cli') {
        // Keyed (steps.idx), not positional — see the module header.
        block = readAntigravityToolBlockAt(sourcePath, ref.recordIndex, ref.blockIndex);
    } else {
        let records: Record<string, unknown>[];
        try {
            records = readRecords(reader, sourcePath);
        } catch {
            return { ok: false, reason: 'source_unavailable' };
        }
        if (ref.recordIndex >= records.length) return { ok: false, reason: 'block_not_found' };
        const record = records[ref.recordIndex];
        if (record == null || typeof record !== 'object') return { ok: false, reason: 'block_not_found' };
        block = readBlock(reader, record, ref.blockIndex);
    }
    if (!block) return { ok: false, reason: 'not_a_tool_block' };

    if (block.callArgs !== undefined) {
        return {
            ok: true,
            ...(block.toolName ? { toolName: block.toolName } : {}),
            callArgs: block.callArgs,
            // Measured on the same whitespace-flattened text the readers cap,
            // so `truncated` here means exactly what it meant there.
            truncated: flatLength(block.callArgs) > TOOL_CALL_SUMMARY_MAX,
        };
    }
    if (block.result !== undefined) {
        return {
            ok: true,
            result: block.result,
            truncated: flatLength(block.result) > TOOL_RESULT_SUMMARY_MAX,
        };
    }
    return { ok: false, reason: 'not_a_tool_block' };
}

function readRecords(reader: string, sourcePath: string): Record<string, unknown>[] {
    switch (reader) {
        case 'claude-cli': return readClaudeRecords(sourcePath);
        case 'codex-cli':  return readCodexRecords(sourcePath);
        case 'grok-cli':   return readGrokRecords(sourcePath);
        default:           return [];
    }
}

function readBlock(
    reader: string,
    record: Record<string, unknown>,
    blockIndex: number,
): RawToolBlock | null {
    switch (reader) {
        // claude nests tool blocks in `message.content[]`, so the ref carries a
        // real array position.
        case 'claude-cli': return readClaudeToolBlockAt(record, blockIndex);
        // codex and grok persist each tool call/result as its own record; the
        // record IS the block, which the ref marks with blockIndex -1.
        case 'codex-cli':  return readCodexToolBlockAt(record);
        case 'grok-cli':   return readGrokToolBlockAt(record);
        default:           return null;
    }
}

function flatLength(s: string): number {
    return s.replace(/\s+/g, ' ').trim().length;
}
