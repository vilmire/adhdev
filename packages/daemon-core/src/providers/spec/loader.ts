/**
 * spec.json loader + strict validator.
 *
 * Supports both v1 (adhdev:cli/spec@1) and v3 (adhdev:cli/spec@3).
 * v1 specs are auto-migrated to v3 before validation.
 * Rejects spec files that don't conform to the schema.
 */
'use strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import Ajv from 'ajv';
import type { CliSpec, SectionDef, Condition, ExtractTitle, ExtractButtons } from './types.js';
import { SCHEMA_V1, SCHEMA_V3 } from './schema.gen.js';

const ajvV1 = new Ajv({ allErrors: true, strict: false });
const validateV1 = ajvV1.compile(SCHEMA_V1);

const ajvV3 = new Ajv({ allErrors: true, strict: false });
const validateV3 = ajvV3.compile<CliSpec>(SCHEMA_V3);

export interface SpecLoadResult {
    ok: true;
    spec: CliSpec;
    sourcePath: string;
}

export interface SpecLoadError {
    ok: false;
    errors: string[];
    sourcePath: string;
}

export function loadSpec(sourcePath: string): SpecLoadResult | SpecLoadError {
    let raw: unknown;
    try {
        const text = fs.readFileSync(sourcePath, 'utf8');
        raw = JSON.parse(text);
    } catch (err) {
        return { ok: false, errors: [`Failed to read spec: ${(err as Error).message}`], sourcePath };
    }

    // Auto-migrate v1 → v3
    const schemaStr = (raw as any)?.$schema;
    if (schemaStr === 'adhdev:cli/spec@1') {
        // Validate as v1 first
        if (!validateV1(raw)) {
            const errors = (validateV1.errors || []).map(e => `${e.instancePath || '(root)'} ${e.message ?? 'invalid'} (v1 parse)`);
            return { ok: false, errors, sourcePath };
        }
        raw = migrateV1toV3(raw as any);
    }

    if (!validateV3(raw)) {
        const errors = (validateV3.errors || []).map(e => `${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`);
        return { ok: false, errors, sourcePath };
    }

    const spec = raw as CliSpec;
    const extra = validateRefs(spec);
    if (extra.length > 0) return { ok: false, errors: extra, sourcePath };

    // Populate legacy `debounce` alias from `timing` for backward compat
    attachDebounceAlias(spec);

    return { ok: true, spec, sourcePath };
}

/**
 * Populate spec.debounce as a backward-compat alias for spec.timing.
 * The driver and tests read debounce.{busy_hold_ms, idle_hold_ms, ...}.
 * After this call both fields point at equivalent data.
 */
function attachDebounceAlias(spec: CliSpec): void {
    const t = spec.timing;
    if (!t) return;
    const cm = t.completion_marker;
    (spec as any).debounce = {
        ...(t.busy_hold_ms !== undefined ? { busy_hold_ms: t.busy_hold_ms } : {}),
        ...(t.idle_hold_ms !== undefined ? { idle_hold_ms: t.idle_hold_ms } : {}),
        ...(t.startup_grace_ms !== undefined ? { startup_grace_ms: t.startup_grace_ms } : {}),
        ...(cm ? {
            completion_idle_after: {
                ...(cm.section ? { section: cm.section } : {}),
                regex: cm.matches,
                ...(cm.flags ? { flags: cm.flags } : {}),
                hold_ms: cm.hold_ms,
                ...(cm.force_after_ms !== undefined ? { force_after_ms: cm.force_after_ms } : {}),
            },
        } : {}),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Migration: v1 → v3
// ─────────────────────────────────────────────────────────────────────────────

export function migrateV1toV3(raw: any): any {
    // sections: array → object
    const sections: Record<string, SectionDef> = {};
    for (const sec of raw.layout?.sections ?? []) {
        const { id, anchor_regex, until_regex, until_regex_flags, ...rest } = sec;
        const sectionDef: any = { ...rest };

        // anchor_regex → anchor
        if (anchor_regex) sectionDef.anchor = anchor_regex;

        // until: { section: id } → until: id (section reference)
        if (rest.until?.section) {
            sectionDef.until = rest.until.section;
        } else {
            delete sectionDef.until;
        }

        // keep until_regex for anchor-based extension
        if (until_regex) sectionDef.until_regex = until_regex;
        if (until_regex_flags) sectionDef.until_regex_flags = until_regex_flags;

        sections[id] = sectionDef;
    }

    // states: convert when/extract_title/modal_buttons
    const states = (raw.states ?? []).map((s: any) => {
        // Convert when: SectionRegex → when: AllCondition | AnyCondition
        let when: any;
        if (s.when?.cursor_above_lines && s.when?.changed) {
            // v1 delta detection condition
            when = {
                any: [
                    { cursor_above: s.when.cursor_above_lines, changed: true as const },
                ],
            };
        } else if (s.when?.regex) {
            const regexCond: any = {
                section: s.when.section,
                matches: s.when.regex,
                ...(s.when.flags ? { flags: s.when.flags } : {}),
                ...(s.when.cursor_row_min !== undefined ? { cursor_row_min: s.when.cursor_row_min } : {}),
                ...(s.when.cursor_row_max !== undefined ? { cursor_row_max: s.when.cursor_row_max } : {}),
                ...(s.when.cursor_col_min !== undefined ? { cursor_col_min: s.when.cursor_col_min } : {}),
                ...(s.when.cursor_col_max !== undefined ? { cursor_col_max: s.when.cursor_col_max } : {}),
            };
            if (!regexCond.section) delete regexCond.section;
            when = { all: [regexCond] };
        } else {
            // No regex — empty all (always matches)
            when = { all: [] };
        }

        const extract: any = {};
        if (s.extract_title) {
            if (s.extract_title.first_line) {
                extract.title = { section: s.extract_title.section, first_line: true as const };
                if (!extract.title.section) delete extract.title.section;
            } else if (s.extract_title.regex) {
                extract.title = {
                    section: s.extract_title.section,
                    regex: s.extract_title.regex,
                    ...(s.extract_title.flags ? { flags: s.extract_title.flags } : {}),
                };
                if (!extract.title.section) delete extract.title.section;
            }
        }
        if (s.modal_buttons) {
            const mb = s.modal_buttons;
            // Use first pattern from patterns[] array, or single pattern
            const pat = mb.patterns?.length ? mb.patterns[0].pattern : mb.pattern;
            const flg = mb.patterns?.length ? mb.patterns[0].flags : mb.flags;
            if (pat) {
                extract.buttons = {
                    ...(mb.section ? { section: mb.section } : {}),
                    pattern: pat,
                    ...(flg ? { flags: flg } : {}),
                    key_for_index: mb.key_for_index,
                    ...(mb.min_count !== undefined ? { min_count: mb.min_count } : {}),
                    ...(mb.continuation_lines !== undefined ? { continuation_lines: mb.continuation_lines } : {}),
                };
            }
        }

        return {
            id: s.id,
            label: s.label,
            when,
            ...(Object.keys(extract).length > 0 ? { extract } : {}),
        };
    });

    // timing (from debounce)
    const d = raw.debounce ?? {};
    const timing: any = {};
    if (d.busy_hold_ms !== undefined) timing.busy_hold_ms = d.busy_hold_ms;
    if (d.idle_hold_ms !== undefined) timing.idle_hold_ms = d.idle_hold_ms;
    if (d.startup_grace_ms !== undefined) timing.startup_grace_ms = d.startup_grace_ms;
    if (d.completion_idle_after) {
        timing.completion_marker = {
            ...(d.completion_idle_after.section ? { section: d.completion_idle_after.section } : {}),
            matches: d.completion_idle_after.regex,
            ...(d.completion_idle_after.flags ? { flags: d.completion_idle_after.flags } : {}),
            hold_ms: d.completion_idle_after.hold_ms,
            ...(d.completion_idle_after.force_after_ms !== undefined
                ? { force_after_ms: d.completion_idle_after.force_after_ms } : {}),
        };
    }

    return {
        $schema: 'adhdev:cli/spec@3',
        id: raw.id,
        name: raw.name,
        binary: raw.binary,
        ...(raw.cli_version_range ? { cli_version_range: raw.cli_version_range } : {}),
        ...(raw.spawn_args ? { spawn_args: raw.spawn_args } : {}),
        ...(raw.env ? { env: raw.env } : {}),
        send_message: raw.send_message,
        sections,
        states,
        default_state: raw.default_state,
        ...(Object.keys(timing).length > 0 ? { timing } : {}),
        ...(raw.control_bar ? { control_bar: raw.control_bar } : {}),
        ...(raw.notifications ? { notifications: raw.notifications } : {}),
        ...(raw.delegate ? { delegate: raw.delegate } : {}),
        ...(raw.native_history ? { native_history: raw.native_history } : {}),
        ...(raw.requiresFinalAssistantBeforeIdle
            ? { requiresFinalAssistantBeforeIdle: raw.requiresFinalAssistantBeforeIdle } : {}),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-field validation
// ─────────────────────────────────────────────────────────────────────────────

function validateRefs(spec: CliSpec): string[] {
    const errs: string[] = [];
    const sectionIds = new Set(Object.keys(spec.sections));
    const stateIds = new Set(spec.states.map(s => s.id));

    if (!stateIds.has(spec.default_state)) {
        errs.push(`default_state "${spec.default_state}" is not defined in states[]`);
    }

    for (const s of spec.states) {
        validateConditionRefs(s.when, `states[${s.id}].when`, sectionIds, errs);
        const ext = s.extract;
        if (ext?.title) {
            if (ext.title.section && !sectionIds.has(ext.title.section)) {
                errs.push(`states[${s.id}].extract.title.section "${ext.title.section}" unknown`);
            }
            if (ext.title.regex) {
                compileRegexCheck(ext.title.regex, ext.title.flags, `states[${s.id}].extract.title.regex`, errs);
            }
        }
        if (ext?.buttons) {
            if (ext.buttons.section && !sectionIds.has(ext.buttons.section)) {
                errs.push(`states[${s.id}].extract.buttons.section "${ext.buttons.section}" unknown`);
            }
            compileRegexCheck(ext.buttons.pattern, ext.buttons.flags ?? 'm', `states[${s.id}].extract.buttons.pattern`, errs);
        }
    }

    for (const c of spec.control_bar ?? []) {
        for (const stId of c.visible_when_state ?? []) {
            if (!stateIds.has(stId)) errs.push(`control_bar[${c.id}].visible_when_state references unknown state "${stId}"`);
        }
        if (c.action.type === 'open_picker') {
            if (c.action.wait_for.section && !sectionIds.has(c.action.wait_for.section ?? '')) {
                errs.push(`control_bar[${c.id}].action.wait_for.section "${c.action.wait_for.section}" unknown`);
            }
            if (c.action.wait_for.regex) {
                compileRegexCheck(c.action.wait_for.regex, c.action.wait_for.flags, `control_bar[${c.id}].action.wait_for.regex`, errs);
            }
            if (c.action.extract_choices.section && !sectionIds.has(c.action.extract_choices.section)) {
                errs.push(`control_bar[${c.id}].action.extract_choices.section "${c.action.extract_choices.section}" unknown`);
            }
            compileRegexCheck(c.action.extract_choices.pattern, c.action.extract_choices.flags ?? 'm', `control_bar[${c.id}].action.extract_choices.pattern`, errs);
        }
    }

    for (const n of spec.notifications ?? []) {
        if (!stateIds.has(n.when_state)) errs.push(`notifications[${n.id}].when_state "${n.when_state}" unknown`);
    }
    for (const d of spec.delegate ?? []) {
        if (!stateIds.has(d.when_state)) errs.push(`delegate[${d.id}].when_state "${d.when_state}" unknown`);
    }

    // native_history: exactly one of {reader, source, override_path}.
    const nh = spec.native_history;
    if (nh) {
        const modes = (['reader', 'source', 'override_path'] as const).filter(k => (nh as Record<string, unknown>)[k] !== undefined);
        if (modes.length === 0) {
            errs.push('native_history must set exactly one of {reader, source, override_path}');
        } else if (modes.length > 1) {
            errs.push(`native_history sets ${modes.length} modes (${modes.join(', ')}); pick exactly one`);
        }
    }

    return errs;
}

function validateConditionRefs(cond: any, where: string, sectionIds: Set<string>, errs: string[]): void {
    if (!cond) return;
    if ('all' in cond) {
        for (const c of cond.all ?? []) validateConditionRefs(c, where, sectionIds, errs);
    } else if ('any' in cond) {
        for (const c of cond.any ?? []) validateConditionRefs(c, where, sectionIds, errs);
    } else if ('matches' in cond) {
        if (cond.section && !sectionIds.has(cond.section)) {
            errs.push(`${where}.section "${cond.section}" unknown`);
        }
        compileRegexCheck(cond.matches, cond.flags, `${where}.matches`, errs);
    }
    // ChangedCondition has no section refs
}

function compileRegexCheck(source: string | undefined, flags: string | undefined, where: string, errs: string[]): void {
    if (!source) return;
    try { new RegExp(source, flags ?? ''); } catch (err) {
        errs.push(`${where} regex invalid: ${(err as Error).message}`);
    }
}

/** Convenience: look up a provider's spec.json next to its provider dir. */
export function resolveSpecPath(providerDir: string): string {
    return path.join(providerDir, 'spec.json');
}
