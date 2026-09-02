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
 * truncation, no glyph damage.
 *
 * ★MEASURED (2026-09-02), CORRECTING AN EARLIER MISREAD: the `tool_use` block
 * is NOT written while the picker is parked on screen. It is appended to disk
 * together with its `tool_result` as a single pair, at the moment the picker
 * closes (Submit) — never before. Live instrumentation across a full
 * ask→answer cycle showed the on-disk line/tool_use count staying flat
 * (lines=11, toolu=0) through parking, a first answered question in a
 * multi-question call, and the review/Submit screen, then jumping straight to
 * both the tool_use AND tool_result together (lines=17, toolu=2) the instant
 * Submit was pressed. A retrospective sweep of 363 transcripts (420
 * AskUserQuestion calls) found zero unresolved `tool_use` records anywhere —
 * impossible if the ask were what triggered the write, since any session
 * interrupted between ask and answer would have left one behind.
 *
 * The earlier version of this comment cited a multi-minute gap between the
 * `tool_use` and `tool_result` *timestamp* fields as proof the tool_use line
 * was written first. That reasoning doesn't hold: `timestamp` is filled in
 * from the moment the tool was ASKED, but the line itself is written
 * retroactively when the pair is flushed — confirmed by comparing a record's
 * `timestamp` field against the wall-clock instant its bytes actually landed
 * on disk (02:22:50 recorded vs. 02:24:34 physically written, in lockstep with
 * the next line). A gap between two timestamp FIELDS says nothing about which
 * line was WRITTEN first; both can be written at once with old timestamps.
 *
 * CONSEQUENCE: this detector cannot see a picker while it is still open —
 * that data isn't on disk yet — so in practice `detectClaudePendingQuestion`
 * effectively always returns null and the caller's screen-scrape fallback is
 * what actually serves every live AskUserQuestion prompt today. This module
 * is kept anyway, deliberately not deleted: it still fires correctly for the
 * narrow window between Submit-write and the caller's next scrape/resolve
 * pass, it gives verbatim (non-wrapped) label/description/preview text in
 * that window, and if a future claude-cli version starts flushing tool_use
 * eagerly (ahead of tool_result) this path starts working for the pending
 * case with no code change — ripping it out now would mean re-deriving all of
 * the below from scratch later. See DETECTION below for the exact pairing
 * rule this implies.
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
 * This detector is a PREFERRED source, never an exclusive one — and per the
 * ★MEASURED note above, it is currently the MINORITY source in practice: the
 * caller's screen-scrape path (see maybeCaptureClaudeTuiPrompt) is what
 * resolves nearly every live pending picker, because this module's own write
 * lags the repaint by the full ask→answer duration, not merely a few frames.
 * The fallback also still earns its keep independently of that gap: a
 * transcript may be unresolvable for a sidecar-claimed session, and
 * non-claude providers have no such file at all.
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
        applyClaudeFreeformEscape(prompt);
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
 * Restore the freeform ("Type something.") escape hatch that the TUI renders
 * but the native tool call does not carry.
 *
 * MEASURED, not assumed. The scrape does NOT surface that row as an option: it
 * matches the label, sets `allowFreeform = true`, and `continue`s WITHOUT
 * pushing it (parseClaudeInteractiveTuiQuestion, interactive-prompt.ts). So the
 * screen-derived option list is already the real options only, and the escape
 * hatch travels as a per-question BOOLEAN. The dashboard renders its own
 * textarea from that flag (InteractivePromptModal), and the keystroke builder
 * falls back to `options.length` — one past the last real option, exactly where
 * the TUI draws the row — when no such option is present.
 *
 * Synthesizing a `Type something.` OPTION here would therefore have created new
 * drift rather than removing it: the dashboard would show a dead row that
 * selects a label the TUI never offers as an option, and it would shift every
 * subsequent digit in the keystroke protocol. Setting the flag is what makes
 * the two transports agree.
 *
 * Unconditional, matching the scrape's effective behaviour and the identical
 * kimi precedent (kimi-pending-question.ts forces allowFreeform: true): claude
 * renders the escape hatch on every AskUserQuestion picker, single- and
 * multi-select alike, and `input.questions[]` never carries an allowFreeform
 * key of its own, so nothing here can be overwritten.
 */
function applyClaudeFreeformEscape(prompt: InteractivePrompt): void {
    for (const question of prompt.questions) question.allowFreeform = true;
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
