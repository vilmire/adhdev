import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { commitLocalBridgeDelivery, ensureBridgeSchema, type BridgeEnvelope } from '../../src/mesh/worker-bridge.js';
import { afterBridgeCommit } from '../../src/mesh/worker-bridge-transaction.js';
const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
it('local receipt failure is retryable and rolls back evidence and post-commit effects', () => {
    const db = new Database(':memory:'); databases.push(db); ensureBridgeSchema(db);
    db.exec('CREATE TABLE synthetic_evidence(id TEXT PRIMARY KEY)');
    const envelope: BridgeEnvelope = { protocol: 1, kind: 'report', ownerDaemonId: 'owner', senderDaemonId: 'owner', senderCommit: 'b'.repeat(40), senderVersion: '1.0.82-b', meshId: 'mesh', nodeId: 'node', taskId: 'task', sessionId: 'session', attemptId: 'attempt', generation: 0, deliveryId: 'synthetic-local-receipt', reportedAtMs: Date.now(), payload: { report: { summary: 'Synthetic.' } } };
    let effects = 0;
    const apply = () => { db.prepare('INSERT INTO synthetic_evidence VALUES (?)').run('report'); afterBridgeCommit(db, () => { effects++; }); return { success: true }; };
    db.exec(`CREATE TRIGGER synthetic_failure BEFORE UPDATE OF receipt_json ON worker_bridge_delivery BEGIN SELECT RAISE(ABORT, 'disk failure'); END`);
    expect(commitLocalBridgeDelivery(db, envelope, apply)).toEqual({ success: false, error: 'storage_failed' });
    expect(db.prepare('SELECT * FROM synthetic_evidence').all()).toEqual([]); expect(effects).toBe(0);
    db.exec('DROP TRIGGER synthetic_failure');
    expect(commitLocalBridgeDelivery(db, envelope, apply)).toEqual({ success: true });
    expect(commitLocalBridgeDelivery(db, envelope, apply)).toEqual({ success: true });
    expect(db.prepare('SELECT * FROM synthetic_evidence').all()).toHaveLength(1); expect(effects).toBe(1);
});
it('a transient apply refusal cannot commit partially written evidence', () => {
    const db = new Database(':memory:'); databases.push(db); ensureBridgeSchema(db);
    db.exec('CREATE TABLE synthetic_evidence(id TEXT PRIMARY KEY)');
    const envelope = { protocol: 1, kind: 'progress', ownerDaemonId: 'owner', senderDaemonId: 'owner', senderCommit: 'b'.repeat(40), senderVersion: '1.0.82-b', meshId: 'mesh', nodeId: 'node', taskId: 'task', sessionId: 'session', attemptId: 'attempt', generation: 0, deliveryId: 'synthetic-progress-receipt', reportedAtMs: Date.now(), payload: { note: 'Synthetic.' } } as BridgeEnvelope;
    expect(commitLocalBridgeDelivery(db, envelope, () => { db.prepare('INSERT INTO synthetic_evidence VALUES (?)').run('progress'); return { success: false, error: 'storage_failed' }; })).toEqual({ success: false, error: 'storage_failed' });
    expect(db.prepare('SELECT * FROM synthetic_evidence').all()).toEqual([]);
});
