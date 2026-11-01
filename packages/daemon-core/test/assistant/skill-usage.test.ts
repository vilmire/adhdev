/**
 * Skill usage (design 2026-11-01-procedure-skills.md §3, §4): `attachCount`
 * is the use count and is separate from `viewCount`; an attach-only skill is
 * not archived by the curator; old `.state.json` files load unchanged; the
 * owner list reads without moving a counter; skill_views / skill_writes
 * metrics are actually incremented.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASSISTANT_VERB } from '@adhdev/mesh-shared';
import { AssistantSkillStore } from '../../src/assistant/skills/skill-store.js';
import { AssistantCurator, CURATOR_RULES } from '../../src/assistant/skills/skill-curator.js';
import { orderSkillsForIndex } from '../../src/assistant/skills/skill-index.js';
import { assistantStoreHandlers } from '../../src/commands/high-family/assistant-store.js';
import { ASSISTANT_SKILLS_LIST_COMMAND } from '../../src/commands/high-family/assistant-skill-verbs.js';
import { createAssistantServices, setAssistantServicesForTests, type AssistantServices } from '../../src/assistant/assistant-services.js';

const DAY = 24 * 60 * 60 * 1000;
let dir: string;
let clock: Date;
const mk = () => new AssistantSkillStore({ configDir: dir, now: () => clock });
const make = (s: AssistantSkillStore, name = 'release-report') =>
    s.manage({ action: 'create', name, description: 'How to write a release report', body: '# Steps\n1. collect\n' }, 'owner', null);
const advance = (days: number) => { clock = new Date(clock.getTime() + days * DAY); };

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adhdev-skill-usage-'));
    clock = new Date('2026-10-07T09:00:00Z');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('attach counts as use, view stays a read', () => {
    it('recordAttach bumps attachCount + lastAttachedAt, once per (message, skill), never viewCount', () => {
        const s = mk();
        make(s);
        expect(s.recordAttach(['release-report'], 'm1')).toEqual(['release-report']);
        expect(s.recordAttach(['release-report'], 'm1')).toEqual([]); // retried send
        expect(s.recordAttach(['release-report'], 'm2')).toEqual(['release-report']);
        const row = s.list().find((x) => x.name === 'release-report')!;
        expect(row).toMatchObject({ attachCount: 2, viewCount: 0, lastAttachedAt: clock.toISOString(), lastViewedAt: null });
    });

    it('a view does not change attachCount; an attach revives a stale skill', () => {
        const s = mk();
        make(s);
        s.view('release-report');
        expect(s.list()[0]).toMatchObject({ viewCount: 1, attachCount: 0 });
        advance(40);
        new AssistantCurator(s, null).runCurator(clock);
        expect(s.list()[0]!.status).toBe('stale');
        s.recordAttach(['release-report'], 'm1');
        expect(s.list()[0]).toMatchObject({ status: 'active', attachCount: 1 });
    });

    it('skills that do not exist are not counted', () => {
        const s = mk();
        expect(s.recordAttach(['nope'], 'm1')).toEqual([]);
    });

    it('a .state.json written before attachCount existed loads with zero counters', () => {
        const s = mk();
        make(s);
        const path = join(dir, 'assistant', 'skills', '.state.json');
        writeFileSync(path, JSON.stringify({
            version: 1,
            skills: { 'release-report': { status: 'active', pinned: false, origin: 'agent', createdAt: '2026-09-01T00:00:00.000Z', statusChangedAt: '2026-09-01T00:00:00.000Z', viewCount: 3, lastViewedAt: '2026-09-02T00:00:00.000Z', patchCount: 0, lastPatchedAt: null, patchesSinceReview: 0, sessionPatches: {}, turnPatches: {} } },
        }));
        expect(mk().list()[0]).toMatchObject({ viewCount: 3, attachCount: 0, lastAttachedAt: null, hintShownCount: 0, hintAcceptCount: 0 });
    });

    it('the index orders by the latest of view / attach', () => {
        const mkEntry = (name: string, lastViewedAt: string | null, lastAttachedAt: string | null) =>
            ({ name, description: 'd', status: 'active' as const, pinned: false, lastViewedAt, lastAttachedAt });
        const ordered = orderSkillsForIndex([
            mkEntry('viewed', '2026-10-01T00:00:00Z', null),
            mkEntry('attached', null, '2026-10-05T00:00:00Z'),
        ]);
        expect(ordered.map((x) => x.name)).toEqual(['attached', 'viewed']);
    });
});

describe('curator keeps attach-only skills (bug fix §4.2)', () => {
    it('an attach-only skill ages from its last attach, an unused one from creation', () => {
        const s = mk();
        make(s, 'used-by-attach');
        make(s, 'unused');
        const curator = new AssistantCurator(s, null);
        advance(29);
        s.recordAttach(['used-by-attach'], 'm1'); // never viewed
        advance(2); // 31 days after creation, 2 after the attach
        const r = curator.runCurator(clock);
        expect(r.staled).toEqual(['unused']);
        expect(s.list().find((x) => x.name === 'used-by-attach')!.status).toBe('active');
        advance(CURATOR_RULES.staleAfterMs / DAY); // 30 days since the attach
        expect(curator.runCurator(clock).staled).toContain('used-by-attach');
        advance(CURATOR_RULES.archiveAfterMs / DAY);
        expect(curator.runCurator(clock).archived).toContain('used-by-attach');
    });

    it('measured from creation only, a never-viewed never-attached skill is archived at 90 days (unchanged)', () => {
        const s = mk();
        make(s, 'unused');
        advance(91);
        expect(new AssistantCurator(s, null).runCurator(clock).archived).toEqual(['unused']);
    });

    it('REGRESSION: a skill attached 60 days ago and never viewed is not archived from its creation date', () => {
        const s = mk();
        make(s, 'attach-only');
        advance(95);
        s.recordAttach(['attach-only'], 'm1'); // last use today; created 95 days ago
        const r = new AssistantCurator(s, null).runCurator(clock);
        expect(r.archived).not.toContain('attach-only');
        expect(s.list()[0]!.status).toBe('active');
    });
});

describe('metrics and the owner list', () => {
    let svc: AssistantServices;
    const bump = vi.fn();
    const run = (verb: string, args: Record<string, unknown> = {}) => assistantStoreHandlers[verb]({} as any, args);
    beforeEach(() => {
        bump.mockReset();
        svc = createAssistantServices({ configDir: dir, listMeshes: () => [] });
        svc.skillMetrics = { bump, rows: () => [] };
        setAssistantServicesForTests(svc);
        mkdirSync(join(dir, 'assistant'), { recursive: true });
    });
    afterEach(() => setAssistantServicesForTests(null));
    const cols = () => bump.mock.calls.map((c) => c[0]);

    it('skill_view of a name bumps skill_views; list and refusals do not', async () => {
        make(svc.skills);
        await run(ASSISTANT_VERB.skillView, { name: 'list' });
        await run(ASSISTANT_VERB.skillView, { name: 'nope' });
        expect(cols()).not.toContain('skill_views');
        await run(ASSISTANT_VERB.skillView, { name: 'release-report' });
        expect(cols().filter((c) => c === 'skill_views')).toHaveLength(1);
    });

    it('skill_manage applied and staged bump skill_writes; a refusal does not', async () => {
        svc.inputLog.begin('a1');
        svc.inputLog.append('a1', 'human');
        const create = (name: string, sid = 'a1') => run(ASSISTANT_VERB.skillManage, { action: 'create', name, description: 'd', body: 'b', assistantSessionId: sid });
        expect(await create('one')).toMatchObject({ result: 'applied' });
        expect(cols().filter((c) => c === 'skill_writes')).toHaveLength(1);
        expect(await create('Bad Name')).toMatchObject({ result: 'skill_invalid_name' });
        expect(cols().filter((c) => c === 'skill_writes')).toHaveLength(1);
        expect(await create('two', 'unknown-session')).toMatchObject({ result: 'staged' }); // fail-closed origin
        expect(cols().filter((c) => c === 'skill_writes')).toHaveLength(2);
    });

    it('the owner list verb moves no counter and reports attach / view counts separately', async () => {
        make(svc.skills);
        svc.skills.recordAttach(['release-report'], 'm1');
        const before = JSON.stringify(svc.skills.list());
        const out: any = await run(ASSISTANT_SKILLS_LIST_COMMAND);
        expect(out.success).toBe(true);
        expect(out.skills[0]).toMatchObject({ name: 'release-report', attachCount: 1, viewCount: 0 });
        expect(JSON.stringify(svc.skills.list())).toBe(before);
        expect(bump).not.toHaveBeenCalled();
    });
});
