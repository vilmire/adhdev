import { afterEach, expect, it, vi } from 'vitest';
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
function evidence(file = ':memory:') {
    const db = new Database(file); dbs.push(db); ensureAssistantRelaySchema(db);
    db.exec('CREATE TABLE turn_events(event_id TEXT,attempt_id TEXT,session_id TEXT,generation INTEGER,to_state TEXT,payload_json TEXT,recorded_at INTEGER)');
    const attempt: any = { attemptId: 'attempt', sessionId: 'coord', scope: 'plain', meshId: null, generation: 1, acceptedAt: 100, terminal: { outcome: 'completed', at: 200 } };
    const add = (id: string, payload: unknown, to: string | null = 'completed', at = 200) => db.prepare('INSERT INTO turn_events VALUES (?,?,?,?,?,?,?)').run(id, 'attempt', 'coord', 1, to, JSON.stringify(payload), at);
    return { db, attempt, add };
}
it('rehydrates exact committed attempt envelope, never an older false-idle summary or unrelated latest tail', async () => {
    const { db, attempt, add } = evidence();
    add('old', { evidence: { kind: 'turn_end' }, local: { envelope: { finalSummary: 'wrong earlier summary' } } }, 'candidate', 150);
    add('terminal', { evidence: { kind: 'turn_end', messageAt: 190 } });
    const execute = vi.fn(async () => ({ success: true, messages: [{ role: 'assistant', timestamp: 199, content: 'unrelated latest tail' }], hasMore: false }));
    const missing = await recoverAttemptReport(db, attempt, 'mesh', 'coord', execute);
    expect(missing).toMatchObject({ body: null, reason: 'original_native_bubble_unavailable' });
    db.prepare('UPDATE turn_events SET payload_json=? WHERE event_id=?').run(JSON.stringify({ evidence: { kind: 'turn_end' }, local: { envelope: { finalSummary: 'exact original report'.repeat(250) } } }), 'terminal');
    execute.mockClear(); const recovered = await recoverAttemptReport(db, attempt, 'mesh', 'coord', execute);
    expect(recovered.body).toBe('exact original report'.repeat(250)); expect(execute).not.toHaveBeenCalled();
    expect((await recoverAttemptReport(db, attempt, 'mesh', 'foreign', execute)).body).toBe(null);
});
it('uses only the unique native bubble reference inside the attempt; missing or ambiguous evidence remains unavailable', async () => {
    const { db, attempt, add } = evidence(); add('terminal', { evidence: { kind: 'turn_end', messageAt: 190 } });
    const execute = vi.fn(async () => ({ success: true, messages: [{ role: 'assistant', timestamp: 190, content: 'original native report' }, { role: 'assistant', timestamp: 199, content: 'latest' }] }));
    expect(await recoverAttemptReport(db, attempt, 'mesh', 'coord', execute)).toMatchObject({ body: 'original native report', source: 'exact_native_bubble' });
    db.prepare('DELETE FROM turn_events').run(); execute.mockClear();
    expect(await recoverAttemptReport(db, attempt, 'mesh', 'coord', execute)).toMatchObject({ body: null, reason: 'original_terminal_evidence_unavailable' });
    expect(execute).not.toHaveBeenCalled();
});
it('restart relay rehydrates each original session/attempt independently; missing evidence is explicit and 24h folding stays intact', async () => {
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
    expect(text).toContain('older than 24 h'); expect(text).toContain('first original'); expect(text).toContain('original report unavailable');
    expect(rehydrate.mock.calls).toEqual([['mesh', 'old-coord', 'first'], ['mesh', 'new-coord', 'second']]); expect(tail).not.toHaveBeenCalled();
    expect(text).toContain('reportId');
});

it('captures only an exact native reference, then recovers complete pages after database reopen with source unavailable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'exact-attempt-restart-')); dirs.push(dir);
    const file = join(dir, 'runtime.db');
    const { db, attempt, add } = evidence(file); add('terminal', { evidence: { kind: 'turn_end', messageAt: 190 } });
    const store = new SqliteAssistantRelayStore(db), now = Date.now();
    store.recordCommitted({ attemptId: attempt.attemptId, meshId: 'mesh', coordinatorSessionId: 'coord', committedAt: now, kind: 'relay', outcome: 'completed' });
    const body = 'Public original report. '.repeat(600) + 'EXACT TAIL';
    const first = await recoverAttemptReport(db, attempt, 'mesh', 'coord', vi.fn(async () => ({ success: true,
        messages: [{ role: 'assistant', timestamp: 190, content: body }, { role: 'assistant', timestamp: 199, content: 'newer tail' }] })));
    expect(first.source).toBe('exact_native_bubble');
    store.markDelivered([attempt.attemptId], now);
    db.close(); const reopened = new Database(file); dbs.push(reopened);
    const execute = vi.fn(async () => ({ success: false }));
    const result = await recoverAttemptReport(reopened, attempt, 'mesh', 'coord', execute);
    expect(result).toMatchObject({ body, source: 'durable_attempt_capture', provenance: { version: 1, attemptId: attempt.attemptId, generation: 1 } });
    const pages: string[] = []; let offset = 0;
    for (;;) {
        const page = pageAttemptReport(result.body!, { attemptId: attempt.attemptId, coordinatorSessionId: 'coord', offset }, result.source);
        expect(page.success).toBe(true); pages.push(page.text!);
        if (page.nextOffset == null) break;
        expect(page.nextOffset - offset).toBe(4000); offset = page.nextOffset;
    }
    expect(pages.join('')).toBe(body); expect(pages.at(-1)).toContain('EXACT TAIL');
    for (const [a, mesh, sid] of [[null, 'mesh', 'coord'], [attempt, 'mesh', 'foreign'], [{ ...attempt, meshId: 'foreign' }, 'mesh', 'coord'],
        [{ ...attempt, terminal: null }, 'mesh', 'coord'], [{ ...attempt, generation: 2 }, 'mesh', 'coord']] as const) {
        expect((await recoverAttemptReport(reopened, a, mesh, sid, execute)).body).toBeNull();
    }
    reopened.prepare('DELETE FROM turn_events').run();
    expect((await recoverAttemptReport(reopened, attempt, 'mesh', 'coord', execute)).body).toBeNull();
    expect(execute).not.toHaveBeenCalled();
});
it('never trusts legacy session-tail captures without provenance, even with a valid terminal', async () => {
    const { db, attempt, add } = evidence();
    db.prepare('INSERT INTO assistant_attempt_bodies(attempt_id,mesh_id,coordinator_session_id,captured_at,body) VALUES(?,?,?,?,?)')
        .run(attempt.attemptId, 'mesh', 'coord', Date.now(), 'wrong second turn tail');
    const execute = vi.fn(async () => ({ success: true, messages: [{ role: 'assistant', timestamp: 199, content: 'wrong second turn tail' }], hasMore: false }));
    expect((await recoverAttemptReport(db, attempt, 'mesh', 'coord', execute)).body).toBeNull(); expect(execute).not.toHaveBeenCalled();
    add('terminal', { evidence: { kind: 'turn_end', messageAt: 190 } });
    expect((await recoverAttemptReport(db, attempt, 'mesh', 'coord', execute)).body).toBeNull();
    expect(db.prepare('SELECT evidence_ref FROM assistant_attempt_bodies').get()).toEqual({ evidence_ref: null });
});
it.each([false, true])('delayed local and remote commits resolve exact attempts, never newer/stale polled tail (remote=%s)', async remote => {
    const { db } = evidence(); const store = new SqliteAssistantRelayStore(db);
    const attempts = [1, 2].map(n => ({ attemptId: `plain:coord:${n}`, sessionId: 'coord', scope: 'plain', generation: n,
        acceptedAt: n * 100, terminal: { outcome: 'completed', at: n * 100 + 90 } } as any));
    for (const [i, a] of attempts.entries()) db.prepare('INSERT INTO turn_events VALUES(?,?,?,?,?,?,?)').run('end' + i, a.attemptId, 'coord', a.generation,
        'completed', JSON.stringify({ evidence: { kind: 'turn_end', messageAt: a.acceptedAt + 80 } }), a.terminal.at);
    let release!: () => void; const delayed = new Promise<void>(r => { release = r });
    // This snapshot has a stale and a newer tail, and only attempt 2's exact reference.
    const execute = vi.fn(async () => { await delayed; return { success: true, messages: [
        { role: 'assistant', timestamp: 50, content: 'stale tail' },
        { role: 'assistant', timestamp: 280, content: 'second turn body' },
        { role: 'assistant', timestamp: 299, content: 'newer tail' },
    ], hasMore: false } });
    let handler: (e: any) => void = () => {};
    const tail = vi.fn(async () => 'second turn body');
    const reader = (mesh: string, sid: string, id: string) => recoverAttemptReport(db, attempts.find(a => a.attemptId === id) ?? null, mesh, sid, execute).then(r => r.body);
    const ports = { subscribe: (h: typeof handler) => { handler = h; return () => {} }, coordinatorMeshOf: () => 'mesh', projectSlug: () => 'p',
        readCoordinatorTail: tail, rehydrateAttemptReport: reader, meshWork: () => null, hasAssistant: () => true,
        assistantSessionId: () => null, isAssistantReady: () => false, submit: async () => ({ kind: 'delivered' as const }), inputLog: new AssistantInputLog(), store };
    const relay = new AssistantRelay(ports); relay.start(); relay.openThread('mesh');
    for (const a of attempts) {
        if (remote) relay.onRemoteCommitted('mesh', { attemptId: a.attemptId, coordinatorSessionId: 'coord', outcome: 'completed', body: 'second turn body' });
        else handler({ kind: 'turn', phase: 'committed', sessionId: 'coord', attemptId: a.attemptId, generation: a.generation, at: Date.now(), outcome: 'completed' });
    }
    await Promise.resolve(); release();
    await Promise.all([...(relay as any).attemptBodyCapture.values()]); relay.stop();
    expect(tail).not.toHaveBeenCalled();
    expect(db.prepare('SELECT attempt_id FROM assistant_attempt_bodies').all()).toEqual([{ attempt_id: attempts[1].attemptId }]);
    const noSource = vi.fn(async () => ({ success: false }));
    expect((await recoverAttemptReport(db, attempts[0], 'mesh', 'coord', noSource)).body).toBeNull();
    expect((await recoverAttemptReport(db, attempts[1], 'mesh', 'coord', noSource)).body).toBe('second turn body');
    const restarted = new AssistantRelay({ ...ports, store: new SqliteAssistantRelayStore(db) }); restarted.start();
    const events = await restarted.pullPending(null); restarted.stop();
    const text = events.map(e => e.text).join('\n');
    expect(text).toContain('original report unavailable'); expect(text.match(/second turn body/g)).toHaveLength(1);
});
it('equal text belongs to distinct attempts only when each has its own exact native reference', async () => {
    const { db } = evidence(); const store = new SqliteAssistantRelayStore(db);
    for (let n = 1; n <= 2; n++) {
        const attempt: any = { attemptId: 'plain:coord:' + n, sessionId: 'coord', scope: 'plain', generation: n, acceptedAt: n * 100, terminal: { outcome: 'completed', at: n * 100 + 90 } };
        db.prepare('INSERT INTO turn_events VALUES(?,?,?,?,?,?,?)').run('end' + n, attempt.attemptId, 'coord', n, 'completed', JSON.stringify({ evidence: { kind: 'turn_end', messageAt: n * 100 + 80 } }), attempt.terminal.at);
        store.recordCommitted({ attemptId: attempt.attemptId, meshId: 'mesh', coordinatorSessionId: 'coord', committedAt: Date.now(), kind: 'relay', outcome: 'completed' });
        expect((await recoverAttemptReport(db, attempt, 'mesh', 'coord', vi.fn(async () => ({ success: true, messages: [
            { role: 'assistant', timestamp: 180, content: 'same report' }, { role: 'assistant', timestamp: 280, content: 'same report' },
        ] })))).body).toBe('same report');
    }
    const refs = db.prepare('SELECT evidence_ref FROM assistant_attempt_bodies').all() as any[];
    expect(refs).toHaveLength(2); expect(refs[0].evidence_ref).not.toBe(refs[1].evidence_ref);
});
it('refuses ambiguous native matches instead of choosing the first message', async () => {
    const { db, attempt, add } = evidence(); add('terminal', { evidence: { kind: 'turn_end', messageAt: 190 } });
    const execute = vi.fn(async () => ({ success: true, messages: [
        { role: 'assistant', timestamp: 190, content: 'first' }, { role: 'assistant', timestamp: 190, content: 'second' },
    ], hasMore: false }));
    expect((await recoverAttemptReport(db, attempt, 'mesh', 'coord', execute)).body).toBeNull();
});

it('follows the actual transcript_final producer reference through a hold-expiry terminal, never an earlier unreferenced end', async () => {
    const { db, attempt, add } = evidence();
    add('original-native', { evidence: { kind: 'transcript_final', messageAt: 190 } }, 'candidate', 190);
    add('terminal', { evidence: { kind: 'hold_expired' } });
    add('terminal#notify:1', { textEventId: 'original-native' }, null, 201);
    const execute = vi.fn(async () => ({ success: true, messages: [{ role: 'assistant', timestamp: 190, content: 'exact native final' }] }));
    expect((await recoverAttemptReport(db, attempt, 'mesh', 'coord', execute)).body).toBe('exact native final');
    db.prepare('DELETE FROM turn_events WHERE event_id=?').run('original-native'); execute.mockClear();
    expect((await recoverAttemptReport(db, attempt, 'mesh', 'coord', execute)).body).toBeNull();
    expect(execute).not.toHaveBeenCalled();
});
it('refuses duplicate terminal and native references without choosing the first available fallback', async () => {
    const { db, attempt, add } = evidence(); add('terminal', { evidence: { kind: 'turn_end', messageAt: 190 } });
    const execute = vi.fn(async (command: string) => ({ success: true, messages: command === 'read_chat' ? [
        { role: 'assistant', timestamp: 190, content: 'one' }, { role: 'assistant', timestamp: 190, content: 'two' },
    ] : [{ role: 'assistant', timestamp: 190, content: 'one' }] }));
    expect((await recoverAttemptReport(db, attempt, 'mesh', 'coord', execute)).body).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1); execute.mockClear();
    add('second-terminal', { evidence: { kind: 'turn_end', messageAt: 190 } });
    expect((await recoverAttemptReport(db, attempt, 'mesh', 'coord', execute)).body).toBeNull();
    expect(execute).not.toHaveBeenCalled();
});
