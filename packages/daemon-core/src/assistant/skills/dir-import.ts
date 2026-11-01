/**
 * Directory import (`assistant_import_skills {source:'dir'}`) — copies skills
 * kept in a project repository (`docs/skills/` or `.claude/skills/`, Claude
 * Code skill layout: `<name>/SKILL.md` + optional `references/`) into the
 * assistant skill store with origin `imported`. This is how an owner installs
 * repository-specific procedures locally; none are shipped with the product
 * (design 2026-11-01-procedure-skills.md §8, owner decision D2).
 *
 * Read-only on the repository. The directory is never a request path: the
 * caller resolves a known project's checkout root, and only the two fixed
 * sub-directories are accepted; the resolved directory must stay inside that
 * root (symlinks that leave it are refused). `dryRun` defaults to true.
 */

import { existsSync, readFileSync, realpathSync } from 'fs';
import { join, relative, sep } from 'path';
import { blockedCode, findSkillDirs, skillNameOf } from './hermes-import.js';
import { isValidSkillName, readSkillDir, SKILL_LIMITS } from './skill-format.js';
import type { AssistantSkillStore, SkillManageResult } from './skill-store.js';

/** The only repository sub-directories a dir import reads. */
export const DIR_IMPORT_SUBDIRS = ['docs/skills', '.claude/skills'] as const;
export type DirImportSubdir = typeof DIR_IMPORT_SUBDIRS[number];

export interface DirSkillCandidate {
    name: string;
    relDir: string;
    bodyChars: number;
    fileCount: number;
    /** Empty = importable, subject to apply-time checks. */
    problems: string[];
}

/** Resolve `<root>/<subdir>` to a real directory inside `root`, or null. */
export function resolveSkillDirectory(root: string, subdir: string): string | null {
    if (!(DIR_IMPORT_SUBDIRS as readonly string[]).includes(subdir)) return null;
    try {
        const realRoot = realpathSync(root);
        const dir = join(realRoot, ...subdir.split('/'));
        if (!existsSync(dir)) return null;
        const realDir = realpathSync(dir);
        const rel = relative(realRoot, realDir);
        return rel && !rel.startsWith('..') && !rel.split(sep).includes('..') ? realDir : null;
    } catch {
        return null;
    }
}

interface Scanned { candidate: DirSkillCandidate; dir: string; read: ReturnType<typeof readSkillDir> }

function scan(dir: string, existing: ReadonlySet<string>): Scanned[] {
    const dirs: string[] = [];
    findSkillDirs(dir, dir, 0, dirs);
    const seen = new Set<string>();
    return dirs.map((d) => {
        const name = skillNameOf(d);
        const read = readSkillDir(d, name);
        const problems: string[] = [];
        if (seen.has(name)) problems.push('duplicate_name');
        seen.add(name);
        if (!isValidSkillName(name)) problems.push('skill_invalid_name');
        if (existing.has(name)) problems.push('skill_exists');
        if (!read) problems.push('skill_invalid_format');
        else {
            if (read.problem === 'blocked_content' && read.blocked) problems.push(blockedCode(read.blocked));
            else if (read.problem) problems.push('skill_invalid_format');
            for (const o of read.overLimit) problems.push(`skill_too_large:${o.reason}`);
        }
        return {
            dir: d, read,
            candidate: { name, relDir: relative(dir, d), bodyChars: read?.bodyChars ?? 0, fileCount: read?.files.length ?? 0, problems },
        };
    });
}

export function scanSkillDirectory(dir: string, store: Pick<AssistantSkillStore, 'list'>): DirSkillCandidate[] {
    return scan(dir, new Set(store.list().map((s) => s.name))).map((s) => s.candidate);
}

export type DirSkillImportResult =
    | { name: string; result: 'would_import' | 'skill_not_found' | 'duplicate_name' | 'skill_invalid_name' }
    | ({ name: string } & Exclude<SkillManageResult, { result: 'staged' }>);

export function importFromDirectory(
    req: { dir: string; skills: readonly string[]; dryRun?: boolean },
    store: AssistantSkillStore,
): { dryRun: boolean; skills: DirSkillImportResult[] } {
    const dryRun = req.dryRun !== false;
    const scanned = scan(req.dir, new Set());
    const results: DirSkillImportResult[] = [];
    let plannedLive = 0;
    for (const name of req.skills) {
        const matches = scanned.filter((s) => s.candidate.name === name);
        if (!matches.length) { results.push({ name, result: 'skill_not_found' }); continue; }
        if (matches.length > 1) { results.push({ name, result: 'duplicate_name' }); continue; }
        const { dir, read } = matches[0]!;
        if (!isValidSkillName(name)) { results.push({ name, result: 'skill_invalid_name' }); continue; }
        if (read?.problem === 'blocked_content' && read.blocked) {
            const code = blockedCode(read.blocked);
            results.push(code === 'skill_secret_rejected' ? { name, result: code } : { name, result: code, pattern: read.blocked.pattern } as DirSkillImportResult);
            continue;
        }
        if (!read || read.problem) { results.push({ name, result: 'skill_invalid_format', reason: 'unparseable_skill_md' }); continue; }
        const over = read.overLimit[0];
        if (over) { results.push({ name, result: 'skill_too_large', ...over }); continue; }
        const input = {
            name, frontmatterRaw: read.frontmatterRaw, body: read.body,
            files: read.files.map((f) => ({ path: f.path, content: readFileSync(join(dir, f.path), 'utf-8') })),
        };
        if (dryRun) {
            const pre = store.checkImport(input);
            if (pre) { results.push({ name, ...pre }); continue; }
            const live = store.liveCount() + plannedLive;
            if (live >= SKILL_LIMITS.liveSkills) { results.push({ name, result: 'skill_limit', live, limit: SKILL_LIMITS.liveSkills }); continue; }
            plannedLive++;
            results.push({ name, result: 'would_import' });
        } else {
            results.push({ name, ...(store.importSkill(input) as Exclude<SkillManageResult, { result: 'staged' }>) });
        }
    }
    return { dryRun, skills: results };
}
