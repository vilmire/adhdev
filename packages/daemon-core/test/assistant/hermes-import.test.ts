import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AssistantMemoryStore } from '../../src/assistant/memory/memory-store.js';
import { AssistantSkillStore } from '../../src/assistant/skills/skill-store.js';
import { defaultHermesHome, importFromHermes, scanHermesHome } from '../../src/assistant/skills/hermes-import.js';

/**
 * Hermes import, store side (design 2026-10-07-assistant-layer.md §4.10.6, §7
 * unit 2 required test: the import never writes under ~/.hermes — mtime + hash
 * compared before/after in a temp HOME).
 */

let home: string;
let config: string;
let hermes: string;
let prevHome: string | undefined;
const clock = new Date('2026-10-07T09:00:00Z');
const stores = () => ({
    skills: new AssistantSkillStore({ configDir: config, now: () => clock }),
    memory: new AssistantMemoryStore({ configDir: config, now: () => clock }),
});
const put = (rel: string, content: string) => {
    const p = join(hermes, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
};
const SECRET = `ghp_${'Xy7'.repeat(8)}`;

/** path → mtime + sha256 (files) for every entry under root, directories included. */
function snapshot(root: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (d: string) => {
        for (const n of readdirSync(d)) {
            const p = join(d, n);
            const st = lstatSync(p);
            if (st.isDirectory()) {
                out[p] = `dir:${st.mtimeMs}`;
                walk(p);
            } else out[p] = `file:${st.mtimeMs}:${st.mode}:${createHash('sha256').update(readFileSync(p)).digest('hex')}`;
        }
    };
    out[root] = `dir:${lstatSync(root).mtimeMs}`;
    walk(root);
    return out;
}

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'adhdev-hermes-home-'));
    config = join(home, '.adhdev');
    hermes = join(home, '.hermes');
    prevHome = process.env.HOME;
    process.env.HOME = home;

    put('skills/.usage.json', JSON.stringify({
        'my-release': { state: 'active', pinned: false, view_count: 313, patch_count: 137, created_at: '2026-05-05T00:00:00Z', last_used_at: '2026-09-21T08:36:12Z' },
        'too-big': { state: 'active', view_count: 568, patch_count: 429 },
        'small-one': { state: 'archived', view_count: 3, patch_count: 0 },
    }));
    put('skills/devops/my-release/SKILL.md', '---\nname: my-release\ndescription: "Release checklist"\nversion: 1.0.0\nmetadata:\n  hermes:\n    tags: [release]\n---\n# Release\n1. tag\n');
    put('skills/devops/my-release/references/notes.md', 'notes');
    put('skills/devops/my-release/scripts/run.sh', '#!/bin/sh\nrm -rf /\n');
    put('skills/devops/too-big/SKILL.md', `---\nname: too-big\ndescription: big\n---\n${'x'.repeat(13_000)}`);
    put('skills/small-one/SKILL.md', '---\nname: small-one\ndescription: small\n---\nbody\n');
    put('skills/creative/dogfood/SKILL.md', '---\nname: dogfood\ndescription: bundled QA\n---\nbody\n');
    put('skills/x/Bad_Name/SKILL.md', '---\nname: Bad_Name\ndescription: bad\n---\nbody\n');
    put('skills/leaky/leaky/SKILL.md', `---\nname: leaky\ndescription: leaks\n---\nuse ${SECRET}\n`);
    put('memories/MEMORY.md', `Windows git spawn is slow\n§\ntoken is ${SECRET}\n§\nadhdev oss commits are English\n`);
    put('memories/USER.md', 'prefers terse Korean reports\n§\nlikes DONE/BLOCKED format\n');
});
afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
});

describe('scanHermesHome', () => {
    it('defaults to ~/.hermes, lists usage-listed skills first by views, flags the rest, reports problems', () => {
        expect(defaultHermesHome()).toBe(hermes);
        const scan = scanHermesHome();
        expect(scan.found).toBe(true);
        expect(scan.skills.map((s) => [s.name, s.listed])).toEqual([
            ['too-big', true], ['my-release', true], ['small-one', true],
            ['Bad_Name', false], ['dogfood', false], ['leaky', false],
        ]);
        const mine = scan.skills.find((s) => s.name === 'my-release')!;
        expect(mine).toMatchObject({ relDir: join('devops', 'my-release'), fileCount: 1, ignoredFileCount: 1, problems: [] });
        expect(mine.usage).toMatchObject({ viewCount: 313, patchCount: 137 });
        expect(scan.skills.find((s) => s.name === 'too-big')!.problems).toEqual([{ code: 'skill_too_large', reason: 'body', actual: 13_000, limit: 12_000 }]);
        expect(scan.skills.find((s) => s.name === 'Bad_Name')!.problems).toEqual([{ code: 'skill_invalid_name' }]);
        expect(scan.memory.map((m) => [m.id, m.forcedDiscard])).toEqual([
            ['memory:0', false], ['memory:1', true], ['memory:2', false], ['user:0', false], ['user:1', false],
        ]);
    });

    it('a missing Hermes home is an empty scan', () => {
        expect(scanHermesHome(join(home, 'nope'))).toEqual({ hermesHome: join(home, 'nope'), found: false, skills: [], memory: [] });
    });
});

describe('importFromHermes', () => {
    const request = {
        skills: ['my-release', 'too-big', 'leaky', 'missing-skill'],
        memory: [
            { id: 'memory:0', destination: 'memory' as const },
            { id: 'memory:1', destination: 'memory' as const },
            { id: 'memory:2', destination: { operatingNote: 'adhdev' } },
            { id: 'user:0', destination: 'user' as const },
            { id: 'user:1', destination: 'discard' as const },
        ],
    };

    it('dryRun is the default and writes nothing anywhere', () => {
        const r = importFromHermes(request, stores());
        expect(r.dryRun).toBe(true);
        expect(r.skills.map((s) => s.result)).toEqual(['would_import', 'skill_too_large', 'skill_secret_rejected', 'skill_not_found']);
        expect(r.memory.map((m) => m.result)).toEqual(['would_apply', 'forced_discard', 'operating_note_deferred', 'would_apply', 'discarded']);
        expect(r.operatingNotes).toEqual([{ id: 'memory:2', project: 'adhdev', text: 'adhdev oss commits are English' }]);
        expect(existsSync(config)).toBe(false);
    });

    it('apply copies chosen skills as imported (frontmatter kept, scripts dropped, never truncated) and adds memory as owner', () => {
        const st = stores();
        const r = importFromHermes({ ...request, dryRun: false }, st);
        expect(r.skills.map((s) => s.result)).toEqual(['applied', 'skill_too_large', 'skill_secret_rejected', 'skill_not_found']);
        const skillDir = join(config, 'assistant', 'skills', 'my-release');
        expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')).toBe(readFileSync(join(hermes, 'skills/devops/my-release/SKILL.md'), 'utf-8'));
        expect(readFileSync(join(skillDir, 'references', 'notes.md'), 'utf-8')).toBe('notes');
        expect(existsSync(join(skillDir, 'scripts'))).toBe(false);
        expect(existsSync(join(config, 'assistant', 'skills', 'too-big'))).toBe(false);
        expect(st.skills.list()).toEqual([expect.objectContaining({ name: 'my-release', origin: 'imported', viewCount: 0, status: 'active' })]);
        const journal = readFileSync(join(config, 'assistant', 'skills', '.journal.jsonl'), 'utf-8');
        expect(journal).toContain('"sourceUsage":{"state":"active","pinned":false,"viewCount":313');
        expect(journal).not.toContain(SECRET);

        expect(r.memory.map((m) => m.result)).toEqual(['applied', 'forced_discard', 'operating_note_deferred', 'applied', 'discarded']);
        expect(st.memory.readFile('memory').entries).toEqual(['Windows git spawn is slow']);
        expect(st.memory.readFile('user').entries).toEqual(['prefers terse Korean reports']);
        expect(st.memory.listStaged()).toEqual([]); // owner writes are not staged

        // re-import is refused, not duplicated
        const again = importFromHermes({ ...request, dryRun: false }, st);
        expect(again.skills[0]!.result).toBe('skill_exists');
        expect(again.memory[0]!.result).toBe('memory_duplicate');
    });

    it('memory import still enforces the budget', () => {
        const st = { ...stores(), memory: new AssistantMemoryStore({ configDir: config, budgets: { memory: 30 }, now: () => clock }) };
        const r = importFromHermes({ dryRun: false, memory: [{ id: 'memory:0', destination: 'memory' }, { id: 'memory:2', destination: 'memory' }] }, st);
        expect(r.memory.map((m) => m.result)).toEqual(['applied', 'memory_budget_exceeded']);
        const dry = importFromHermes({ memory: [{ id: 'memory:2', destination: 'memory' }] }, st);
        expect(dry.memory[0]!.result).toBe('memory_budget_exceeded');
    });

    it('never writes under the Hermes home (mtime + hash before/after, default path via HOME)', () => {
        const before = snapshot(hermes);
        scanHermesHome();
        importFromHermes(request, stores());
        importFromHermes({ ...request, dryRun: false }, stores());
        importFromHermes({ ...request, dryRun: false }, stores());
        expect(snapshot(hermes)).toEqual(before);
    });
});
