/**
 * Frame bookkeeping for the FSM driver: the scrollback-extended guard frame,
 * per-region change clocks behind `stable_ms` conditions, and the small pure
 * helpers the driver uses to compare / summarize evaluations.
 *
 * Split out of fsm-driver.ts (file-size gate). Everything here is a pure
 * function of its arguments — the driver owns the state and passes it in.
 */
import { resolveSections, type ResolvedSection } from './evaluator.js';
import { stableRegionKey, type CondResult, type TransitionEval } from './fsm-evaluator.js';
import { outgoingTransitions, type CliSpecV4, type FsmTransition } from './fsm-types.js';
import type { ModalSnapshot, VisibleControl } from './fsm-driver-types.js';
import { recordDebugTrace } from '../../logging/debug-trace.js';
import { shouldCollectTraceCategory } from '../../logging/debug-config.js';

/**
 * APPROVAL-WAIT-BLINDSPOT fix ③ — how many scrollback lines a transition
 * guard may look ABOVE the viewport.
 *
 * Bounded on purpose. `snapshotWithScrollback()` can return the session's
 * whole history (thousands of lines), and every transition guard on every
 * PTY frame re-runs `resolveSections` + each regex over whatever it is
 * handed — during generating that is many frames per second. Feeding it an
 * unbounded buffer would turn a per-frame O(viewport) scan into O(session),
 * degrading as the session ages: the classic fix that works on a fresh
 * session and melts after an hour.
 *
 * 200 lines is ~2–3 viewport heights at a normal terminal size, which is the
 * scale of the problem being solved (a modal whose box-top anchor is pushed
 * a screenful or two above the viewport by a tall diff). A modal taller than
 * that is not recoverable by looking further up anyway — its own choices
 * would have scrolled off too.
 */
const GUARD_SCROLLBACK_LOOKBACK_LINES = 200;

/**
 * Build the frame a transition guard is evaluated against.
 *
 * APPROVAL-WAIT-BLINDSPOT fix ③ (live defect, 2026-09-22). Until now
 * `deriveModal` read a SCROLLBACK-inclusive buffer (so a tall approval's
 * off-screen box-top anchor still matched) while the transition guards that
 * decide whether we are even IN the approval state read the VIEWPORT only.
 * The two halves disagreed exactly when it mattered: a tall modal pushed the
 * `─────` anchor above the viewport, the `→approval` guard's section
 * resolved empty, and the transition never fired. Measured cost was a
 * `waiting_approval` that arrived 4 minutes late — by which time the task had
 * already been reaped and the event was discarded as `stale`.
 *
 * So the guards now read the same class of buffer the extraction does. Two
 * things must be preserved while doing it, and both are why this is a helper
 * rather than a one-line swap to `scrollbackLines()`:
 *
 *  1. CURSOR ROWS STAY ALIGNED. `cursor.row` is viewport-relative, and
 *     `cursor_above` (used by codex/antigravity/claude/hermes busy→idle
 *     guards) slices `lines[cursor.row - N .. cursor.row]`. Prepending K
 *     scrollback lines without rebasing the cursor would silently slide that
 *     window K lines up the screen and compare the wrong region — turning a
 *     stability check into noise. The cursor is therefore shifted by exactly
 *     the number of prepended lines, making the slice byte-identical to the
 *     viewport-only one.
 *  2. `prevScreenLines` MUST BE TRACKED ON THE SAME BASIS. A `changed`
 *     condition diffs current vs previous at the same row indices; mixing an
 *     extended current frame with a viewport-only previous frame would
 *     report "changed" on every frame purely from the offset. The caller
 *     stores the same extended lines it evaluates (see FsmDriver.reevaluate()).
 *
 * Falls back to the plain viewport whenever scrollback is unavailable or
 * adds nothing, so a driver without scrollback support behaves exactly as
 * before.
 */
export function buildGuardFrame(
    viewportScreen: string,
    cursor: { row: number; col: number },
    readScrollbackLines: () => string[],
): {
    screen: string;
    lines: string[];
    cursor: { row: number; col: number };
} {
    const viewportLines = viewportScreen.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l);
    let full: string[];
    try {
        full = readScrollbackLines();
    } catch {
        return { screen: viewportScreen, lines: viewportLines, cursor };
    }
    // The viewport is the TAIL of the scrollback-inclusive buffer. Anything
    // else (scrollback read failed, returned the viewport verbatim, or is
    // somehow shorter) means there is nothing extra to look at.
    const extraLines = full.length - viewportLines.length;
    if (extraLines <= 0) return { screen: viewportScreen, lines: viewportLines, cursor };
    // ★Pad to a FIXED lookback rather than using however much scrollback
    // happens to exist right now. `changed` conditions diff the current
    // frame against `prevScreenLines` at the SAME ABSOLUTE row indices, so a
    // lookback that grew by even one line between two frames would shift
    // every row and report the whole region as changed — a `stable_ms` guard
    // would then never settle and the session would wedge in busy (the
    // BUSY-IDLE-BOUNDED-FALLBACK family of defects, re-introduced through
    // the back door). Padding with blank lines keeps the frame height
    // constant from the very first frame, so row indices are stable for the
    // whole session and the cursor rebase below is a single constant.
    const available = Math.min(extraLines, GUARD_SCROLLBACK_LOOKBACK_LINES);
    const lookback = GUARD_SCROLLBACK_LOOKBACK_LINES;
    const pad = new Array(lookback - available).fill('');
    const lines = [...pad, ...full.slice(full.length - viewportLines.length - available)];
    return {
        screen: lines.join('\n'),
        lines,
        // Rebase: the viewport's row 0 now sits `lookback` lines down. Fixed,
        // so `cursor_above` slices land on exactly the same screen content
        // they did before this change.
        cursor: { row: cursor.row + lookback, col: cursor.col },
    };
}

/** The driver-owned clocks trackRegionChanges reads and advances. The maps are
 *  mutated in place; `prevLines` is the previous guard frame. */
export interface RegionClockState {
    spec: CliSpecV4;
    stateId: string;
    stateEnteredAt: number;
    prevLines: string[];
    regionLastChangedAt: Map<number | string, number>;
    stableVerdictCache: Map<number | string, boolean>;
}

/** Track which stable regions changed since the previous frame so
 *  stable_ms conditions can measure quiet time. We record every distinct
 *  stable region referenced in the current state (numeric cursor_above /
 *  whole-screen -1, and named `section:<id>` regions) plus, for each, the
 *  optional `ignore_lines` filter that folds into its key.
 *
 *  `ignore_lines` is the content-aware fix for the busy→idle wedge: lines
 *  matching it are stripped from BOTH frames before the comparison, so a
 *  benign residual ticker (bare token counter / elapsed timer that repaints
 *  every frame post-generation) no longer resets the clock — while an active
 *  spinner line, which does NOT match the benign pattern, still does (the
 *  FALSEIDLE2 / FALSEBUSY-B whole-screen invariant is preserved). */
export function trackRegionChanges(st: RegionClockState, currentLines: string[], cursor: { row: number; col: number }, now: number): void {
    if (st.prevLines.length === 0) return;
    const descs = stableRegionDescriptors(st.spec, st.stateId);
    // COMPLETION-EARLYNOTIFY hook 4: record the stable/not-stable verdict for each
    // tracked region, but ONLY when the verdict flips (see stableVerdictCache) so a
    // quiet screen does not spam the ring buffer. This is the case-b diagnostic — an
    // ignore_lines-scoped stable clause declaring a tool-execution screen "stable-idle"
    // shows up here as verdict:true with a short fingerprint. Payload carries lengths
    // and the pattern SOURCE only — never screen text.
    const stableTraceOn = shouldCollectTraceCategory('fsm-transition');
    // Section ranges depend on screen content, so resolve per-frame for both
    // frames — but only when some tracked region is actually section-scoped.
    const needsSections = descs.some(d => !!d.section);
    const curSections = needsSections ? resolveSections(st.spec.sections ?? {}, currentLines) : [];
    const prevSections = needsSections ? resolveSections(st.spec.sections ?? {}, st.prevLines) : [];
    for (const d of descs) {
        let curLines: string[]; let prevLines: string[];
        if (d.section) {
            curLines = sliceSectionLines(currentLines, curSections, d.section);
            prevLines = sliceSectionLines(st.prevLines, prevSections, d.section);
        } else if (!d.cursor_above || d.cursor_above <= 0) {
            curLines = currentLines;
            prevLines = st.prevLines;
        } else {
            // CODEX-FSM-DEGENERATE-STABLE fix: cursor.row is the backend's RAW
            // row coordinate (ghostty getCursorPosition(), un-normalized), while
            // currentLines is the VIEWPORT snapshot with blank ends trimmed
            // (ghostty-vt-backend getText → trimBlankEnds). The two coordinate
            // spaces diverge whenever trailing blank rows are trimmed away (or
            // the backend counts scrollback rows): cursor.row then overshoots
            // the array and slice(start, cursor.row) returns an EMPTY window.
            // Two empty windows compare equal on every frame, so
            // regionLastChangedAt never advances and stable_ms accumulates
            // forever — the FSM read a generating screen as
            // "stable cursor_above=4 353833ms / 1500ms" and committed a false
            // busy→idle (live RCA: generating_completed at duration=402s while
            // the native transcript kept growing).
            //
            // Invariant: an unmeasurable window must NEVER read as "stable".
            // Clamp the window end to the content length (when the cursor sits
            // in the trimmed blank region, the lines directly above it in
            // content terms are the content tail), and when the window is still
            // empty (no measurable content at all) mark the region CHANGED so
            // the stable clock restarts instead of accumulating.
            const window = stableCursorWindow(currentLines.length, cursor.row, d.cursor_above);
            if (!window) {
                st.regionLastChangedAt.set(d.key, now);
                continue;
            }
            curLines = currentLines.slice(window.start, window.end);
            prevLines = st.prevLines.slice(window.start, window.end);
        }
        const cur = filterIgnoredLines(curLines, d.ignoreRe).join('\n');
        const prev = filterIgnoredLines(prevLines, d.ignoreRe).join('\n');
        if (cur !== prev) st.regionLastChangedAt.set(d.key, now);
        if (stableTraceOn && typeof d.holdMs === 'number') {
            const lastChanged = st.regionLastChangedAt.get(d.key) ?? st.stateEnteredAt;
            const ageMs = now - lastChanged;
            const verdict = ageMs >= d.holdMs;
            if (st.stableVerdictCache.get(d.key) !== verdict) {
                st.stableVerdictCache.set(d.key, verdict);
                recordDebugTrace({
                    category: 'fsm-transition',
                    stage: 'stable-eval',
                    level: 'debug',
                    payload: {
                        state: st.stateId,
                        regionKey: String(d.key),
                        ignorePattern: d.ignoreRe?.source ?? null,
                        fingerprintLen: cur.length,
                        ageMs,
                        holdMs: d.holdMs,
                        verdict,
                    },
                });
            }
        }
    }
}

/** Every distinct stable-region descriptor referenced by stable_ms
 *  conditions in the current state's outgoing transitions, plus the plain
 *  whole-screen key (-1) that other machinery (stall watchdog) reads.
 *  De-duplicated by key. Cached lazily per spec load would be nicer but the
 *  set is tiny. */
export function stableRegionDescriptors(spec: CliSpecV4, stateId: string): StableRegionDescriptor[] {
    const byKey = new Map<number | string, StableRegionDescriptor>();
    byKey.set(-1, { key: -1 });
    for (const t of outgoingTransitions(spec, stateId)) {
        collectStableDescriptors(t.when, byKey);
    }
    return [...byKey.values()];
}

export function sameModal(a: ModalSnapshot | null, b: ModalSnapshot | null): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    if (a.title !== b.title) return false;
    if (a.buttons.length !== b.buttons.length) return false;
    for (let i = 0; i < a.buttons.length; i += 1) {
        if (a.buttons[i].label !== b.buttons[i].label) return false;
    }
    return true;
}

export function sameControls(a: VisibleControl[], b: VisibleControl[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (a[i].id !== b[i].id) return false;
    return true;
}

/** A compact one-line-per-condition summary of why a transition fired. */
export function summarizeTransition(t: TransitionEval): string[] {
    const out: string[] = [`${t.label} fired`];
    if (t.cond) flattenCond(t.cond, out, 1);
    return out;
}

function flattenCond(c: CondResult, out: string[], depth: number): void {
    const matched = c.matchedText ? ` matched=${JSON.stringify(c.matchedText)}` : '';
    out.push(`${'  '.repeat(depth)}${c.kind} ${c.detail} = ${c.result}${c.remainingMs ? ` (${c.remainingMs}ms left)` : ''}${matched}`);
    for (const child of c.children ?? []) flattenCond(child, out, depth + 1);
}

export function findStable(c: CondResult): { totalMs: number } | null {
    if (c.kind === 'stable') {
        const m = /\/ (\d+)ms/.exec(c.detail);
        return { totalMs: m ? Number(m[1]) : 0 };
    }
    for (const child of c.children ?? []) {
        const r = findStable(child);
        if (r) return r;
    }
    return null;
}

/** Resolved description of one stable region the driver must track: its map
 *  key, the geometry (section / cursor_above / whole-screen), and a compiled
 *  `ignore_lines` matcher. */
export interface StableRegionDescriptor {
    key: number | string;
    section?: string;
    cursor_above?: number;
    ignoreRe?: RegExp;
    /** The stable_ms threshold the FIRST clause on this region declares. Used
     *  only by the COMPLETION-EARLYNOTIFY stable-eval trace to report the
     *  stable/not-stable verdict; the FSM decision itself is owned by the
     *  evaluator against the live clause. */
    holdMs?: number;
}

function collectStableDescriptors(when: FsmTransition['when'], byKey: Map<number | string, StableRegionDescriptor>): void {
    if (!when) return;
    const w = when as any;
    if ('stable_ms' in w) {
        const key = stableRegionKey(w);
        const existing = byKey.get(key);
        if (!existing) {
            let ignoreRe: RegExp | undefined;
            if (w.ignore_lines) {
                // Compile once here; a bad pattern is validated at load time, so
                // this is best-effort and simply skips the filter if it throws.
                try { ignoreRe = new RegExp(w.ignore_lines, 'm'); } catch { /* validated at load */ }
            }
            byKey.set(key, { key, section: w.section, cursor_above: w.cursor_above, ignoreRe, holdMs: typeof w.stable_ms === 'number' ? w.stable_ms : undefined });
        } else if (existing.holdMs === undefined && typeof w.stable_ms === 'number') {
            // Enrich the -1 whole-screen seed (or an earlier clause) with a threshold
            // so its verdict can be traced. Geometry/ignoreRe from the first set win.
            existing.holdMs = w.stable_ms;
        }
        return;
    }
    if ('all' in w) { for (const c of w.all) collectStableDescriptors(c, byKey); return; }
    if ('any' in w) { for (const c of w.any) collectStableDescriptors(c, byKey); return; }
    if ('not' in w) { collectStableDescriptors(w.not, byKey); return; }
}

/** Lines of section `id` on the given frame, or [] if that section is absent
 *  this frame. Used to compute per-frame change of a section-scoped stable
 *  region. */
function sliceSectionLines(lines: string[], sections: ResolvedSection[], id: string): string[] {
    const sec = sections.find(s => s.id === id);
    if (!sec) return [];
    return lines.slice(sec.fromLine, sec.toLine);
}

/** Drop lines matching `ignoreRe` so a per-frame repaint confined to them does
 *  not register as a region change. No filter → lines returned unchanged.
 *  Exported for unit tests of the stable_ms `ignore_lines` change-detection. */
export function filterIgnoredLines(lines: string[], ignoreRe: RegExp | undefined): string[] {
    if (!ignoreRe) return lines;
    return lines.filter(l => !ignoreRe.test(l));
}

/** Compute the [start, end) line window a cursor_above stable region measures,
 *  reconciling the backend's raw cursor row with the blank-trimmed viewport
 *  line array (see the CODEX-FSM-DEGENERATE-STABLE note in trackRegionChanges).
 *  The window end is clamped to the content length so an overshooting cursor
 *  row measures the content tail instead of slicing past the array into a
 *  permanently-empty — and therefore permanently "unchanged" — window.
 *  Returns null when no measurable window exists (cursor at/above row 0, or no
 *  content): the caller must treat the region as CHANGED, never stable.
 *  Exported for unit tests. */
export function stableCursorWindow(lineCount: number, cursorRow: number, cursorAbove: number): { start: number; end: number } | null {
    const end = Math.min(Math.max(0, cursorRow), Math.max(0, lineCount));
    const start = Math.max(0, end - cursorAbove);
    if (end <= start) return null;
    return { start, end };
}
