/**
 * Pure preparation of skill_manage create / patch writes: shape validation,
 * unique-substring replacement, size limits. Returns the files to write, the
 * journal fields and the text to credential-check — or a refusal. Reads the
 * current file for a reference-file patch; never writes.
 * Design: docs/design/2026-10-07-assistant-layer.md §4.10.4.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { charCount } from '../memory/memory-store.js';
import {
    checkSkillLimits, composeSkillMd, newSkillFrontmatter, normalizeSkillFilePath, validateDescription, withDescription,
    SKILL_FILE, type SkillDirRead,
} from './skill-format.js';
import type { SkillJournalRecord } from './skill-journal.js';
import type { SkillManageOp, SkillRefusal } from './skill-store.js';

export interface PreparedWrite {
    files: Array<{ path: string; content: string }>; // relative to the skill dir
    journal: Pick<SkillJournalRecord, 'field' | 'file' | 'before' | 'after'>;
    scan: string[]; // text to credential-check
}

export function prepareCreate(op: Extract<SkillManageOp, { action: 'create' }>): PreparedWrite | SkillRefusal {
    if (!validateDescription(op.description)) return { result: 'skill_invalid_format', reason: 'bad_description' };
    if (typeof op.body !== 'string' || !op.body.trim()) return { result: 'skill_invalid_format', reason: 'empty_body' };
    if (op.project !== undefined && (typeof op.project !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(op.project))) {
        return { result: 'skill_invalid_format', reason: 'bad_patch' };
    }
    const files: PreparedWrite['files'] = [];
    for (const [p, content] of Object.entries(op.files ?? {})) {
        const np = normalizeSkillFilePath(p);
        if (!np || typeof content !== 'string') return { result: 'skill_invalid_format', reason: 'bad_file_path' };
        files.push({ path: np, content });
    }
    const over = checkSkillLimits(charCount(op.body), files.map((f) => ({ path: f.path, chars: charCount(f.content) })));
    if (over[0]) return { result: 'skill_too_large', ...over[0] };
    const fm = newSkillFrontmatter(op.name, op.description, op.project);
    return {
        files: [{ path: SKILL_FILE, content: composeSkillMd(fm, op.body) }, ...files],
        journal: { field: 'create', before: null, after: op.description.trim() },
        scan: [op.description, op.body, ...files.map((f) => f.content)],
    };
}

export function preparePatch(op: Extract<SkillManageOp, { action: 'patch' }>, d: SkillDirRead, skillDir: string): PreparedWrite | SkillRefusal {
    const isStr = (v: unknown): v is string => typeof v === 'string';
    const bad: SkillRefusal = { result: 'skill_invalid_format', reason: 'bad_patch' };
    if (op.description !== undefined) {
        if (op.old !== undefined || op.new !== undefined || op.file !== undefined) return bad;
        if (!validateDescription(op.description)) return { result: 'skill_invalid_format', reason: 'bad_description' };
        const fm = withDescription(d.frontmatterRaw, op.description);
        return {
            files: [{ path: SKILL_FILE, content: composeSkillMd(fm, d.body) }],
            journal: { field: 'description', before: d.description, after: op.description.trim() },
            scan: [op.description],
        };
    }
    if (!isStr(op.new)) return bad;
    const replace = (text: string): string | SkillRefusal => {
        if (!isStr(op.old) || !op.old) return bad;
        const count = text.split(op.old).length - 1;
        if (count === 0) return { result: 'skill_no_match' };
        if (count > 1) return { result: 'skill_ambiguous', count };
        return text.replace(op.old, () => op.new!);
    };
    if (op.file === undefined) {
        const body = replace(d.body);
        if (typeof body !== 'string') return body;
        const over = checkSkillLimits(charCount(body), d.files);
        if (over[0]) return { result: 'skill_too_large', ...over[0] };
        return {
            files: [{ path: SKILL_FILE, content: composeSkillMd(d.frontmatterRaw, body) }],
            journal: { field: 'body', before: op.old!, after: op.new },
            scan: [op.new],
        };
    }
    const p = normalizeSkillFilePath(op.file);
    if (!p) return { result: 'skill_invalid_format', reason: 'bad_file_path' };
    const exists = d.files.some((f) => f.path === p);
    let content: string;
    if (op.old === undefined) {
        if (exists || existsSync(join(skillDir, p))) return { result: 'skill_file_exists' };
        content = op.new;
    } else {
        if (!exists) return { result: 'skill_file_not_found' };
        const r = replace(readFileSync(join(skillDir, p), 'utf-8'));
        if (typeof r !== 'string') return r;
        content = r;
    }
    const files = [...d.files.filter((f) => f.path !== p), { path: p, chars: charCount(content) }];
    const over = checkSkillLimits(d.bodyChars, files);
    if (over[0]) return { result: 'skill_too_large', ...over[0] };
    return { files: [{ path: p, content }], journal: { field: 'file', file: p, before: op.old ?? null, after: op.new }, scan: [op.new] };
}

