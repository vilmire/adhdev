import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSession } from '../../src/providers/native-history/grok-cli-transcript.js';
import { ensureAssistantRelaySchema } from '../../src/mesh/mesh-runtime-store-schema.js';
import { ensureTurnLedgerSchema } from '../../src/mesh/turn-ledger/schema.js';
import { createTurnLedger } from '../../src/mesh/turn-ledger/ledger.js';
import { recoverAttemptReport } from '../../src/assistant/attempt-report-recovery.js';
import { SqliteAssistantRelayStore } from '../../src/assistant/assistant-relay-sqlite-store.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.useRealTimers(); });

function fixture(envelope?: string, acceptedAt = 10_000) {
    const db = new Database(':memory:'); databases.push(db);
    ensureAssistantRelaySchema(db); ensureTurnLedgerSchema(db);
    const ledger = createTurnLedger({ db, selfDaemonId: 'host', now: () => 20_000, autoFlush: false });
    const started = ledger.observe({ eventId: 'start', at: acceptedAt, source: 'fsm_edge', sessionId: 'coord', observedBy: 'host', kind: 'turn_started', retro: false }).attempt!;
    const common = { eventId: 'end', at: 20_000, source: 'fsm_edge' as const, sessionId: 'coord', observedBy: 'host', attemptRef: { attemptId: started.attemptId, generation: started.generation } };
    const attempt = envelope !== undefined
        ? ledger.observe({ ...common, kind: 'turn_end', strength: 'genuine' }, { envelope: { finalSummary: envelope } }).attempt!
        : ledger.observe({ ...common, kind: 'transcript_final', selfAttributing: true, nativeRead: true,
            live: { modal: false, adapterPending: false, trailingTool: false }, messageAt: 19_000 }).attempt!;
    new SqliteAssistantRelayStore(db).recordCommitted({ attemptId: attempt.attemptId, meshId: 'mesh', coordinatorSessionId: 'coord', committedAt: Date.now(), kind: 'relay', outcome: 'completed' });
    return { db, attempt, recover: (execute: any) => recoverAttemptReport(db, attempt, 'mesh', 'coord', execute) };
}

const bubble = (timestamp: number, content: string, extra = {}) => ({ role: 'assistant', kind: 'standard', bubbleState: 'final', timestamp, content, ...extra });
const native = (messages: unknown[], extra = {}) => ({ success: true, messageSource: { selected: 'native-history' },
    debugReadChat: { provider: 'codex-cli' }, providerObservedStatus: 'idle', coverage: 'full', messages, ...extra });

describe('native relay capture review regressions', () => {
    it('replaces the live streaming snapshot with finalized native history, including real Claude receivedAt rows', async () => {
        const fragment = 'The synthetic workspace is ready, and that';
        const full = fragment + ' completes the first sentence. A second sentence is also part of the final reply.';
        const f = fixture(fragment);
        const execute = vi.fn(async (command: string) => command === 'read_chat'
            ? native([{ role: 'assistant', kind: 'standard', receivedAt: 19_000, content: fragment, bubbleState: 'streaming' }],
                { debugReadChat: { provider: 'claude-cli' } })
            : { success: true, source: 'provider-native', agent: 'claude-cli', hasMore: false,
                messages: [{ role: 'assistant', kind: 'standard', receivedAt: 19_000, content: full }] });
        const result = await f.recover(execute);
        expect(result).toMatchObject({ body: full, completeness: 'final_native' });
        expect(execute).toHaveBeenCalledTimes(2);
        expect(f.db.prepare('SELECT body FROM assistant_attempt_bodies').get()).toEqual({ body: full });
    });

    it('accepts finalized history after live native rows omit bubbleState, without weakening explicit streaming checks', async () => {
        const f = fixture();
        const final = { role: 'assistant', kind: 'standard', receivedAt: 19_000, content: 'All sentences. The finalized native reply.' };
        expect(await f.recover(async (command: string) => command === 'read_chat'
            ? native([final]) : native([final], { hasMore: false })))
            .toMatchObject({ body: final.content, completeness: 'final_native' });
        expect((await f.recover(async () => native([{ ...final, isStreaming: true }], { hasMore: false }))).source)
            .toBe('durable_attempt_capture');
    });

    it('captures a native flush after the FSM debounce timestamp and fences off the next attempt', async () => {
        const prefix = 'The synthetic final';
        const full = prefix + ' arrived after the debounce edge. Every sentence belongs to this attempt.';
        const f = fixture(prefix);
        f.db.prepare(`INSERT INTO turn_attempts(attempt_id,scope,session_id,owner_daemon_id,state,accepted_at,created_at,updated_at)
            VALUES('next','plain','coord','host','running',23000,23000,23000)`).run();
        const result = await f.recover(async () => native([
            bubble(21_000, full), bubble(24_000, 'Next attempt reply must never be included.'),
        ]));
        expect(result).toMatchObject({ body: full, completeness: 'final_native', parts: [{ at: 21_000, chars: full.length }] });
        const ref = JSON.parse(result.provenance!.evidenceRef);
        expect(ref[2]).toBe(20_000); // original terminal cause remains bound
        expect(ref[8]).toBe(22_999); // independently fenced transcript window
    });

    it('never promotes a PTY fallback to native evidence or stores it as exact', async () => {
        const f = fixture('screen row');
        const result = await f.recover(async () => ({ success: true, source: 'pty-parser', messageSource: { selected: 'pty-parser' }, messages: [bubble(19_000, 'screen row')], hasMore: false }));
        expect(result).toMatchObject({ body: 'screen row', completeness: 'envelope_unverified' });
        expect(f.db.prepare('SELECT count(*) AS n FROM assistant_attempt_bodies').get()).toEqual({ n: 0 });
    });

    it('rejects contradictory native/source claims', async () => {
        const f = fixture('screen row');
        expect(await f.recover(async () => native([bubble(19_000, 'screen row')], {
            source: 'provider-native', messageSource: { selected: 'pty-parser' },
        }))).toMatchObject({ body: 'screen row', completeness: 'envelope_unverified' });
    });

    it.each([true, false])('pages a native tail even when it contains the final (hasMore=%s)', async hasMore => {
        const f = fixture();
        const execute = vi.fn(async (command: string) => command === 'read_chat'
            ? native([bubble(19_000, 'final')], { coverage: 'tail', ...(hasMore ? { hasMore: true } : {}) })
            : native([bubble(12_000, 'intermediate'), bubble(19_000, 'final')], { source: 'provider-native', agent: 'codex-cli', hasMore: false }));
        const result = await f.recover(execute);
        expect(execute).toHaveBeenCalledWith('read_chat', { targetSessionId: 'coord', tailLimit: 200 });
        expect(execute).toHaveBeenCalledWith('chat_history', expect.objectContaining({ offset: 0, excludeRecentCount: 0 }));
        expect(result.completeness).toBe('final_native');
        expect(result.body).toContain('intermediate');
        expect(result.body).toContain('final');
    });

    it('pages an empty in-window read_chat tail without a hasMore field', async () => {
        const f = fixture();
        const result = await f.recover(async (cmd: string) => cmd === 'read_chat'
            ? native([], { coverage: 'tail' }) : native([bubble(19_000, 'final')], { source: 'provider-native', agent: 'codex-cli', hasMore: false }));
        expect(result).toMatchObject({ body: 'final', completeness: 'final_native' });
    });

    it('leaves exhausted history budgets unverified instead of pinning a partial body', async () => {
        const f = fixture('final');
        const execute = vi.fn(async () => native([bubble(19_000, 'final')], { coverage: 'tail', hasMore: true }));
        const result = await f.recover(execute);
        expect(result.completeness).toBe('envelope_unverified');
        expect(execute.mock.calls.length).toBeLessThanOrEqual(5);
        expect(f.db.prepare('SELECT count(*) AS n FROM assistant_attempt_bodies').get()).toEqual({ n: 0 });
    });

    it('does not mistake a finalized intermediate for the terminal native bubble', async () => {
        const f = fixture();
        expect((await f.recover(async () => native([bubble(12_000, 'intermediate')]))).completeness).not.toBe('final_native');
        expect((await f.recover(async () => native([bubble(12_000, 'intermediate'), bubble(19_000, 'final')]))).completeness).toBe('final_native');
    });

    it.each(['draft', 'streaming', 'removed'])('does not persist a %s terminal bubble', async bubbleState => {
        const f = fixture();
        expect((await f.recover(async () => native([bubble(19_000, 'unfinished', { bubbleState })]))).completeness).not.toBe('final_native');
    });

    it('bounds a hung read and ignores its late result', async () => {
        vi.useFakeTimers();
        const f = fixture('envelope');
        let resolve!: (result: unknown) => void;
        const pending = f.recover(() => new Promise(r => { resolve = r; }));
        await vi.advanceTimersByTimeAsync(8_001);
        expect(await pending).toMatchObject({ body: 'envelope', completeness: 'envelope_unverified' });
        resolve(native([bubble(19_000, 'late final')]));
        await Promise.resolve();
        expect(f.db.prepare('SELECT count(*) AS n FROM assistant_attempt_bodies').get()).toEqual({ n: 0 });
    });

    it('treats Grok synthesized timestamps as uncertainty even with native provenance', async () => {
        const f = fixture('grok final');
        const result = await f.recover(async () => native([bubble(7_500, 'current intermediate'), bubble(19_000, 'grok final')], { debugReadChat: { provider: 'grok-cli' } }));
        expect(result).toMatchObject({ body: 'grok final', completeness: 'envelope_unverified' });
        expect(f.db.prepare('SELECT count(*) AS n FROM assistant_attempt_bodies').get()).toEqual({ n: 0 });
    });

    it('does not assign cold-read Grok interpolation to exact attempt boundaries', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'relay-grok-clock-'));
        try {
            const path = join(dir, 'chat_history.jsonl');
            writeFileSync(join(dir, 'summary.json'), JSON.stringify({ created_at: new Date(1_000).toISOString() }));
            writeFileSync(path, [
                { type: 'user', content: 'old turn' }, { type: 'assistant', content: 'old answer' },
                { type: 'user', content: 'current turn' }, { type: 'assistant', content: 'current intermediate' },
                { type: 'assistant', content: 'grok final' },
            ].map(record => JSON.stringify(record)).join('\n'));
            utimesSync(path, new Date(19_000), new Date(19_000));
            const messages = readSession(path, 'grok')!.messages.map(m => ({ ...m, timestamp: m.receivedAt, bubbleState: 'final' }));
            expect(messages.find(m => m.content === 'current intermediate')!.timestamp).toBeLessThan(18_000);
            const f = fixture('grok final', 18_000);
            expect((await f.recover(async () => native(messages, { debugReadChat: { provider: 'grok-cli' } }))).completeness).toBe('envelope_unverified');
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it('does not resurrect an earlier unvalidated v2 capture during a read failure', async () => {
        const f = fixture('screen row');
        const good = await f.recover(async () => native([bubble(19_000, 'screen row and the complete native reply')]));
        const reference = JSON.parse(good.provenance!.evidenceRef);
        reference[7] = 'old-parts-only-hash';
        f.db.prepare('UPDATE assistant_attempt_bodies SET evidence_ref=?,body=?').run(JSON.stringify(reference), 'old truncated v2');
        expect(await f.recover(async () => ({ success: false }))).toMatchObject({ body: 'screen row', completeness: 'envelope_unverified' });
    });

    it('binds same-length native corrections to different evidence references', async () => {
        const f = fixture();
        const first = await f.recover(async () => native([bubble(19_000, 'first')]));
        const corrected = await f.recover(async () => native([bubble(19_000, 'other')]));
        expect(first.provenance!.evidenceRef).not.toBe(corrected.provenance!.evidenceRef);
        expect(f.db.prepare('SELECT body FROM assistant_attempt_bodies').get()).toEqual({ body: 'other' });
    });

    it('excludes a preceding attempt final inside the old one-second tolerance', async () => {
        const f = fixture();
        const result = await f.recover(async () => native([bubble(9_500, 'previous attempt final'), bubble(19_000, 'current final')]));
        expect(result.body).toBe('current final');
        expect(result.parts).toEqual([{ at: 19_000, chars: 'current final'.length }]);
    });
});
