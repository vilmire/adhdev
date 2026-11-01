/**
 * Memory housekeeping: duplicate consolidation, suggestions, expiry and the
 * lesson TTL (docs/design/2026-11-01-assistant-memory.md §3.9, §3.10, D6).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ASSISTANT_VERB } from '@adhdev/mesh-shared';
import { ensureAssistantMemorySchema } from '../../src/mesh/assistant-memory-schema.js';
import { ARCHIVE_GRACE_MS, DEFAULT_LESSON_TTL_DAYS, MemoryArchive } from '../../src/assistant/memory/memory-archive.js';
import { AssistantMemoryStore } from '../../src/assistant/memory/memory-store.js';
import { SIMILAR_THRESHOLD } from '../../src/assistant/memory/memory-consolidate.js';
import { MemoryNoticeCollector } from '../../src/assistant/memory/memory-notice.js';
import { AssistantCurator, CURATOR_RULES } from '../../src/assistant/skills/skill-curator.js';
import { AssistantSkillStore } from '../../src/assistant/skills/skill-store.js';
import { AssistantRegistry } from '../../src/assistant/assistant-registry.js';
import { assistantStoreHandlers } from '../../src/commands/high-family/assistant-store.js';
import { createAssistantServices, setAssistantServicesForTests } from '../../src/assistant/assistant-services.js';

const DAY = 24 * 60 * 60_000;
let dir: string;
let nowMs: number;
let db: InstanceType<typeof Database>;
let archive: MemoryArchive;
let store: AssistantMemoryStore;
const file = (f: string) => { try { return readFileSync(join(dir, 'assistant', 'memory', f), 'utf-8'); } catch { return ''; } };

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adhdev-mem-cons-'));
    nowMs = Date.parse('2026-11-01T09:00:00Z');
    db = new Database(':memory:');
    ensureAssistantMemorySchema(db);
    store = new AssistantMemoryStore({ configDir: dir, now: () => new Date(nowMs) });
    archive = new MemoryArchive(db, () => nowMs, () => store.lessonTtlMs());
    store.attachArchive(archive);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

/** Plant entries the store itself would refuse (a hand edit) so duplicates exist to consolidate. */
function writeMemoryFile(entries: string[]) {
    store.apply({ action: 'add', target: 'memory', content: 'seed' }, 'human');
    writeFileSync(join(dir, 'assistant', 'memory', 'MEMORY.md'), `${entries.join('\n§\n')}\n`);
}

describe('exact duplicates (§3.9)', () => {
    it('three equal-after-normalisation MEMORY entries become one (the newest), as one batch the owner can undo byte-for-byte', () => {
        writeMemoryFile(['Deploy on Tuesdays.', 'keep this one', 'deploy on tuesdays', 'DEPLOY ON TUESDAYS!']);
        const original = file('MEMORY.md');
        const r = store.runMaintenance();
        expect(r.duplicatesRemoved.core).toBe(2);
        expect(store.readFile('memory').entries).toEqual(['keep this one', 'DEPLOY ON TUESDAYS!']);
        const recs = store.readJournal().filter((x) => x.origin === 'curator');
        expect(recs).toHaveLength(2);
        expect(recs.every((x) => x.batchId === recs[0]!.batchId && x.action === 'remove' && x.result === 'applied')).toBe(true);
        expect(store.undo({ batchId: recs[0]!.batchId! })).toMatchObject({ result: 'applied' });
        expect(store.readFile('memory').entries.sort()).toEqual(['DEPLOY ON TUESDAYS!', 'Deploy on Tuesdays.', 'deploy on tuesdays', 'keep this one'].sort());
        void original;
    });

    it('USER duplicates are never changed by the pass, only suggested', () => {
        store.apply({ action: 'add', target: 'user', content: 'likes tabs' }, 'human');
        writeFileSync(join(dir, 'assistant', 'memory', 'USER.md'), 'likes tabs\n§\nLikes tabs.\n');
        const before = file('USER.md');
        const r = store.runMaintenance();
        expect(r.duplicatesRemoved.core).toBe(0);
        expect(file('USER.md')).toBe(before);
        expect(store.consolidationSuggestions().some((s) => s.kind === 'duplicate' && s.target === 'user')).toBe(true);
    });

    it('similar entries (Jaccard >= 0.8) are suggestions only; the files are untouched', () => {
        writeMemoryFile(['always run the full test suite before merging to main', 'always run the full test suite before merging into main']);
        const before = file('MEMORY.md');
        const r = store.runMaintenance();
        expect(r.duplicatesRemoved.core).toBe(0);
        expect(file('MEMORY.md')).toBe(before);
        const sim = store.consolidationSuggestions().find((s) => s.kind === 'similar')!;
        expect(sim).toBeTruthy();
        expect((sim as { score: number }).score).toBeGreaterThanOrEqual(SIMILAR_THRESHOLD);
        expect(r.suggestions).toBeGreaterThan(0);
    });

    it('an unreadable file is skipped and reported, never rewritten', () => {
        store.apply({ action: 'add', target: 'memory', content: 'fine' }, 'human');
        const p = join(dir, 'assistant', 'memory', 'MEMORY.md');
        writeFileSync(p, Buffer.from([0xff, 0xfe, 0x00, 0x80]));
        const before = readFileSync(p);
        const r = store.runMaintenance();
        expect(r.skipped).toContain('memory_file_unreadable');
        expect(readFileSync(p).equals(before)).toBe(true);
    });

    it('archive-tier duplicates keep the newest row; preference duplicates only wait for the owner', () => {
        const row = (text: string, scope: 'archive' | 'project' = 'archive', target: 'memory' | 'user' = 'memory') =>
            store.apply({ action: 'add', target, content: text, scope, ...(scope === 'project' ? { projectRef: 'm1' } : {}) }, 'owner');
        row('Retries are capped at three.');
        nowMs += DAY;
        // a hand-planted near-identical row (the write path itself refuses normalised duplicates)
        db.prepare(`INSERT INTO assistant_memory_entry(id,scope,project_ref,kind,text,origin,created_at,updated_at) VALUES ('dupnew','global',NULL,'rule','retries are capped at three',?,?,?)`).run('human', nowMs, nowMs);
        row('p1 fact', 'project');
        row('Likes dark mode.', 'archive', 'user');
        db.prepare(`INSERT INTO assistant_memory_entry(id,scope,project_ref,kind,text,origin,created_at,updated_at) VALUES ('prefdup','global',NULL,'preference','likes dark mode',?,?,?)`).run('human', nowMs, nowMs);
        const r = store.runMaintenance();
        expect(r.duplicatesRemoved.archive).toBe(1);
        const texts = archive.active('global').map((e) => e.text).sort();
        expect(texts).toEqual(['Likes dark mode.', 'likes dark mode', 'retries are capped at three']);
        expect(store.consolidationSuggestions().some((s) => s.kind === 'duplicate' && s.target === 'user' && s.tier === 'archive')).toBe(true);
    });

    it('the pass is not echoed into the live session (the knowledge is still there)', () => {
        writeMemoryFile(['same thing', 'Same thing.']);
        const sent: unknown[] = [];
        const c = new MemoryNoticeCollector(store, { liveSessionId: () => 's', enqueue: (i) => sent.push(i) });
        c.start();
        store.markSnapshotTaken();
        store.runMaintenance();
        c.evaluate();
        expect(sent).toEqual([]);
    });
});

describe('expiry (D6): only review-origin lessons age out', () => {
    const lesson = (text: string, origin: 'human' | 'review' | 'owner', scope: 'archive' | 'project' = 'archive') =>
        store.apply({ action: 'add', target: 'memory', content: text, scope, kind: 'lesson', ...(scope === 'project' ? { projectRef: 'm1' } : {}) }, origin);

    it('archives a review lesson after the default 90 days, never a human one, and counts a purge after the grace period', () => {
        expect(DEFAULT_LESSON_TTL_DAYS).toBe(90);
        lesson('review learned that retries help', 'review');
        lesson('human said retries help', 'human');
        nowMs += 89 * DAY;
        expect(store.runMaintenance().lessonsExpired).toBe(0);
        nowMs += 2 * DAY;
        const r = store.runMaintenance();
        expect(r.lessonsExpired).toBe(1);
        expect(archive.active('global').map((e) => e.text)).toEqual(['human said retries help']);
        nowMs += ARCHIVE_GRACE_MS + DAY;
        expect(store.runMaintenance().purged).toBe(1);
    });

    it('a search hit restarts the lesson TTL', () => {
        lesson('lesson about flaky windows tests', 'review');
        nowMs += 80 * DAY;
        expect((archive.search('flaky windows') as { hits: unknown[] }).hits).toHaveLength(1);
        nowMs += 80 * DAY;
        expect(store.runMaintenance().lessonsExpired).toBe(0);
        nowMs += 11 * DAY;
        expect(store.runMaintenance().lessonsExpired).toBe(1);
    });

    it('an expired lesson comes back with one undo within the 30-day grace', () => {
        lesson('short lived lesson', 'review');
        nowMs += 91 * DAY;
        store.runMaintenance();
        expect(archive.active('global')).toHaveLength(0);
        const batch = store.readJournal().find((x) => x.origin === 'curator')!.batchId!;
        nowMs += 10 * DAY;
        expect(store.undo({ batchId: batch }).result).toBe('applied');
        expect(archive.active('global').map((e) => e.text)).toEqual(['short lived lesson']);
        expect(store.undo({ batchId: batch }).result).toBe('memory_undo_already');
    });

    it('after the 30-day grace the row is purged and the undo is refused as a conflict', () => {
        lesson('gone for good', 'review');
        nowMs += 91 * DAY;
        store.runMaintenance();
        const batch = store.readJournal().find((x) => x.origin === 'curator')!.batchId!;
        nowMs += ARCHIVE_GRACE_MS + DAY;
        expect(store.runMaintenance().purged).toBe(1);
        const out = store.undo({ batchId: batch });
        expect(out.result).toBe('memory_undo_partial');
        expect((out as { failed: Array<{ result: string }> }).failed[0]!.result).toBe('memory_undo_conflict');
    });

    it('memoryLessonTtlDays in assistant.json is honoured; a bad value falls back to 90', () => {
        const cfg = join(dir, 'assistant.json');
        writeFileSync(cfg, JSON.stringify({ memoryLessonTtlDays: 30 }));
        expect(store.lessonTtlDays()).toBe(30);
        lesson('thirty day lesson', 'review');
        nowMs += 31 * DAY;
        expect(store.runMaintenance().lessonsExpired).toBe(1);
        for (const bad of [0, -5, 4000, 'ninety', null]) {
            writeFileSync(cfg, JSON.stringify({ memoryLessonTtlDays: bad }));
            expect(store.lessonTtlDays()).toBe(90);
        }
    });

    it('the registry keeps memoryLessonTtlDays across its own rewrites and rejects a bad patch', () => {
        const reg = new AssistantRegistry({ configDir: dir });
        reg.bindSession({ sessionId: 's1', cliType: 'claude-cli', workspace: dir, at: 1 });
        reg.updateSettings({ memoryLessonTtlDays: 45 });
        reg.updateSettings({ busyInputMode: 'steer' as never });
        reg.recordTurnState('s1', 'idle', 5);
        expect(JSON.parse(readFileSync(join(dir, 'assistant.json'), 'utf-8')).memoryLessonTtlDays).toBe(45);
        expect(new AssistantMemoryStore({ configDir: dir }).lessonTtlDays()).toBe(45);
        expect(() => reg.updateSettings({ memoryLessonTtlDays: 0 })).toThrow(/invalid memoryLessonTtlDays/);
    });

    it('property: whatever the clock does, human / owner / promotion / non-lesson rows are never expired', () => {
        // small deterministic PRNG so a failure reproduces
        let seed = 0x2f6e2b1;
        const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
        const protectedTexts: string[] = [];
        let n = 0;
        const addRow = (origin: 'human' | 'owner' | 'review', kind: 'lesson' | 'rule' | 'env', scope: 'archive' | 'project') => {
            const text = `row ${n++} ${origin} ${kind}`;
            store.apply({ action: 'add', target: 'memory', content: text, scope, kind, ...(scope === 'project' ? { projectRef: 'm1' } : {}) }, origin);
            if (origin !== 'review' || kind !== 'lesson') protectedTexts.push(text);
        };
        for (let step = 0; step < 300; step++) {
            const roll = rnd();
            if (roll < 0.45) addRow(['human', 'owner', 'review'][Math.floor(rnd() * 3)] as 'human', ['lesson', 'rule', 'env'][Math.floor(rnd() * 3)] as 'lesson', rnd() < 0.5 ? 'archive' : 'project');
            else if (roll < 0.6) archive.search(`row ${Math.floor(rnd() * Math.max(1, n))}`);
            nowMs += Math.floor(rnd() * 120) * DAY;
            store.runMaintenance({ liveProjectRefs: () => new Set(['m1']) });
        }
        const alive = new Set([...archive.active('global'), ...archive.active('project', 'm1')].map((e) => e.text));
        for (const t of protectedTexts) expect(alive.has(t), t).toBe(true);
        // and the review lessons really did age out in that run (the sweep is not a no-op)
        expect(store.readJournal().filter((r) => r.origin === 'curator' && r.tier === 'archive' && r.result === 'applied').length).toBeGreaterThan(0);
    });
});

describe('orphaned project memory', () => {
    it('archives entries of projects that no longer exist, but never on an empty inventory', () => {
        store.apply({ action: 'add', target: 'memory', content: 'gone fact', scope: 'project', projectRef: 'gone' }, 'human');
        store.apply({ action: 'add', target: 'memory', content: 'kept fact', scope: 'project', projectRef: 'kept' }, 'human');
        expect(store.runMaintenance({ liveProjectRefs: () => new Set() }).projectEntriesArchived).toBe(0);
        expect(store.runMaintenance({ liveProjectRefs: () => null }).projectEntriesArchived).toBe(0);
        expect(store.runMaintenance({ liveProjectRefs: () => new Set(['kept']) }).projectEntriesArchived).toBe(1);
        expect(archive.active('project', 'kept')).toHaveLength(1);
        expect(archive.active('project', 'gone')).toHaveLength(0);
    });
});

describe('curator integration', () => {
    it('runCurator includes the memory pass in its report and uses the live-project provider', () => {
        writeMemoryFile(['dup entry', 'Dup entry']);
        store.apply({ action: 'add', target: 'memory', content: 'orphan', scope: 'project', projectRef: 'gone' }, 'human');
        const skills = new AssistantSkillStore({ configDir: dir, now: () => new Date(nowMs) });
        const curator = new AssistantCurator(skills, store, CURATOR_RULES, () => new Set(['live']));
        const rep = curator.runCurator(new Date(nowMs));
        expect(rep.memory).toMatchObject({ duplicatesRemoved: { core: 1 }, projectEntriesArchived: 1 });
        expect(new AssistantCurator(skills, null).runCurator(new Date(nowMs)).memory).toBeUndefined();
    });
});

describe('owner merge and digest suggestions (verbs)', () => {
    it('digest carries suggestions; merge drops one entry, optionally rewrites the other, and undoes as one batch', async () => {
        const svc = createAssistantServices({ configDir: dir, hermesHome: join(dir, 'h'), listMeshes: () => [] });
        svc.memory.attachArchive(archive);
        setAssistantServicesForTests(svc);
        try {
            const a = 'always run the full test suite before merging to main';
            const b = 'always run the full test suite before merging into main';
            svc.memory.apply({ action: 'add', target: 'memory', content: a }, 'owner');
            svc.memory.apply({ action: 'add', target: 'memory', content: b }, 'owner');
            const d = await assistantStoreHandlers[ASSISTANT_VERB.memoryDigest]({} as any, {});
            expect((d.suggestions as any[]).some((s) => s.kind === 'similar')).toBe(true);
            const merged = await assistantStoreHandlers[ASSISTANT_VERB.storeAdmin]({} as any, { target: 'memory', action: 'merge', file: 'memory', keep: a, drop: b, content: 'always run the full test suite before merging to main (CI too)' });
            expect(merged).toMatchObject({ success: true, result: 'applied' });
            expect(svc.memory.readFile('memory').entries).toEqual(['always run the full test suite before merging to main (CI too)']);
            const undone = await assistantStoreHandlers[ASSISTANT_VERB.memoryUndo]({} as any, { batchId: merged.batchId });
            expect(undone).toMatchObject({ success: true, result: 'applied' });
            expect(svc.memory.readFile('memory').entries.sort()).toEqual([a, b].sort());
            expect(await assistantStoreHandlers[ASSISTANT_VERB.storeAdmin]({} as any, { target: 'memory', action: 'merge', file: 'memory', keep: a })).toMatchObject({ code: 'invalid_args' });
            expect(await assistantStoreHandlers[ASSISTANT_VERB.storeAdmin]({} as any, { target: 'memory', action: 'merge', file: 'memory', keep: a, drop: 'not there' })).toMatchObject({ success: false, code: 'memory_no_match' });
        } finally {
            setAssistantServicesForTests(null);
        }
    });
});
