/**
 * Spec evaluator — pure function.
 *
 * Given a visible screen text and a CliSpec (v3), returns:
 *   - which sections cover which line ranges
 *   - which state matched and why
 *   - extracted modal title + buttons (if any)
 *   - which control_bar entries are visible
 *   - which notifications/delegates this evaluation activates
 *   - a trace object that explains every decision (for the inspector)
 *
 * No I/O, no state. Pass prevLines for delta (changed) condition support.
 */
'use strict';

import type {
    CliSpec, SectionDef, SpecStateV3, Condition, RegexCondition,
    ChangedCondition, AllCondition, AnyCondition,
    ExtractTitle, ExtractButtons,
    ControlAction, NotificationRule, DelegateTrigger,
} from './types.js';

export interface ResolvedSection {
    id: string;
    fromLine: number;        // inclusive
    toLine: number;          // exclusive
    text: string;
}

export interface ModalSnapshot {
    title: string | null;
    buttons: { index: number; label: string; key: string }[];
}

export interface VisibleControl {
    id: string;
    label: string;
    actionType: 'send_keys' | 'open_picker' | 'attach_image';
}

export interface FiredNotification {
    id: string;
    title: string;
    body: string;
}

export interface FiredDelegate {
    id: string;
    task: string;
}

export interface TraceEntry {
    kind: 'section' | 'state_match' | 'state_skip' | 'modal' | 'control' | 'notification' | 'delegate';
    text: string;
}

export interface SpecEvaluation {
    state: { id: string; label: string; title: string | null };
    modal: ModalSnapshot | null;
    controls: VisibleControl[];
    notifications: FiredNotification[];
    delegates: FiredDelegate[];
    sections: ResolvedSection[];
    trace: TraceEntry[];
}

// ────────────────────────────────────────────────────────────────────────────
// Layout — v3 sections{} object
// ────────────────────────────────────────────────────────────────────────────

function resolveSize(size: number | string | undefined, total: number): number {
    if (size === undefined) return 0;
    if (typeof size === 'number') return Math.max(0, Math.min(total, size));
    const m = /^(\d+(?:\.\d+)?)%$/.exec(size);
    if (!m) return 0;
    const pct = Number(m[1]);
    return Math.max(0, Math.min(total, Math.round((total * pct) / 100)));
}

/**
 * Resolve v3 sections{} object into an ordered array of ResolvedSection.
 * Two-pass: first anchor/positional, then apply `until` cross-references.
 */
function resolveSections(
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
                const re = new RegExp(sec.anchor, sec.anchor_flags ?? '');
                const prevRe = sec.anchor_context?.prev !== undefined
                    ? new RegExp(sec.anchor_context.prev, sec.anchor_context.prev_flags ?? '') : null;
                const nextRe = sec.anchor_context?.next !== undefined
                    ? new RegExp(sec.anchor_context.next, sec.anchor_context.next_flags ?? '') : null;
                const matches = (i: number) =>
                    re.test(lines[i])
                    && (prevRe === null || (i > 0 && prevRe.test(lines[i - 1])))
                    && (nextRe === null || (i < total - 1 && nextRe.test(lines[i + 1])));
                let idx = -1;
                if (sec.anchor_last) {
                    for (let i = total - 1; i >= 0; i--) { if (matches(i)) { idx = i; break; } }
                } else {
                    for (let i = 0; i < total; i++) { if (matches(i)) { idx = i; break; } }
                }
                if (idx !== -1) {
                    from = idx;
                    to = total;
                    if (sec.until_regex !== undefined) {
                        // until_regex on anchor-based sections (extension field)
                        try {
                            const ure = new RegExp(sec.until_regex, sec.until_regex_flags ?? '');
                            const end = lines.findIndex((l, i) => i > idx && ure.test(l));
                            if (end !== -1) to = end;
                        } catch { /* bad until_regex */ }
                    } else if (sec.lines !== undefined) {
                        to = Math.min(total, from + sec.lines);
                    }
                    // `until` regex check on anchor sections (starts with ^)
                    // handled in second pass
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
                // `until` is a regex: stop at the first matching line after fromLine
                try {
                    const ure = new RegExp(sec.until);
                    const end = lines.findIndex((l, i) => i > fromLine && ure.test(l));
                    if (end !== -1) toLine = end;
                } catch { /* bad until regex */ }
            } else {
                // `until` is a section id reference
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

function sectionText(sections: ResolvedSection[], sectionId: string | undefined, fullScreen: string): string {
    if (!sectionId) return fullScreen;
    const found = sections.find(s => s.id === sectionId);
    return found ? found.text : '';
}

// ────────────────────────────────────────────────────────────────────────────
// Condition evaluation (v3)
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

function evaluateCondition(
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
        const endRow = cursor.row; // exclusive
        const currentSlice = curLines.slice(startRow, endRow).join('\n');
        const prevSlice = prevLines.slice(startRow, endRow).join('\n');
        const didChange = currentSlice !== prevSlice;
        // changed:false means "region is currently stable" — stable_ms duration
        // is enforced by the driver, not here.
        const result = cond.changed ? didChange : !didChange;
        trace.push({ kind: 'section', text: `state[${stateId}] changed cond cursor_above=${cond.cursor_above} rows[${startRow},${endRow}) changed=${didChange} expected=${cond.changed} result=${result}` });
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

        // Cursor-position guards
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
// State matching
// ────────────────────────────────────────────────────────────────────────────

function matchState(
    state: SpecStateV3,
    sections: ResolvedSection[],
    fullScreen: string,
    trace: TraceEntry[],
    cursor: { row: number; col: number } | undefined,
    prevLines: string[] | undefined,
): { matched: boolean; title: string | null } {
    // Support v1-shaped state.when ({ regex, section }) for backward compat
    // with test objects that don't go through the loader.
    let effectiveWhen = state.when;
    const stateAny = state as any;
    if (stateAny.when && 'regex' in stateAny.when && !('all' in stateAny.when) && !('any' in stateAny.when)) {
        effectiveWhen = normalizeV1When(stateAny.when);
    }
    const condMatched = evaluateCondition(effectiveWhen, sections, fullScreen, cursor, prevLines, trace, state.id);

    if (!condMatched) {
        trace.push({ kind: 'state_skip', text: `state[${state.id}] when condition not met` });
        return { matched: false, title: null };
    }

    trace.push({ kind: 'state_match', text: `state[${state.id}] matched` });

    let title: string | null = null;
    const stateAny2 = state as any;
    const extract = state.extract;
    // v1 compat: extract_title
    const titleRule: ExtractTitle | undefined = extract?.title
        ?? (stateAny2.extract_title ? v1ExtractTitleToV3(stateAny2.extract_title) : undefined);
    if (titleRule) {
        title = extractTitle(titleRule, sections, fullScreen);
        trace.push({ kind: 'state_match', text: `state[${state.id}] extract.title → ${title ?? '(none)'}` });
    }

    return { matched: true, title };
}

function extractTitle(
    rule: ExtractTitle,
    sections: ResolvedSection[],
    fullScreen: string,
): string | null {
    const hay = sectionText(sections, rule.section, fullScreen);
    if (!hay) return null;

    if (rule.first_line) {
        // Take the first non-separator, non-empty line
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

function extractButtonsFromRule(
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

function extractModal(
    state: SpecStateV3,
    sections: ResolvedSection[],
    fullScreen: string,
    title: string | null,
    trace: TraceEntry[],
): ModalSnapshot | null {
    const stateAny = state as any;
    // v1 compat: modal_buttons
    const buttonsRule: ExtractButtons | undefined = state.extract?.buttons
        ?? (stateAny.modal_buttons ? v1ModalButtonsToV3(stateAny.modal_buttons) : undefined);
    if (!buttonsRule) return null;

    const hay = sectionText(sections, buttonsRule.section, fullScreen);
    const minCount = buttonsRule.min_count ?? 2;
    const buttons = extractButtonsFromRule(buttonsRule, hay);

    if (buttons.length < minCount) {
        trace.push({ kind: 'modal', text: `extract.buttons matched ${buttons.length}/${minCount} required — discarded` });
        return null;
    }
    trace.push({ kind: 'modal', text: `extract.buttons matched ${buttons.length} choices` });
    return { title, buttons };
}

// ────────────────────────────────────────────────────────────────────────────
// v1 backward-compat helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Convert a v1 sections array to a v3 sections object (for inline test specs
 * that bypass the loader and thus the migration path).
 */
function buildSectionsMapFromV1(v1Sections: any[]): Record<string, SectionDef> {
    const map: Record<string, SectionDef> = {};
    for (const sec of v1Sections) {
        const { id, anchor_regex, ...rest } = sec;
        const def: SectionDef = { ...rest };
        if (anchor_regex) def.anchor = anchor_regex;
        // v1 until: { section: id } → v3 until: id
        if (rest.until?.section) def.until = rest.until.section;
        else if (rest.until && typeof rest.until === 'string') def.until = rest.until;
        else delete (def as any).until;
        map[id] = def;
    }
    return map;
}

/** Convert v1 SectionRegex (when.regex) to v3 AllCondition. */
function normalizeV1When(v1When: any): AllCondition {
    if (v1When?.cursor_above_lines && v1When?.changed) {
        return { all: [{ cursor_above: v1When.cursor_above_lines, changed: true as const }] };
    }
    const cond: any = { matches: v1When.regex };
    if (v1When.section) cond.section = v1When.section;
    if (v1When.flags) cond.flags = v1When.flags;
    if (v1When.cursor_row_min !== undefined) cond.cursor_row_min = v1When.cursor_row_min;
    if (v1When.cursor_row_max !== undefined) cond.cursor_row_max = v1When.cursor_row_max;
    if (v1When.cursor_col_min !== undefined) cond.cursor_col_min = v1When.cursor_col_min;
    if (v1When.cursor_col_max !== undefined) cond.cursor_col_max = v1When.cursor_col_max;
    return { all: [cond] };
}

/** Convert v1 extract_title to v3 ExtractTitle. */
function v1ExtractTitleToV3(v1: any): ExtractTitle {
    if (v1.first_line) return { section: v1.section, first_line: true };
    return { section: v1.section, regex: v1.regex, flags: v1.flags };
}

/** Convert v1 modal_buttons to v3 ExtractButtons. */
function v1ModalButtonsToV3(v1: any): ExtractButtons | undefined {
    // Use first pattern from patterns[] or single pattern
    const pat = v1.patterns?.length ? v1.patterns[0].pattern : v1.pattern;
    if (!pat) return undefined;
    const flg = v1.patterns?.length ? v1.patterns[0].flags : v1.flags;
    return {
        section: v1.section,
        pattern: pat,
        flags: flg,
        key_for_index: v1.key_for_index,
        min_count: v1.min_count,
        continuation_lines: v1.continuation_lines,
    };
}

// ────────────────────────────────────────────────────────────────────────────
// Public evaluator
// ────────────────────────────────────────────────────────────────────────────

export function evaluate(
    spec: CliSpec,
    screenText: string,
    /** Optional cursor position (0-based row and col). */
    cursor?: { row: number; col: number },
    /** Optional previous screen lines for `changed` condition detection. */
    prevLines?: string[],
): SpecEvaluation {
    const trace: TraceEntry[] = [];
    const lines = screenText.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l);
    const cleanScreen = lines.join('\n');

    // Support both v3 (sections{}) and v1-shaped objects (layout.sections[])
    // The v1 path exists for tests that build raw spec objects without going
    // through the loader (which would normally migrate v1 → v3).
    const specAny = spec as any;
    const effectiveSectionsMap: Record<string, SectionDef> = spec.sections
        ?? buildSectionsMapFromV1(specAny.layout?.sections ?? []);
    const sections = resolveSections(effectiveSectionsMap, lines);

    for (const s of sections) {
        trace.push({ kind: 'section', text: `section[${s.id}] lines [${s.fromLine}, ${s.toLine}) (${s.toLine - s.fromLine} lines)` });
    }
    if (cursor !== undefined) {
        trace.push({ kind: 'section', text: `cursor (${cursor.row}, ${cursor.col})` });
    }

    let activeState: { id: string; label: string; title: string | null } | null = null;
    let modal: ModalSnapshot | null = null;

    for (const st of spec.states) {
        const { matched, title } = matchState(st, sections, cleanScreen, trace, cursor, prevLines);
        if (!matched) continue;
        const extractedModal = extractModal(st, sections, cleanScreen, title, trace);
        // If the state declares extract.buttons (or v1 modal_buttons) but
        // extraction failed, don't promote the state (avoids phantom approvals).
        const stAny = st as any;
        if ((st.extract?.buttons || stAny.modal_buttons) && !extractedModal) {
            trace.push({ kind: 'state_skip', text: `state[${st.id}] matched but extract.buttons failed — not promoting` });
            continue;
        }
        activeState = { id: st.id, label: st.label, title };
        modal = extractedModal;
        break;
    }

    if (!activeState) {
        const def = spec.states.find(s => s.id === spec.default_state);
        if (def) {
            activeState = { id: def.id, label: def.label, title: null };
            trace.push({ kind: 'state_match', text: `(no state matched — fallback to default_state ${def.id})` });
        } else {
            activeState = { id: spec.default_state, label: spec.default_state, title: null };
            trace.push({ kind: 'state_match', text: `(no state matched, no default_state defined — using id "${spec.default_state}")` });
        }
    }

    const controls: VisibleControl[] = [];
    for (const c of spec.control_bar ?? []) {
        const visible = !c.visible_when_state || c.visible_when_state.includes(activeState.id);
        trace.push({ kind: 'control', text: `control[${c.id}] visible=${visible}${c.visible_when_state ? ` (when_state ${c.visible_when_state.join('|')})` : ''}` });
        if (visible) controls.push({ id: c.id, label: c.label, actionType: c.action.type });
    }

    const notifications: FiredNotification[] = [];
    for (const n of spec.notifications ?? []) {
        if (n.when_state !== activeState.id) continue;
        const body = interpolate(n.body ?? '', activeState, sections);
        notifications.push({ id: n.id, title: n.title, body });
        trace.push({ kind: 'notification', text: `notification[${n.id}] fired (when_state=${n.when_state})` });
    }

    const delegates: FiredDelegate[] = [];
    for (const d of spec.delegate ?? []) {
        if (d.when_state !== activeState.id) continue;
        delegates.push({ id: d.id, task: interpolate(d.task_template, activeState, sections) });
    }

    return {
        state: activeState,
        modal,
        controls,
        notifications,
        delegates,
        sections,
        trace,
    };
}

function interpolate(
    template: string,
    state: { id: string; label: string; title: string | null },
    sections: ResolvedSection[],
): string {
    return template
        .replace(/\{state\.label\}/g, state.label)
        .replace(/\{state\.title\}/g, state.title ?? '')
        .replace(/\{state\.id\}/g, state.id)
        .replace(/\{screen\.([a-z][a-z0-9_]*)\}/g, (_, id: string) => {
            const s = sections.find(s => s.id === id);
            return s ? s.text : '';
        });
}
