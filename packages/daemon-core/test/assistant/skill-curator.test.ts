import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantMemoryStore } from '../../src/assistant/memory/memory-store.js';
import { AssistantSkillStore } from '../../src/assistant/skills/skill-store.js';
import { AssistantCurator, pruneJsonlByTs, startAssistantCuratorTimer } from '../../src/assistant/skills/skill-curator.js';

/** Curator (design 2026-10-07-assistant-layer.md §4.10.6): 30/90-day transitions, pin exclusion, housekeeping. */

const DAY = 24 * 60 * 60 * 1000;
let dir: string;
let clock: Date;
const at = (days: number) => new Date(Date.parse('2026-10-07T00:00:00Z') + days * DAY);
const skills = () => new AssistantSkillStore({ configDir: dir, now: () => clock });
const memory = () => new AssistantMemoryStore({ configDir: dir, now: () => clock });
const ctx = { sessionId: 's', turnId: 't' };
const mkSkill = (s: AssistantSkillStore, name: string) =>
    expect(s.manage({ action: 'create', name, description: 'd', body: 'b' }, 'owner', ctx).result).toBe('applied');
const status = (s: AssistantSkillStore, name: string) => s.list().find((x) => x.name === name)?.status;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adhdev-assistant-curator-'));
    clock = at(0);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('runCurator', () => {
    it('30 days since last view (or creation) → stale, 90 → archived; files kept; view revives', () => {
        const s = skills();
        mkSkill(s, 'never-viewed');
        mkSkill(s, 'viewed-later');
        clock = at(20);
        s.view('viewed-later');
        const cur = new AssistantCurator(s, null);

        clock = at(29);
        expect(cur.runCurator(clock)).toMatchObject({ staled: [], archived: [] });
        clock = at(30);
        expect(cur.runCurator(clock)).toMatchObject({ staled: ['never-viewed'], archived: [] });
        expect(status(s, 'viewed-later')).toBe('active');
        clock = at(50);
        expect(cur.runCurator(clock).staled).toEqual(['viewed-later']);
        clock = at(90);
        expect(cur.runCurator(clock)).toMatchObject({ staled: [], archived: ['never-viewed'] });
        expect(status(s, 'viewed-later')).toBe('stale');
        expect(existsSync(join(dir, 'assistant', 'skills', 'never-viewed', 'SKILL.md'))).toBe(true);

        expect(s.view('never-viewed')).toMatchObject({ result: 'ok', status: 'active' });
        expect(cur.runCurator(clock).archived).toEqual([]);
    });

    it('a skill untouched for 90+ days goes straight to archived', () => {
        const s = skills();
        mkSkill(s, 'ancient');
        clock = at(120);
        expect(new AssistantCurator(s, null).runCurator(clock)).toMatchObject({ staled: [], archived: ['ancient'] });
    });

    it('pinned skills are excluded', () => {
        const s = skills();
        mkSkill(s, 'pinned-one');
        s.pin('pinned-one');
        clock = at(200);
        expect(new AssistantCurator(s, null).runCurator(clock)).toMatchObject({ staled: [], archived: [] });
        expect(status(s, 'pinned-one')).toBe('active');
    });

    it('expires staged writes older than 14 days (skill + memory) and prunes journal lines older than 90 days', () => {
        const s = skills();
        const m = memory();
        mkSkill(s, 'kept');
        const st = s.manage({ action: 'patch', name: 'kept', old: 'b', new: 'c' }, 'relay', ctx);
        const sm = m.apply({ action: 'add', target: 'memory', content: 'relayed fact' }, 'relay');
        expect(st.result).toBe('staged');
        expect(sm.result).toBe('staged');

        clock = at(13);
        const early = new AssistantCurator(s, m).runCurator(clock);
        expect(early.stagedExpired).toEqual({ skills: [], memory: [] });

        clock = at(15);
        const later = new AssistantCurator(s, m).runCurator(clock);
        expect(later.stagedExpired.skills).toHaveLength(1);
        expect(later.stagedExpired.memory).toHaveLength(1);
        expect(s.listStaged()).toEqual([]);
        expect(m.listStaged()).toEqual([]);
        expect(later.journalLinesPruned).toEqual({ skills: 0, memory: 0 });

        clock = at(100);
        const pruned = new AssistantCurator(s, m).runCurator(clock);
        // cutoff = day 10: the day-0 lines (create + staged) go, the day-15 expiry lines stay
        expect(pruned.journalLinesPruned.skills).toBe(2);
        expect(pruned.journalLinesPruned.memory).toBe(1); // the day-0 staged line
        const skillRows = readFileSync(s.journal.path, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
        expect(skillRows.every((r) => Date.parse(r.ts) >= at(10).getTime())).toBe(true);
    });

    it('pruneJsonlByTs keeps lines without a parseable ts', () => {
        const p = join(dir, 'j.jsonl');
        writeFileSync(p, `${JSON.stringify({ ts: at(-200).toISOString() })}\nnot json\n${JSON.stringify({ ts: at(0).toISOString() })}\n${JSON.stringify({ x: 1 })}\n`);
        expect(pruneJsonlByTs(p, at(-90).getTime())).toBe(1);
        expect(readFileSync(p, 'utf-8').trim().split('\n')).toHaveLength(3);
        expect(pruneJsonlByTs(join(dir, 'missing.jsonl'), 0)).toBe(0);
    });
});

describe('startAssistantCuratorTimer', () => {
    it('schedules every 24 h, unrefs the handle, single-flights re-entrant ticks, stops cleanly', () => {
        let scheduled: { fn: () => void; ms: number } | null = null;
        const unref = vi.fn();
        const clear = vi.fn();
        let reentrant: unknown = 'unset';
        const timer = startAssistantCuratorTimer(
            {
                runCurator: () => {
                    reentrant = timer.tick(); // a tick while one runs is skipped
                    return { staled: [], archived: [], journalLinesPruned: { skills: 0, memory: 0 }, stagedExpired: { skills: [], memory: [] } };
                },
            },
            { setInterval: (fn, ms) => ((scheduled = { fn, ms }), { unref }), clearInterval: clear },
        );
        expect(scheduled!.ms).toBe(DAY);
        expect(unref).toHaveBeenCalledTimes(1);
        scheduled!.fn();
        expect(reentrant).toBeNull();
        const onError = vi.fn();
        const failing = startAssistantCuratorTimer({ runCurator: () => { throw new Error('boom'); } }, { setInterval: () => ({}), onError });
        expect(failing.tick()).toBeNull();
        expect(onError).toHaveBeenCalledTimes(1);
        timer.stop();
        expect(clear).toHaveBeenCalledTimes(1);
    });
});
