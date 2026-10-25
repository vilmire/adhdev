import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportMessageId } from '../../src/assistant/project-views.js';
import { pageHistoryRecords, buildHistoryMessageIdentity, historyBoundaryDigest } from '../../src/config/chat-history-tail.js';
import { collectCoordinatorReplies } from '../../src/assistant/assistant-relay-audit.js';
import { readNativeWindow } from '../../src/assistant/attempt-report-recovery.js';
import { NativeScanCheckpoints } from '../../src/assistant/native-scan-checkpoint.js';
import { ensureTurnLedgerSchema } from '../../src/mesh/turn-ledger/schema.js';
import { ensureAssistantRelaySchema } from '../../src/mesh/mesh-runtime-store-schema.js';
import { AssistantRelay } from '../../src/assistant/assistant-relay.js';
import { AssistantInputLog } from '../../src/assistant/assistant-input-log.js';
import { InMemoryAssistantRelayStore } from '../../src/assistant/assistant-relay-store.js';

vi.mock('../../src/mesh/coordinator-registry.js', () => ({ getCoordinatorForSession: () => ({ cliType: 'codex-cli' }) }));
const NOW = 1_790_000_000_000;
const sessions = [{ sessionId: 'coord', cliType: 'codex-cli', meshId: 'mesh' }];
const resources: Array<() => void> = [];
afterEach(() => { for (const f of resources.splice(0)) f(); vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture(file = ':memory:') {
    let db = new Database(file); ensureTurnLedgerSchema(db); ensureAssistantRelaySchema(db);
    db.prepare(`INSERT INTO turn_attempts(attempt_id,scope,session_id,owner_daemon_id,state,accepted_at,created_at,updated_at)
        VALUES('plain:open','plain','coord','host','generating',?,?,?)`).run(NOW - 800_000, NOW - 800_000, NOW);
    const rows = Array.from({ length: 650 }, (_, i) => ({ role: 'assistant', kind: 'standard', providerUnitKey: `row-${i}`,
        receivedAt: NOW - 700_000 + i * 1_000, content: `Synthetic final ${i}`, bubbleState: 'final' }));
    const markers = rows.slice(0, -1).map((row, i) => ({ nativeSessionId: 'native-session', turnId: `turn-${i}`, startedAt: row.receivedAt - 100,
        inputAt: row.receivedAt - 90, inputDigest: 'a'.repeat(64), receivedAt: row.receivedAt + 1, outcome: 'completed', summary: row.content }));
    const calls: any[] = [];
    let fail = false, source = 'native-session', badBoundary = false;
    const execute = async (cmd: string, args: any) => {
        calls.push({ cmd, ...args });
        if (fail) return { success: false };
        const page = cmd === 'read_chat' ? { messages: rows.slice(-100), hasMore: true }
            : pageHistoryRecords('codex-cli', rows as any, 0, 100, 0, undefined, args.excludeFromIdentity);
        return { success: true, agent: 'codex-cli', source: 'provider-native', providerSessionId: source, turnTerminalMarkers: markers,
            ...page, ...(badBoundary && args.excludeFromIdentity ? { boundaryResolved: false } : {}) };
    };
    const audit = (now = NOW, extra = {}) => collectCoordinatorReplies({ db, execute, sinceMs: 0, now, coordinatorSessions: sessions, ...extra });
    resources.push(() => { if (db.open) db.close(); });
    return { get db() { return db; }, rows, calls, markers, execute, audit, fail: (v: boolean) => { fail = v; },
        source: (v: string) => { source = v; }, badBoundary: () => { badBoundary = true; },
        reopen() { db.close(); db = new Database(file); } };
}

describe('rc29 verified partial native audit and durable bounded traversal', () => {
    it('returns individually closed turns from an incomplete >400-row window, never a whole-attempt report', async () => {
        const r = fixture(); const result = await r.audit();
        expect(result.complete).toBe(false); expect(result.length).toBeGreaterThan(0);
        expect(result.every(p => p.nativeTurnProof && p.attemptOpen && !p.attemptReportId)).toBe(true);
        expect(result.some(p => p.text === 'Synthetic final 648')).toBe(true);
        expect(result.some(p => p.text === 'Synthetic final 649')).toBe(false); // later turn has no terminal marker
        expect(r.db.prepare('SELECT state FROM turn_attempts').get()).toEqual({ state: 'generating' });
        const full = await readNativeWindow(r.execute, 'coord', NOW - 86_400_000, NOW);
        expect(full.complete).toBe(false);
    });
    it('resumes identity-anchored older pages across restart while serving appended tail, with metadata only', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'native-scan-rc29-')); resources.unshift(() => rmSync(dir, { recursive: true, force: true }));
        const r = fixture(join(dir, 'fixture.db'));
        await r.audit();
        const before: any = r.db.prepare('SELECT * FROM assistant_native_scan_checkpoints').get();
        expect(before).toBeDefined(); expect(before.payload).not.toContain('Synthetic final');
        const boundary = JSON.parse(before.payload).boundary;
        r.reopen();
        r.rows.push({ ...r.rows.at(-1)!, providerUnitKey: 'new-tail', receivedAt: NOW + 1, content: 'Later active native turn' });
        r.calls.length = 0; const result = await r.audit(NOW + 2);
        expect(result.complete).toBe(false); expect(r.calls.some(c => c.excludeFromIdentity === boundary)).toBe(true);
        expect(r.calls.filter(c => c.cmd === 'chat_history')).toHaveLength(4);
        expect(result.some(p => p.text === 'Synthetic final 0')).toBe(true);
        expect(result.some(p => p.text === 'Later active native turn')).toBe(false);
    });
    it.each(['boundary', 'generation', 'source', 'ownership'])('invalidates %s drift without promoting a window', async defect => {
        const r = fixture(); await r.audit();
        if (defect === 'boundary') r.badBoundary();
        if (defect === 'generation') r.db.prepare('UPDATE turn_attempts SET generation=1').run();
        if (defect === 'source') r.source('other-session');
        if (defect === 'source') { await expect(r.audit(NOW + 1)).rejects.toThrow('coordinator native audit unavailable'); return; }
        const result = await r.audit(NOW + 1, defect === 'ownership' ? { isAuthorized: () => false } : {});
        expect(result.complete).toBe(false);
        expect(result.every(p => !p.attemptReportId)).toBe(true);
        if (defect === 'source') expect(result).toHaveLength(0);
    });
    it('keeps healthy partial finals when another coordinator is offline; wholly unavailable still errors', async () => {
        const r = fixture();
        const result = await collectCoordinatorReplies({ db: r.db, now: NOW, sinceMs: 0, coordinatorSessions: [...sessions, { ...sessions[0]!, sessionId: 'offline' }],
            execute: (cmd, args) => args.targetSessionId === 'offline' ? Promise.resolve({ success: false }) : r.execute(cmd, args) });
        expect(result.complete).toBe(false); expect(result.length).toBeGreaterThan(0);
        r.fail(true); await expect(r.audit()).rejects.toThrow('coordinator native audit unavailable');
    });
    it('rejects unresolved history identity fallback, and resets malformed/expired checkpoint versions', () => {
        const r = fixture(); const page = pageHistoryRecords('codex-cli', r.rows as any, 0, 100, 0, undefined, 'unit:missing');
        expect(page.boundaryResolved).toBe(false);
        const checkpoints = new NativeScanCheckpoints(r.db); const first = r.rows[100]!;
        const value = { version: 1 as const, sessionId: 'coord', scope: 'scope', provenance: 'native', lower: NOW - 800_000, upper: NOW,
            boundary: buildHistoryMessageIdentity(first as any), digest: historyBoundaryDigest(first as any), boundaryAt: first.receivedAt, lastNativeTurnId: 'turn-100', expiresAt: NOW + 10 };
        checkpoints.save(value); expect(checkpoints.load('coord', 'scope', NOW)).toEqual(value);
        expect(checkpoints.load('coord', 'scope', NOW + 11)).toBeNull();
        r.db.prepare('INSERT INTO assistant_native_scan_checkpoints VALUES(?,?,?,?)').run('coord', 99, NOW + 100, '{"version":99}');
        expect(checkpoints.load('coord', 'scope', NOW)).toBeNull();
    });
    it('rejects a generation or authorization change during the asynchronous scan', async () => {
        const r = fixture(); let changed = false;
        const result = await collectCoordinatorReplies({ db: r.db, now: NOW, sinceMs: 0, coordinatorSessions: sessions,
            execute: async (cmd, args) => { const result = await r.execute(cmd, args); if (!changed) { changed = true; r.db.prepare('UPDATE turn_attempts SET generation=1').run(); } return result; } });
        expect(result).toHaveLength(0); expect(result.complete).toBe(false);
        expect(r.db.prepare('SELECT COUNT(*) AS count FROM assistant_native_scan_checkpoints').get()).toEqual({ count: 0 });
    });
    it('does not certify reordered continuation pages as whole-window coverage', async () => {
        const r = fixture(); const checkpoints = new NativeScanCheckpoints(r.db);
        const result = await readNativeWindow(async (cmd, args) => {
            const page = await r.execute(cmd, args);
            return args.excludeFromIdentity ? { ...page, messages: [...(page as any).messages].reverse(), hasMore: false } : page;
        }, 'coord', NOW - 86_400_000, NOW, { checkpoints, scope: 'scope' });
        expect(result.complete).toBe(false);
        expect(r.db.prepare('SELECT COUNT(*) AS count FROM assistant_native_scan_checkpoints').get()).toEqual({ count: 0 });
    });
    it('caps durable metadata and rejects malformed content without storing bodies', () => {
        const r = fixture(); const checkpoints = new NativeScanCheckpoints(r.db); const row = r.rows[100]!;
        for (let i = 0; i < 140; i++) checkpoints.save({ version: 1, sessionId: `session-${i}`, scope: 'scope', provenance: 'native',
            lower: NOW - 800_000, upper: NOW, boundary: buildHistoryMessageIdentity(row as any), digest: historyBoundaryDigest(row as any),
            boundaryAt: row.receivedAt, lastNativeTurnId: 'native-turn', expiresAt: NOW + 1000 });
        expect(r.db.prepare('SELECT COUNT(*) AS count FROM assistant_native_scan_checkpoints').get()).toEqual({ count: 128 });
        expect(JSON.stringify(r.db.prepare('SELECT payload FROM assistant_native_scan_checkpoints').all())).not.toContain('Synthetic final');
    });
    it('surfaces a proved final inside a stale open attempt once; unproved/new active replies stay suppressed', async () => {
        vi.useFakeTimers(); vi.setSystemTime(NOW);
        const r = fixture(); const observed = await r.audit();
        const old = observed.find(p => p.text === 'Synthetic final 648')!;
        const submits: string[] = []; const submittedIds: string[] = [];
        let audited = [old, { ...old, messageId: 'unproved', text: 'Unproved active reply', nativeTurnProof: undefined }];
        const relay = new AssistantRelay({ subscribe: () => () => {}, coordinatorMeshOf: () => 'mesh', projectSlug: () => 'synthetic',
            auditCoordinatorReplies: async () => Object.assign(audited, { complete: false }),
            canReadCoordinatorReply: async () => true, meshWork: () => null, hasAssistant: () => true, assistantSessionId: () => 'assistant', isAssistantReady: () => true,
            submit: async (_sid, input) => { submits.push(input.text); submittedIds.push(input.messageId); return { kind: 'delivered' }; }, inputLog: new AssistantInputLog(), store: new InMemoryAssistantRelayStore() });
        relay.start(); relay.openThread('mesh'); resources.unshift(() => relay.stop());
        relay.tick(); await vi.advanceTimersByTimeAsync(10); await relay.idle();
        expect(submits).toHaveLength(1); expect(submits[0]).not.toContain('Unproved active reply');
        relay.tick(NOW + 60_000); await vi.advanceTimersByTimeAsync(10); await relay.idle(); expect(submits).toHaveLength(1);
        const nextAt = old.messageAt + 2_000;
        const nextId = reportMessageId({ role: 'assistant', kind: 'standard', receivedAt: nextAt, content: old.text });
        audited = [{ ...old, messageAt: nextAt, messageId: nextId, nativeTurnProof: { ...old.nativeTurnProof!,
            turnId: 'another-native-turn', messageId: nextId, startedAt: nextAt - 10, endedAt: nextAt + 1 } }];
        relay.tick(NOW + 120_000); await vi.advanceTimersByTimeAsync(10); await relay.idle();
        expect(submits).toHaveLength(2); expect(new Set(submittedIds).size).toBe(2);
        expect(r.db.prepare('SELECT state FROM turn_attempts').get()).toEqual({ state: 'generating' });
    });
});
