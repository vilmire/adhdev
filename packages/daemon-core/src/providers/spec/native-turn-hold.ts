/**
 * Native-turn generating hold for Codex.
 *
 * Codex's own rollout records the turn lifecycle (`event_msg` task_started ...
 * task_complete | turn_aborted). While a composing model keeps the TUI quiet
 * for tens of seconds (no spinner line, composer drawn), the screen FSM reads
 * the gap as `busy -> idle`, and the next output as `idle -> busy`: a healthy
 * worker flaps and the mesh paged its coordinator ("Worker session ... is
 * flapping"). The rollout, not the screen, is the authority on whether the turn
 * is over, so the FSM's generating->idle edge is VETOED while the instance-owned
 * rollout shows an open turn.
 *
 * Safety:
 *  - Only an OWNER-CONFIRMED rollout counts (the same instance-claim resolution
 *    the chat reader uses); an unmapped or ambiguous rollout never holds.
 *  - Bounded: when the rollout file has not been written for
 *    NATIVE_TURN_STALE_MS the hold lapses and the screen decides again (a
 *    killed/wedged codex never wrote task_complete). 5 min is ~4x the longest
 *    quiet gap observed between assistant messages in a healthy turn (40-80 s);
 *    a long silent tool call keeps its spinner on screen, which vetoes idle on
 *    its own, so the rollout bound only has to cover composing/reasoning gaps.
 *  - Read errors / missing markers fail open (no hold).
 */
import * as fs from 'node:fs';
import { LOG } from '../../logging/logger.js';
import { readTailJsonlLines } from './background-task-detector.js';
import { resolveJsonlSourcePathDetailed } from './native-history-executor.js';
import { statusForState, stateById, type CliSpecV4 } from './fsm-types.js';
import type { FsmEvaluation } from './fsm-evaluator.js';
import type { NativeHistoryConfig } from './types.js';
import type { NativeHistoryInput } from './native-history-types.js';
import { registerNativeTurnPeek, unregisterNativeTurnPeek, type NativeTurnState } from '../../shared/native-turn-registry.js';

export type { NativeTurnState };

export const NATIVE_TURN_STALE_MS = 300_000;
export const NATIVE_TURN_POLL_MS = 2_000;
const TAIL_BYTES = 512 * 1024;
const SAMPLE_TTL_MS = 1_000;

/** Last turn-lifecycle marker in oldest->newest rollout records. */
export function codexTurnStateFromRecords(records: unknown[]): 'open' | 'closed' | 'none' {
    let state: 'open' | 'closed' | 'none' = 'none';
    for (const rec of records) {
        const r = rec as { type?: unknown; payload?: { type?: unknown } } | null;
        if (r?.type !== 'event_msg') continue;
        const t = r.payload?.type;
        if (t === 'task_started') state = 'open';
        else if (t === 'task_complete' || t === 'turn_aborted') state = 'closed';
    }
    return state;
}

export interface NativeTurnHold {
    /** True when the generating->idle edge must be vetoed right now. */
    holds(now: number): boolean;
    /** Re-run `cb` shortly so a vetoed edge is re-judged without a screen frame. */
    arm(cb: () => void): void;
    peek(now?: number): NativeTurnState;
    dispose(): void;
}

export function createCodexNativeTurnHold(opts: {
    sessionId?: string;
    getConfig: () => NativeHistoryConfig | undefined;
    getInput: () => NativeHistoryInput;
    tag?: string;
}): NativeTurnHold {
    let cachedPath: string | null = null;
    let sample: { at: number; state: NativeTurnState; reason: string } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastLogged = '';

    const read = (now: number): { state: NativeTurnState; reason: string } => {
        const src = opts.getConfig()?.source;
        if (!src || src.kind !== 'jsonl') return { state: 'unknown', reason: 'no_jsonl_source' };
        if (!cachedPath || !fs.existsSync(cachedPath)) {
            const res = resolveJsonlSourcePathDetailed(src, opts.getInput());
            cachedPath = res.path && res.outcome?.ownerConfirmed === true ? res.path : null;
            if (!cachedPath) return { state: 'unknown', reason: 'rollout_unmapped' };
        }
        let mtime = 0;
        try { mtime = fs.statSync(cachedPath).mtimeMs; } catch { cachedPath = null; return { state: 'unknown', reason: 'rollout_unreadable' }; }
        const marker = codexTurnStateFromRecords(readTailJsonlLines(cachedPath, TAIL_BYTES));
        if (marker === 'none') return { state: 'unknown', reason: 'no_turn_marker' };
        if (marker === 'closed') return { state: 'closed', reason: 'task_complete' };
        const quiet = now - mtime;
        if (quiet > NATIVE_TURN_STALE_MS) return { state: 'unknown', reason: `rollout_stale_${Math.round(quiet / 1000)}s` };
        return { state: 'open', reason: 'task_started_open' };
    };

    const peek = (now = Date.now()): NativeTurnState => {
        if (sample && now - sample.at < SAMPLE_TTL_MS && now >= sample.at) return sample.state;
        let r: { state: NativeTurnState; reason: string };
        try { r = read(now); } catch { r = { state: 'unknown', reason: 'read_error' }; }
        sample = { at: now, ...r };
        const key = `${r.state}:${r.reason.replace(/\d+s$/, '')}`;
        if (key !== lastLogged) {
            lastLogged = key;
            LOG.info('NativeTurnHold', `[${opts.tag ?? opts.sessionId ?? '-'}] native turn ${r.state} (${r.reason})`);
        }
        return r.state;
    };
    if (opts.sessionId) {
        registerNativeTurnPeek(opts.sessionId, () => peek());
    }
    return {
        holds: (now) => peek(now) === 'open',
        peek,
        arm(cb) {
            if (timer) return;
            timer = setTimeout(() => { timer = null; cb(); }, NATIVE_TURN_POLL_MS);
            (timer as { unref?: () => void }).unref?.();
        },
        dispose() {
            if (timer) clearTimeout(timer);
            timer = null;
            if (opts.sessionId) unregisterNativeTurnPeek(opts.sessionId);
        },
    };
}

/**
 * Veto a fired generating->idle transition while the native turn is open.
 * Pure on `ev` (returns a copy); schedules its own re-judgement via `hold.arm`.
 */
export function applyNativeTurnHold(
    ev: FsmEvaluation, spec: CliSpecV4, fromStateId: string, hold: NativeTurnHold | undefined,
    reevaluate: () => void, now = Date.now(),
): FsmEvaluation {
    if (!hold || !ev.fired) return ev;
    const from = stateById(spec, fromStateId);
    const to = stateById(spec, ev.fired.to);
    if (!from || !to || statusForState(from) !== 'generating' || statusForState(to) !== 'idle') return ev;
    if (!hold.holds(now)) return ev;
    hold.arm(reevaluate);
    return { ...ev, fired: null };
}
