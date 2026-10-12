import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { recoverAttemptReport } from '../../src/assistant/attempt-report-recovery.js';
import { AssistantRelay } from '../../src/assistant/assistant-relay.js';
import { InMemoryAssistantRelayStore } from '../../src/assistant/assistant-relay-store.js';
import { AssistantInputLog } from '../../src/assistant/assistant-input-log.js';
const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function evidence() {
    const db = new Database(':memory:'); dbs.push(db);
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
