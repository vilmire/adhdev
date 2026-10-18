import { reportMessageId } from '../../src/assistant/project-views.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ensureAssistantRelaySchema } from '../../src/mesh/mesh-runtime-store-schema.js';
import { ensureTurnLedgerSchema } from '../../src/mesh/turn-ledger/schema.js';
import { SqliteAssistantRelayStore } from '../../src/assistant/assistant-relay-sqlite-store.js';
import { InMemoryAssistantRelayStore } from '../../src/assistant/assistant-relay-store.js';
import { AssistantRelay } from '../../src/assistant/assistant-relay.js';
import { AssistantInputLog } from '../../src/assistant/assistant-input-log.js';
import { renderNativeReplies } from '../../src/assistant/assistant-native-window.js';
import { collectCoordinatorReplies } from '../../src/assistant/assistant-relay-audit.js';

const NOW = Date.parse('2026-10-17T07:00:00Z');
const DAY = 24 * 60 * 60_000;
const databases: Database.Database[] = [];
const directories: string[] = [];
afterEach(() => {
    for (const db of databases.splice(0)) if (db.open) db.close();
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
});
function database(path = ':memory:') {
    const db = new Database(path); databases.push(db); ensureAssistantRelaySchema(db); ensureTurnLedgerSchema(db); return db;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const manifest = (attemptId = 'plain:a', messageAt = NOW - 6_000, text = 'shown') => ({
    attemptId, coordinatorSessionId: 'coord', replies: [{ messageAt, contentHash: hash(text) }],
});
function commit(store: any, attemptId = 'plain:a', sessionId = 'coord') {
    store.recordCommitted({ attemptId, meshId: 'mesh', coordinatorSessionId: sessionId, committedAt: NOW - 3_000, kind: 'relay', outcome: 'completed' });
}
function attempt(db: Database.Database, id = 'plain:a') {
    db.prepare(`INSERT INTO turn_attempts(attempt_id,scope,session_id,owner_daemon_id,state,terminal_outcome,accepted_at,terminal_at,created_at,updated_at)
        VALUES(?,'plain','coord','host','completed','completed',?,?,?,?)`).run(id, NOW - 10_000, NOW - 3_000, NOW - 10_000, NOW - 3_000);
}
function relay(store: any, report: any, audit: any = async () => []) {
    return new AssistantRelay({ subscribe: () => () => {}, coordinatorMeshOf: () => 'mesh', projectSlug: () => 'p',
        readCoordinatorTail: async () => { throw new Error('forbidden tail'); }, rehydrateAttemptReport: async () => report,
        auditCoordinatorReplies: audit, canReadCoordinatorReply: async () => true, meshWork: () => null, hasAssistant: () => true, assistantSessionId: () => null,
        isAssistantReady: () => false, submit: async () => ({ kind: 'delivered' }), inputLog: new AssistantInputLog(), store });
}
async function micro() { for (let n = 0; n < 20; n++) await Promise.resolve(); }

describe('delivered native coverage persistence', () => {
    it('migrates an old schema without backfilling captured bodies as delivered hashes', () => {
        const db = new Database(':memory:'); databases.push(db);
        db.exec(`CREATE TABLE assistant_attempt_bodies(attempt_id TEXT PRIMARY KEY,mesh_id TEXT NOT NULL,coordinator_session_id TEXT NOT NULL,captured_at INTEGER NOT NULL,body TEXT NOT NULL);
            INSERT INTO assistant_attempt_bodies VALUES('old','mesh','coord',${NOW},'undisplayed captured tail');
            CREATE TABLE assistant_relays(attempt_id TEXT PRIMARY KEY,mesh_id TEXT NOT NULL,coordinator_session_id TEXT NOT NULL,committed_at INTEGER NOT NULL,delivered_at INTEGER,kind TEXT NOT NULL,outcome TEXT NOT NULL);`);
        ensureAssistantRelaySchema(db); ensureAssistantRelaySchema(db);
        expect((new SqliteAssistantRelayStore(db) as any).listDeliveredCoverage(NOW)).toEqual([]);
        expect(db.prepare('SELECT body FROM assistant_attempt_bodies').get()).toEqual({ body: 'undisplayed captured tail' });
        expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_assistant_relay_coverage_age'").get()).toBeTruthy();
    });

    it.each(['memory', 'sqlite'])('validates settlement/session ownership and never overwrites delivered coverage (%s)', kind => {
        const store: any = kind === 'memory' ? new InMemoryAssistantRelayStore() : new SqliteAssistantRelayStore(database());
        commit(store);
        store.markDelivered(['plain:a'], NOW, ['plain:a'], [{ ...manifest(), coordinatorSessionId: 'foreign' }, manifest('foreign')]);
        expect(store.listDeliveredCoverage(NOW)).toEqual([]);
        store.markDelivered(['plain:a'], NOW + 1, ['plain:a'], [manifest()]);
        expect(store.listDeliveredCoverage(NOW + 1)).toEqual([]); // already settled: cannot invent later delivery
        commit(store, 'plain:b');
        store.markDelivered(['plain:b'], NOW, ['plain:b'], [manifest('plain:b')]);
        expect(store.listDeliveredCoverage(NOW)).toEqual([{ ...manifest('plain:b'), renderedAt: NOW }]);
        const read = store.listDeliveredCoverage(NOW); read[0].replies[0].contentHash = hash('tampered read');
        expect(store.listDeliveredCoverage(NOW)[0].replies[0].contentHash).toBe(hash('shown'));
        store.markDelivered(['plain:b'], NOW + 1, ['plain:b'], [manifest('plain:b', NOW - 5_000, 'later capture')]);
        store.captureAttemptBody('plain:b', 'mesh', 'coord', 'later undisplayed capture', NOW + 1, 'changed-ref');
        expect(store.listDeliveredCoverage(NOW + 1)[0].replies[0].contentHash).toBe(hash('shown'));
    });

    it.each(['memory', 'sqlite'])('stores only allow-listed hashes and respects the byte budget (%s)', kind => {
        const db = kind === 'sqlite' ? database() : null;
        const store: any = db ? new SqliteAssistantRelayStore(db) : new InMemoryAssistantRelayStore();
        const coordinatorSessionId = 'c'.repeat(512);
        const manifests = Array.from({ length: 2_000 }, (_, i) => ({ attemptId: `plain:${i}`.padEnd(512, 'x'), coordinatorSessionId,
            text: 'PRIVATE EXTRA MUST NOT PERSIST', replies: [
                { messageAt: NOW - 6_000, contentHash: hash(`first:${i}`), text: 'PRIVATE EXTRA MUST NOT PERSIST' },
                { messageAt: NOW - 5_000, contentHash: hash(`last:${i}`) },
            ],
        }));
        for (const m of manifests) commit(store, m.attemptId, coordinatorSessionId);
        store.markDelivered(manifests.map(m => m.attemptId), NOW, manifests.map(m => m.attemptId), manifests);
        const retained = store.listDeliveredCoverage(NOW);
        expect(retained.length).toBeGreaterThan(0); expect(retained.length).toBeLessThan(manifests.length);
        expect(retained.reduce((n: number, m: any) => n + Buffer.byteLength(JSON.stringify(m.replies))
            + Buffer.byteLength(m.attemptId) + Buffer.byteLength(m.coordinatorSessionId) + 32, 0)).toBeLessThanOrEqual(2 * 1_048_576);
        expect(JSON.stringify(retained)).not.toContain('PRIVATE EXTRA');
        if (db) expect(JSON.stringify(db.prepare('SELECT * FROM assistant_relay_coverage').all())).not.toContain('PRIVATE EXTRA');
    });

    it.each(['memory', 'sqlite'])('bounds reply count by pruning complete manifests and expires them (%s)', kind => {
        const store: any = kind === 'memory' ? new InMemoryAssistantRelayStore() : new SqliteAssistantRelayStore(database());
        const manifests = Array.from({ length: 2_049 }, (_, i) => ({ ...manifest(`plain:${i}`), replies: [
            { messageAt: NOW - 6_000, contentHash: hash(`first:${i}`) }, { messageAt: NOW - 5_000, contentHash: hash(`last:${i}`) },
        ] }));
        for (const m of manifests) commit(store, m.attemptId);
        store.markDelivered(manifests.map(m => m.attemptId), NOW, manifests.map(m => m.attemptId), manifests);
        const retained = store.listDeliveredCoverage(NOW);
        expect(retained).toHaveLength(2_048);
        expect(retained.every((m: any) => m.replies.length === 2)).toBe(true);
        expect(store.listDeliveredCoverage(NOW + DAY)).toEqual([]);
    });

    it('rolls back relay settlement when its coverage write fails', () => {
        const db = database(); const store = new SqliteAssistantRelayStore(db); commit(store);
        db.exec("CREATE TRIGGER reject_coverage BEFORE INSERT ON assistant_relay_coverage BEGIN SELECT RAISE(ABORT,'focused coverage failure'); END");
        expect(() => (store as any).markDelivered(['plain:a'], NOW, ['plain:a'], [manifest()])).toThrow('focused coverage failure');
        expect(store.listUndelivered()).toHaveLength(1);
        expect((store as any).listDeliveredCoverage(NOW)).toEqual([]);
    });

    it('resumes a partially delivered native report after SQLite reopen and covers it only after the last page', async () => {
        vi.useFakeTimers(); vi.setSystemTime(NOW);
        const dir = mkdtempSync(join(tmpdir(), 'relay-delivered-coverage-')); directories.push(dir);
        const path = join(dir, 'runtime.db');
        const db = database(path); const store = new SqliteAssistantRelayStore(db); commit(store); attempt(db);
        const bubbles = [{ at: NOW - 6_000, text: 'shown', chars: 5 }, { at: NOW - 5_000, text: 'x'.repeat(4_200) + 'UNDISPLAYED', chars: 4_211 }];
        const report = { body: renderNativeReplies(bubbles), completeness: 'final_native', parts: bubbles.map(({ at, chars }) => ({ at, chars })) };
        const first = relay(store, report); first.start();
        const text = (await first.pullPending(null)).map(x => x.text).join('\n');
        expect(text).toContain('shown'); expect(text).not.toContain('UNDISPLAYED');
        first.stop(); db.close();
        const reopened = database(path); const nextStore = new SqliteAssistantRelayStore(reopened);
        const stored = (nextStore as any).listDeliveredCoverage(NOW);
        expect(stored).toEqual([]);
        expect(JSON.stringify(reopened.prepare('SELECT * FROM assistant_relay_coverage').all())).not.toContain('shown');
        const audit = (sinceMs: number) => collectCoordinatorReplies({ db: reopened, sinceMs, now: NOW + 60_000,
            coordinatorSessions: [{ sessionId: 'coord', cliType: 'codex-cli' }], execute: async () => ({ success: true, coverage: 'full',
                debugReadChat: { provider: 'codex-cli' }, messageSource: { selected: 'native-history' },
                messages: bubbles.map(b => ({ role: 'assistant', kind: 'standard', bubbleState: 'final', timestamp: b.at, content: b.text })),
            }),
        });
        const restarted = relay(nextStore, report, audit); restarted.start();
        const remaining = (await restarted.pullPending(null)).map(x => x.text).join('\n');
        expect(remaining).toContain('UNDISPLAYED');
        expect(remaining).not.toContain('\nshown\n');
        expect(nextStore.listUndelivered()).toEqual([]);
        expect(nextStore.listDeliveredCoverage(NOW)[0].replies).toHaveLength(2);
        restarted.tick(NOW + 60_000); await micro();
        const gaps = (await restarted.pullPending(null)).filter(x => x.text.includes('[ADHDev relay gap]'));
        expect(gaps).toHaveLength(0);
        restarted.stop();
    });

    it.each(['legacy', 'capacity-pruned'])('keeps %s delivered coverage uncertain without suppressing a known unrendered attempt', async kind => {
        const db = database(); const store = new SqliteAssistantRelayStore(db);
        for (const id of ['plain:a', 'plain:b']) { commit(store, id); attempt(db, id); }
        store.markDelivered(['plain:a'], NOW - 10, ['plain:a'], kind === 'legacy' ? [] : [manifest()]);
        if (kind === 'capacity-pruned') {
            const empty = Array.from({ length: 4_096 }, (_, i) => ({ ...manifest(`extra:${i}`), replies: [] }));
            for (const m of empty) commit(store, m.attemptId);
            store.markDelivered(empty.map(m => m.attemptId), NOW, empty.map(m => m.attemptId), empty);
            expect(store.listDeliveredCoverage(NOW)).toHaveLength(4_096);
            expect(store.listDeliveredCoverage(NOW).some(m => m.attemptId === 'plain:a')).toBe(false);
        }
        store.markDelivered(['plain:b'], NOW, []);
        db.prepare("UPDATE turn_attempts SET accepted_at=?,terminal_at=? WHERE attempt_id='plain:b'").run(NOW - 2_000, NOW - 1_000);
        db.prepare("UPDATE assistant_relays SET committed_at=? WHERE attempt_id='plain:b'").run(NOW - 1_000);
        const replies = await collectCoordinatorReplies({ db, now: NOW + 60_000, sinceMs: NOW,
            coordinatorSessions: [{ sessionId: 'coord', cliType: 'codex-cli' }], execute: async () => ({ success: true, coverage: 'full',
                debugReadChat: { provider: 'codex-cli' }, messageSource: { selected: 'native-history' }, messages: [
                    { role: 'assistant', kind: 'standard', bubbleState: 'final', timestamp: NOW - 6_000, content: 'legacy coverage unknown' },
                    { role: 'assistant', kind: 'standard', bubbleState: 'final', timestamp: NOW - 1_500, content: 'known unrendered' },
                ],
            }),
        });
        expect(replies.complete).toBe(false);
        expect(replies.map(r => r.attemptId)).toEqual(['plain:b']);
    });

    it('rejects corrupt persisted manifests instead of loading false coverage', () => {
        const db = database(); const store = new SqliteAssistantRelayStore(db); commit(store);
        store.markDelivered(['plain:a'], NOW, ['plain:a'], [manifest()]);
        db.prepare('UPDATE assistant_relay_coverage SET replies_json=?').run('not-json');
        expect(store.listDeliveredCoverage(NOW)).toEqual([]);
        expect(db.prepare('SELECT count(*) AS n FROM assistant_relay_coverage').get()).toEqual({ n: 0 });
    });

    it('keeps memory and SQLite manifest ordering consistent', () => {
        const stores = [new InMemoryAssistantRelayStore(), new SqliteAssistantRelayStore(database())];
        for (const store of stores) for (const id of ['plain:a', 'plain:A', 'plain:á', 'plain:😀']) {
            commit(store, id); store.markDelivered([id], NOW, [id], [manifest(id)]);
        }
        expect(stores[0].listDeliveredCoverage(NOW)).toEqual(stores[1].listDeliveredCoverage(NOW));
    });
});

it('persists content-free read and notification receipts across SQLite reopen and expires them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-receipts-')); directories.push(dir);
    const path = join(dir, 'receipts.db');
    const db = database(path); const store = new SqliteAssistantRelayStore(db);
    store.writeReceipt('a'.repeat(64), 'full', NOW); db.close();
    const reopened = database(path); const restored = new SqliteAssistantRelayStore(reopened);
    expect(restored.readReceipt('a'.repeat(64), NOW + 1)).toBe('full');
    expect(restored.readReceipt('a'.repeat(64), NOW + 8 * DAY)).toBeNull();
});
