/** Request ↔ skill matcher (design 2026-11-01-procedure-skills.md §6.1, acceptance 4). */
import { describe, expect, it } from 'vitest';
import { SKILL_HINT_THRESHOLD, matchSkills, skillHintsFor, type MatchableSkill } from '../../src/assistant/skills/skill-match.js';
import { STARTER_SKILLS } from '../../src/assistant/skills/starter-skills.js';

const sk = (over: Partial<MatchableSkill> & { name: string }): MatchableSkill => ({ description: 'd', status: 'active', ...over });
const skills: MatchableSkill[] = [
    sk({ name: 'preview-release', description: 'Ship a preview build and verify it live', triggers: ['deploy the preview', 'preview 배포'] }),
    sk({ name: 'blog-publish', description: 'Publish a blog post', project: 'blog' }),
    sk({ name: 'archived-one', description: 'Deploy the preview everywhere', status: 'archived' }),
    sk({ name: 'broken-one', description: 'Deploy the preview', problem: 'bad_yaml' }),
];

describe('matchSkills', () => {
    it('ranks the skill whose name / triggers fit the request and ignores unrelated ones', () => {
        const m = matchSkills('deploy the preview build and verify it', skills);
        expect(m[0]!.name).toBe('preview-release');
        expect(m.map((x) => x.name)).not.toContain('blog-publish');
        expect(m[0]!.score).toBeGreaterThanOrEqual(SKILL_HINT_THRESHOLD);
    });

    it('matches Korean through a trigger phrase', () => {
        const m = matchSkills('프리뷰 배포 해줘', skills);
        expect(m[0]).toMatchObject({ name: 'preview-release' });
    });

    it('leaves out archived and problem skills', () => {
        const names = matchSkills('deploy the preview', skills).map((x) => x.name);
        expect(names).not.toContain('archived-one');
        expect(names).not.toContain('broken-one');
    });

    it('a request that shares nothing gets no hint; a single weak word stays under the threshold', () => {
        expect(skillHintsFor('fix the rss feed', skills)).toEqual([]);
        expect(skillHintsFor('write something about the release schedule for next quarter planning', skills)).toEqual([]);
    });

    it('is deterministic and breaks ties by name', () => {
        const a = matchSkills('deploy the preview build', skills);
        const b = matchSkills('deploy the preview build', [...skills].reverse());
        expect(a).toEqual(b);
        const twins = [sk({ name: 'zeta-deploy', description: 'deploy things' }), sk({ name: 'alpha-deploy', description: 'deploy things' })];
        expect(matchSkills('deploy things', twins).map((x) => x.name)).toEqual(['alpha-deploy', 'zeta-deploy']);
    });

    it('adds a bonus for the project slug', () => {
        const base = matchSkills('publish the blog post', skills);
        const withProject = matchSkills('publish the blog post', skills, { project: 'blog' });
        expect(withProject[0]!.score).toBeGreaterThan(base[0]!.score);
    });

    it('stale skills score lower than the same skill active', () => {
        const active = matchSkills('deploy the preview', [skills[0]!])[0]!.score;
        const stale = matchSkills('deploy the preview', [{ ...skills[0]!, status: 'stale' }])[0]!.score;
        expect(stale).toBeLessThan(active);
    });

    it('returns at most two hints with a content-free reason', () => {
        const many = Array.from({ length: 5 }, (_, i) => sk({ name: `deploy-${i}`, description: 'deploy the preview' }));
        const hints = skillHintsFor('deploy the preview', many);
        expect(hints).toHaveLength(2);
        expect(hints[0]!.why).toMatch(/^matched: /);
    });

    it('the shipped starter skills answer their own trigger phrases', () => {
        const asSkills = STARTER_SKILLS.map((d) => sk({ name: d.name, description: d.description, triggers: d.triggers }));
        expect(skillHintsFor('deploy a change and verify it before release', asSkills)[0]?.name).toBe('deploy-verify-checklist');
        expect(skillHintsFor('delegate a task to the project', asSkills)[0]?.name).toBe('mesh-dispatch-hygiene');
    });
});
