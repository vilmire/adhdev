import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ensureAssistantRelaySchema } from '../../src/mesh/mesh-runtime-store-schema.js';
import { SqliteAssistantRelayStore } from '../../src/assistant/assistant-relay-sqlite-store.js';
import { pageAttemptReport } from '../../src/assistant/report-continuation.js';
import { recoverAttemptReport } from '../../src/assistant/attempt-report-recovery.js';
import { AssistantRelay } from '../../src/assistant/assistant-relay.js';
import { InMemoryAssistantRelayStore } from '../../src/assistant/assistant-relay-store.js';
import { AssistantInputLog } from '../../src/assistant/assistant-input-log.js';
const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function evidence() {
    const db = new Database(':memory:'); dbs.push(db); ensureAssistantRelaySchema(db);
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

it('recovers the complete durable attempt before evidence, with page-size continuation and exact identity fences', async () => {
    const { db, attempt } = evidence();
    const store = new SqliteAssistantRelayStore(db), now = Date.now();
    store.recordCommitted({ attemptId: attempt.attemptId, meshId: 'mesh', coordinatorSessionId: 'coord', committedAt: now, kind: 'relay', outcome: 'completed' });
    const body = 'Public original report. '.repeat(600) + 'EXACT TAIL';
    store.captureAttemptBody(attempt.attemptId, 'mesh', 'coord', body, now);
    store.markDelivered([attempt.attemptId], now);
    const execute = vi.fn(async () => ({ success: true, messages: [] }));
    const result = await recoverAttemptReport(db, attempt, 'mesh', 'coord', execute);
    expect(result).toEqual({ body, source: 'durable_attempt_capture' });
    const pages: string[] = []; let offset = 0;
    for (;;) {
        const page = pageAttemptReport(result.body!, { attemptId: attempt.attemptId, coordinatorSessionId: 'coord', offset }, result.source);
        expect(page.success).toBe(true); pages.push(page.text!);
        if (page.nextOffset == null) break;
        expect(page.nextOffset - offset).toBe(4000); offset = page.nextOffset;
    }
    expect(pages.join('')).toBe(body); expect(pages.at(-1)).toContain('EXACT TAIL');
    for (const [a, mesh, sid] of [[null, 'mesh', 'coord'], [attempt, 'mesh', 'foreign'], [{ ...attempt, meshId: 'foreign' }, 'mesh', 'coord'], [{ ...attempt, terminal: null }, 'mesh', 'coord']] as const) {
        expect((await recoverAttemptReport(db, a, mesh, sid, execute)).body).toBeNull();
    }
    expect(execute).not.toHaveBeenCalled();
});

it('captures through the relay at commit, then a new relay instance rehydrates without reading a later tail', async () => {
    const { db, attempt } = evidence(); attempt.attemptId = 'plain:coord:1';
    const store = new SqliteAssistantRelayStore(db);
    const body = 'Exact captured public report. '.repeat(300) + 'original final tail';
    let handler: (event: any) => void = () => {};
    const tail = vi.fn(async () => body);
    const ports = { subscribe: (h: typeof handler) => { handler = h; return () => {} }, coordinatorMeshOf: () => 'mesh',
        projectSlug: () => 'p', readCoordinatorTail: tail, meshWork: () => null, hasAssistant: () => true,
        assistantSessionId: () => null, isAssistantReady: () => false, submit: async () => ({ kind: 'delivered' as const }),
        inputLog: new AssistantInputLog(), store,
        rehydrateAttemptReport: async (mesh: string, sid: string, id: string) =>
            (await recoverAttemptReport(db, id === attempt.attemptId ? attempt : null, mesh, sid, vi.fn(async () => ({ success: false })))).body };
    const relay = new AssistantRelay(ports); relay.start(); relay.openThread('mesh');
    handler({ kind: 'turn', phase: 'committed', sessionId: 'coord', attemptId: attempt.attemptId, generation: 1, at: Date.now(), outcome: 'completed' });
    await Promise.resolve(); await Promise.resolve();
    expect(store.readAttemptBody(attempt.attemptId, 'mesh', 'coord', Date.now())).toBe(body);
    relay.stop(); tail.mockImplementation(async () => 'unrelated later tail');
    const restarted = new AssistantRelay({ ...ports, store: new SqliteAssistantRelayStore(db) }); restarted.start();
    const events = await restarted.pullPending(null); restarted.stop();
    expect(events.map(e => e.text).join('\n')).toContain(body.slice(0, 200));
    expect(events.map(e => e.text).join('\n')).not.toContain('unrelated later tail');
    expect(tail).toHaveBeenCalledTimes(1);
    expect((await recoverAttemptReport(db, attempt, 'mesh', 'coord', vi.fn())).body).toBe(body);
});
it('refuses ambiguous native matches instead of choosing the first message', async () => {
    const { db, attempt, add } = evidence(); add('terminal', { evidence: { kind: 'turn_end', messageAt: 190 } });
    const execute = vi.fn(async () => ({ success: true, messages: [
        { role: 'assistant', timestamp: 190, content: 'first' }, { role: 'assistant', timestamp: 190, content: 'second' },
    ], hasMore: false }));
    expect((await recoverAttemptReport(db, attempt, 'mesh', 'coord', execute)).body).toBeNull();
});
