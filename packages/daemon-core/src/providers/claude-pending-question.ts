/**
 * claude-pending-question — native JSONL transcript authority for claude-cli's
 * AskUserQuestion picker, the structured counterpart to the TUI screen scrape.
 *
 * WHY THIS EXISTS (the scrape is provably lossy, not merely imprecise):
 * the claude TUI wraps a long option label onto a continuation line indented to
 * the same column the option's `description` uses:
 *
 *     2. ⚠️ 렌더링은 OK, 모달이 안
 *        닫힘                            ← wrapped LABEL   (indent 5)
 *     3. ❌ 렌더링이 아직 깨짐
 *        질문문이 잘리거나 라벨이 쪼개짐  ← DESCRIPTION     (indent 5)
 *
 * Both continuation lines are byte-identical in shape, so no screen parser can
 * tell a wrapped label from a description — the distinguishing information is
 * simply not on the screen. Chasing it with a smarter matcher is unwinnable;
 * the fix has to change the SOURCE.
 *
 * Claude Code appends the tool call to its own transcript
 * (`~/.claude/projects/<cwd-slug>/<session_id>.jsonl`) as structured JSON:
 *
 *   { "type":"assistant", "message": { "content": [ {
 *       "type":"tool_use", "name":"AskUserQuestion", "id":"toolu_…",
 *       "input": { "questions": [ { question, header, multiSelect,
 *                  options: [ { label, description, preview } ] } ] } } ] } }
 *
 * Labels, descriptions, previews and emoji arrive verbatim — no wrapping, no
 * truncation, no glyph damage. Verified against live plain-TUI captures (no
 * `--ax-screen-reader`, no spawn-arg change): the tool_use line is written when
 * the question is ASKED, minutes before the answer lands, so it is readable
 * while the picker is still parked on screen.
 *
 *   USE 11:21:55 → RES 11:26:39   (4m44s apart)
 *   USE 12:50:19 → RES 12:53:51   (3m32s)
 *
 * DETECTION (identical shape to kimi-pending-question, which solved the same
 * problem against kimi's wire.jsonl — this module reuses its bounded-tail read,
 * its latest-wins pairing rule, and its fail-open error contract):
 *
 *   - pending:  the most recent `tool_use` with name === 'AskUserQuestion'
 *               with NO `tool_result` carrying the same tool_use_id after it.
 *   - resolved: that matching `tool_result` (claude writes it whether the
 *               answer came from the terminal or from an injected keystroke),
 *               or a later user turn — either way the picker has left the
 *               screen and the held prompt must clear.
 *
 * promptId is claude's own `tool_use.id` (`toolu_…`): stable, unique per call,
 * and identical across a daemon restart, so a pre-restart answer still binds.
 * Note the TUI path instead derives a content-addressed id
 * (`stableClaudeTuiPromptId`), so the two transports produce DIFFERENT ids for
 * the same picker. That is deliberate and already handled downstream:
 * hasBoundClaudeAskUserQuestionToolResult() binds a TUI-captured prompt to its
 * native call by question/option identity before falling back to id equality.
 *
 * This detector is a PREFERRED source, never an exclusive one. The caller keeps
 * the screen-scrape path as fallback (see maybeCaptureClaudeTuiPrompt): the
 * JSONL write can lag the repaint, a transcript may be unresolvable for a
 * sidecar-claimed session, and non-claude providers have no such file at all.
 *
 * OSS code (AGPL-3.0). Must not import from packages/ (proprietary).
 */
'use strict';

import { LOG } from '../logging/logger.js';
import {
    resolveJsonlSourcePath,
    type NativeHistoryInput,
} from './spec/native-history-executor.js';
import { readTailJsonlLines } from './spec/background-task-detector.js';
import type { NativeHistoryConfig } from './spec/types.js';
import {
    detectClaudeAskUserQuestionPromptFromJson,
    type InteractivePrompt,
} from './types/interactive-prompt.js';

/**
 * Only the recent tail of the transcript is scanned so a long session does not
 * re-read megabytes on every status poll. A pending AskUserQuestion blocks the
 * turn, so its tool_use line is always near the write head. 512 KiB matches the
 * bound background-task-detector and kimi-pending-question already use.
 *
 * Claude transcript lines are fatter than kimi's wire (a single tool_use can
 * carry multi-KiB `preview` strings), but the bound is on the READ, not on the
 * record count: the newest records are the ones retained, so the pending call
 * survives truncation even when the tail holds fewer lines than kimi's would.
 */
const TAIL_BYTES = 512 * 1024;

/**
 * Detect whether claude's own transcript shows an UNANSWERED AskUserQuestion,
 * and if so build the InteractivePrompt for it.
 *
 * Returns null for every non-claude provider, on any resolution/read/parse
 * failure (fail-open: a transient read error must never wedge a held prompt nor
 * fabricate one — the caller falls back to the screen scrape), and once the
 * call's tool_result has landed.
 */
export function detectClaudePendingQuestion(
    cfg: NativeHistoryConfig | undefined,
    input: NativeHistoryInput,
): InteractivePrompt | null {
    if ((input.agentType ?? '').trim() !== 'claude-cli') return null;
    if (!cfg?.source || cfg.source.kind !== 'jsonl') return null;

    let sourcePath: string | null;
    try {
        sourcePath = resolveJsonlSourcePath(cfg.source, input);
    } catch {
        return null;
    }
    if (!sourcePath) return null;

    let records: unknown[];
    try {
        records = readTailJsonlLines(sourcePath, TAIL_BYTES);
    } catch {
        return null;
    }
    return detectClaudePendingQuestionFromRecords(records);
}

/**
 * Core detection over already-parsed transcript records (oldest→newest).
 * Exposed for tests so the pairing logic can be exercised without touching
 * disk — same seam style as detectKimiPendingQuestionFromRecords.
 *
 * Latest-wins: with several AskUserQuestion calls in the tail only the MOST
 * RECENT one can still be on screen (an earlier one necessarily resolved or was
 * superseded for the turn to advance), and even that one counts only when no
 * tool_result with its tool_use_id follows it.
 */
export function detectClaudePendingQuestionFromRecords(records: unknown[]): InteractivePrompt | null {
    let latestIdx = -1;
    let latestPrompt: InteractivePrompt | null = null;

    for (let i = 0; i < records.length; i++) {
        // Reuse the shared block walker rather than re-deriving the content
        // shape here: it already handles `message.content[]`, bare `content[]`
        // and a naked tool_use record, and it normalizes questions/options
        // (label, description, preview, multiSelect) exactly as the stream-json
        // transport does. Duplicating that logic is how the two transports
        // would drift apart.
        const prompt = detectClaudeAskUserQuestionPromptFromJson(records[i]);
        if (!prompt) continue;
        // A synthesized fallback id (no `toolu_…` on the block) cannot be
        // paired with a tool_result, so it can never be shown to clear. Skip
        // it and let the screen scrape own that picker.
        if (!prompt.promptId.startsWith('toolu_')) continue;
        latestIdx = i;
        latestPrompt = prompt;
    }
    if (latestIdx < 0 || !latestPrompt) return null;

    // Answered (in the terminal or via an injected answer): claude appends the
    // tool_result for the same tool_use_id and the turn continues.
    for (let i = latestIdx + 1; i < records.length; i++) {
        if (readClaudeToolResultIds(records[i]).includes(latestPrompt.promptId)) return null;
    }

    // Preserve the transcript's own timestamp so the prompt's createdAt does
    // not jump on every poll (it is re-derived from disk each time).
    const createdAt = readRecordTimestamp(records[latestIdx]);
    if (createdAt) latestPrompt.createdAt = createdAt;

    LOG.info(
        'ClaudeQuestion',
        `pending AskUserQuestion from native JSONL: promptId=${latestPrompt.promptId} questions=${latestPrompt.questions.length}`,
    );
    return latestPrompt;
}

/**
 * Collect the `tool_use_id`s of every tool_result carried by one transcript
 * record. Claude nests results under `message.content[]` on a user line, but a
 * bare `content[]` and a naked tool_result record are both accepted so the
 * pairing does not depend on which envelope the CLI version emits.
 */
function readClaudeToolResultIds(record: unknown): string[] {
    if (!record || typeof record !== 'object') return [];
    const r = record as Record<string, unknown>;
    const blocks: unknown[] = [];
    if (Array.isArray(r.content)) blocks.push(...r.content);
    const message = r.message;
    if (message && typeof message === 'object' && Array.isArray((message as Record<string, unknown>).content)) {
        blocks.push(...((message as Record<string, unknown>).content as unknown[]));
    }
    if (r.type === 'tool_result') blocks.push(r);

    const ids: string[] = [];
    for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b.type !== 'tool_result') continue;
        const id = typeof b.tool_use_id === 'string' ? b.tool_use_id.trim() : '';
        if (id) ids.push(id);
    }
    return ids;
}

/** ms-epoch of a transcript record's ISO/numeric `timestamp`, or 0. */
function readRecordTimestamp(record: unknown): number {
    if (!record || typeof record !== 'object') return 0;
    const value = (record as Record<string, unknown>).timestamp;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    if (typeof value !== 'string') return 0;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
