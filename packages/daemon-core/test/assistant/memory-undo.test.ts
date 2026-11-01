/**
 * Memory digest + undo (docs/design/2026-11-01-assistant-memory.md §3.2).
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ASSISTANT_OWNER_VERBS, ASSISTANT_TOOL_VERBS, ASSISTANT_VERB } from '@adhdev/mesh-shared';
import { ensureAssistantMemorySchema } from '../../src/mesh/assistant-memory-schema.js';
import { MemoryArchive } from '../../src/assistant/memory/memory-archive.js';
import { AssistantMemoryStore, type MemoryJournalRecord } from '../../src/assistant/memory/memory-store.js';
import { assistantStoreHandlers } from '../../src/commands/high-family/assistant-store.js';
import { createAssistantServices, setAssistantServicesForTests } from '../../src/assistant/assistant-services.js';

const DAY = 24 * 60 * 60_000;
let dir: string;
let nowMs: number;
let db: InstanceType<typeof Database>;
let archive: MemoryArchive;
const mk = () => new AssistantMemoryStore({ configDir: dir, now: () => new Date(nowMs), archive });
const file = (f: string) => { try { return readFileSync(join(dir, 'assistant', 'memory', f), 'utf-8'); } catch { return ''; } };
const journal = (): MemoryJournalRecord[] => file('.journal.jsonl').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const lastId = () => journal().filter((r) => r.result === 'applied').at(-1)!.jid!;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adhdev-mem-undo-'));
    nowMs = Date.parse('2026-11-01T09:00:00Z');
    db = new Database(':memory:');
    ensureAssistantMemorySchema(db);
    archive = new MemoryArchive(db, () => nowMs);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('undo — core tier round trips are byte identical', () => {
    it('add → undo removes the entry and restores the original file bytes', () => {
        const s = mk();
        s.apply({ action: 'add', target: 'memory', content: 'one' }, 'human');
        const before = file('MEMORY.md');
        s.apply({ action: 'add', target: 'memory', content: 'two' }, 'human');
        expect(s.undo({ id: lastId() })).toMatchObject({ result: 'applied' });
        expect(file('MEMORY.md')).toBe(before);
    });

    it('replace → undo restores the old text in place', () => {
        const s = mk();
        s.apply({ action: 'add', target: 'user', content: 'likes tabs' }, 'human');
        s.apply({ action: 'add', target: 'user', content: 'likes dark mode' }, 'human');
        const before = file('USER.md');
        s.apply({ action: 'replace', target: 'user', match: 'tabs', content: 'likes spaces' }, 'human');
        expect(s.undo({ id: lastId() })).toMatchObject({ result: 'applied' });
        expect(file('USER.md')).toBe(before);
    });

    it('remove → undo re-adds the entry (at the end; the content is what matters)', () => {
        const s = mk();
        s.apply({ action: 'add', target: 'memory', content: 'keep' }, 'human');
        s.apply({ action: 'add', target: 'memory', content: 'drop me' }, 'human');
        s.apply({ action: 'remove', target: 'memory', match: 'drop me' }, 'human');
        expect(s.undo({ id: lastId() })).toMatchObject({ result: 'applied' });
        expect(s.readFile('memory').entries).toEqual(['keep', 'drop me']);
    });

    it('the undo is journaled as reverted with restoredFrom, and cannot be undone twice', () => {
        const s = mk();
        s.apply({ action: 'add', target: 'memory', content: 'x1' }, 'human');
        const id = lastId();
        s.undo({ id });
        const rec = journal().at(-1)!;
        expect(rec).toMatchObject({ result: 'reverted', restoredFrom: id, origin: 'owner' });
        expect(s.undo({ id })).toEqual({ result: 'memory_undo_already' });
        // the reverted line itself is not an undo target
        expect(s.undo({ id: rec.jid! })).toEqual({ result: 'memory_undo_not_found' });
    });

    it('refuses to overwrite an entry that changed after the write (conflict, file untouched)', () => {
        const s = mk();
        s.apply({ action: 'add', target: 'memory', content: 'deploy on tuesday' }, 'human');
        const id = lastId();
        s.apply({ action: 'replace', target: 'memory', match: 'tuesday', content: 'deploy on wednesday' }, 'human');
        const bytes = file('MEMORY.md');
        const r = s.undo({ id });
        expect(r.result).toBe('memory_undo_conflict');
        expect(file('MEMORY.md')).toBe(bytes);
    });

    it('undo of a remove conflicts when the same text was added back in the meantime', () => {
        const s = mk();
        s.apply({ action: 'add', target: 'memory', content: 'same' }, 'human');
        s.apply({ action: 'remove', target: 'memory', match: 'same' }, 'human');
        const id = lastId();
        s.apply({ action: 'add', target: 'memory', content: 'same' }, 'human');
        expect(s.undo({ id }).result).toBe('memory_undo_conflict');
    });

    it('a file that cannot be decoded is never rewritten by an undo', () => {
        const s = mk();
        s.apply({ action: 'add', target: 'memory', content: 'fine' }, 'human');
        const id = lastId();
        writeFileSync(join(dir, 'assistant', 'memory', 'MEMORY.md'), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
        const before = readFileSync(join(dir, 'assistant', 'memory', 'MEMORY.md'));
        expect(s.undo({ id }).result).toBe('memory_store_unreadable');
        expect(readFileSync(join(dir, 'assistant', 'memory', 'MEMORY.md')).equals(before)).toBe(true);
    });

    it('records written in the same millisecond are told apart by id; ts alone is refused as ambiguous', () => {
        const s = mk();
        s.apply({ action: 'add', target: 'memory', content: 'a1' }, 'human');
        s.apply({ action: 'add', target: 'memory', content: 'a2' }, 'human');
        const [r1, r2] = journal();
        expect(r1!.ts).toBe(r2!.ts);
        expect(r1!.jid).not.toBe(r2!.jid);
        expect(s.undo({ ts: r1!.ts })).toMatchObject({ result: 'memory_undo_not_undoable', reason: 'ambiguous_ts_use_id' });
        expect(s.undo({ id: r1!.jid! }).result).toBe('applied');
        expect(s.readFile('memory').entries).toEqual(['a2']);
    });

    it('legacy journal lines (no jid) are addressed by ts', () => {
        const s = mk();
        s.apply({ action: 'add', target: 'memory', content: 'present' }, 'human');
        appendFileSync(join(dir, 'assistant', 'memory', '.journal.jsonl'), `${JSON.stringify({ ts: '2026-10-01T00:00:00.000Z', action: 'add', target: 'memory', before: null, after: 'present', origin: 'human', result: 'applied' })}\n`);
        expect(s.undo({ ts: '2026-10-01T00:00:00.000Z' }).result).toBe('applied');
        expect(s.readFile('memory').entries).toEqual([]);
    });
});

describe('undo does not bypass the write checks', () => {
    it('a redacted or blank record is not undoable and the digest says so', () => {
        const s = mk();
        s.apply({ action: 'add', target: 'memory', content: 'real' }, 'human');
        const secret = `ghp_${'Xy7'.repeat(8)}`;
        appendFileSync(join(dir, 'assistant', 'memory', '.journal.jsonl'), `${JSON.stringify({ ts: new Date(nowMs).toISOString(), jid: 'legacyredacted', action: 'remove', target: 'memory', before: null, after: null, origin: 'human', result: 'applied', redacted: ['before'] })}\n`);
        const row = s.digest().entries.find((e) => e.id === 'legacyredacted')!;
        expect(row.undoable).toBe(false);
        expect(s.undo({ id: 'legacyredacted' })).toMatchObject({ result: 'memory_undo_not_undoable', reason: 'redacted' });
        // a hand-planted remove line whose "before" is a credential: the re-add runs the credential check and refuses
        appendFileSync(join(dir, 'assistant', 'memory', '.journal.jsonl'), `${JSON.stringify({ ts: new Date(nowMs).toISOString(), jid: 'plantedsecret', action: 'remove', target: 'memory', before: secret, after: null, origin: 'human', result: 'applied' })}\n`);
        expect(s.undo({ id: 'plantedsecret' }).result).toBe('memory_secret_rejected');
        expect(s.readFile('memory').entries).toEqual(['real']);
    });

    it('an undo that would exceed the budget is refused', () => {
        const s = mk();
        s.apply({ action: 'add', target: 'memory', content: 'big '.repeat(100) }, 'human');
        s.apply({ action: 'remove', target: 'memory', match: 'big' }, 'human');
        const id = lastId();
        for (let i = 0; i < 5; i++) s.apply({ action: 'add', target: 'memory', content: `fill${i} ${'z'.repeat(395)}` }, 'human');
        expect(s.undo({ id }).result).toBe('memory_budget_exceeded');
    });
});

describe('undo — archive tier and batches', () => {
    it('add / replace / remove on a project scope round-trip', () => {
        const s = mk();
        const scope = { scope: 'project' as const, projectRef: 'm1' };
        s.apply({ action: 'add', target: 'memory', content: 'p fact one', ...scope }, 'human');
        const addId = lastId();
        s.apply({ action: 'replace', target: 'memory', match: 'one', content: 'p fact two', ...scope }, 'human');
        const repId = lastId();
        expect(s.undo({ id: repId }).result).toBe('applied');
        expect(archive.active('project', 'm1').map((e) => e.text)).toEqual(['p fact one']);
        s.apply({ action: 'remove', target: 'memory', match: 'p fact one', ...scope }, 'human');
        const rmId = lastId();
        expect(archive.active('project', 'm1')).toHaveLength(0);
        expect(s.undo({ id: rmId }).result).toBe('applied');
        expect(archive.active('project', 'm1').map((e) => e.text)).toEqual(['p fact one']);
        expect(s.undo({ id: addId }).result).toBe('applied');
        expect(archive.active('project', 'm1')).toHaveLength(0);
    });

    it('archive-tier conflict: replaced row cannot be undone back over a newer edit', () => {
        const s = mk();
        const scope = { scope: 'archive' as const };
        s.apply({ action: 'add', target: 'memory', content: 'arch v1', ...scope }, 'human');
        const id = lastId();
        s.apply({ action: 'replace', target: 'memory', match: 'v1', content: 'arch v2', ...scope }, 'human');
        expect(s.undo({ id }).result).toBe('memory_undo_conflict');
        expect(archive.active('global').map((e) => e.text)).toEqual(['arch v2']);
    });

    it('batch undo restores an archive move: the entry returns to the file and leaves the archive', () => {
        const s = mk();
        s.apply({ action: 'add', target: 'memory', content: 'stay' }, 'human');
        s.apply({ action: 'add', target: 'memory', content: 'movable legacy entry' }, 'human');
        const fileBefore = file('MEMORY.md');
        s.apply({ action: 'archive', target: 'memory', match: 'movable' }, 'human');
        expect(s.readFile('memory').entries).toEqual(['stay']);
        const batchId = journal().find((r) => r.batchId)!.batchId!;
        const out = s.undo({ batchId });
        expect(out).toMatchObject({ result: 'applied' });
        expect(file('MEMORY.md')).toBe(fileBefore);
        expect(archive.active('global')).toHaveLength(0);
        expect(s.undo({ batchId }).result).toBe('memory_undo_already');
    });

    it('batch undo is partial and loses nothing when the file side cannot take the entry back', () => {
        const s = mk();
        s.apply({ action: 'add', target: 'memory', content: `movable ${'m'.repeat(300)}` }, 'human');
        s.apply({ action: 'archive', target: 'memory', match: 'movable' }, 'human');
        const batchId = journal().find((r) => r.batchId)!.batchId!;
        for (let i = 0; i < 5; i++) s.apply({ action: 'add', target: 'memory', content: `fill${i} ${'z'.repeat(395)}` }, 'human');
        const out = s.undo({ batchId });
        expect(out.result).toBe('memory_undo_partial');
        // the archive row was NOT taken away because the file could not take it back
        expect(archive.active('global')).toHaveLength(1);
    });

    it('an unknown id / batch is memory_undo_not_found', () => {
        const s = mk();
        expect(s.undo({ id: 'nope' }).result).toBe('memory_undo_not_found');
        expect(s.undo({ batchId: 'nope' }).result).toBe('memory_undo_not_found');
    });
});

describe('digest', () => {
    it('lists recent writes newest first with counts, undo state and the window', () => {
        const s = mk();
        s.apply({ action: 'add', target: 'memory', content: 'old entry' }, 'human');
        nowMs += 2 * DAY;
        s.apply({ action: 'add', target: 'memory', content: 'new one' }, 'human');
        s.apply({ action: 'add', target: 'memory', content: 'new two' }, 'human');
        s.apply({ action: 'replace', target: 'memory', match: 'new two', content: 'new two b' }, 'human');
        s.apply({ action: 'remove', target: 'memory', match: 'new one' }, 'human');
        s.apply({ action: 'add', target: 'memory', content: 'relay says' }, 'relay');
        const d = s.digest();
        expect(d.counts).toMatchObject({ added: 2, replaced: 1, removed: 1, promoted: 0, staged: 1, reverted: 0 });
        expect(d.entries.map((e) => e.state)).toEqual(['staged', 'applied', 'applied', 'applied', 'applied']);
        expect(d.entries[0]).toMatchObject({ text: 'relay says', undoable: false });
        expect(d.entries.some((e) => e.text === 'old entry')).toBe(false);
        expect(s.digest({ sinceMs: 5 * DAY }).entries.some((e) => e.text === 'old entry')).toBe(true);
        const limited = s.digest({ limit: 2 });
        expect(limited.entries).toHaveLength(2);
        expect(limited.truncated).toBe(true);
    });

    it('marks undone writes and counts the revert; refused attempts are not shown', () => {
        const s = mk();
        s.apply({ action: 'add', target: 'memory', content: 'one' }, 'human');
        const id = lastId();
        s.apply({ action: 'add', target: 'memory', content: 'one' }, 'human'); // duplicate
        s.undo({ id });
        const d = s.digest();
        expect(d.entries.map((e) => e.state).sort()).toEqual(['reverted', 'undone']);
        expect(d.entries.find((e) => e.id === id)!.undoable).toBe(false);
        expect(d.counts).toMatchObject({ added: 0, reverted: 1 });
    });

    it('never carries a rejected credential', () => {
        const s = mk();
        s.apply({ action: 'add', target: 'memory', content: `ghp_${'Xy7'.repeat(8)}` }, 'human');
        expect(JSON.stringify(s.digest())).not.toContain('ghp_');
    });
});

describe('verbs are owner-only', () => {
    it('digest and undo are owner verbs, not assistant tools', () => {
        expect(ASSISTANT_OWNER_VERBS).toContain(ASSISTANT_VERB.memoryDigest);
        expect(ASSISTANT_OWNER_VERBS).toContain(ASSISTANT_VERB.memoryUndo);
        const toolVerbs = new Set<string>(Object.values(ASSISTANT_TOOL_VERBS));
        expect(toolVerbs.has(ASSISTANT_VERB.memoryUndo)).toBe(false);
        expect(toolVerbs.has(ASSISTANT_VERB.memoryDigest)).toBe(false);
    });

    it('the verbs answer through the store; undo needs exactly one selector', async () => {
        const svc = createAssistantServices({ configDir: dir, hermesHome: join(dir, 'h'), listMeshes: () => [] });
        svc.memory.attachArchive(archive);
        setAssistantServicesForTests(svc);
        try {
            svc.memory.apply({ action: 'add', target: 'memory', content: 'via verb' }, 'owner');
            const d = await assistantStoreHandlers[ASSISTANT_VERB.memoryDigest]({} as any, {});
            expect(d).toMatchObject({ success: true, result: 'ok', stats: { autoApplied: 0, undone: 0, rate: 0 } });
            expect(Array.isArray(d.suggestions)).toBe(true);
            const id = (d.entries as any[])[0].id;
            expect(await assistantStoreHandlers[ASSISTANT_VERB.memoryUndo]({} as any, {})).toMatchObject({ success: false, code: 'invalid_args' });
            expect(await assistantStoreHandlers[ASSISTANT_VERB.memoryUndo]({} as any, { id, ts: 'x' })).toMatchObject({ success: false, code: 'invalid_args' });
            expect(await assistantStoreHandlers[ASSISTANT_VERB.memoryUndo]({} as any, { id })).toMatchObject({ success: true, result: 'applied' });
            expect(await assistantStoreHandlers[ASSISTANT_VERB.memoryUndo]({} as any, { id })).toMatchObject({ success: false, code: 'memory_undo_already' });
        } finally {
            setAssistantServicesForTests(null);
        }
    });
});
