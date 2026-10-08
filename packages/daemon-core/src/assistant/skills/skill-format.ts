/**
 * Assistant skill format — directory layout, frontmatter, limits and the
 * read-only directory reader shared by the skill store and the Hermes import.
 *
 * Design: docs/design/2026-10-07-assistant-layer.md §4.10.4.
 *
 *  - `<skillsDir>/<name>/SKILL.md` + optional `references/`, `templates/`.
 *    Name per the Agent Skills spec: 1–64 of `[a-z0-9-]`, no leading,
 *    trailing or consecutive hyphen; `list` reserved, no category subdirs.
 *    A directory named under the older rule (`^[a-z0-9][a-z0-9-]{1,63}$`)
 *    is still listed — with problem `invalid_name`, out of the index — so the
 *    owner sees it and can rename it; it is never silently dropped.
 *  - Frontmatter (YAML, js-yaml CORE schema so dates stay strings): required
 *    `name` (= directory name) and one-line `description` (1–300 chars);
 *    optional `version`, `metadata.adhdev.project`. Every other key is
 *    preserved verbatim and ignored — the raw frontmatter text is kept and
 *    only re-dumped when the description itself is patched.
 *  - Only `.md .txt .json .yaml .yml` under references/ and templates/ are
 *    read; anything else (scripts/, executables) is ignored on read and
 *    refused on write. Symlinks are never followed.
 *  - The description and body are re-scanned on every read (invisible
 *    Unicode, injection phrases, credentials); a hit marks the skill
 *    `blocked_content` — left out of the index, refused by view/attach, files
 *    untouched — the same handling as an unparseable SKILL.md.
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { charCount } from '../memory/memory-store.js';
import { scanStoredContent, type StoreContentFinding } from '../store-guards.js';

// ── Constants ───────────────────────────────────────────────────────────────

/** Agent Skills spec (agentskills.io/specification): 1–64 chars, no leading/trailing/consecutive hyphen. */
export const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/;
/** The rule before 2026-10-08 — only used to keep finding (and reporting) directories named under it. */
export const LEGACY_SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
export const RESERVED_SKILL_NAMES: ReadonlySet<string> = new Set(['list']);
export const SKILL_FILE = 'SKILL.md';
export const SKILL_SUBDIRS = ['references', 'templates'] as const;
export const SKILL_ALLOWED_EXTENSIONS: readonly string[] = ['.md', '.txt', '.json', '.yaml', '.yml'];

export const SKILL_LIMITS = {
    /** SKILL.md body (after the frontmatter), Unicode code points. */
    bodyChars: 12_000,
    /** Files under references/ + templates/. */
    files: 20,
    /** Per reference/template file, code points. */
    fileChars: 20_000,
    /** active + stale skills. */
    liveSkills: 100,
    descriptionChars: 300,
} as const;

/** A file path segment: no dot-leading names, no `..`, no separators. */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_FILE_DEPTH = 3;
const PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type SkillStatus = 'active' | 'stale' | 'archived';
export type SkillOrigin = 'agent' | 'owner' | 'imported';

export function isValidSkillName(name: unknown): name is string {
    return typeof name === 'string' && SKILL_NAME_RE.test(name) && !RESERVED_SKILL_NAMES.has(name);
}

/**
 * Validate a reference/template path `references/<seg>[/<seg>…]`. Returns the
 * normalized path or null. Rejects traversal, hidden files and disallowed
 * extensions.
 */
export function normalizeSkillFilePath(path: unknown): string | null {
    if (typeof path !== 'string') return null;
    const parts = path.replace(/\\/g, '/').split('/');
    if (parts.length < 2 || parts.length > MAX_FILE_DEPTH + 1) return null;
    if (!(SKILL_SUBDIRS as readonly string[]).includes(parts[0]!)) return null;
    if (!parts.slice(1).every((p) => SEGMENT_RE.test(p) && p !== '..' && !p.includes('..'))) return null;
    if (!hasAllowedExtension(parts[parts.length - 1]!)) return null;
    return parts.join('/');
}

export function hasAllowedExtension(fileName: string): boolean {
    const lower = fileName.toLowerCase();
    return SKILL_ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// ── Frontmatter ─────────────────────────────────────────────────────────────

export interface ParsedSkillMd {
    /** Raw YAML between the fences, preserved verbatim on write. */
    frontmatterRaw: string;
    meta: Record<string, unknown>;
    body: string;
}

export type SkillFormatProblem =
    | 'no_frontmatter'
    | 'bad_yaml'
    | 'name_mismatch'
    | 'bad_description'
    /** Description or body failed the content re-scan; `blocked` says which check. */
    | 'blocked_content';

/** Split `---\n<yaml>\n---\n<body>`. Returns null when there is no frontmatter block. */
export function splitSkillMd(text: string): { frontmatterRaw: string; body: string } | null {
    const t = text.replace(/\r\n?/g, '\n');
    if (!t.startsWith('---\n')) return null;
    const end = t.indexOf('\n---', 3);
    if (end < 0) return null;
    const after = t.slice(end + 4);
    if (after !== '' && !after.startsWith('\n')) return null;
    return { frontmatterRaw: t.slice(4, end), body: after.replace(/^\n/, '') };
}

export function parseSkillMd(text: string): ParsedSkillMd | { problem: 'no_frontmatter' | 'bad_yaml' } {
    const split = splitSkillMd(text);
    if (!split) return { problem: 'no_frontmatter' };
    let meta: unknown;
    try {
        meta = yaml.load(split.frontmatterRaw, { schema: yaml.CORE_SCHEMA });
    } catch {
        return { problem: 'bad_yaml' };
    }
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return { problem: 'bad_yaml' };
    return { frontmatterRaw: split.frontmatterRaw, meta: meta as Record<string, unknown>, body: split.body };
}

export function validateDescription(d: unknown): d is string {
    if (typeof d !== 'string') return false;
    const t = d.trim();
    return t.length > 0 && !/[\r\n]/.test(t) && charCount(t) <= SKILL_LIMITS.descriptionChars;
}

export function projectHint(meta: Record<string, unknown>): string | undefined {
    const md = meta.metadata as Record<string, unknown> | undefined;
    const ad = md && typeof md === 'object' ? (md.adhdev as Record<string, unknown> | undefined) : undefined;
    const p = ad && typeof ad === 'object' ? ad.project : undefined;
    return typeof p === 'string' && PROJECT_SLUG_RE.test(p) ? p : undefined;
}

export function dumpFrontmatter(meta: Record<string, unknown>): string {
    return yaml.dump(meta, { schema: yaml.CORE_SCHEMA, lineWidth: -1, noRefs: true }).trimEnd();
}

export function composeSkillMd(frontmatterRaw: string, body: string): string {
    return `---\n${frontmatterRaw}\n---\n${body}`;
}

/** Frontmatter for a newly created skill. */
export function newSkillFrontmatter(name: string, description: string, project?: string): string {
    const meta: Record<string, unknown> = { name, description: description.trim() };
    if (project) meta.metadata = { adhdev: { project } };
    return dumpFrontmatter(meta);
}

/** Replace only the description, keeping every other key (re-dumped). */
export function withDescription(frontmatterRaw: string, description: string): string {
    const meta = yaml.load(frontmatterRaw, { schema: yaml.CORE_SCHEMA }) as Record<string, unknown>;
    return dumpFrontmatter({ ...meta, description: description.trim() });
}

// ── Directory reader ────────────────────────────────────────────────────────

export interface SkillDirFile {
    /** `references/foo.md` */
    path: string;
    chars: number;
}

export type SkillLimitReason = 'body' | 'file_count' | 'file_size';

export interface SkillDirRead {
    name: string;
    /** Set when SKILL.md is unusable; the skill is left out of the index. */
    problem?: SkillFormatProblem;
    /** With problem `blocked_content`: the first finding (pattern id only, never the text). */
    blocked?: StoreContentFinding;
    frontmatterRaw: string;
    meta: Record<string, unknown>;
    description: string;
    project?: string;
    body: string;
    bodyChars: number;
    files: SkillDirFile[];
    /** Files present but not read: disallowed extension, symlink, too deep, bad name. */
    ignoredFiles: string[];
    /** Limits this directory exceeds (never truncated). */
    overLimit: Array<{ reason: SkillLimitReason; actual: number; limit: number; path?: string }>;
}

function walkSubdir(root: string, rel: string, depth: number, out: SkillDirFile[], ignored: string[]): void {
    let names: string[];
    try {
        names = readdirSync(join(root, rel)).sort();
    } catch {
        return;
    }
    for (const n of names) {
        const childRel = `${rel}/${n}`;
        let st;
        try {
            st = lstatSync(join(root, childRel));
        } catch {
            continue;
        }
        if (st.isSymbolicLink() || !SEGMENT_RE.test(n)) {
            ignored.push(childRel);
        } else if (st.isDirectory()) {
            if (depth < MAX_FILE_DEPTH) walkSubdir(root, childRel, depth + 1, out, ignored);
            else ignored.push(childRel);
        } else if (st.isFile() && normalizeSkillFilePath(childRel)) {
            out.push({ path: childRel, chars: charCount(readFileSync(join(root, childRel), 'utf-8')) });
        } else {
            ignored.push(childRel);
        }
    }
}

/**
 * Read a skill directory without modifying anything. `expectedName` is the
 * name the frontmatter must carry (the directory name in the store; the
 * chosen name on import). Returns null when SKILL.md is missing or a symlink.
 */
export function readSkillDir(dir: string, expectedName: string): SkillDirRead | null {
    const mdPath = join(dir, SKILL_FILE);
    if (!existsSync(mdPath)) return null;
    try {
        if (!lstatSync(mdPath).isFile()) return null;
    } catch {
        return null;
    }
    const text = readFileSync(mdPath, 'utf-8');
    const files: SkillDirFile[] = [];
    const ignoredFiles: string[] = [];
    for (const sub of SKILL_SUBDIRS) {
        if (existsSync(join(dir, sub))) walkSubdir(dir, sub, 1, files, ignoredFiles);
    }
    for (const n of readdirSync(dir)) {
        if (n !== SKILL_FILE && !(SKILL_SUBDIRS as readonly string[]).includes(n)) ignoredFiles.push(n);
    }

    const parsed = parseSkillMd(text);
    const base = { name: expectedName, files, ignoredFiles };
    let out: SkillDirRead;
    if ('problem' in parsed) {
        const body = splitSkillMd(text)?.body ?? text;
        out = { ...base, problem: parsed.problem, frontmatterRaw: '', meta: {}, description: '', body, bodyChars: charCount(body), overLimit: [] };
    } else {
        let problem: SkillFormatProblem | undefined =
            parsed.meta.name !== expectedName ? 'name_mismatch' : !validateDescription(parsed.meta.description) ? 'bad_description' : undefined;
        const blocked = problem ? null : scanStoredContent(String(parsed.meta.description)) ?? scanStoredContent(parsed.body);
        if (blocked) problem = 'blocked_content';
        out = {
            ...base,
            problem,
            frontmatterRaw: parsed.frontmatterRaw,
            meta: parsed.meta,
            description: typeof parsed.meta.description === 'string' ? parsed.meta.description.trim() : '',
            project: projectHint(parsed.meta),
            body: parsed.body,
            bodyChars: charCount(parsed.body),
            overLimit: [],
            ...(blocked ? { blocked } : {}),
        };
    }
    out.overLimit = checkSkillLimits(out.bodyChars, files);
    return out;
}

export function checkSkillLimits(bodyChars: number, files: readonly SkillDirFile[]): SkillDirRead['overLimit'] {
    const over: SkillDirRead['overLimit'] = [];
    if (bodyChars > SKILL_LIMITS.bodyChars) over.push({ reason: 'body', actual: bodyChars, limit: SKILL_LIMITS.bodyChars });
    if (files.length > SKILL_LIMITS.files) over.push({ reason: 'file_count', actual: files.length, limit: SKILL_LIMITS.files });
    for (const f of files) {
        if (f.chars > SKILL_LIMITS.fileChars) over.push({ reason: 'file_size', actual: f.chars, limit: SKILL_LIMITS.fileChars, path: f.path });
    }
    return over;
}
