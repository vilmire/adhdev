/**
 * Hermes import — store side (`assistant_import_skills`).
 *
 * Design: docs/design/2026-10-07-assistant-layer.md §4.10.6.
 *  - READ-ONLY on the Hermes home (default ~/.hermes): skills/**\/SKILL.md,
 *    skills/.usage.json, memories/MEMORY.md, memories/USER.md. Nothing is ever
 *    written under it; symlinks are not followed.
 *  - Skill candidates: the ones listed in `.usage.json` first (the owner's own
 *    skills), the rest flagged `listed: false` (bundled skills, shown behind
 *    "show all"). Chosen skills are copied with origin `imported`; anything
 *    over a limit is refused with `skill_too_large` — never truncated. Hermes
 *    counters go to the import journal only.
 *  - Memory candidates: one per `§` entry, each mapped by the owner to
 *    memory / user / operating note / discard. Credential-shaped entries are
 *    forced to discard. Applied as owner writes (no staging) through the
 *    memory store, so the budget still applies. Operating-note destinations
 *    are returned for a later caller (`project_note`); nothing is written.
 *  - `dryRun` defaults to true.
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { basename, join, relative } from 'path';
import { detectCredential } from '../store-guards.js';
import {
    charCount, parseMemoryEntries, MAX_MEMORY_ENTRY_CHARS, MEMORY_ENTRY_SEPARATOR,
    type AssistantMemoryStore, type MemoryTarget,
} from '../memory/memory-store.js';
import { isValidSkillName, parseSkillMd, readSkillDir, SKILL_FILE, SKILL_LIMITS, type SkillDirRead } from './skill-format.js';
import type { AssistantSkillStore, SkillManageResult } from './skill-store.js';

const MAX_SCAN_DEPTH = 6;

export function defaultHermesHome(): string {
    return join(homedir(), '.hermes');
}

export interface HermesUsage {
    state?: string;
    pinned?: boolean;
    viewCount?: number;
    patchCount?: number;
    createdAt?: string;
    lastUsedAt?: string;
}

export interface HermesSkillCandidate {
    name: string;
    /** Directory relative to <hermesHome>/skills. */
    relDir: string;
    listed: boolean;
    usage?: HermesUsage;
    bodyChars: number;
    fileCount: number;
    ignoredFileCount: number;
    /** Why it cannot be imported as-is (empty = importable, subject to apply-time checks). */
    problems: Array<
        | { code: 'skill_invalid_name' }
        | { code: 'skill_invalid_format'; reason: string }
        | { code: 'skill_too_large'; reason: string; actual: number; limit: number; path?: string }
        | { code: 'duplicate_name' }
    >;
}

export interface HermesMemoryCandidate {
    /** `memory:<i>` / `user:<i>` — stable for one scan of unchanged files. */
    id: string;
    source: MemoryTarget;
    text: string;
    /** Matches a credential pattern → destination is fixed to discard. */
    forcedDiscard: boolean;
}

export interface HermesScan {
    hermesHome: string;
    found: boolean;
    skills: HermesSkillCandidate[];
    memory: HermesMemoryCandidate[];
}

function readUsage(skillsRoot: string): Map<string, HermesUsage> {
    const out = new Map<string, HermesUsage>();
    try {
        const raw = JSON.parse(readFileSync(join(skillsRoot, '.usage.json'), 'utf-8')) as Record<string, Record<string, unknown>>;
        for (const [name, u] of Object.entries(raw ?? {})) {
            if (!u || typeof u !== 'object') continue;
            const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
            const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
            out.set(name, {
                state: str(u.state), pinned: u.pinned === true, viewCount: num(u.view_count), patchCount: num(u.patch_count),
                createdAt: str(u.created_at), lastUsedAt: str(u.last_used_at),
            });
        }
    } catch { /* missing or unreadable — no listed skills */ }
    return out;
}

/** Directories under skills/ that contain a SKILL.md (no descent into a skill's own subdirs). */
function findSkillDirs(root: string, dir: string, depth: number, out: string[]): void {
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { return; }
    if (names.includes(SKILL_FILE) && dir !== root) {
        out.push(dir);
        return;
    }
    if (depth >= MAX_SCAN_DEPTH) return;
    for (const n of names) {
        if (n.startsWith('.')) continue;
        const p = join(dir, n);
        try { if (lstatSync(p).isDirectory()) findSkillDirs(root, p, depth + 1, out); } catch { /* skip */ }
    }
}

function skillNameOf(dir: string): string {
    try {
        const parsed = parseSkillMd(readFileSync(join(dir, SKILL_FILE), 'utf-8'));
        if (!('problem' in parsed) && typeof parsed.meta.name === 'string') return parsed.meta.name;
    } catch { /* fall through */ }
    return basename(dir);
}

interface ScannedSkill { candidate: HermesSkillCandidate; dir: string; read: SkillDirRead | null }

function scanSkills(hermesHome: string): ScannedSkill[] {
    const root = join(hermesHome, 'skills');
    if (!existsSync(root)) return [];
    const usage = readUsage(root);
    const dirs: string[] = [];
    findSkillDirs(root, root, 0, dirs);
    const seen = new Set<string>();
    const out: ScannedSkill[] = [];
    for (const dir of dirs) {
        const name = skillNameOf(dir);
        const read = readSkillDir(dir, name);
        const problems: HermesSkillCandidate['problems'] = [];
        if (seen.has(name)) problems.push({ code: 'duplicate_name' });
        seen.add(name);
        if (!isValidSkillName(name)) problems.push({ code: 'skill_invalid_name' });
        if (!read) problems.push({ code: 'skill_invalid_format', reason: 'unreadable' });
        else {
            if (read.problem) problems.push({ code: 'skill_invalid_format', reason: read.problem });
            for (const o of read.overLimit) problems.push({ code: 'skill_too_large', ...o });
        }
        out.push({
            dir, read,
            candidate: {
                name, relDir: relative(root, dir), listed: usage.has(name), usage: usage.get(name),
                bodyChars: read?.bodyChars ?? 0, fileCount: read?.files.length ?? 0, ignoredFileCount: read?.ignoredFiles.length ?? 0, problems,
            },
        });
    }
    return out.sort((a, b) => {
        const A = a.candidate, B = b.candidate;
        if (A.listed !== B.listed) return A.listed ? -1 : 1;
        return (B.usage?.viewCount ?? 0) - (A.usage?.viewCount ?? 0) || A.name.localeCompare(B.name);
    });
}

function scanMemory(hermesHome: string): HermesMemoryCandidate[] {
    const out: HermesMemoryCandidate[] = [];
    for (const [source, file] of [['memory', 'MEMORY.md'], ['user', 'USER.md']] as const) {
        let text: string;
        try { text = readFileSync(join(hermesHome, 'memories', file), 'utf-8'); } catch { continue; }
        parseMemoryEntries(text).forEach((entry, i) => {
            out.push({ id: `${source}:${i}`, source, text: entry, forcedDiscard: detectCredential(entry) !== null });
        });
    }
    return out;
}

/** Read-only scan of a Hermes home. */
export function scanHermesHome(hermesHome: string = defaultHermesHome()): HermesScan {
    const found = existsSync(hermesHome);
    return {
        hermesHome,
        found,
        skills: found ? scanSkills(hermesHome).map((s) => s.candidate) : [],
        memory: found ? scanMemory(hermesHome) : [],
    };
}

// ── apply ───────────────────────────────────────────────────────────────────

export type HermesMemoryDestination = 'memory' | 'user' | 'discard' | { operatingNote: string };

export interface HermesImportRequest {
    hermesHome?: string;
    /** Default true: report what would happen, write nothing. */
    dryRun?: boolean;
    /** Skill names (from the scan) to copy. */
    skills?: string[];
    memory?: Array<{ id: string; destination: HermesMemoryDestination }>;
}

export type HermesSkillImportResult =
    | { name: string; result: 'would_import' }
    | { name: string; result: 'skill_not_found' | 'duplicate_name' }
    | ({ name: string } & Exclude<SkillManageResult, { result: 'staged' }>);

export interface HermesMemoryImportResult {
    id: string;
    destination: HermesMemoryDestination;
    /** `would_apply`, `applied`, `discarded`, `forced_discard`, `operating_note_deferred`, `not_found`, or a memory refusal code. */
    result: string;
}

export interface HermesImportResult {
    dryRun: boolean;
    hermesHome: string;
    skills: HermesSkillImportResult[];
    memory: HermesMemoryImportResult[];
    /** Entries the owner routed to a project's operating notes, for the `project_note` caller. */
    operatingNotes: Array<{ id: string; project: string; text: string }>;
}

export function importFromHermes(
    req: HermesImportRequest,
    stores: { skills: AssistantSkillStore; memory: AssistantMemoryStore },
): HermesImportResult {
    const hermesHome = req.hermesHome ?? defaultHermesHome();
    const dryRun = req.dryRun !== false;
    const result: HermesImportResult = { dryRun, hermesHome, skills: [], memory: [], operatingNotes: [] };

    // Skills
    const scanned = req.skills?.length ? scanSkills(hermesHome) : [];
    let plannedLive = 0;
    for (const name of req.skills ?? []) {
        const matches = scanned.filter((s) => s.candidate.name === name);
        if (!matches.length) { result.skills.push({ name, result: 'skill_not_found' }); continue; }
        if (matches.length > 1) { result.skills.push({ name, result: 'duplicate_name' }); continue; }
        const { dir, read, candidate } = matches[0]!;
        if (!isValidSkillName(name)) { result.skills.push({ name, result: 'skill_invalid_name' }); continue; }
        if (!read || read.problem) {
            result.skills.push({ name, result: 'skill_invalid_format', reason: 'unparseable_skill_md' });
            continue;
        }
        const over = read.overLimit[0];
        if (over) { result.skills.push({ name, result: 'skill_too_large', ...over }); continue; }
        const input = {
            name, frontmatterRaw: read.frontmatterRaw, body: read.body,
            files: read.files.map((f) => ({ path: f.path, content: readFileSync(join(dir, f.path), 'utf-8') })),
            sourceUsage: candidate.usage ? { ...candidate.usage } : undefined,
        };
        if (dryRun) {
            const pre = stores.skills.checkImport(input);
            if (pre) { result.skills.push({ name, ...pre }); continue; }
            const live = stores.skills.liveCount() + plannedLive;
            if (live >= SKILL_LIMITS.liveSkills) { result.skills.push({ name, result: 'skill_limit', live, limit: SKILL_LIMITS.liveSkills }); continue; }
            plannedLive++;
            result.skills.push({ name, result: 'would_import' });
        } else {
            const r = stores.skills.importSkill(input);
            result.skills.push({ name, ...(r as Exclude<SkillManageResult, { result: 'staged' }>) });
        }
    }

    // Memory
    if (req.memory?.length) {
        const candidates = new Map(scanMemory(hermesHome).map((c) => [c.id, c]));
        const sim: Record<MemoryTarget, string[]> = {
            memory: [...stores.memory.readFile('memory').entries],
            user: [...stores.memory.readFile('user').entries],
        };
        for (const { id, destination } of req.memory) {
            const c = candidates.get(id);
            const push = (r: string) => result.memory.push({ id, destination, result: r });
            if (!c) { push('not_found'); continue; }
            if (destination === 'discard') { push('discarded'); continue; }
            if (c.forcedDiscard) { push('forced_discard'); continue; }
            if (typeof destination === 'object') {
                const project = destination?.operatingNote;
                if (typeof project !== 'string' || !project) { push('invalid_destination'); continue; }
                result.operatingNotes.push({ id, project, text: c.text });
                push('operating_note_deferred');
                continue;
            }
            if (destination !== 'memory' && destination !== 'user') { push('invalid_destination'); continue; }
            if (!dryRun) {
                push(stores.memory.apply({ action: 'add', target: destination, content: c.text }, 'owner').result);
                continue;
            }
            const entries = sim[destination];
            const budget = stores.memory.budgets[destination];
            if (charCount(c.text) > MAX_MEMORY_ENTRY_CHARS) push('memory_invalid_format');
            else if (entries.includes(c.text)) push('memory_duplicate');
            else if (charCount([...entries, c.text].join(MEMORY_ENTRY_SEPARATOR)) > budget) push('memory_budget_exceeded');
            else {
                entries.push(c.text);
                push('would_apply');
            }
        }
    }
    return result;
}
