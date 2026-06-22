/**
 * Section + condition evaluator — pure functions shared by the v4 FSM engine.
 *
 * Provides: section resolution, condition evaluation (regex/changed/all/any),
 * title/button extraction. The v4 FSM driver and evaluator import these
 * directly; there is no v3 SpecDriver anymore.
 */
'use strict';

import type {
    SectionDef, AnchorContext, Condition, RegexCondition,
    ChangedCondition, AllCondition, AnyCondition,
    ExtractTitle, ExtractButtons,
} from './types.js';

export interface ResolvedSection {
    id: string;
    fromLine: number;        // inclusive
    toLine: number;          // exclusive
    text: string;
}

export interface TraceEntry {
    kind: 'section' | 'state_match' | 'state_skip' | 'modal' | 'control' | 'notification' | 'delegate';
    text: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Layout — sections{} object
// ────────────────────────────────────────────────────────────────────────────

function resolveSize(size: number | string | undefined, total: number): number {
    if (size === undefined) return 0;
    if (typeof size === 'number') return Math.max(0, Math.min(total, size));
    const m = /^(\d+(?:\.\d+)?)%$/.exec(size);
    if (!m) return 0;
    const pct = Number(m[1]);
    return Math.max(0, Math.min(total, Math.round((total * pct) / 100)));
}

export function resolveSections(
    sectionsObj: Record<string, SectionDef>,
    lines: string[],
): ResolvedSection[] {
    const total = lines.length;
    const anchored = new Map<string, { fromLine: number; toLine: number }>();
    const sectionEntries = Object.entries(sectionsObj);

    for (const [id, sec] of sectionEntries) {
        let from = 0;
        let to = total;

        if (sec.anchor !== undefined) {
            try {
                // Normalize anchor + context into parallel candidate lists. A
                // scalar anchor becomes a single-entry array; a single context
                // object applies to every entry; an array context is positional.
                // Each candidate resolves its own anchor line independently
                // (anchor_last → that candidate's LAST matching line, else its
                // FIRST). Across candidates we then pick the TOPMOST resolved
                // line, because a section's anchor marks the TOP of the block:
                // among several recognized landmark shapes, the highest one
                // bounds the whole block. This keeps a scalar anchor identical
                // (one candidate), preserves a genuine box-top divider (it sits
                // ABOVE the question line, so it still wins), and — crucially —
                // stops a stray lower landmark from clipping the block: e.g. a
                // claude approval whose numbered choices sit ABOVE the input-box
                // `────` rule. anchor_last on the bare-divider pattern alone
                // would latch that LOWER chrome rule and strand the buttons
                // above it (deriveModal sees < min_count → auto-approve never
                // fires); preferring the topmost landmark (here the question
                // line just above the choices, matched by the fallback context)
                // captures the whole modal. The fallback still only contributes
                // when its own pattern matches, so non-modal screens are
                // unaffected.
                const anchorPatterns = Array.isArray(sec.anchor) ? sec.anchor : [sec.anchor];
                const sharedCtx: AnchorContext | null = Array.isArray(sec.anchor_context)
                    ? null
                    : (sec.anchor_context ?? null);
                const ctxList: (AnchorContext | null)[] = Array.isArray(sec.anchor_context)
                    ? sec.anchor_context
                    : anchorPatterns.map(() => sharedCtx);
                const candidates = anchorPatterns.map((pattern, k) => {
                    const ctx = ctxList[k] ?? null;
                    return {
                        re: new RegExp(pattern, sec.anchor_flags ?? ''),
                        prevRe: ctx?.prev !== undefined
                            ? new RegExp(ctx.prev, ctx.prev_flags ?? '') : null,
                        nextRe: ctx?.next !== undefined
                            ? new RegExp(ctx.next, ctx.next_flags ?? '') : null,
                    };
                });
                const matchesCandidate = (c: typeof candidates[number], i: number) =>
                    c.re.test(lines[i])
                    && (c.prevRe === null || (i > 0 && c.prevRe.test(lines[i - 1])))
                    && (c.nextRe === null || (i < total - 1 && c.nextRe.test(lines[i + 1])));
                let idx = -1;
                for (const c of candidates) {
                    let candIdx = -1;
                    if (sec.anchor_last) {
                        for (let i = total - 1; i >= 0; i--) { if (matchesCandidate(c, i)) { candIdx = i; break; } }
                    } else {
                        for (let i = 0; i < total; i++) { if (matchesCandidate(c, i)) { candIdx = i; break; } }
                    }
                    // Topmost resolved anchor across candidates wins (see note
                    // above): keep the smallest matching line index.
                    if (candIdx !== -1 && (idx === -1 || candIdx < idx)) idx = candIdx;
                }
                if (idx !== -1) {
                    from = idx;
                    to = total;
                    if (sec.until_regex !== undefined) {
                        try {
                            const ure = new RegExp(sec.until_regex, sec.until_regex_flags ?? '');
                            const end = lines.findIndex((l, i) => i > idx && ure.test(l));
                            if (end !== -1) to = end;
                        } catch { /* bad until_regex */ }
                    } else if (sec.lines !== undefined) {
                        to = Math.min(total, from + sec.lines);
                    }
                }
            } catch { /* bad anchor regex */ }
        } else if (sec.from_top !== undefined) {
            from = resolveSize(sec.from_top, total);
            to = total;
        } else if (sec.from_bottom !== undefined) {
            const sz = resolveSize(sec.from_bottom, total);
            from = total - sz;
            to = total;
        }

        anchored.set(id, { fromLine: from, toLine: to });
    }

    // Second pass: apply `until` references or `until` regex strings.
    const resolved: ResolvedSection[] = [];
    for (const [id, sec] of sectionEntries) {
        let { fromLine, toLine } = anchored.get(id)!;

        if (sec.until !== undefined) {
            if (sec.until.startsWith('^')) {
                try {
                    const ure = new RegExp(sec.until);
                    const end = lines.findIndex((l, i) => i > fromLine && ure.test(l));
                    if (end !== -1) toLine = end;
                } catch { /* bad until regex */ }
            } else {
                const target = anchored.get(sec.until);
                if (target) toLine = target.fromLine;
            }
        }

        if (toLine < fromLine) toLine = fromLine;
        const text = lines.slice(fromLine, toLine).join('\n');
        resolved.push({ id, fromLine, toLine, text });
    }

    return resolved;
}

export function sectionText(sections: ResolvedSection[], sectionId: string | undefined, fullScreen: string): string {
    if (!sectionId) return fullScreen;
    const found = sections.find(s => s.id === sectionId);
    return found ? found.text : '';
}

// ────────────────────────────────────────────────────────────────────────────
// Condition evaluation
// ────────────────────────────────────────────────────────────────────────────

function isRegexCondition(c: Condition): c is RegexCondition {
    return 'matches' in c;
}

function isChangedCondition(c: Condition): c is ChangedCondition {
    return 'cursor_above' in c && 'changed' in c;
}

function isAllCondition(c: Condition): c is AllCondition {
    return 'all' in c;
}

function isAnyCondition(c: Condition): c is AnyCondition {
    return 'any' in c;
}

export function evaluateCondition(
    cond: Condition,
    sections: ResolvedSection[],
    fullScreen: string,
    cursor: { row: number; col: number } | undefined,
    prevLines: string[] | undefined,
    trace: TraceEntry[],
    stateId: string,
): boolean {
    if (isAllCondition(cond)) {
        for (const child of cond.all) {
            if (!evaluateCondition(child, sections, fullScreen, cursor, prevLines, trace, stateId)) {
                return false;
            }
        }
        return true;
    }

    if (isAnyCondition(cond)) {
        for (const child of cond.any) {
            if (evaluateCondition(child, sections, fullScreen, cursor, prevLines, trace, stateId)) {
                return true;
            }
        }
        return false;
    }

    if (isChangedCondition(cond)) {
        if (!cursor || !prevLines || prevLines.length === 0) return false;
        const curLines = fullScreen.split('\n');
        const startRow = Math.max(0, cursor.row - cond.cursor_above);
        const endRow = cursor.row;
        const currentSlice = curLines.slice(startRow, endRow).join('\n');
        const prevSlice = prevLines.slice(startRow, endRow).join('\n');
        const didChange = currentSlice !== prevSlice;
        const result = cond.changed ? didChange : !didChange;
        const stableSuffix = cond.stable_ms != null ? ` stable_ms=${cond.stable_ms}` : '';
        trace.push({
            kind: result ? 'state_match' : 'state_skip',
            text: `state[${stateId}] changed cond cursor_above=${cond.cursor_above} rows[${startRow},${endRow}) changed=${didChange} expected=${cond.changed}${stableSuffix} result=${result}`,
        });
        return result;
    }

    if (isRegexCondition(cond)) {
        const haystack = sectionText(sections, cond.section, fullScreen);
        let matched = false;
        try {
            const re = new RegExp(cond.matches, cond.flags ?? 'i');
            matched = re.test(haystack);
        } catch { matched = false; }

        if (!matched) {
            trace.push({ kind: 'state_skip', text: `state[${stateId}] regex cond ${cond.section ?? '*'}~/${cond.matches}/ no match` });
            return false;
        }

        if (cursor !== undefined) {
            if (cond.cursor_row_min !== undefined && cursor.row < cond.cursor_row_min) {
                trace.push({ kind: 'state_skip', text: `state[${stateId}] cursor row ${cursor.row} < cursor_row_min ${cond.cursor_row_min}` });
                return false;
            }
            if (cond.cursor_row_max !== undefined && cursor.row > cond.cursor_row_max) {
                trace.push({ kind: 'state_skip', text: `state[${stateId}] cursor row ${cursor.row} > cursor_row_max ${cond.cursor_row_max}` });
                return false;
            }
            if (cond.cursor_col_min !== undefined && cursor.col < cond.cursor_col_min) {
                trace.push({ kind: 'state_skip', text: `state[${stateId}] cursor col ${cursor.col} < cursor_col_min ${cond.cursor_col_min}` });
                return false;
            }
            if (cond.cursor_col_max !== undefined && cursor.col > cond.cursor_col_max) {
                trace.push({ kind: 'state_skip', text: `state[${stateId}] cursor col ${cursor.col} > cursor_col_max ${cond.cursor_col_max}` });
                return false;
            }
        }

        trace.push({ kind: 'state_match', text: `state[${stateId}] regex cond ${cond.section ?? '*'}~/${cond.matches}/ matched${cursor !== undefined ? ` cursor=(${cursor.row},${cursor.col})` : ''}` });
        return true;
    }

    return false;
}

// ────────────────────────────────────────────────────────────────────────────
// Extraction helpers (used by FsmDriver for modal/title)
// ────────────────────────────────────────────────────────────────────────────

export function extractTitle(
    rule: ExtractTitle,
    sections: ResolvedSection[],
    fullScreen: string,
): string | null {
    const hay = sectionText(sections, rule.section, fullScreen);
    if (!hay) return null;

    if (rule.first_line) {
        const lines = hay.split('\n');
        for (const line of lines) {
            const stripped = line.trim();
            if (stripped && !/^[─╌═─\s]+$/.test(stripped)) {
                return stripped;
            }
        }
        return null;
    }

    if (rule.regex) {
        try {
            const re = new RegExp(rule.regex, rule.flags ?? 'i');
            const m = re.exec(hay);
            if (m) return (m[1] ?? m[0]).trim();
        } catch { /* bad regex */ }
    }

    return null;
}

function compilePattern(ref: { pattern: string; flags?: string }): RegExp {
    const flags = ref.flags ?? 'gm';
    return new RegExp(ref.pattern, flags.includes('g') ? flags : flags + 'g');
}

function compileLinePattern(ref: { pattern: string; flags?: string }): RegExp {
    const flags = (ref.flags ?? 'm').replace(/g/g, '');
    return new RegExp(ref.pattern, flags);
}

export function extractButtonsFromRule(
    rule: ExtractButtons,
    hay: string,
): { index: number; label: string; key: string }[] {
    const keyTemplate = rule.key_for_index;
    const continuationLines = rule.continuation_lines ?? false;
    const buttons: { index: number; label: string; key: string }[] = [];

    if (continuationLines) {
        const re = compileLinePattern(rule);
        const lines = hay.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
            const m = re.exec(lines[i]);
            if (!m) continue;
            const idx = Number(m[1]);
            let label = String(m[2] ?? '').trim();
            if (!Number.isFinite(idx) || idx <= 0 || !label) continue;
            let j = i + 1;
            while (j < lines.length) {
                const next = lines[j];
                if (!next.trim()) break;
                if (re.test(next)) break;
                if (!/^\s+/.test(next)) break;
                label += ' ' + next.trim();
                j += 1;
            }
            if (buttons.some(b => b.index === idx)) continue;
            const key = keyTemplate.replace(/\{index\}/g, String(idx));
            buttons.push({ index: idx, label, key });
            i = j - 1;
        }
    } else {
        const re = compilePattern(rule);
        let m: RegExpExecArray | null;
        while ((m = re.exec(hay)) !== null) {
            const idx = Number(m[1]);
            const label = String(m[2] ?? '').trim();
            if (!Number.isFinite(idx) || idx <= 0 || !label) continue;
            if (buttons.some(b => b.index === idx)) continue;
            const key = keyTemplate.replace(/\{index\}/g, String(idx));
            buttons.push({ index: idx, label, key });
        }
    }

    buttons.sort((a, b) => a.index - b.index);
    return buttons;
}
