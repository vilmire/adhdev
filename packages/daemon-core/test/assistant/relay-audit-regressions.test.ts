import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { collectCoordinatorReplies } from '../../src/assistant/assistant-relay-audit.js';
import { ensureAssistantRelaySchema } from '../../src/mesh/mesh-runtime-store-schema.js';
import { ensureTurnLedgerSchema } from '../../src/mesh/turn-ledger/schema.js';

const registry = vi.hoisted(() => ({ sessions: ['coord'] }));
vi.mock('../../src/mesh/coordinator-registry.js', () => ({
    listCoordinatorsForMesh: () => registry.sessions.map(sessionId => ({ sessionId, meshId: 'mesh', cliType: 'codex-cli' })),
    getCoordinatorForSession: (sessionId: string) => registry.sessions.includes(sessionId) ? { sessionId, meshId: 'mesh', cliType: 'codex-cli' } : undefined,
}));
vi.mock('../../src/config/mesh-config.js', () => ({ listMeshesReadOnly: () => [{ id: 'mesh' }] }));

const NOW = Date.parse('2026-10-17T06:00:00Z');
let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); ensureAssistantRelaySchema(db); ensureTurnLedgerSchema(db); registry.sessions = ['coord']; });
afterEach(() => db.close());
function attempt(sessionId = 'coord', state = 'running', terminalAt: number | null = null) {
    db.prepare(`INSERT INTO turn_attempts(attempt_id,scope,session_id,owner_daemon_id,state,accepted_at,terminal_at,terminal_reason,terminal_source,created_at,updated_at)
        VALUES(?,'plain',?,'host',?,?,?,?,?,?,?)`).run(sessionId, sessionId, state, NOW - 30 * 60_000, terminalAt,
        terminalAt ? 'session_error' : null, terminalAt ? 'session_registry' : null, NOW - 30 * 60_000, NOW);
}
const read = (timestamp = NOW - 5 * 60_000) => ({ success: true, coverage: 'full', messageSource: { selected: 'native-history' },
    debugReadChat: { provider: 'codex-cli' }, messages: [{ role: 'assistant', kind: 'standard', bubbleState: 'final', timestamp, content: 'native reply' }] });

describe('relay audit review regressions', () => {
    it('discovers a registered coordinator with no attempt and never reads a private plain session', async () => {
        attempt('private-owner-chat', 'completed', NOW - 60_000);
        const execute = vi.fn(async () => read());
        const replies = await collectCoordinatorReplies({ db, execute, sinceMs: NOW - 60_000, now: NOW });
        expect(execute.mock.calls).toHaveLength(1);
        expect(execute).toHaveBeenCalledWith('read_chat', { targetSessionId: 'coord', tailLimit: 200 });
        expect(replies).toEqual([expect.objectContaining({ sessionId: 'coord', attemptId: null })]);
    });

    it('revisits an old open-attempt reply after restart closure despite the advanced cursor', async () => {
        attempt();
        const first = await collectCoordinatorReplies({ db, execute: async () => read(), sinceMs: NOW - 6 * 60_000, now: NOW });
        expect(first[0]?.attemptOpen).toBe(true);
        db.prepare("UPDATE turn_attempts SET state='failed',terminal_at=?,terminal_reason='session_error',terminal_source='session_registry' WHERE attempt_id='coord'").run(NOW + 10_000);
        const second = await collectCoordinatorReplies({ db, execute: async () => read(), sinceMs: NOW, now: NOW + 60_000 });
        expect(second).toEqual([expect.objectContaining({ attemptId: 'coord', restartClosed: true })]);
        expect(second[0]?.attemptOpen).not.toBe(true);
    });

    it('includes a pre-start reply in a recently restart-closed attempt', async () => {
        attempt('coord', 'failed', NOW - 60_000);
        const replies = await collectCoordinatorReplies({ db, execute: async () => read(), sinceMs: NOW, now: NOW });
        expect(replies).toEqual([expect.objectContaining({ restartClosed: true })]);
    });

    it('defers a just-closed attempt during the normal relay quiet window', async () => {
        attempt('coord', 'completed', NOW - 1_000);
        const replies = await collectCoordinatorReplies({ db, execute: async () => read(), sinceMs: NOW - 60_000, now: NOW });
        expect(replies[0]?.attemptOpen).toBe(true);
    });

    it('surfaces read failures rather than committing a successful empty audit', async () => {
        attempt('coord', 'completed', NOW - 60_000);
        await expect(collectCoordinatorReplies({ db, execute: async () => { throw new Error('offline'); }, sinceMs: NOW - 60_000, now: NOW })).rejects.toThrow();
    });

    it('keeps healthy sessions observable during a partial audit failure', async () => {
        registry.sessions = ['coord', 'offline'];
        const replies = await collectCoordinatorReplies({ db, now: NOW, sinceMs: NOW,
            execute: async (_cmd, args) => args.targetSessionId === 'offline' ? { success: false } : read(),
        });
        expect(replies.complete).toBe(false);
        expect(replies.map(r => r.sessionId)).toEqual(['coord']);
    });

    it('keeps Grok clock uncertainty partial without reading or claiming an empty native history', async () => {
        const execute = vi.fn(async () => { throw new Error('Grok clocks are not attempt evidence'); });
        const replies = await collectCoordinatorReplies({ db, execute, sinceMs: NOW, now: NOW,
            coordinatorSessions: [{ sessionId: 'grok', cliType: 'grok-cli' }],
        });
        expect(replies).toHaveLength(0);
        expect(replies.complete).toBe(false);
        expect(execute).not.toHaveBeenCalled();
    });
});
