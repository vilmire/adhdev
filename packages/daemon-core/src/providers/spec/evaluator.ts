/**
 * Spec evaluator — pure function.
 *
 * Given a visible screen text and a CliSpec, returns:
 *   - which sections cover which line ranges
 *   - which state matched and why
 *   - extracted modal title + buttons (if any)
 *   - which control_bar entries are visible
 *   - which notifications/delegates this evaluation activates
 *   - a trace object that explains every decision (for the inspector)
 *
 * No I/O, no state.
 */
'use strict';

import type {
    CliSpec, Section, SectionRegex, SectionPattern, SpecState,
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
// Layout
// ────────────────────────────────────────────────────────────────────────────

function resolveSize(size: number | string | undefined, total: number): number {
    if (size === undefined) return 0;
    if (typeof size === 'number') return Math.max(0, Math.min(total, size));
    const m = /^(\d+(?:\.\d+)?)%$/.exec(size);
    if (!m) return 0;
    const pct = Number(m[1]);
    return Math.max(0, Math.min(total, Math.round((total * pct) / 100)));
}

function resolveSections(spec: CliSpec, lines: string[]): ResolvedSection[] {
    const total = lines.length;
    const resolved: ResolvedSection[] = [];
    // Two-pass: first resolve from_top / from_bottom without `until`.
    const anchored = new Map<string, { fromLine: number; toLine: number }>();

    for (const sec of spec.layout.sections) {
        let from = 0;
        let to = total;
        if (sec.from_top !== undefined) {
            from = resolveSize(sec.from_top, total);
        }
        if (sec.from_bottom !== undefined) {
            const sz = resolveSize(sec.from_bottom, total);
            from = total - sz;
            to = total;
        }
        anchored.set(sec.id, { fromLine: from, toLine: to });
    }

    // Second pass: apply `until` references.
    for (const sec of spec.layout.sections) {
        let { fromLine, toLine } = anchored.get(sec.id)!;
        if (sec.until) {
            const target = anchored.get(sec.until.section);
            if (target) toLine = target.fromLine;
        }
        if (toLine < fromLine) toLine = fromLine;
        const text = lines.slice(fromLine, toLine).join('\n');
        resolved.push({ id: sec.id, fromLine, toLine, text });
    }

    return resolved;
}

function sectionText(sections: ResolvedSection[], sectionId: string | undefined, fullScreen: string): string {
    if (!sectionId) return fullScreen;
    const found = sections.find(s => s.id === sectionId);
    return found ? found.text : '';
}

function compileRegex(ref: { regex: string; flags?: string }): RegExp {
    return new RegExp(ref.regex, ref.flags ?? 'i');
}

function compilePattern(ref: { pattern: string; flags?: string }): RegExp {
    const flags = ref.flags ?? 'gm';
    return new RegExp(ref.pattern, flags.includes('g') ? flags : flags + 'g');
}

// ────────────────────────────────────────────────────────────────────────────
// State matching
// ────────────────────────────────────────────────────────────────────────────

function matchState(
    state: SpecState,
    sections: ResolvedSection[],
    fullScreen: string,
    trace: TraceEntry[],
): { matched: boolean; title: string | null } {
    const haystack = sectionText(sections, state.when.section, fullScreen);
    const re = compileRegex(state.when);
    if (!re.test(haystack)) {
        trace.push({ kind: 'state_skip', text: `state[${state.id}] when ${state.when.section ?? '*'}~/${state.when.regex}/ no match` });
        return { matched: false, title: null };
    }
    trace.push({ kind: 'state_match', text: `state[${state.id}] matched via ${state.when.section ?? '*'}~/${state.when.regex}/` });

    let title: string | null = null;
    if (state.extract_title) {
        const titleHay = sectionText(sections, state.extract_title.section, fullScreen);
        const m = compileRegex(state.extract_title).exec(titleHay);
        if (m) title = (m[1] ?? m[0]).trim();
        trace.push({ kind: 'state_match', text: `state[${state.id}] extract_title → ${title ?? '(none)'}` });
    }
    return { matched: true, title };
}

function extractModal(
    state: SpecState,
    sections: ResolvedSection[],
    fullScreen: string,
    title: string | null,
    trace: TraceEntry[],
): ModalSnapshot | null {
    if (!state.modal_buttons) return null;
    const hay = sectionText(sections, state.modal_buttons.section, fullScreen);
    const re = compilePattern(state.modal_buttons);
    const buttons: { index: number; label: string; key: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(hay)) !== null) {
        const idx = Number(m[1]);
        const label = String(m[2] ?? '').trim();
        if (!Number.isFinite(idx) || idx <= 0 || !label) continue;
        if (buttons.some(b => b.index === idx)) continue;
        const key = state.modal_buttons.key_for_index.replace(/\{index\}/g, String(idx));
        buttons.push({ index: idx, label, key });
    }
    buttons.sort((a, b) => a.index - b.index);
    const minCount = state.modal_buttons.min_count ?? 2;
    if (buttons.length < minCount) {
        trace.push({ kind: 'modal', text: `modal_buttons matched ${buttons.length}/${minCount} required — discarded` });
        return null;
    }
    trace.push({ kind: 'modal', text: `modal_buttons matched ${buttons.length} choices` });
    return { title, buttons };
}

// ────────────────────────────────────────────────────────────────────────────
// Public evaluator
// ────────────────────────────────────────────────────────────────────────────

export function evaluate(spec: CliSpec, screenText: string): SpecEvaluation {
    const trace: TraceEntry[] = [];
    const lines = screenText.split('\n');
    const sections = resolveSections(spec, lines);
    for (const s of sections) {
        trace.push({ kind: 'section', text: `section[${s.id}] lines [${s.fromLine}, ${s.toLine}) (${s.toLine - s.fromLine} lines)` });
    }

    let activeState: { id: string; label: string; title: string | null } | null = null;
    let modal: ModalSnapshot | null = null;

    for (const st of spec.states) {
        const { matched, title } = matchState(st, sections, screenText, trace);
        if (!matched) continue;
        activeState = { id: st.id, label: st.label, title };
        modal = extractModal(st, sections, screenText, title, trace);
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
        // after_duration_ms is enforced by the driver, not the evaluator
        // (the evaluator is pure / stateless). The driver bundles a
        // timer per delegate trigger and emits when it fires.
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
