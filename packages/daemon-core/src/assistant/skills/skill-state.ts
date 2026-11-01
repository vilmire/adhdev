/**
 * Assistant skill `.state.json` — status, pin, origin and counters, kept out
 * of the frontmatter so a skill directory copies cleanly to/from Claude Code
 * `.claude/skills/` or Hermes (design 2026-10-07-assistant-layer.md §4.10.4).
 *
 * One file for the whole store, `<skillsDir>/.state.json`, keyed by skill
 * name (like Hermes `skills/.usage.json`). A skill directory without an entry
 * (made by hand in an editor) is treated as an owner skill, active, created at
 * its SKILL.md mtime.
 */

import { existsSync, readFileSync } from 'fs';
import { writeFileAtomic600 } from '../store-guards.js';
import type { SkillOrigin, SkillStatus } from './skill-format.js';

/** Self-patch caps (§4.10.4). Chosen values, not measured. */
export const SKILL_PATCH_CAPS = {
    perSession: 3,
    perTurn: 1,
    /** Cumulative patches since the last owner review that lock the skill. */
    sinceReview: 10,
} as const;

/** How many distinct session / turn keys a skill remembers counts for. */
const MAX_TRACKED_KEYS = 20;

export interface SkillState {
    status: SkillStatus;
    pinned: boolean;
    origin: SkillOrigin;
    createdAt: string;
    statusChangedAt: string;
    viewCount: number;
    lastViewedAt: string | null;
    /**
     * Times the skill body was attached to a `project_send` (one per message).
     * This is the USE count; `viewCount` only says the assistant read it
     * (design 2026-11-01-procedure-skills.md §3). Optional in old files.
     */
    attachCount: number;
    lastAttachedAt: string | null;
    /** Hint-quality counters: shown in a `project_send` response / then attached to the next send. */
    hintShownCount: number;
    hintAcceptCount: number;
    patchCount: number;
    lastPatchedAt: string | null;
    /** Applied agent patches since the owner last cleared the review lock. */
    patchesSinceReview: number;
    /** Accepted agent patches (applied or staged) per caller-supplied sessionId. */
    sessionPatches: Record<string, number>;
    /** Accepted agent patches per `<sessionId>\u0000<turnId>`. */
    turnPatches: Record<string, number>;
}

export interface SkillStateFile {
    version: 1;
    skills: Record<string, SkillState>;
    /** Starter skills the owner archived — never re-installed (tombstones). */
    starterDismissed?: string[];
}

export function newSkillState(origin: SkillOrigin, nowIso: string): SkillState {
    return {
        status: 'active',
        pinned: false,
        origin,
        createdAt: nowIso,
        statusChangedAt: nowIso,
        viewCount: 0,
        lastViewedAt: null,
        attachCount: 0,
        lastAttachedAt: null,
        hintShownCount: 0,
        hintAcceptCount: 0,
        patchCount: 0,
        lastPatchedAt: null,
        patchesSinceReview: 0,
        sessionPatches: {},
        turnPatches: {},
    };
}

export function needsReview(s: SkillState): boolean {
    return s.patchesSinceReview >= SKILL_PATCH_CAPS.sinceReview;
}

export function turnKey(sessionId: string, turnId: string): string {
    return `${sessionId}\u0000${turnId}`;
}

/** Increment a bounded counter map; the oldest keys are dropped past MAX_TRACKED_KEYS. */
export function bumpCounter(map: Record<string, number>, key: string): Record<string, number> {
    const next = { ...map };
    const v = (next[key] ?? 0) + 1;
    delete next[key];
    next[key] = v; // re-insert so insertion order = recency
    const keys = Object.keys(next);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_TRACKED_KEYS))) delete next[k];
    return next;
}

const STATUSES: readonly SkillStatus[] = ['active', 'stale', 'archived'];
const ORIGINS: readonly SkillOrigin[] = ['agent', 'owner', 'imported', 'starter'];

function sanitize(raw: unknown, fallbackIso: string): SkillState | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Partial<SkillState>;
    const base = newSkillState(ORIGINS.includes(r.origin as SkillOrigin) ? (r.origin as SkillOrigin) : 'owner', fallbackIso);
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    const counters = (v: unknown) => {
        const out: Record<string, number> = {};
        if (v && typeof v === 'object') for (const [k, n] of Object.entries(v)) if (num(n) > 0) out[k] = num(n);
        return out;
    };
    return {
        ...base,
        status: STATUSES.includes(r.status as SkillStatus) ? (r.status as SkillStatus) : 'active',
        pinned: r.pinned === true,
        createdAt: str(r.createdAt) ?? fallbackIso,
        statusChangedAt: str(r.statusChangedAt) ?? str(r.createdAt) ?? fallbackIso,
        viewCount: num(r.viewCount),
        lastViewedAt: str(r.lastViewedAt),
        attachCount: num(r.attachCount),
        lastAttachedAt: str(r.lastAttachedAt),
        hintShownCount: num(r.hintShownCount),
        hintAcceptCount: num(r.hintAcceptCount),
        patchCount: num(r.patchCount),
        lastPatchedAt: str(r.lastPatchedAt),
        patchesSinceReview: num(r.patchesSinceReview),
        sessionPatches: counters(r.sessionPatches),
        turnPatches: counters(r.turnPatches),
    };
}

/**
 * Read the state file. Missing → empty. A corrupt file is NOT silently reset
 * to empty on the next write: `corrupt` is set and the store refuses writes.
 */
export function readSkillStateFile(path: string, fallbackIso: string): { file: SkillStateFile; corrupt?: string } {
    const empty: SkillStateFile = { version: 1, skills: {} };
    if (!existsSync(path)) return { file: empty };
    try {
        const raw = JSON.parse(readFileSync(path, 'utf-8')) as { skills?: Record<string, unknown>; starterDismissed?: unknown };
        const skills: Record<string, SkillState> = {};
        for (const [name, v] of Object.entries(raw?.skills ?? {})) {
            const s = sanitize(v, fallbackIso);
            if (s) skills[name] = s;
        }
        const dismissed = Array.isArray(raw?.starterDismissed) ? raw.starterDismissed.filter((n): n is string => typeof n === 'string') : [];
        return { file: { version: 1, skills, ...(dismissed.length ? { starterDismissed: dismissed } : {}) } };
    } catch (err) {
        return { file: empty, corrupt: err instanceof Error ? err.message : String(err) };
    }
}

export function writeSkillStateFile(path: string, file: SkillStateFile): void {
    writeFileAtomic600(path, `${JSON.stringify(file, null, 2)}\n`);
}

/**
 * Latest of the timestamps that keep a skill alive: a skill used only through
 * `project_send` attachments has no view, so view-only recency would archive it
 * (design 2026-11-01-procedure-skills.md §4.2). Returns NaN when none parses.
 */
export function lastUsedMs(s: Pick<SkillState, 'lastViewedAt' | 'lastAttachedAt' | 'createdAt'>): number {
    let best = NaN;
    for (const t of [s.lastViewedAt, s.lastAttachedAt, s.createdAt]) {
        const ms = t ? Date.parse(t) : NaN;
        if (Number.isFinite(ms) && !(ms <= best)) best = ms;
    }
    return best;
}
