/**
 * Request ↔ skill matcher (design 2026-11-01-procedure-skills.md §6.1).
 *
 * Pure and deterministic: a BM25-lite coverage score over the skill's name,
 * `metadata.adhdev.triggers` and description, blended with how much of the
 * skill's own name / best trigger phrase the request contains. Scores are
 * 0..1. The thresholds are chosen values, not measurements — metrics M-S2 /
 * M-S3 are the first calibration evidence (§2).
 */

import { tokenize } from './skill-text.js';

/** Minimum score for a `project_send` skill hint (chosen). */
export const SKILL_HINT_THRESHOLD = 0.35;
/** A skill scoring at least this against a recurring request "covers" it: no new-skill proposal (chosen). */
export const SKILL_COVERED_THRESHOLD = 0.5;
export const SKILL_HINT_MAX = 2;

const FIELD_WEIGHT = { name: 3, trigger: 3, description: 1 } as const;
const PROJECT_BONUS = 0.1;
const PINNED_BONUS = 0.03;
const STALE_FACTOR = 0.85;

export interface MatchableSkill {
    name: string;
    description: string;
    triggers?: readonly string[];
    project?: string;
    status: 'active' | 'stale' | 'archived';
    pinned?: boolean;
    problem?: string;
}

export interface SkillMatch {
    name: string;
    score: number;
    /** Query tokens that hit the skill (for the hint's `why`). */
    matched: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Highest-scoring first; ties by name. Archived / problem skills and zero scores are left out. */
export function matchSkills(query: string, skills: readonly MatchableSkill[], opts: { project?: string } = {}): SkillMatch[] {
    const qTokens = [...new Set(tokenize(query))];
    if (qTokens.length === 0) return [];
    const eligible = skills.filter((s) => s.status !== 'archived' && !s.problem);
    if (eligible.length === 0) return [];

    const docs = eligible.map((s) => {
        const nameTokens = new Set(tokenize(s.name.replace(/-/g, ' ')));
        const triggerPhrases = (s.triggers ?? []).map((t) => [...new Set(tokenize(t))]).filter((p) => p.length > 0);
        const triggerTokens = new Set(triggerPhrases.flat());
        const descTokens = new Set(tokenize(s.description));
        return { s, nameTokens, triggerPhrases, triggerTokens, descTokens };
    });

    const N = docs.length;
    const idf = new Map<string, number>();
    for (const q of qTokens) {
        const df = docs.filter((d) => d.nameTokens.has(q) || d.triggerTokens.has(q) || d.descTokens.has(q)).length;
        idf.set(q, Math.max(0.1, Math.log(1 + (N - df + 0.5) / (df + 0.5))));
    }
    const denom = qTokens.reduce((n, q) => n + idf.get(q)! * FIELD_WEIGHT.name, 0);

    const out: SkillMatch[] = [];
    for (const d of docs) {
        let num = 0;
        const matched: string[] = [];
        for (const q of qTokens) {
            const fw = d.nameTokens.has(q) ? FIELD_WEIGHT.name
                : d.triggerTokens.has(q) ? FIELD_WEIGHT.trigger
                : d.descTokens.has(q) ? FIELD_WEIGHT.description : 0;
            if (fw > 0) {
                num += idf.get(q)! * fw;
                matched.push(q);
            }
        }
        if (num === 0) continue;
        const queryCoverage = num / denom;
        const phrases = [[...d.nameTokens], ...d.triggerPhrases].filter((p) => p.length > 0);
        const qSet = new Set(qTokens);
        const skillCoverage = phrases.reduce((best, p) => Math.max(best, p.filter((t) => qSet.has(t)).length / p.length), 0);
        let score = 0.5 * queryCoverage + 0.5 * skillCoverage;
        if (opts.project && d.s.project === opts.project) score += PROJECT_BONUS;
        if (d.s.pinned) score += PINNED_BONUS;
        if (d.s.status === 'stale') score *= STALE_FACTOR;
        out.push({ name: d.s.name, score: round2(Math.min(1, score)), matched });
    }
    return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/** Top hints at or above the threshold (`why` is a short, content-free reason). */
export function skillHintsFor(
    query: string, skills: readonly MatchableSkill[], opts: { project?: string; threshold?: number; max?: number } = {},
): Array<{ name: string; score: number; why: string }> {
    const threshold = opts.threshold ?? SKILL_HINT_THRESHOLD;
    return matchSkills(query, skills, opts)
        .filter((m) => m.score >= threshold)
        .slice(0, opts.max ?? SKILL_HINT_MAX)
        .map((m) => ({ name: m.name, score: m.score, why: `matched: ${m.matched.slice(0, 5).join(', ')}` }));
}
