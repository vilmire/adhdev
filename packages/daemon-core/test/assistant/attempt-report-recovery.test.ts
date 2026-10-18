import { ensureTurnLedgerSchema } from '../../src/mesh/turn-ledger/schema.js';
import { createTurnLedger } from '../../src/mesh/turn-ledger/ledger.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureAssistantRelaySchema } from '../../src/mesh/mesh-runtime-store-schema.js';
import { SqliteAssistantRelayStore } from '../../src/assistant/assistant-relay-sqlite-store.js';
import { pageAttemptReport } from '../../src/assistant/report-continuation.js';
import { recoverAttemptReport } from '../../src/assistant/attempt-report-recovery.js';
import { AssistantRelay } from '../../src/assistant/assistant-relay.js';
import { InMemoryAssistantRelayStore } from '../../src/assistant/assistant-relay-store.js';
import { AssistantInputLog } from '../../src/assistant/assistant-input-log.js';
const dbs: Database.Database[] = [];
const dirs: string[] = [];
afterEach(() => { for (const db of dbs.splice(0)) if (db.open) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it('restart relay rehydrates each original session/attempt independently; missing evidence stays pending and 24h folding stays intact', async () => {
    const now = Date.now(); const store = new InMemoryAssistantRelayStore();
    for (const [attemptId, sid, meshId, committedAt] of [['first', 'old-coord', 'mesh', now], ['second', 'new-coord', 'mesh', now], ['aged', 'old-coord', 'oldmesh', now - 25 * 60 * 60_000]] as const) {
        store.recordCommitted({ attemptId, meshId, coordinatorSessionId: sid, committedAt, kind: 'relay', outcome: 'completed' });
    }
    const rehydrate = vi.fn(async (_mesh: string, _sid: string, id: string) => id === 'first' ? 'first original' : null);
    const tail = vi.fn(async () => 'unrelated latest');
    const relay = new AssistantRelay({ subscribe: () => () => {}, coordinatorMeshOf: () => 'mesh', projectSlug: () => 'p', readCoordinatorTail: tail,
        rehydrateAttemptReport: rehydrate, meshWork: () => null, hasAssistant: () => true, assistantSessionId: () => null,
        isAssistantReady: () => false, submit: async () => ({ kind: 'delivered' }), inputLog: new AssistantInputLog(), store });
    relay.start(); const events = await relay.pullPending(null); relay.stop();
    const text = events.map(e => e.text).join('\n');
    expect(text).toContain('older than 24 h'); expect(text).toContain('first original'); expect(text).not.toContain('original report unavailable');
    expect(rehydrate.mock.calls).toEqual([['mesh', 'old-coord', 'first'], ['mesh', 'new-coord', 'second']]); expect(tail).not.toHaveBeenCalled();
    expect(text).toContain('reportId');
});

// Positive fixtures always use the real schema and producer API.
function producer(file = ':memory:') {
    const db = new Database(file); dbs.push(db); ensureAssistantRelaySchema(db); ensureTurnLedgerSchema(db);
    let now = 100;
    const ledger = createTurnLedger({ db, selfDaemonId: 'host', now: () => now, autoFlush: false });
    const start = (id = 'start', at = 100) => {
        now = at;
        const result = ledger.observe({ eventId: id, at, source: 'fsm_edge', sessionId: 'coord', observedBy: 'host', kind: 'turn_started', retro: false });
        expect(result.rule).toBe('R0a'); return result.attempt!;
    };
    const finish = (attempt = start(), mode: 'envelope' | 'native' | 'hold' = 'native', body = 'original report', at = 200) => {
        now = at;
        const common = { eventId: 'end:' + attempt.attemptId, at, source: 'fsm_edge' as const, sessionId: 'coord', observedBy: 'host',
            attemptRef: { attemptId: attempt.attemptId, generation: attempt.generation } };
        const result = mode === 'envelope'
            ? ledger.observe({ ...common, kind: 'turn_end', strength: 'genuine' }, { envelope: { finalSummary: body } })
            : ledger.observe({ ...common, kind: 'transcript_final', selfAttributing: mode === 'native', nativeRead: mode === 'native',
                live: { modal: false, adapterPending: false, trailingTool: false }, messageAt: at - 10 });
        expect(result.rule).toBe(mode === 'envelope' ? 'R9' : mode === 'native' ? 'R14' : 'R15');
        if (mode !== 'hold') return result.attempt!;
        const hold = ledger.store.activeHolds(attempt.attemptId).find(h => h.reason === 'weak_candidate')!;
        now = hold.until!;
        ledger.observe({ ...common, eventId: 'alive:' + attempt.attemptId, at: now, kind: 'liveness', result: 'alive', probeStartedAtMs: at });
        const expiry = ledger.expiredHoldEvidence(now).find(e => e.holdId === hold.holdId)!;
        const expired = ledger.observe(expiry);
        expect(expired.rule).toBe('R13a'); return expired.attempt!;
    };
    return { db, ledger, start, finish };
}
const nativeRead = (messages: any[]) => ({ success: true, coverage: 'full', hasMore: false,
    messageSource: { selected: 'native-history' }, debugReadChat: { provider: 'codex-cli' }, providerObservedStatus: 'idle',
    messages: messages.map(m => ({ bubbleState: 'final', ...m })) });
const nativeReader = (body = 'original report', at = 190) => vi.fn(async () => nativeRead(
    [{ role: 'assistant', timestamp: at, content: body }, { role: 'assistant', timestamp: at + 1e12, content: 'unrelated latest tail' }]));
it.each(['envelope', 'native', 'hold'] as const)('recovers the real plain %s cause plus derived commit', async mode => {
    const { db, finish, ledger } = producer(); const attempt = finish(undefined, mode);
    const rows = ledger.store.listEvents(attempt.attemptId);
    expect(rows.filter(r => r.toState === 'completed')).toHaveLength(2);
    if (mode === 'hold') expect(rows.some(r => r.kind === 'notify')).toBe(false);
    const execute = nativeReader();
    expect(await recoverAttemptReport(db, attempt, 'mesh', 'coord', execute)).toMatchObject({ body: 'original report',
        source: 'native_window', completeness: 'final_native' });
    expect(execute).toHaveBeenCalled();
});
it('validates real producer evidence before durable lookup after reopen, with complete >4000 pages and later observations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'exact-attempt-restart-')); dirs.push(dir); const file = join(dir, 'runtime.db');
    const { db, finish, ledger } = producer(file); const attempt = finish();
    const store = new SqliteAssistantRelayStore(db), now = Date.now();
    store.recordCommitted({ attemptId: attempt.attemptId, meshId: 'mesh', coordinatorSessionId: 'coord', committedAt: now, kind: 'relay', outcome: 'completed' });
    const body = 'Public original report. '.repeat(600) + 'EXACT TAIL';
    expect((await recoverAttemptReport(db, attempt, 'mesh', 'coord', nativeReader(body))).body).toBe(body);
    for (let n = 0; n < 160; n++) {
        const result = ledger.observe({ eventId: 'late:' + n, at: 300 + n, source: 'fsm_edge', sessionId: 'coord', observedBy: 'host',
            attemptRef: { attemptId: attempt.attemptId, generation: attempt.generation }, kind: 'turn_end', strength: 'genuine' });
        expect(result.verdict).toBe('recorded');
    }
    store.markDelivered([attempt.attemptId], now); db.close();
    const reopened = new Database(file); dbs.push(reopened);
    const execute = vi.fn(async () => ({ success: false }));
    const result = await recoverAttemptReport(reopened, attempt, 'mesh', 'coord', execute);
    expect(result).toMatchObject({ body, source: 'durable_attempt_capture', completeness: 'final_native', provenance: { version: 2, attemptId: attempt.attemptId, generation: attempt.generation } });
    execute.mockClear();
    const pages: string[] = []; let offset = 0;
    for (;;) {
        const page = pageAttemptReport(result.body!, { attemptId: attempt.attemptId, coordinatorSessionId: 'coord', offset }, result.source);
        expect(page.success).toBe(true); pages.push(page.text!);
        if (page.nextOffset == null) break;
        expect(page.nextOffset - offset).toBe(4000); offset = page.nextOffset;
    }
    expect(pages.join('')).toBe(body); expect(pages.at(-1)).toContain('EXACT TAIL');
    for (const a of [null, { ...attempt, generation: attempt.generation + 1 }, { ...attempt, sessionId: 'foreign' }, { ...attempt, terminal: null }, { ...attempt, meshId: 'foreign' }])
        expect((await recoverAttemptReport(reopened, a, 'mesh', 'coord', execute)).body).toBeNull();
    reopened.prepare("DELETE FROM turn_events WHERE kind='transcript_final'").run();
    expect((await recoverAttemptReport(reopened, attempt, 'mesh', 'coord', execute)).body).toBeNull();
    expect(execute).not.toHaveBeenCalled();
});
it.each(['competing cause', 'stale cause', 'foreign cause', 'missing commit', 'wrong linkage', 'wrong outcome'])(
    'refuses %s before durable or native reads', async defect => {
    const { db, finish, ledger } = producer(); const attempt = finish();
    const store = new SqliteAssistantRelayStore(db);
    store.recordCommitted({ attemptId: attempt.attemptId, meshId: 'mesh', coordinatorSessionId: 'coord', committedAt: Date.now(), kind: 'relay', outcome: 'completed' });
    await recoverAttemptReport(db, attempt, 'mesh', 'coord', nativeReader());
    if (defect === 'competing cause') {
        const cause = ledger.store.listEvents(attempt.attemptId).find(r => r.kind === 'transcript_final')!;
        // Fault injection of a competing applied transition; ordinary later
        // evidence is recorded, as verified above through observe().
        expect(ledger.store.insertEvent({ ...cause, eventId: 'competing', dedupeKey: 'competing' })).toBe(true);
    } else if (defect === 'stale cause') db.prepare("UPDATE turn_events SET generation=generation+1 WHERE kind='transcript_final'").run();
    else if (defect === 'foreign cause') db.prepare("UPDATE turn_events SET session_id='foreign' WHERE kind='transcript_final'").run();
    else if (defect === 'missing commit') db.prepare("DELETE FROM turn_events WHERE kind='committed'").run();
    else if (defect === 'wrong linkage') db.prepare("UPDATE turn_events SET event_id='unlinked#committed' WHERE kind='committed'").run();
    else db.prepare("UPDATE turn_events SET to_state='failed' WHERE kind='committed'").run();
    const execute = nativeReader();
    expect((await recoverAttemptReport(db, attempt, 'mesh', 'coord', execute)).body).toBeNull(); expect(execute).not.toHaveBeenCalled();
});
it.each(['missing source', 'stale hold', 'foreign source', 'missing pointer'] as const)('refuses hold expiry with %s', async defect => {
    const { db, finish } = producer(); const attempt = finish(undefined, 'hold');
    if (defect === 'missing source') db.prepare("DELETE FROM turn_events WHERE kind='transcript_final'").run();
    else if (defect === 'stale hold') db.prepare('UPDATE turn_holds SET generation=generation+1').run();
    else if (defect === 'foreign source') db.prepare("UPDATE turn_events SET session_id='foreign' WHERE kind='transcript_final'").run();
    else db.prepare("UPDATE turn_holds SET data_json='{}'").run();
    const execute = nativeReader();
    expect((await recoverAttemptReport(db, attempt, 'mesh', 'coord', execute)).body).toBeNull(); expect(execute).not.toHaveBeenCalled();
});
it('binds equal bodies of distinct real attempts to separate evidence', async () => {
    const { db, start, finish } = producer(); const store = new SqliteAssistantRelayStore(db);
    const first = finish(), second = finish(start('second', 300), 'native', '', 400);
    for (const [attempt, at] of [[first, 190], [second, 390]] as const) {
        store.recordCommitted({ attemptId: attempt.attemptId, meshId: 'mesh', coordinatorSessionId: 'coord', committedAt: Date.now(), kind: 'relay', outcome: 'completed' });
        expect((await recoverAttemptReport(db, attempt, 'mesh', 'coord', nativeReader('same report', at))).body).toBe('same report');
    }
    const refs = db.prepare('SELECT evidence_ref FROM assistant_attempt_bodies').all() as { evidence_ref: string }[];
    expect(refs).toHaveLength(2); expect(refs[0].evidence_ref).not.toBe(refs[1].evidence_ref);
});
it('refuses ambiguous native bubbles and never trusts a legacy session tail', async () => {
    const { db, finish } = producer(); const attempt = finish();
    db.prepare('INSERT INTO assistant_attempt_bodies(attempt_id,mesh_id,coordinator_session_id,captured_at,body) VALUES(?,?,?,?,?)')
        .run(attempt.attemptId, 'mesh', 'coord', Date.now(), 'unproven latest tail');
    const absent = vi.fn(async () => ({ success: true, messages: [{ role: 'assistant', timestamp: 10_000, content: 'unrelated latest' }], hasMore: false }));
    expect((await recoverAttemptReport(db, attempt, 'mesh', 'coord', absent)).body).toBeNull();
    const execute = vi.fn(async () => nativeRead([
        { role: 'assistant', timestamp: 190, content: 'one' }, { role: 'assistant', timestamp: 190, content: 'two' },
    ]));
    expect((await recoverAttemptReport(db, attempt, 'mesh', 'coord', execute)).body).toBeNull(); expect(execute).toHaveBeenCalledTimes(1);
});
it.each([false, true])('delayed relay commits retain exact real-attempt attribution (remote=%s)', async remote => {
    const { db, start, finish } = producer(); const store = new SqliteAssistantRelayStore(db);
    const attempts = [finish(), finish(start('second', 300), 'native', '', 400)];
    let release!: () => void; const delayed = new Promise<void>(r => { release = r });
    const execute = vi.fn(async () => { await delayed; return nativeRead([
        { role: 'assistant', timestamp: -5000, content: 'stale tail' },
        { role: 'assistant', timestamp: 390, content: 'second turn body' },
        { role: 'assistant', timestamp: 500, content: 'newer tail' },
    ]); });
    let handler: (e: any) => void = () => {};
    const tail = vi.fn(async () => 'second turn body');
    const timers: Array<{ at: number; fn: () => void; id: number }> = [];
    let now = 0; let nextTimer = 1;
    const clock = {
        now: () => now,
        setTimeout: (fn: () => void, ms: number) => { const id = nextTimer++; timers.push({ at: now + ms, fn, id }); return id; },
        clearTimeout: (h: unknown) => { const i = timers.findIndex((x) => x.id === h); if (i >= 0) timers.splice(i, 1); },
        advance(ms: number) {
            const end = now + ms;
            for (;;) {
                const due = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
                if (!due) break;
                timers.splice(timers.indexOf(due), 1);
                now = due.at; due.fn();
            }
            now = end;
        },
    };
    const ports = { subscribe: (h: typeof handler) => { handler = h; return () => {} }, coordinatorMeshOf: () => 'mesh', projectSlug: () => 'p',
        readCoordinatorTail: tail, rehydrateAttemptReport: (mesh: string, sid: string, id: string) =>
            recoverAttemptReport(db, attempts.find(a => a.attemptId === id) ?? null, mesh, sid, execute).then(r => r.body),
        meshWork: () => null, hasAssistant: () => true, assistantSessionId: () => null, isAssistantReady: () => false,
        submit: async () => ({ kind: 'delivered' as const }), inputLog: new AssistantInputLog(), store, clock };
    const relay = new AssistantRelay(ports); relay.start(); relay.openThread('mesh');
    for (const a of attempts) {
        if (remote) relay.onRemoteCommitted('mesh', { attemptId: a.attemptId, coordinatorSessionId: 'coord', outcome: 'completed', body: 'second turn body' });
        else handler({ kind: 'turn', phase: 'committed', sessionId: 'coord', attemptId: a.attemptId, generation: a.generation, at: Date.now(), outcome: 'completed' });
    }
    await Promise.resolve(); release();
    for (let i = 0; i < 32; i++) await Promise.resolve();
    const pending = [...(relay as any).attemptBodyCapture.values()];
    relay.stop(); clock.advance(1000);
    await Promise.all(pending);
    expect(tail).not.toHaveBeenCalled();
    expect(db.prepare('SELECT attempt_id FROM assistant_attempt_bodies').all()).toEqual([{ attempt_id: attempts[1].attemptId }]);
    const restarted = new AssistantRelay({ ...ports, store: new SqliteAssistantRelayStore(db) }); restarted.start();
    const text = (await restarted.pullPending(null)).map(e => e.text).join('\n');
    expect(store.listUndelivered().map(r => r.attemptId)).toEqual([attempts[0].attemptId]); restarted.stop();
    expect(text).not.toContain('original report unavailable'); expect(text.match(/second turn body/g)).toHaveLength(1);
});

it('relays a short multi-sentence reply whole when it wraps past one screen row', async () => {
    const { db, finish } = producer();
    const full = 'Sentence one is already past eighty columns on a wrapped screen. Sentence two stays in the same bubble. Sentence three finishes the reply.';
    expect(full.length).toBeGreaterThan(80);
    const attempt = finish(undefined, 'envelope', full.slice(0, 80));
    const store = new SqliteAssistantRelayStore(db);
    store.recordCommitted({ attemptId: attempt.attemptId, meshId: 'mesh', coordinatorSessionId: 'coord', committedAt: Date.now(), kind: 'relay', outcome: 'completed' });
    const result = await recoverAttemptReport(db, attempt, 'mesh', 'coord', nativeReader(full));
    expect(result).toMatchObject({ body: full, source: 'native_window', completeness: 'final_native' });
    expect(result.body).not.toBe(full.slice(0, 80));
    const page = pageAttemptReport(result.body!, { attemptId: attempt.attemptId, coordinatorSessionId: 'coord', offset: 0 }, result.source, result.completeness);
    expect(page.complete).toBe(true);
});

it('relays a long native reply whole, in 4000-character pages with a stable report id', async () => {
    const { db, finish } = producer();
    const body = `${'n'.repeat(5190)}EXACT-TAIL`;
    expect(body.length).toBe(5200);
    const attempt = finish(undefined, 'native', '', 200);
    const store = new SqliteAssistantRelayStore(db);
    store.recordCommitted({ attemptId: attempt.attemptId, meshId: 'mesh', coordinatorSessionId: 'coord', committedAt: Date.now(), kind: 'relay', outcome: 'completed' });
    const result = await recoverAttemptReport(db, attempt, 'mesh', 'coord', nativeReader(body));
    expect(result.body).toBe(body);
    expect(result.completeness).toBe('final_native');
    const cursor = { attemptId: attempt.attemptId, coordinatorSessionId: 'coord', offset: 0 };
    const first = pageAttemptReport(result.body!, cursor, result.source, result.completeness);
    const second = pageAttemptReport(result.body!, { ...cursor, offset: first.nextOffset!, reportId: first.reportId }, result.source, result.completeness);
    expect(first.text).toHaveLength(4000);
    expect(second.text).toHaveLength(1200);
    expect(second.complete).toBe(true);
    expect(second.reportId).toBe(first.reportId);
    expect(first.text + second.text).toBe(body);
    expect(second.totalChars).toBe(5200);
});

it('relays every native reply in one attempt, oldest first', async () => {
    const { db, finish } = producer();
    const attempt = finish();
    const store = new SqliteAssistantRelayStore(db);
    store.recordCommitted({ attemptId: attempt.attemptId, meshId: 'mesh', coordinatorSessionId: 'coord', committedAt: Date.now(), kind: 'relay', outcome: 'completed' });
    const execute = vi.fn(async () => nativeRead([
        { role: 'assistant', timestamp: 190, content: 'Second native reply.' },
        { role: 'assistant', kind: 'thinking', timestamp: 160, content: 'hidden thinking' },
        { role: 'assistant', timestamp: 150, content: 'First native reply.' },
    ]));
    const result = await recoverAttemptReport(db, attempt, 'mesh', 'coord', execute);
    expect(result.completeness).toBe('final_native');
    expect(result.parts).toEqual([{ at: 150, chars: 'First native reply.'.length }, { at: 190, chars: 'Second native reply.'.length }]);
    expect(result.body).toContain('[reply 1/2 ·');
    expect(result.body).toContain('First native reply.');
    expect(result.body).toContain('[reply 2/2 ·');
    expect(result.body).toContain('Second native reply.');
    expect(result.body).not.toContain('hidden thinking');
    expect(result.body!.indexOf('First native reply.')).toBeLessThan(result.body!.indexOf('Second native reply.'));
});

it('flags an envelope-only report incomplete and does not store it as exact', async () => {
    const { db, finish } = producer();
    const row = 'only the first wrapped screen row';
    const attempt = finish(undefined, 'envelope', row);
    const store = new SqliteAssistantRelayStore(db);
    store.recordCommitted({ attemptId: attempt.attemptId, meshId: 'mesh', coordinatorSessionId: 'coord', committedAt: Date.now(), kind: 'relay', outcome: 'completed' });
    db.prepare(`INSERT INTO assistant_attempt_bodies(attempt_id,mesh_id,coordinator_session_id,captured_at,body,evidence_ref,completeness)
        VALUES(?,?,?,?,?,?,?)`).run(attempt.attemptId, 'mesh', 'coord', Date.now(), 'pinned v1 row', JSON.stringify([1, 0]), 'final_native');
    const execute = vi.fn(async () => ({ success: true, messages: [
        { role: 'assistant', timestamp: attempt.acceptedAt - 1001, content: 'before the window' },
        { role: 'assistant', timestamp: attempt.terminal!.at + 1, content: 'after the window' },
    ], hasMore: false }));
    const result = await recoverAttemptReport(db, attempt, 'mesh', 'coord', execute);
    expect(result).toMatchObject({ body: row, source: 'existing_attempt_envelope', completeness: 'envelope_unverified' });
    expect(result.provenance?.version).toBe(2);
    const page = pageAttemptReport(result.body!, { attemptId: attempt.attemptId, coordinatorSessionId: 'coord', offset: 0 }, result.source, 'envelope_unverified');
    expect(page.complete).toBe(false);
    expect(page.sourceComplete).toBe(false);
    expect(db.prepare('SELECT body, evidence_ref FROM assistant_attempt_bodies').get()).toEqual({ body: 'pinned v1 row', evidence_ref: JSON.stringify([1, 0]) });
});

it('replaces a pinned v1 body when the native window is a different evidence ref', async () => {
    const { db, finish } = producer();
    const attempt = finish(undefined, 'envelope', 'truncated row');
    const store = new SqliteAssistantRelayStore(db);
    store.recordCommitted({ attemptId: attempt.attemptId, meshId: 'mesh', coordinatorSessionId: 'coord', committedAt: Date.now(), kind: 'relay', outcome: 'completed' });
    db.prepare(`INSERT INTO assistant_attempt_bodies(attempt_id,mesh_id,coordinator_session_id,captured_at,body,evidence_ref)
        VALUES(?,?,?,?,?,?)`).run(attempt.attemptId, 'mesh', 'coord', Date.now(), 'truncated row', JSON.stringify([1, attempt.generation]));
    const full = 'truncated row plus the rest of the native reply that the screen scrape dropped.';
    const result = await recoverAttemptReport(db, attempt, 'mesh', 'coord', nativeReader(full));
    expect(result.body).toBe(full);
    expect(result.provenance?.version).toBe(2);
    expect(JSON.parse(result.provenance!.evidenceRef)[0]).toBe(2);
    expect(store.readAttemptBody(attempt.attemptId, 'mesh', 'coord', Date.now(), result.provenance!.evidenceRef)).toBe(full);
});

// 2026-10-18 (preview): every relay fell back to the bare envelope because live
// read_chat / chat_history messages carry their time as `receivedAt`, never
// `timestamp`, and history rows carry no `bubbleState`. Fixtures above use
// `timestamp`; these use the shapes the daemon actually returns.
describe('native window over the real message shapes', () => {
    it('recovers the report from read_chat messages timed by receivedAt', async () => {
        const { db, finish } = producer(); const attempt = finish(undefined, 'native');
        const execute = vi.fn(async () => ({ success: true, coverage: 'full', hasMore: false,
            messageSource: { selected: 'native-history' }, debugReadChat: { provider: 'codex-cli' }, providerObservedStatus: 'idle',
            messages: [
                { role: 'assistant', kind: 'standard', bubbleState: 'final', receivedAt: 190, content: 'original report' },
                { role: 'assistant', kind: 'standard', bubbleState: 'final', receivedAt: 190 + 1e12, content: 'unrelated latest tail' },
            ] }));
        expect(await recoverAttemptReport(db, attempt, 'mesh', 'coord', execute)).toMatchObject({ body: 'original report',
            source: 'native_window', completeness: 'final_native' });
    });

    it('treats stored chat_history rows (no bubbleState) as final', async () => {
        const { readNativeWindow } = await import('../../src/assistant/attempt-report-recovery.js');
        const execute = vi.fn(async (command: string) => command === 'read_chat'
            ? { success: true, coverage: 'tail', hasMore: true, messageSource: { selected: 'native-history' }, debugReadChat: { provider: 'codex-cli' }, providerObservedStatus: 'idle', messages: [] }
            : { success: true, hasMore: false, messageSource: { selected: 'native-history' }, debugReadChat: { provider: 'codex-cli' },
                messages: [{ role: 'assistant', kind: 'standard', receivedAt: 150, content: 'from history' }] });
        const out = await readNativeWindow(execute as any, 'coord', 100, 200);
        expect(out.complete).toBe(true);
        expect(out.bubbles.map(b => b.text)).toEqual(['from history']);
    });
});
