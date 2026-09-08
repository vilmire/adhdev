/**
 * FSM spec (adhdev:cli/spec@4) loader + validator.
 *
 * Validation is intentionally code-based (not AJV) so a spec authored live in
 * the debug panel gets precise, human-readable errors ("transition[2].to
 * references unknown state 'budy'") instead of a JSON-schema path. Every error
 * is something a spec author can act on without reading the engine.
 */
'use strict';

import * as fs from 'node:fs';
import { type CliSpecV4, type FsmCondition, isV4Spec } from './fsm-types.js';

export interface FsmLoadOk { ok: true; spec: CliSpecV4; sourcePath: string; warnings: string[]; }
export interface FsmLoadErr { ok: false; errors: string[]; sourcePath: string; }

export function loadFsmSpec(sourcePath: string): FsmLoadOk | FsmLoadErr {
    let raw: unknown;
    try {
        raw = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
    } catch (err) {
        return { ok: false, errors: [`Failed to read/parse spec: ${(err as Error).message}`], sourcePath };
    }
    const errors = validateFsmSpec(raw);
    if (errors.length) return { ok: false, errors, sourcePath };
    return { ok: true, spec: raw as CliSpecV4, sourcePath, warnings: collectFsmSpecWarnings(raw) };
}

/** Pure validator — usable from a "validate before save" API in the panel. */
export function validateFsmSpec(raw: unknown): string[] {
    const errs: string[] = [];
    if (!isV4Spec(raw)) return ['$schema must be "adhdev:cli/spec@4"'];
    const spec = raw as CliSpecV4;

    if (!spec.id) errs.push('id is required');
    if (!spec.binary) errs.push('binary is required');
    if (!spec.send_message?.submit_key) errs.push('send_message.submit_key is required');

    if (spec.pre_launch_trust !== undefined) {
        const t = spec.pre_launch_trust as { settings_path?: unknown; key?: unknown; scheme?: unknown };
        if (!t || typeof t !== 'object' || Array.isArray(t)) {
            errs.push('pre_launch_trust must be an object');
        } else if (t.scheme !== undefined) {
            if (t.scheme !== 'kimi_workspace_file') errs.push('pre_launch_trust.scheme must be "kimi_workspace_file"');
            if (t.settings_path !== undefined || t.key !== undefined) errs.push('pre_launch_trust with scheme excludes settings_path/key');
        } else {
            if (typeof t.settings_path !== 'string' || !t.settings_path) errs.push('pre_launch_trust.settings_path is required');
            if (typeof t.key !== 'string' || !t.key) errs.push('pre_launch_trust.key is required');
        }
    }

    if (spec.interactive_prompts !== undefined) {
        const ip = spec.interactive_prompts as { scheme?: unknown };
        if (!ip || typeof ip !== 'object' || Array.isArray(ip)) {
            errs.push('interactive_prompts must be an object');
        } else if (ip.scheme !== 'claude_tui' && ip.scheme !== 'kimi_wire') {
            errs.push('interactive_prompts.scheme must be "claude_tui" or "kimi_wire"');
        }
    }

    if (spec.startup_dismiss !== undefined) {
        const d = spec.startup_dismiss as { patterns?: unknown; key?: unknown };
        if (!d || typeof d !== 'object' || Array.isArray(d)) {
            errs.push('startup_dismiss must be an object');
        } else {
            if (typeof d.key !== 'string' || !d.key) errs.push('startup_dismiss.key is required');
            if (!Array.isArray(d.patterns) || d.patterns.length === 0) {
                errs.push('startup_dismiss.patterns must be a non-empty array');
            } else {
                d.patterns.forEach((p, i) => {
                    const rec = (p && typeof p === 'object' ? p : {}) as { regex?: unknown; flags?: unknown };
                    if (typeof rec.regex !== 'string' || !rec.regex) {
                        errs.push(`startup_dismiss.patterns[${i}].regex is required`);
                        return;
                    }
                    try {
                        new RegExp(rec.regex, typeof rec.flags === 'string' ? rec.flags : undefined);
                    } catch {
                        errs.push(`startup_dismiss.patterns[${i}].regex does not compile`);
                    }
                });
            }
        }
    }

    if (spec.refocus_when_stalled_ms !== undefined) {
        if (typeof spec.refocus_when_stalled_ms !== 'number' || !(spec.refocus_when_stalled_ms > 0)) {
            errs.push('refocus_when_stalled_ms must be a positive number');
        } else if (!Array.isArray(spec.send_on_spawn) || spec.send_on_spawn.length === 0) {
            errs.push('refocus_when_stalled_ms requires send_on_spawn (the wake sequence to re-inject)');
        }
    }

    if (!Array.isArray(spec.states) || spec.states.length === 0) {
        errs.push('states[] must be a non-empty array');
        return errs;
    }
    if (!Array.isArray(spec.transitions)) {
        errs.push('transitions[] must be an array');
        return errs;
    }

    const ids = new Set<string>();
    let initialCount = 0;
    for (const [i, s] of spec.states.entries()) {
        if (!s.id) { errs.push(`states[${i}].id is required`); continue; }
        if (ids.has(s.id)) errs.push(`states[${i}].id "${s.id}" is duplicated`);
        ids.add(s.id);
        if (!s.label) errs.push(`states[${i}].label is required`);
        if (s.initial) initialCount += 1;
        if (s.status && !['idle', 'generating', 'approval'].includes(s.status)) {
            errs.push(`states[${i}].status "${s.status}" must be idle|generating|approval`);
        }
    }
    if (initialCount === 0) errs.push('exactly one state must have initial:true (none found)');
    if (initialCount > 1) errs.push(`exactly one state must have initial:true (${initialCount} found)`);

    const sectionIds = new Set(Object.keys(spec.sections ?? {}));
    for (const [i, t] of spec.transitions.entries()) {
        const froms = t.from === '*' ? [] : (Array.isArray(t.from) ? t.from : [t.from]);
        for (const f of froms) {
            if (!ids.has(f)) errs.push(`transitions[${i}].from references unknown state "${f}"`);
        }
        if (t.from !== '*' && froms.length === 0) errs.push(`transitions[${i}].from is required`);
        if (!t.to) errs.push(`transitions[${i}].to is required`);
        else if (!ids.has(t.to)) errs.push(`transitions[${i}].to references unknown state "${t.to}"`);
        if (t.when) errs.push(...validateCondition(t.when, sectionIds, `transitions[${i}].when`));
    }

    // Section refs in state.extract
    for (const [i, s] of spec.states.entries()) {
        const sec = s.extract?.title?.section;
        if (sec && !sectionIds.has(sec)) errs.push(`states[${i}].extract.title.section "${sec}" unknown`);
        const bsec = s.extract?.buttons?.section;
        if (bsec && !sectionIds.has(bsec)) errs.push(`states[${i}].extract.buttons.section "${bsec}" unknown`);
    }

    return errs;
}

/**
 * Emit a loaded spec's advisory lint through the caller's logger. Lives here (not
 * at the call site) so `fsm-driver.ts` — which sits at the file-size cap — stays
 * a single line per load path.
 */
export function reportFsmSpecWarnings(warnings: string[], tag: string, warn: (scope: string, msg: string) => void): void {
    for (const w of warnings) warn('FsmDriver', `[${tag}] spec lint: ${w}`);
}

/**
 * Non-fatal spec lint — advisory diagnostics a spec author should see but which
 * must NEVER fail the load. Third-party / out-of-tree specs are loaded
 * fail-closed on `validateFsmSpec` errors, so anything stylistic belongs here:
 * turning a lint into an error would kill a working provider on upgrade.
 */
export function collectFsmSpecWarnings(raw: unknown): string[] {
    if (!isV4Spec(raw)) return [];
    const spec = raw as CliSpecV4;
    const warns: string[] = [];
    for (const [i, t] of (spec.transitions ?? []).entries()) {
        if (t.when) warns.push(...warnCondition(t.when, `transitions[${i}].when`));
    }
    return warns;
}

/**
 * `matches` conditions are evaluated against the WHOLE screen, and the engine
 * compiles them with `flags ?? 'i'` — no `m`. So an unescaped `^`/`$` anchors to
 * the start/end of the entire screen buffer, not to a line, which silently makes
 * the condition never (or always) match.
 *
 * The `(?:^|\n)` / `(?=\n|$)` idioms are the deliberate line-boundary spellings
 * that work WITHOUT `m` (the built-in claude-cli spec uses both), so they are
 * stripped before the scan rather than flagged.
 */
function warnCondition(c: FsmCondition, path: string): string[] {
    const warns: string[] = [];
    const w = c as any;
    if ('all' in w && Array.isArray(w.all)) { w.all.forEach((x: FsmCondition, i: number) => warns.push(...warnCondition(x, `${path}.all[${i}]`))); return warns; }
    if ('any' in w && Array.isArray(w.any)) { w.any.forEach((x: FsmCondition, i: number) => warns.push(...warnCondition(x, `${path}.any[${i}]`))); return warns; }
    if ('not' in w && w.not) { warns.push(...warnCondition(w.not, `${path}.not`)); return warns; }
    if ('matches' in w && typeof w.matches === 'string') {
        const flags = typeof w.flags === 'string' ? w.flags : 'i';
        if (flags.includes('m')) return warns;
        if (!hasUnescapedLineAnchor(w.matches)) return warns;
        warns.push(
            `${path}.matches uses ^ or $ without the "m" flag — the anchor binds to the whole ` +
            `screen, not a line. Add "flags": "${flags}m" or use the (?:^|\\n) idiom.`,
        );
    }
    return warns;
}

/** The no-`m` line-boundary spellings a spec is SUPPOSED to use: `(?:^|\n)` /
 *  `(?:\n|^)` for line start, `(?=\n|$)` / `(?=$|\n)` for line end (and their
 *  non-lookahead `(?:…)` forms). Stripped before the anchor scan. */
const LINE_BOUNDARY_IDIOMS = [
    /\(\?:\^\|\\n\)/g, /\(\?:\\n\|\^\)/g,
    /\(\?=\\n\|\$\)/g, /\(\?=\$\|\\n\)/g,
    /\(\?:\\n\|\$\)/g, /\(\?:\$\|\\n\)/g,
];

/** True when the pattern carries a `^`/`$` that is neither escaped (`\^`), nor a
 *  negation inside a character class (`[^…]`), nor part of a line-boundary idiom. */
function hasUnescapedLineAnchor(pattern: string): boolean {
    // Strip the sanctioned line-boundary idioms first so they never trip the scan.
    let src = pattern;
    for (const re of LINE_BOUNDARY_IDIOMS) src = src.replace(re, '');
    let inClass = false;
    for (let i = 0; i < src.length; i += 1) {
        const ch = src[i];
        if (ch === '\\') { i += 1; continue; }            // escaped — skip the pair
        if (inClass) { if (ch === ']') inClass = false; continue; } // `[^…]` is negation
        if (ch === '[') { inClass = true; continue; }
        if (ch === '^' || ch === '$') return true;
    }
    return false;
}

function validateCondition(c: FsmCondition, sectionIds: Set<string>, path: string): string[] {
    const errs: string[] = [];
    const w = c as any;
    if ('all' in w) { w.all.forEach((x: FsmCondition, i: number) => errs.push(...validateCondition(x, sectionIds, `${path}.all[${i}]`))); return errs; }
    if ('any' in w) { w.any.forEach((x: FsmCondition, i: number) => errs.push(...validateCondition(x, sectionIds, `${path}.any[${i}]`))); return errs; }
    if ('not' in w) { errs.push(...validateCondition(w.not, sectionIds, `${path}.not`)); return errs; }
    if ('matches' in w) {
        if (w.section && !sectionIds.has(w.section)) errs.push(`${path}.section "${w.section}" unknown`);
        try { new RegExp(w.matches, w.flags ?? 'i'); } catch (e) { errs.push(`${path}.matches invalid regex: ${(e as Error).message}`); }
        return errs;
    }
    if ('cursor_above' in w && 'changed' in w) return errs;
    if ('signal' in w) {
        // TX-FSM Stage 0 (shadow) leaf — validated so a spec can declare it
        // today (evaluation is shadow-only; see fsm-evaluator).
        if (typeof w.signal !== 'string' || !w.signal.trim()) errs.push(`${path}.signal must be a non-empty string`);
        if (w.equals !== undefined && typeof w.equals !== 'boolean') errs.push(`${path}.equals must be a boolean`);
        return errs;
    }
    if ('elapsed_ms' in w) { if (typeof w.elapsed_ms !== 'number') errs.push(`${path}.elapsed_ms must be a number`); return errs; }
    if ('stable_ms' in w) {
        if (typeof w.stable_ms !== 'number') errs.push(`${path}.stable_ms must be a number`);
        if (w.section && !sectionIds.has(w.section)) errs.push(`${path}.section "${w.section}" unknown`);
        if (w.ignore_lines !== undefined) {
            if (typeof w.ignore_lines !== 'string') errs.push(`${path}.ignore_lines must be a string`);
            else try { new RegExp(w.ignore_lines, 'm'); } catch (e) { errs.push(`${path}.ignore_lines invalid regex: ${(e as Error).message}`); }
        }
        return errs;
    }
    errs.push(`${path} is not a recognized condition`);
    return errs;
}
