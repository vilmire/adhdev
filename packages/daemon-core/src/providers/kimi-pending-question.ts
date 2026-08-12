/**
 * kimi-pending-question — wire.jsonl authority for kimi's AskUserQuestion
 * picker (the InteractivePrompt / waiting_choice path, previously
 * claude-cli-only).
 *
 * kimi 0.34 renders AskUserQuestion as an interactive TUI picker (numbered
 * option rows, per-question tabs, a review screen) that the PTY modal/spinner
 * matchers do NOT classify — the session keeps reading 'generating' while it
 * sits parked waiting for an answer, so no waiting_choice status, no
 * agent:waiting_choice event, and mesh_answer_question had nothing to bind to
 * (the live coordinator-question blind spot).
 *
 * The durable signal is the session's own append-only native transcript
 * (`~/.kimi-code/sessions/<wdKey>/session_<uuid>/agents/main/wire.jsonl`),
 * re-read at status-poll time exactly like background-task-detector (whose
 * resolution + bounded tail-read this module reuses):
 *
 *   - pending:  context.append_loop_event / tool.call with
 *               name === 'AskUserQuestion' (toolCallId, args.questions[])
 *               and NO tool.result with the same toolCallId after it.
 *   - resolved: the matching tool.result — kimi writes it whether the answer
 *               came from the terminal or from an injected keystroke answer,
 *               so the held prompt clears on the next poll either way.
 *
 * promptId is the toolCallId: stable, unique per call, and it survives a
 * daemon restart (the same pending call re-read from disk yields the same id,
 * so a pre-restart answer still binds — the rc.20 rebind-fidelity rule the
 * claude TUI path solves with a content fingerprint).
 *
 * Shape verified against live kimi 0.34.0 wire.jsonl captures
 * (~/.kimi-code/sessions/wd_adhdev_78117b8afba9/session_cc5d676d-…): the
 * tool.call event carries `toolCallId` / `name` / `args.questions[]` with
 * { header, question, options: [{ label, description }] }; the tool.result
 * event carries the same top-level `toolCallId`. Multi-select questions carry
 * `multi_select` (snake_case) in the question args; `multiSelect` is also
 * accepted defensively (no live capture of either — see tests).
 *
 * This module ALSO covers kimi's built-in idle/cache-expired selector
 * ("This session has been idle for Nm… / Cache expired — …" with rows like
 * "Compact and continue" / "Start a new session"). That picker is a TUI
 * built-in, NOT an AskUserQuestion tool call, so the wire never carries it
 * and the approval modal matchers never fire — a parked session read as
 * plain `idle` while the selector ate input (live defect, 2026-08-12). It is
 * detected from the live PTY screen (detectKimiIdleSelectorPrompt) and
 * answered with arrow keys (buildKimiSelectorAnswerSteps) — the selector
 * renders no numbered rows, so the digit protocol does not apply.
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
    interactivePromptContentFingerprint,
    normalizeInteractivePrompt,
    type InteractivePrompt,
    type InteractivePromptResponse,
} from './types/interactive-prompt.js';

/**
 * Only the recent tail of the transcript is scanned, so a long session
 * doesn't re-read megabytes on every status poll. A pending AskUserQuestion
 * blocks the turn, so its tool.call is always near the write head; 512 KiB
 * (same bound as background-task-detector) covers it with wide margin.
 */
const TAIL_BYTES = 512 * 1024;

/**
 * Detect whether the session's own wire.jsonl shows an UNANSWERED
 * AskUserQuestion tool call, and if so build the InteractivePrompt for it.
 *
 * Returns null for every non-kimi provider, on any resolution/read/parse
 * failure (fail-open: a transient read error must never wedge a held prompt
 * nor fabricate one), and once the call's tool.result has landed.
 */
export function detectKimiPendingQuestion(
    cfg: NativeHistoryConfig | undefined,
    input: NativeHistoryInput,
): InteractivePrompt | null {
    if ((input.agentType ?? '').trim() !== 'kimi') return null;
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
    return detectKimiPendingQuestionFromRecords(records);
}

/**
 * Core detection over already-parsed wire.jsonl records (oldest→newest).
 * Exposed for tests so the pairing logic can be exercised without touching
 * disk — same seam style as background-task-detector's detectFromRecords.
 *
 * Latest-wins: with several AskUserQuestion calls in the tail, only the MOST
 * RECENT one can still be on screen (an earlier one necessarily resolved or
 * was superseded for the turn to advance), and even that one counts only when
 * no tool.result with its toolCallId follows it.
 */
export function detectKimiPendingQuestionFromRecords(records: unknown[]): InteractivePrompt | null {
    let latestCallIdx = -1;
    let latestCallId = '';
    let latestCallArgs: Record<string, unknown> | null = null;
    let latestCallTime = 0;

    for (let i = 0; i < records.length; i++) {
        const event = loopEvent(records[i]);
        if (!event) continue;
        if (event.type !== 'tool.call' || event.name !== 'AskUserQuestion') continue;
        const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId.trim() : '';
        if (!toolCallId) continue;
        latestCallIdx = i;
        latestCallId = toolCallId;
        latestCallArgs = event.args && typeof event.args === 'object'
            ? (event.args as Record<string, unknown>)
            : null;
        const time = (records[i] as Record<string, unknown>)?.time;
        latestCallTime = typeof time === 'number' && Number.isFinite(time) ? time : 0;
    }
    if (latestCallIdx < 0 || !latestCallId) return null;

    // Answered (in the terminal or via an injected answer): kimi appends the
    // tool.result for the same toolCallId and the turn continues. A later
    // turn.prompt also clears the hold — the turn moved on (e.g. the user
    // cancelled the picker with esc and prompted again), so the picker cannot
    // still be on screen.
    for (let i = latestCallIdx + 1; i < records.length; i++) {
        const record = records[i];
        if (record && typeof record === 'object'
            && String((record as Record<string, unknown>).type ?? '') === 'turn.prompt') {
            return null;
        }
        const event = loopEvent(record);
        if (!event || event.type !== 'tool.result') continue;
        const resultCallId = typeof event.toolCallId === 'string' ? event.toolCallId.trim() : '';
        if (resultCallId === latestCallId) return null;
    }

    // Normalize the question args into the shared InteractivePrompt shape.
    // `multi_select` (snake_case) is the wire spelling; `multiSelect` is
    // accepted defensively. allowFreeform is forced true: kimi ALWAYS renders
    // a trailing "Other" row on screen (it is NOT part of args.questions'
    // options, so it is not added to options either — the dashboard supplies
    // its own freeform escape against allowFreeform, mirroring the claude
    // convention).
    const rawQuestions = Array.isArray(latestCallArgs?.questions) ? latestCallArgs.questions : [];
    const questions = rawQuestions.map((raw) => {
        if (!raw || typeof raw !== 'object') return raw;
        const q = raw as Record<string, unknown>;
        return {
            ...q,
            multiSelect: q.multiSelect === true || q.multi_select === true,
            allowFreeform: true,
        };
    });
    const prompt = normalizeInteractivePrompt({
        promptId: latestCallId,
        origin: 'cli',
        providerType: 'kimi',
        createdAt: latestCallTime || Date.now(),
        questions,
    });
    if (prompt) {
        LOG.info('KimiQuestion', `pending AskUserQuestion: promptId=${latestCallId} questions=${prompt.questions.length}`);
    }
    return prompt;
}

/** Unwrap a `context.append_loop_event` record's loop event, or null. */
function loopEvent(record: unknown): Record<string, unknown> | null {
    if (!record || typeof record !== 'object') return null;
    const r = record as Record<string, unknown>;
    if (String(r.type ?? '') !== 'context.append_loop_event') return null;
    const event = r.event;
    if (!event || typeof event !== 'object') return null;
    return event as Record<string, unknown>;
}

// ─── Built-in idle/cache-expired selector (screen-based) ─────────────────────

/**
 * promptId prefix for kimi's built-in TUI selectors (as opposed to
 * AskUserQuestion wire promptIds, which are toolCallIds). The answer path
 * branches on this prefix: the built-in selector renders NO numbered option
 * rows, so the AskUserQuestion digit protocol does not apply — navigation is
 * arrow keys + Enter ("↑↓ navigate · Enter select · Esc cancel").
 */
export const KIMI_TUI_SELECTOR_PROMPT_PREFIX = 'kimi-tui-selector-';

/** "This session has been idle for 32m and is ~392k tokens." */
const IDLE_SELECTOR_TITLE = /This session has been idle for/i;
/** Picker hint line: "↑↓ navigate · Enter select · Esc cancel". */
const IDLE_SELECTOR_HINT = /↑↓\s*navigate\s*·\s*Enter\s+select/i;

/**
 * One option row of the built-in selector: optional ❯ cursor, the label, then
 * an optional description separated from the label by 2+ spaces (the live
 * layout pads descriptions into a column; a label's own words are single-spaced,
 * and a row without a description — "Don't ask me again" — stays single-part).
 */
function parseSelectorRow(line: string): { label: string; description?: string } | null {
    const m = line.match(/^\s*(?:❯\s*)?(\S[\s\S]*?)\s*$/);
    if (!m) return null;
    const parts = m[1].split(/\s{2,}/);
    const label = (parts[0] ?? '').trim();
    if (!label) return null;
    const description = parts.length > 1 ? parts.slice(1).join(' ').trim() : undefined;
    return { label, ...(description ? { description } : {}) };
}

/**
 * Detect kimi's built-in idle/cache-expired selector on the live PTY screen
 * and build its InteractivePrompt. Layout (kimi 0.34 live capture):
 *
 *   ────────────────────────────────────────────────────────────
 *    This session has been idle for 32m and is ~392k tokens.
 *    ↑↓ navigate · Enter select · Esc cancel
 *
 *    Cache expired — the next message re-sends the entire history at full price.
 *     ❯ Compact and continue    one-time compact cost · cheapest way to keep th...
 *       Start a new session     zero context cost · best for a new task
 *       Continue as-is          full history kept · highest cost per turn
 *       Don't ask me again
 *   ────────────────────────────────────────────────────────────
 *
 * Anchors: the title line AND the hint line AND a ❯ cursor row with ≥2 option
 * rows — quoted prose mentioning one cue alone never parses. The question is
 * the body line between the hint and the option block ("Cache expired — …"),
 * so the volatile "idle for Nm" title is kept out of the question and only
 * rides along as the header: the content-fingerprint promptId stays stable
 * while the minutes tick up across polls.
 *
 * Returns null when the selector is not on screen (answered, dismissed, or
 * scrolled away — the caller clears any held prompt on null, same contract as
 * the wire detector).
 */
export function detectKimiIdleSelectorPrompt(screenText: string): InteractivePrompt | null {
    if (!screenText) return null;
    const lines = screenText.split('\n');

    let titleIdx = -1;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (IDLE_SELECTOR_TITLE.test(lines[i])) { titleIdx = i; break; }
    }
    if (titleIdx < 0) return null;

    let hintIdx = -1;
    for (let i = titleIdx + 1; i <= Math.min(lines.length - 1, titleIdx + 4); i += 1) {
        if (IDLE_SELECTOR_HINT.test(lines[i])) { hintIdx = i; break; }
    }
    if (hintIdx < 0) return null;

    // The ❯ cursor row is the first option row; the question body sits between
    // the hint and it. Stop at the closing separator — no cursor row visible.
    let cursorIdx = -1;
    for (let i = hintIdx + 1; i < lines.length; i += 1) {
        const t = lines[i].trim();
        if (!t) continue;
        if (/^─+$/.test(t)) break;
        if (t.startsWith('❯')) { cursorIdx = i; break; }
    }
    if (cursorIdx < 0) return null;

    const options: { label: string; description?: string }[] = [];
    for (let i = cursorIdx; i < lines.length; i += 1) {
        const t = lines[i].trim();
        if (!t || /^─+$/.test(t)) break;
        const row = parseSelectorRow(lines[i]);
        if (!row) break;
        options.push(row);
    }
    if (options.length < 2) return null;

    let question = '';
    for (let i = cursorIdx - 1; i > hintIdx; i -= 1) {
        const t = lines[i].trim();
        if (!t || /^─+$/.test(t)) continue;
        question = t;
        break;
    }
    if (!question) return null;

    const questions = [{
        questionId: 'q1',
        question,
        header: lines[titleIdx].trim(),
        multiSelect: false,
        options,
    }];
    return {
        promptId: `${KIMI_TUI_SELECTOR_PROMPT_PREFIX}${interactivePromptContentFingerprint(questions)}`,
        origin: 'cli',
        providerType: 'kimi',
        createdAt: Date.now(),
        questions,
    };
}

/**
 * Answer steps for the built-in selector: arrow keys relative to the ❯ cursor
 * row CURRENTLY on screen (re-read live at answer time), then Enter. The
 * selector has no digit shortcuts and no review screen, so this is exactly
 * |target − cursor| arrows + '\r' — the AskUserQuestion builder's digit
 * protocol and trailing review-screen Enter do NOT apply here.
 *
 * Fail-closed, same as the wire path: a single-select answer naming one known
 * option label or it throws (no index/default fallback, no freeform — the
 * selector renders no freeform row).
 */
export function buildKimiSelectorAnswerSteps(
    prompt: InteractivePrompt,
    response: InteractivePromptResponse,
    screenText: string,
): string[] {
    if (response.promptId !== prompt.promptId) throw new Error('Interactive prompt response does not match active prompt');
    if (prompt.questions.length !== 1) throw new Error('kimi built-in selector prompt must have exactly one question');
    const question = prompt.questions[0];
    const answer = response.answers[question.questionId];
    if (!answer) throw new Error(`Missing answer for ${question.questionId}`);
    if (answer.freeformText?.trim()) throw new Error('kimi built-in selector has no freeform input');
    if (answer.selectedLabels.length !== 1) throw new Error(`Expected one selected label for ${question.questionId}`);
    const target = question.options.findIndex((o) => o.label === answer.selectedLabels[0]);
    if (target < 0) throw new Error(`Unknown option for ${question.questionId}: ${answer.selectedLabels[0]}`);

    let cursor = 0;
    for (const line of (screenText ?? '').split('\n')) {
        if (!line.trim().startsWith('❯')) continue;
        const row = parseSelectorRow(line);
        if (!row) continue;
        const idx = question.options.findIndex((o) => o.label === row.label);
        if (idx >= 0) { cursor = idx; break; }
    }

    const steps: string[] = [];
    const diff = target - cursor;
    const key = diff > 0 ? '\x1b[B' : '\x1b[A';
    for (let i = 0; i < Math.abs(diff); i += 1) steps.push(key);
    steps.push('\r');
    return steps;
}
