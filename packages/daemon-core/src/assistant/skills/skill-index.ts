/**
 * Skill index block (frozen at session start, right after the memory
 * snapshot) and the `## Attached procedure` block for `project_send`.
 *
 * Design: docs/design/2026-10-07-assistant-layer.md §4.10.4 (index), §4.10.5
 * (attach). Pure functions — no I/O.
 */

import type { SkillOrigin } from './skill-format.js';
import type { SkillSummary } from './skill-store.js';

export const SKILL_INDEX_BUDGET_CHARS = 3_000;
export const SKILL_INDEX_HEADER = '## Skills (read one with skill_view "<name>" before following it)';

type IndexEntry = Pick<SkillSummary, 'name' | 'description' | 'project' | 'status' | 'pinned' | 'lastViewedAt' | 'problem'>;

/** `- <name> [<project>]: <description>`, with ` (stale)` after the name part for stale skills. */
export function renderSkillIndexLine(s: IndexEntry): string {
    const project = s.project ? ` [${s.project}]` : '';
    const stale = s.status === 'stale' ? ' (stale)' : '';
    return `- ${s.name}${project}${stale}: ${s.description}`;
}

function viewedAt(s: IndexEntry): number {
    const t = s.lastViewedAt ? Date.parse(s.lastViewedAt) : NaN;
    return Number.isFinite(t) ? t : -Infinity;
}

/**
 * Order: pinned → active (most recently viewed first) → stale. Archived skills
 * and skills whose SKILL.md is unusable are left out. Ties break by name so
 * the frozen block is deterministic.
 */
export function orderSkillsForIndex<T extends IndexEntry>(skills: readonly T[]): T[] {
    const rank = (s: IndexEntry) => (s.pinned ? 0 : s.status === 'active' ? 1 : 2);
    return skills
        .filter((s) => s.status !== 'archived' && !s.problem)
        .sort((a, b) => rank(a) - rank(b) || viewedAt(b) - viewedAt(a) || a.name.localeCompare(b.name));
}

/**
 * Render the index within `budget` code points (header included). Lines that
 * do not fit are folded into `(+N more: skill_view "list")`. Counted in
 * Unicode code points, like the memory budget.
 */
export function renderSkillIndex(skills: readonly IndexEntry[], budget: number = SKILL_INDEX_BUDGET_CHARS): string {
    const ordered = orderSkillsForIndex(skills);
    if (!ordered.length) return `${SKILL_INDEX_HEADER}\n(none)`;
    const len = (s: string) => Array.from(s).length;
    const lines = ordered.map(renderSkillIndexLine);
    const fold = (n: number) => `(+${n} more: skill_view "list")`;
    const kept: string[] = [SKILL_INDEX_HEADER];
    let used = len(SKILL_INDEX_HEADER);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const remaining = lines.length - i - 1;
        const need = used + 1 + len(line) + (remaining > 0 ? 1 + len(fold(remaining)) : 0);
        if (need > budget) {
            kept.push(fold(lines.length - i));
            return kept.join('\n');
        }
        kept.push(line);
        used += 1 + len(line);
    }
    return kept.join('\n');
}

/**
 * The block `project_send` appends under the user's text and the assistant's
 * additions (§4.10.5). Only SKILL.md's body is attached — reference files are
 * not. Visible in the coordinator transcript; not a hidden injection.
 */
export function renderAttachedProcedure(skill: { name: string; origin: SkillOrigin; body: string }): string {
    return `## Attached procedure: ${skill.name} (assistant skill, origin ${skill.origin})\n\n${skill.body.trim()}`;
}
