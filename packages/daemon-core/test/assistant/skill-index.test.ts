import { describe, expect, it } from 'vitest';
import {
    SKILL_INDEX_HEADER,
    orderSkillsForIndex,
    renderAttachedProcedure,
    renderSkillIndex,
    renderSkillIndexLine,
} from '../../src/assistant/skills/skill-index.js';
import type { SkillSummary } from '../../src/assistant/skills/skill-store.js';

/** Skill index block and attach block (design 2026-10-07-assistant-layer.md §4.10.4–4.10.5). */

const sk = (name: string, over: Partial<SkillSummary> = {}): SkillSummary => ({
    name,
    description: `desc of ${name}`,
    status: 'active',
    pinned: false,
    origin: 'agent',
    createdAt: '2026-10-01T00:00:00.000Z',
    viewCount: 0,
    lastViewedAt: null,
    patchesSinceReview: 0,
    needsReview: false,
    ...over,
});

describe('renderSkillIndex', () => {
    it('line format with optional [project] and (stale)', () => {
        expect(renderSkillIndexLine(sk('release-report', { project: 'adhdev' }))).toBe('- release-report [adhdev]: desc of release-report');
        expect(renderSkillIndexLine(sk('bump-deps'))).toBe('- bump-deps: desc of bump-deps');
        expect(renderSkillIndexLine(sk('old-one', { status: 'stale' }))).toBe('- old-one (stale): desc of old-one');
    });

    it('orders pinned → active by most recent view → stale, and drops archived / invalid', () => {
        const order = orderSkillsForIndex([
            sk('stale-a', { status: 'stale', lastViewedAt: '2026-10-06T00:00:00Z' }),
            sk('active-old', { lastViewedAt: '2026-09-01T00:00:00Z' }),
            sk('active-never'),
            sk('active-new', { lastViewedAt: '2026-10-06T00:00:00Z' }),
            sk('pinned-x', { pinned: true }),
            sk('gone', { status: 'archived', pinned: true }),
            sk('broken', { problem: 'bad_yaml' }),
        ]).map((s) => s.name);
        expect(order).toEqual(['pinned-x', 'active-new', 'active-old', 'active-never', 'stale-a']);
    });

    it('empty store renders "(none)"', () => {
        expect(renderSkillIndex([])).toBe(`${SKILL_INDEX_HEADER}\n(none)`);
    });

    it('fits the 3,000-char budget and folds the rest into (+N more: skill_view "list")', () => {
        const skills = Array.from({ length: 40 }, (_, i) => sk(`skill-${String(i).padStart(2, '0')}`, { description: 'x'.repeat(150) }));
        const out = renderSkillIndex(skills);
        expect(Array.from(out).length).toBeLessThanOrEqual(3000);
        const lines = out.split('\n');
        const shown = lines.filter((l) => l.startsWith('- ')).length;
        expect(shown).toBeGreaterThan(10);
        expect(shown).toBeLessThan(40);
        expect(lines.at(-1)).toBe(`(+${40 - shown} more: skill_view "list")`);
        // everything that fits is shown in full, no fold
        expect(renderSkillIndex(skills.slice(0, 3))).not.toContain('more: skill_view');
    });

    it('counts code points, not UTF-16 units', () => {
        const skills = [sk('ko-a', { description: '가'.repeat(100) }), sk('ko-b', { description: '😀'.repeat(100) })];
        const out = renderSkillIndex(skills, Array.from(SKILL_INDEX_HEADER).length + 1 + Array.from(renderSkillIndexLine(skills[0]!)).length + 1 + 30);
        expect(out).toContain('- ko-a');
        expect(out.split('\n').at(-1)).toBe('(+1 more: skill_view "list")');
    });
});

describe('renderAttachedProcedure', () => {
    it('renders the attach header with origin and the SKILL.md body', () => {
        expect(renderAttachedProcedure({ name: 'release-report', origin: 'imported', body: '\n# Steps\n1. do it\n' })).toBe(
            '## Attached procedure: release-report (assistant skill, origin imported)\n\n# Steps\n1. do it',
        );
    });
});
