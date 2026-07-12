/**
 * background-task-detector — claude-cli run_in_background bash awareness.
 *
 * The daemon's idle/generating judgment is derived entirely from the PTY
 * screen FSM and has no awareness of claude-cli's own `run_in_background`
 * bash jobs. When claude-cli launches a background bash job and its parent
 * turn returns to a ready prompt, the parent turn is genuinely idle → the
 * session is falsely judged idle while the background job still runs → a
 * false agent:generating_completed fires to the coordinator.
 *
 * The durable signal is claude-cli's native-history JSONL transcript: a
 * background bash `tool_use` block with NO matching `tool_result` /
 * BashOutput completion for the same tool_use id = the job is still running.
 * This module reads that transcript at status-poll time (cheap tail scan)
 * and reports whether ≥1 unresolved background bash job exists.
 *
 * Conservative by design: only a tool_use that is CLEARLY a run_in_background
 * bash counts. A missing completion that will never arrive must not wedge a
 * genuinely-idle session forever — so when in doubt we DO NOT flag. The
 * completion hold (SUB-B) is additionally time-bounded on top of this.
 *
 * OSS code (AGPL-3.0). Must not import from packages/ (proprietary).
 */
'use strict';

import * as fs from 'node:fs';
import { LOG } from '../../logging/logger.js';
import { resolveJsonlSourcePath } from './native-history-executor.js';
import type { NativeHistoryConfig } from './types.js';
import type { NativeHistoryInput } from './native-history-executor.js';

export interface BackgroundTaskDetection {
    active: boolean;
    count: number;
    ids: string[];
}

const EMPTY: BackgroundTaskDetection = { active: false, count: 0, ids: [] };

/**
 * Only the recent tail of the transcript is scanned, so a very long session
 * doesn't re-read megabytes on every status poll. A background job's tool_use
 * and its eventual tool_result are near each other in the transcript, so a
 * generous tail window still captures the resolved/unresolved pairing.
 */
const TAIL_BYTES = 512 * 1024; // 512 KiB

/**
 * Detect whether the claude-cli session's active transcript has ≥1
 * unresolved background bash `tool_use` (a run_in_background Bash whose
 * completion tool_result / BashOutput has not yet appeared).
 *
 * Returns `{ active:false }` for every non-claude-cli agent, any read/parse
 * failure, and whenever no clear background bash is in flight.
 */
export function detectBackgroundTaskActive(
    cfg: NativeHistoryConfig | undefined,
    input: NativeHistoryInput,
): BackgroundTaskDetection {
    // Only claude-cli exposes run_in_background bash in the transcript shape
    // this detector understands. Every other provider stays undefined/false.
    if ((input.agentType ?? '') !== 'claude-cli') return EMPTY;
    if (!cfg?.source || cfg.source.kind !== 'jsonl') return EMPTY;

    let sourcePath: string | null;
    try {
        sourcePath = resolveJsonlSourcePath(cfg.source, input);
    } catch {
        return EMPTY;
    }
    if (!sourcePath) return EMPTY;

    let lines: unknown[];
    try {
        lines = readTailJsonlLines(sourcePath, TAIL_BYTES);
    } catch {
        return EMPTY;
    }
    if (lines.length === 0) return EMPTY;

    return detectFromRecords(lines);
}

/**
 * Core detection over already-parsed JSONL records (oldest→newest). Exposed
 * for tests so the pairing logic can be exercised without touching disk.
 *
 * A tool_use qualifies as a background bash only when it is a Bash tool_use
 * whose input carries `run_in_background: true`. Its completion is any later
 * `tool_result` with the same `tool_use_id`, OR a later `BashOutput` tool_use
 * whose input references the same `bash_id` (claude polls a background job via
 * BashOutput; but a resolved job also yields a tool_result for the original
 * launch id, which is the primary signal). A launch whose tool_result never
 * arrived in the scanned tail is treated as still-running.
 */
export function detectFromRecords(records: unknown[]): BackgroundTaskDetection {
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
    if (unresolved.length === 0) return EMPTY;
    LOG.debug('BackgroundTask', `claude-cli unresolved background bash: count=${unresolved.length} ids=${unresolved.join(',')}`);
    return { active: true, count: unresolved.length, ids: unresolved };
}

/**
 * Read only the last `maxBytes` of a JSONL file and parse the whole lines
 * within it (the first partial line at the read boundary is dropped). Keeps
 * per-poll cost bounded on long transcripts.
 */
function readTailJsonlLines(filePath: string, maxBytes: number): unknown[] {
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
