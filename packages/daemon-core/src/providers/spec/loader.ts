/**
 * spec.json loader + strict validator. Rejects spec files that don't
 * conform to schema.json — unknown fields, missing required fields,
 * wrong types, regex strings that don't compile, state references
 * that don't exist, etc.
 *
 * Validation runs once at load. Hot reload re-runs validation.
 */
'use strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import Ajv from 'ajv';
import type { CliSpec } from './types.js';
import { SCHEMA as schema } from './schema.gen.js';

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile<CliSpec>(schema);

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

    if (!validate(raw)) {
        const errors = (validate.errors || []).map(e => `${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`);
        return { ok: false, errors, sourcePath };
    }

    const spec = raw as CliSpec;
    const extra = validateRefs(spec);
    if (extra.length > 0) return { ok: false, errors: extra, sourcePath };

    return { ok: true, spec, sourcePath };
}

/**
 * Cross-field validation that JSON Schema can't express on its own:
 *   - section references actually point to a defined section
 *   - state references in control_bar/notifications/delegate exist
 *   - default_state exists
 *   - regex / pattern strings compile
 */
function validateRefs(spec: CliSpec): string[] {
    const errs: string[] = [];
    const sectionIds = new Set(spec.layout.sections.map(s => s.id));
    const stateIds = new Set(spec.states.map(s => s.id));

    if (!stateIds.has(spec.default_state)) {
        errs.push(`default_state "${spec.default_state}" is not defined in states[]`);
    }

    for (const s of spec.states) {
        checkSectionRef(s.when, `states[${s.id}].when`, sectionIds, errs);
        compileRegex(s.when.regex, s.when.flags, `states[${s.id}].when.regex`, errs);
        if (s.extract_title) {
            checkSectionRef(s.extract_title, `states[${s.id}].extract_title`, sectionIds, errs);
            compileRegex(s.extract_title.regex, s.extract_title.flags, `states[${s.id}].extract_title.regex`, errs);
        }
        if (s.modal_buttons) {
            if (s.modal_buttons.section && !sectionIds.has(s.modal_buttons.section)) {
                errs.push(`states[${s.id}].modal_buttons.section "${s.modal_buttons.section}" unknown`);
            }
            compileRegex(s.modal_buttons.pattern, s.modal_buttons.flags ?? 'm', `states[${s.id}].modal_buttons.pattern`, errs);
        }
    }

    for (const c of spec.control_bar ?? []) {
        for (const stId of c.visible_when_state ?? []) {
            if (!stateIds.has(stId)) errs.push(`control_bar[${c.id}].visible_when_state references unknown state "${stId}"`);
        }
        if (c.action.type === 'open_picker') {
            checkSectionRef(c.action.wait_for, `control_bar[${c.id}].action.wait_for`, sectionIds, errs);
            compileRegex(c.action.wait_for.regex, c.action.wait_for.flags, `control_bar[${c.id}].action.wait_for.regex`, errs);
            if (c.action.extract_choices.section && !sectionIds.has(c.action.extract_choices.section)) {
                errs.push(`control_bar[${c.id}].action.extract_choices.section "${c.action.extract_choices.section}" unknown`);
            }
            compileRegex(c.action.extract_choices.pattern, c.action.extract_choices.flags ?? 'm', `control_bar[${c.id}].action.extract_choices.pattern`, errs);
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

function checkSectionRef(ref: { section?: string }, where: string, valid: Set<string>, errs: string[]): void {
    if (ref.section && !valid.has(ref.section)) errs.push(`${where}.section "${ref.section}" unknown`);
}

function compileRegex(source: string, flags: string | undefined, where: string, errs: string[]): void {
    try { new RegExp(source, flags ?? ''); } catch (err) { errs.push(`${where} regex invalid: ${(err as Error).message}`); }
}

/** Convenience: look up a provider's spec.json next to its provider dir. */
export function resolveSpecPath(providerDir: string): string {
    return path.join(providerDir, 'spec.json');
}
