/**
 * background-task-detector — durable transcript authority for background tool
 * invocations that outlive the provider's model turn.
 *
 * The daemon's idle/generating judgment is derived from the PTY screen FSM and
 * the provider's own turn lifecycle; it has no native awareness of background
 * tool work the provider launched (`run_in_background`). When the provider
 * launches a background cell and its turn returns to idle with progress prose,
 * the session is falsely judged idle while the background cell still runs → a
 * false agent:generating_completed fires to the coordinator, and a delegated
 * mesh queue task is projected completed before its causally-owned background
 * work finished (rc.27 kimi class) — or before the provider consumed the
 * background result into a final assistant response.
 *
 * The durable signal is the provider's append-only native-history transcript,
 * re-read from disk at every status poll (so the verdict survives daemon
 * restart / session rebind — there is no in-memory state to lose):
 *
 * - claude-cli: a background bash `tool_use` (`run_in_background: true`) with
 *   NO matching `tool_result` for the same tool_use id = still running.
 * - kimi (native-source wire.jsonl): a `tool.call` loop event whose args carry
 *   `run_in_background: true`. The LAUNCH tool.result returns immediately
 *   (`task_id: bash-…`, `status: running`), so call→result pairing alone is
 *   NOT sufficient. The background cell's terminal state is recorded later as
 *   either (a) a `<notification … type="task.completed|failed|timed_out|lost|…"
 *   source_id="bash-…">` inside a `turn.steer` / `context.append_message`
 *   record, or (b) a TaskStop/TaskOutput `tool.result` carrying
 *   `task_id: <id>` with a terminal `status:` (killed/completed/failed/…).
 *   Even once resolved, the hold persists until the provider CONSUMES the
 *   resolution into a final-answer-class assistant `content.part` text (or a
 *   new `turn.prompt` supersedes the turn) — a bare tool-exit is not a final
 *   answer, and neither is progress prose mid-turn: when the wire carries the
 *   step protocol (`step.end` loop events with a `finishReason`), only text
 *   whose step closed with a finishReason OTHER THAN `tool_use` (live-verified:
 *   `end_turn`) counts as consumption. A text whose step continues into more
 *   tool work — e.g. the literal live row "Terminal notification received.
 *   Consuming the task output now." (step ended `tool_use`, followed by the
 *   output-file Read) — is progress prose and must NOT clear the hold.
 *
 * Ownership scoping (per task/turn, not per process): only launches recorded
 * AFTER the last user prompt in the scanned tail are causally owned by the
 * current turn. A detached background process from an earlier turn, foreign
 * task/tool ids, and other sessions' transcripts (the detector reads only the
 * session's own claimed transcript path) never block completion.
 *
 * Provider support is explicit: `support: 'tracked'` for providers whose
 * transcript shape this module understands (claude-cli, kimi), `'unknown'`
 * for every other provider — callers must treat unknown as "not gated", never
 * as silently clean.
 *
 * Conservative by design: only a tool invocation that is CLEARLY flagged
 * run_in_background counts. A missing resolution that will never arrive must
 * not wedge a genuinely-idle session forever — the completion hold that
 * consumes this signal is additionally time-bounded (BACKGROUND_TASK_HOLD_MAX_MS).
 *
 * OSS code (AGPL-3.0). Must not import from packages/ (proprietary).
 */
'use strict';

import * as fs from 'node:fs';
import { LOG } from '../../logging/logger.js';
import { resolveJsonlSourcePath } from './native-history-executor.js';
import type { NativeHistoryConfig } from './types.js';
import type { NativeHistoryInput } from './native-history-executor.js';

export type BackgroundTaskSupport = 'tracked' | 'unknown';

export interface BackgroundTaskDetection {
    active: boolean;
    count: number;
    ids: string[];
    /**
     * kimi only: every in-scope background cell has reached a terminal state,
     * but the provider has not yet consumed the resolution into an assistant
     * text response (nor has a new prompt superseded the turn). The completion
     * must still be held — tool exit alone is not the final answer.
     */
    pendingConsumption?: boolean;
    /**
     * 'tracked' = this provider's transcript is a understood authority for
     * background tool lifecycle; 'unknown' = no such authority exists for this
     * provider (the completion path is NOT gated on background work — an
     * explicit UNKNOWN, not a silent "no background work").
     */
    support?: BackgroundTaskSupport;
}

const EMPTY: BackgroundTaskDetection = { active: false, count: 0, ids: [] };

/** Agent types whose native transcript this detector can authoritatively read. */
const TRACKED_AGENT_TYPES = new Set(['claude-cli', 'kimi']);

/**
 * Only the recent tail of the transcript is scanned, so a very long session
 * doesn't re-read megabytes on every status poll. A background job's launch
 * and its eventual resolution are near each other in the transcript, so a
 * generous tail window still captures the launch/resolution pairing.
 */
const TAIL_BYTES = 512 * 1024; // 512 KiB

/**
 * Detect whether the session's active transcript shows ≥1 causally-owned
 * background tool invocation that is still running, or whose terminal result
 * has not yet been consumed into a final assistant response.
 *
 * Returns `{ active:false, support:'unknown' }` for every provider without a
 * understood transcript authority, and `{ active:false, support:'tracked' }`
 * on any read/parse failure of a tracked provider (fail-open per record, same
 * as the claude-cli branch — the consuming hold is time-bounded on top).
 */
export function detectBackgroundTaskActive(
    cfg: NativeHistoryConfig | undefined,
    input: NativeHistoryInput,
): BackgroundTaskDetection {
    const agentType = (input.agentType ?? '').trim();
    if (!TRACKED_AGENT_TYPES.has(agentType)) return { ...EMPTY, support: 'unknown' };
    if (!cfg?.source || cfg.source.kind !== 'jsonl') return { ...EMPTY, support: 'tracked' };

    let sourcePath: string | null;
    try {
        sourcePath = resolveJsonlSourcePath(cfg.source, input);
    } catch {
        return { ...EMPTY, support: 'tracked' };
    }
    if (!sourcePath) return { ...EMPTY, support: 'tracked' };

    let lines: unknown[];
    try {
        lines = readTailJsonlLines(sourcePath, TAIL_BYTES);
    } catch {
        return { ...EMPTY, support: 'tracked' };
    }
    if (lines.length === 0) return { ...EMPTY, support: 'tracked' };

    return detectFromRecords(lines, agentType);
}

/**
 * Core detection over already-parsed JSONL records (oldest→newest). Exposed
 * for tests so the pairing logic can be exercised without touching disk.
 * Dispatches on the provider's transcript record shape.
 */
export function detectFromRecords(records: unknown[], agentType = 'claude-cli'): BackgroundTaskDetection {
    if (agentType === 'kimi') return detectKimiFromRecords(records);
    return detectClaudeFromRecords(records);
}

/**
 * claude-cli record shape: assistant `tool_use` blocks (with id) and user
 * `tool_result` blocks (with tool_use_id).
 *
 * A tool_use qualifies as a background bash only when it is a Bash tool_use
 * whose input carries `run_in_background: true`. Its completion is any later
 * `tool_result` with the same `tool_use_id`, OR a later `BashOutput` tool_use
 * whose input references the same `bash_id` (claude polls a background job via
 * BashOutput; but a resolved job also yields a tool_result for the original
 * launch id, which is the primary signal). A launch whose tool_result never
 * arrived in the scanned tail is treated as still-running.
 */
function detectClaudeFromRecords(records: unknown[]): BackgroundTaskDetection {
    // tool_use id → true once we've seen a matching tool_result for it.
    const launched = new Map<string, boolean>();

    for (const rec of records) {
        if (!rec || typeof rec !== 'object') continue;
        const record = rec as Record<string, unknown>;
        const type = String(record.type ?? '').trim();
        const message = record.message && typeof record.message === 'object'
            ? (record.message as Record<string, unknown>)
            : null;
        if (!message) continue;
        const content = message.content;
        if (!Array.isArray(content)) continue;

        if (type === 'assistant') {
            for (const block of content) {
                if (!block || typeof block !== 'object') continue;
                const b = block as Record<string, unknown>;
                if (String(b.type ?? '') !== 'tool_use') continue;
                const name = String(b.name ?? '').trim();
                if (name !== 'Bash') continue;
                const inputObj = b.input && typeof b.input === 'object'
                    ? (b.input as Record<string, unknown>)
                    : null;
                // Conservative gate: only a bash EXPLICITLY flagged
                // run_in_background counts. A normal foreground bash (no flag,
                // or false) is ignored — it must never trip the false-idle hold.
                if (!inputObj || inputObj.run_in_background !== true) continue;
                const id = String(b.id ?? '').trim();
                if (!id) continue;
                // A relaunch of the same id is unlikely, but keep an existing
                // resolved-true mapping only if not already present.
                if (!launched.has(id)) launched.set(id, false);
            }
        } else if (type === 'user') {
            for (const block of content) {
                if (!block || typeof block !== 'object') continue;
                const b = block as Record<string, unknown>;
                if (String(b.type ?? '') !== 'tool_result') continue;
                const id = String(b.tool_use_id ?? '').trim();
                if (id && launched.has(id)) launched.set(id, true);
            }
        }
    }

    const unresolved = [...launched.entries()].filter(([, resolved]) => !resolved).map(([id]) => id);
    if (unresolved.length === 0) return { ...EMPTY, support: 'tracked' };
    LOG.debug('BackgroundTask', `claude-cli unresolved background bash: count=${unresolved.length} ids=${unresolved.join(',')}`);
    return { active: true, count: unresolved.length, ids: unresolved, support: 'tracked' };
}

/**
 * kimi native-source record shape (wire.jsonl, verified against live
 * transcripts — see module header):
 *
 *   { type:'context.append_loop_event',
 *     event:{ type:'tool.call', turnId, toolCallId, name:'Bash',
 *             args:{ command, run_in_background:true } } }
 *   { type:'context.append_loop_event',
 *     event:{ type:'tool.result', toolCallId,
 *             result:{ output:'task_id: bash-XXXX\npid: …\nstatus: running\n…' } } }
 *   … later, terminal state …
 *   { type:'turn.steer', input:[{ type:'text',
 *     text:'<notification id="task:bash-XXXX:completed" category="task"
 *            type="task.completed" source_kind="background_task"
 *            source_id="bash-XXXX">…' }] }
 *   … or an explicit stop/poll …
 *   { type:'context.append_loop_event',
 *     event:{ type:'tool.result', result:{ output:'task_id: bash-XXXX\nstatus: killed\n…' } } }
 *   … and finally the provider consuming it …
 *   { type:'context.append_loop_event',
 *     event:{ type:'content.part', part:{ type:'text', text:'<final answer>' } } }
 *   { type:'context.append_loop_event',
 *     event:{ type:'step.end', turnId, step, finishReason:'end_turn' } }
 *
 * Consumption is FINAL-ANSWER-CLASS evidence, not any assistant text: with the
 * step protocol present, a `content.part` text only counts when its step closed
 * with `finishReason !== 'tool_use'` (a `tool_use` finish means the turn
 * continues with more tool work — progress prose like "Terminal notification
 * received…"). A text whose `step.end` has not landed yet is not yet
 * consumption evidence either (fail-safe: the hold persists, time-bounded by
 * BACKGROUND_TASK_HOLD_MAX_MS). Transcripts with NO step protocol at all keep
 * the legacy any-assistant-text rule.
 *
 * Ownership is scoped to the current turn: only launches AFTER the last
 * `turn.prompt` count, so a detached background process from an earlier turn
 * never blocks an ordinary task (and a foreign/stale task_id never matches a
 * tracked launch).
 */
export function detectKimiFromRecords(records: unknown[]): BackgroundTaskDetection {
    /** task_id (or `call:<toolCallId>` when the launch id was unrecoverable) → lifecycle. */
    const launches = new Map<string, { callIdx: number; resolvedIdx: number }>();
    /** toolCallId → record index for a run_in_background call whose LAUNCH result hasn't landed. */
    const pendingLaunchByCallId = new Map<string, number>();
    let lastPromptIdx = -1;
    /** Assistant text parts with their step identity. Final-answer-class is
     *  judged AFTER the scan: a part's own `step.end` (carrying the
     *  finishReason) lands LATER in the tail than the text itself. */
    const textParts: { idx: number; stepKey: string | null }[] = [];
    /** step key → finishReason, from `step.end` loop events (kimi step protocol). */
    const stepFinishReason = new Map<string, string>();

    for (let i = 0; i < records.length; i++) {
        const rec = records[i];
        if (!rec || typeof rec !== 'object') continue;
        const record = rec as Record<string, unknown>;
        const type = String(record.type ?? '').trim();

        if (type === 'turn.prompt') {
            // New user instruction: scope boundary (ownership restarts) and a
            // consumption boundary (a pending resolution is superseded by the
            // new turn, whose own completion is a separate event).
            lastPromptIdx = i;
            continue;
        }

        const event = record.event && typeof record.event === 'object'
            ? (record.event as Record<string, unknown>)
            : null;
        if (event) {
            const eventType = String(event.type ?? '').trim();
            if (eventType === 'content.part') {
                const part = event.part && typeof event.part === 'object'
                    ? (event.part as Record<string, unknown>)
                    : null;
                if (part && String(part.type ?? '') === 'text' && String(part.text ?? '').trim().length > 0) {
                    textParts.push({ idx: i, stepKey: kimiStepKey(event) });
                }
            } else if (eventType === 'step.end') {
                const stepKey = kimiStepKey(event);
                const finishReason = String(event.finishReason ?? '').trim();
                if (stepKey && finishReason) stepFinishReason.set(stepKey, finishReason);
            } else if (eventType === 'tool.call') {
                const args = event.args && typeof event.args === 'object'
                    ? (event.args as Record<string, unknown>)
                    : null;
                // Same conservative gate as claude: only an EXPLICIT
                // run_in_background:true counts (any tool name — Bash and Task
                // both accept the flag; the flag is the authority).
                if (args && args.run_in_background === true) {
                    const callId = String(event.toolCallId ?? '').trim();
                    if (callId) pendingLaunchByCallId.set(callId, i);
                }
            } else if (eventType === 'tool.result') {
                const output = kimiResultOutputText(event);
                const callId = String(event.toolCallId ?? '').trim();
                if (callId && pendingLaunchByCallId.has(callId)) {
                    // LAUNCH result. It returns immediately with
                    // `task_id: …` + `status: running`, so it never resolves the
                    // cell — it only lets us key the launch by its task_id. A
                    // result with no task_id and no running status is a rejected
                    // / failed launch (e.g. approval denied) → do not track.
                    const taskId = parseKimiTaskField(output, 'task_id');
                    if (taskId) {
                        launches.set(taskId, { callIdx: pendingLaunchByCallId.get(callId)!, resolvedIdx: -1 });
                    } else if (parseKimiTaskField(output, 'status') === 'running') {
                        launches.set(`call:${callId}`, { callIdx: pendingLaunchByCallId.get(callId)!, resolvedIdx: -1 });
                    }
                    pendingLaunchByCallId.delete(callId);
                    continue;
                }
                // TaskStop / TaskOutput result: `task_id: <id>` + terminal
                // `status:` resolves the cell (an explicit kill is a terminal
                // state — a stopped cell must not block).
                const taskId = parseKimiTaskField(output, 'task_id');
                const status = parseKimiTaskField(output, 'status');
                if (taskId && status && KIMI_TERMINAL_TASK_STATUSES.has(status)) {
                    markKimiResolved(launches, taskId, i);
                }
            }
            continue;
        }

        if (type === 'turn.steer' || type === 'context.append_message') {
            // Background terminal notifications arrive as structured
            // `<notification …>` envelopes in user-role steer/append records.
            for (const text of kimiRecordTextParts(record)) {
                for (const match of text.matchAll(/<notification\b[^>]*>/g)) {
                    const attrs = parseNotificationAttrs(match[0]);
                    if (attrs.get('category') !== 'task') continue;
                    const sourceId = attrs.get('source_id') ?? '';
                    const notifType = (attrs.get('type') ?? '').replace(/^task\./, '');
                    if (sourceId && KIMI_TERMINAL_TASK_STATUSES.has(notifType)) {
                        markKimiResolved(launches, sourceId, i);
                    }
                }
            }
        }
    }

    // A run_in_background call whose LAUNCH result never landed in the scanned
    // tail is still in flight — track it by its toolCallId.
    for (const [callId, callIdx] of pendingLaunchByCallId) {
        launches.set(`call:${callId}`, { callIdx, resolvedIdx: -1 });
    }

    // Ownership scope: only launches recorded after the last user prompt are
    // causally owned by the current turn.
    const inScope = [...launches.entries()].filter(([, v]) => v.callIdx > lastPromptIdx);
    const unresolved = inScope.filter(([, v]) => v.resolvedIdx < 0).map(([id]) => id);
    // Consumption boundary: the last FINAL-ANSWER-CLASS assistant text. When
    // the transcript carries the kimi step protocol (any step.end with a
    // finishReason), a text part counts only when its step closed with a
    // finishReason other than 'tool_use' — a 'tool_use' finish means the model
    // turn continued with more tool work, so the text was progress prose (the
    // literal live post-notification row "Terminal notification received.
    // Consuming the task output now." ended its step with tool_use and was
    // followed by the output-file Read; treating it as consumption released the
    // hold ~19s before the genuine final report). A text whose step.end has
    // not landed yet (step still in flight) is not consumption evidence either
    // — fail-safe towards holding, bounded by BACKGROUND_TASK_HOLD_MAX_MS.
    // Transcripts with no step protocol at all keep the legacy rule: any
    // assistant text counts.
    const hasStepProtocol = stepFinishReason.size > 0;
    let lastAssistantTextIdx = -1;
    for (const part of textParts) {
        if (!hasStepProtocol) {
            lastAssistantTextIdx = part.idx;
            continue;
        }
        if (!part.stepKey) continue;
        const finish = stepFinishReason.get(part.stepKey);
        if (finish && finish !== 'tool_use') lastAssistantTextIdx = part.idx;
    }
    const consumedBoundary = Math.max(lastPromptIdx, lastAssistantTextIdx);
    const pendingConsumption = inScope.some(([, v]) => v.resolvedIdx >= 0 && v.resolvedIdx > consumedBoundary);

    if (unresolved.length === 0 && !pendingConsumption) return { ...EMPTY, support: 'tracked' };
    if (unresolved.length > 0) {
        LOG.debug('BackgroundTask', `kimi unresolved background tool: count=${unresolved.length} ids=${unresolved.join(',')}`);
    } else {
        LOG.debug('BackgroundTask', 'kimi background tool resolved but result not yet consumed into a final assistant response');
    }
    return {
        active: true,
        count: unresolved.length,
        ids: unresolved,
        pendingConsumption: unresolved.length === 0 ? true : undefined,
        support: 'tracked',
    };
}

/** Terminal background-task states, from live transcripts (task.* notification
 * types and TaskStop/TaskOutput `status:` values). `running` is NOT terminal. */
const KIMI_TERMINAL_TASK_STATUSES = new Set([
    'completed', 'failed', 'killed', 'timed_out', 'lost', 'stopped', 'cancelled',
]);

function markKimiResolved(launches: Map<string, { callIdx: number; resolvedIdx: number }>, taskId: string, idx: number): void {
    const entry = launches.get(taskId);
    if (entry && entry.resolvedIdx < 0) entry.resolvedIdx = idx;
}

/**
 * Step identity shared by `content.part` / `tool.call` / `step.end` loop
 * events. The `turnId:step` pair is present on all three and is preferred —
 * the step's uuid travels under DIFFERENT field names per event kind
 * (`stepUuid` on content.part/tool.call, `uuid` on step.begin/step.end), so
 * the pair is the only uniform join key. Falls back to `stepUuid` for
 * transcripts that carry it without a numeric step.
 */
function kimiStepKey(event: Record<string, unknown>): string | null {
    const turnId = String(event.turnId ?? '').trim();
    const step = event.step;
    if (turnId && (typeof step === 'number' || (typeof step === 'string' && step.trim() !== ''))) {
        return `${turnId}:${typeof step === 'string' ? step.trim() : step}`;
    }
    const stepUuid = String(event.stepUuid ?? '').trim();
    return stepUuid || null;
}

/** Extract the tool.result output as flat text (string or JSON-encoded object). */
function kimiResultOutputText(event: Record<string, unknown>): string {
    const result = event.result && typeof event.result === 'object'
        ? (event.result as Record<string, unknown>)
        : null;
    const output = result ? result.output : undefined;
    if (typeof output === 'string') return output;
    if (output === undefined || output === null) return '';
    try { return JSON.stringify(output); } catch { return String(output); }
}

/** Parse a `key: value` line from a tool.result output (e.g. `task_id: bash-x`). */
function parseKimiTaskField(output: string, key: string): string {
    const match = output.match(new RegExp(`(?:^|\\n)\\s*${key}:\\s*(\\S+)`));
    return match ? match[1].trim() : '';
}

/** Collect the text payloads of a turn.steer / context.append_message record. */
function kimiRecordTextParts(record: Record<string, unknown>): string[] {
    const out: string[] = [];
    const collect = (parts: unknown): void => {
        if (!Array.isArray(parts)) return;
        for (const part of parts) {
            if (!part || typeof part !== 'object') continue;
            const text = (part as Record<string, unknown>).text;
            if (typeof text === 'string' && text) out.push(text);
        }
    };
    collect(record.input);
    const message = record.message && typeof record.message === 'object'
        ? (record.message as Record<string, unknown>)
        : null;
    if (message) collect(message.content);
    return out;
}

/** Parse `key="value"` attributes out of a `<notification …>` tag. */
function parseNotificationAttrs(tag: string): Map<string, string> {
    const attrs = new Map<string, string>();
    for (const match of tag.matchAll(/([\w-]+)="([^"]*)"/g)) {
        attrs.set(match[1], match[2]);
    }
    return attrs;
}

/**
 * Read only the last `maxBytes` of a JSONL file and parse the whole lines
 * within it (the first partial line at the read boundary is dropped). Keeps
 * per-poll cost bounded on long transcripts.
 *
 * Exported for the sibling wire-tail readers (kimi-pending-question) that
 * share the same bounded-read requirement — one implementation of the
 * partial-line-drop rule.
 */
export function readTailJsonlLines(filePath: string, maxBytes: number): unknown[] {
    const stat = fs.statSync(filePath);
    const size = stat.size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const length = size - start;
    if (length <= 0) return [];
    const fd = fs.openSync(filePath, 'r');
    let text: string;
    try {
        const buf = Buffer.alloc(length);
        const bytes = fs.readSync(fd, buf, 0, length, start);
        text = buf.subarray(0, bytes).toString('utf8');
    } finally {
        fs.closeSync(fd);
    }
    const rawLines = text.split('\n');
    // When we started mid-file, the first element is a partial line — drop it.
    if (start > 0 && rawLines.length > 0) rawLines.shift();
    const out: unknown[] = [];
    for (const line of rawLines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { out.push(JSON.parse(trimmed)); } catch { /* skip malformed / truncated */ }
    }
    return out;
}
