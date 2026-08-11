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
    normalizeInteractivePrompt,
    type InteractivePrompt,
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
