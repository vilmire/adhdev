import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { TurnStore } from '../../src/mesh/turn-ledger/store.js';
import { ensureAssistantRelaySchema } from '../../src/mesh/mesh-runtime-store-schema.js';
import { SqliteAssistantRelayStore } from '../../src/assistant/assistant-relay-sqlite-store.js';
import {
    clearFollowerWakeRateLimitForTest,
    FOLLOWER_COORDINATOR_WAKE_EVENT_KIND,
    rebuildFollowerWakeRateLimitFromStore,
    reserveFollowerWakeSlot,
    settleFollowerWakeReservation,
} from '../../src/commands/high-family/assistant-follower-wake-quota.js';

const meshId = 'mesh_quota_test';
const sender = 'daemon_mach_quota_test_00001';
const t0 = Date.parse('2026-10-22T00:00:00Z');
const future = t0 + 30 * 24 * 60 * 60_000;
const originalConfigDir = process.env.ADHDEV_CONFIG_DIR;
let configDir: string;
const db = () => MeshRuntimeStore.getInstance().db;
const snapshot = () => db().prepare('SELECT * FROM turn_events ORDER BY event_id').all();
const bounds = () => db().prepare('SELECT * FROM assistant_follower_wake_audit_bounds ORDER BY event_id').all();

function restart(at: number): void {
    clearFollowerWakeRateLimitForTest();
    MeshRuntimeStore.resetForTests();
    rebuildFollowerWakeRateLimitFromStore(at);
}
function seedAudit(eventId: string, at: number, wakeId = eventId, wakeAt = at): void {
    new TurnStore(db()).insertEvent({
        eventId, meshId, sessionId: 'coordinator', kind: FOLLOWER_COORDINATOR_WAKE_EVENT_KIND,
        source: 'mesh_event', verdict: 'recorded', publishState: 'none',
        payload: { senderDaemonId: sender, wakeId, wakeAtMs: wakeAt, atMs: at },
        atMs: at, recordedAt: at + 123,
    });
}
function seedReceipt(at: number, wakeId = 'wake', receiptKey = 'receipt'): void {
    db().prepare('INSERT INTO assistant_relay_receipts (receipt_key, value, at_ms, kind) VALUES (?, ?, ?, ?)')
        .run(receiptKey, JSON.stringify({ meshId, sender, wakeId, atMs: at, status: 'charged' }), at, 'follower_wake_quota');
}
function seedBound(eventId: string, at: number, value?: string): void {
    db().prepare('INSERT INTO assistant_follower_wake_audit_bounds (event_id, at_ms, value) VALUES (?, ?, ?)')
        .run(eventId, at, value ?? JSON.stringify({
            targetKind: 'audit', targetId: eventId, wakeId: eventId,
            originalAtMs: at, originalRowAtMs: at, firstNormalizedAtMs: at, conflict: false,
        }));
}
function charge(at: number): void {
    const slot = reserveFollowerWakeSlot(meshId, sender, at);
    expect(slot.ok).toBe(true);
    if (slot.ok) settleFollowerWakeReservation(slot.reservation, at, { charge: true });
}
beforeEach(() => {
    MeshRuntimeStore.resetForTests();
    clearFollowerWakeRateLimitForTest();
    configDir = mkdtempSync(join(tmpdir(), 'follower-wake-quota-'));
    process.env.ADHDEV_CONFIG_DIR = configDir;
    ensureAssistantRelaySchema(db());
});
afterEach(() => {
    clearFollowerWakeRateLimitForTest();
    MeshRuntimeStore.resetForTests();
    if (originalConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = originalConfigDir;
    rmSync(configDir, { recursive: true, force: true });
});

describe('follower-wake quota-owned audit bounds', () => {
    it('keeps complete ledger rows immutable and expires two future audit charges across real store restarts', () => {
        seedAudit('future-1', future);
        seedAudit('future-2', future);
        seedAudit('past', t0 - 16 * 60_000);
        const before = snapshot();
        rebuildFollowerWakeRateLimitFromStore(t0);
        expect(snapshot()).toEqual(before);
        expect(reserveFollowerWakeSlot(meshId, sender, t0)).toMatchObject({ ok: false, reason: 'cooldown' });
        const firstBounds = bounds();
        restart(t0 + 61_000);
        expect(snapshot()).toEqual(before);
        expect(bounds()).toEqual(firstBounds);
        expect(reserveFollowerWakeSlot(meshId, sender, t0 + 61_000)).toMatchObject({ ok: false, reason: 'window_limit' });
        restart(t0 + 16 * 60_000);
        expect(snapshot()).toEqual(before);
        charge(t0 + 16 * 60_000);
        charge(t0 + 17 * 60_000);
        expect(reserveFollowerWakeSlot(meshId, sender, t0 + 18 * 60_000)).toMatchObject({ ok: false, reason: 'window_limit' });
    });
    it('reconciles one receipt and audit into one charge through two backward clock steps without losing provenance', () => {
        seedReceipt(future);
        seedAudit('audit', future, 'wake');
        const before = snapshot();
        rebuildFollowerWakeRateLimitFromStore(t0);
        restart(t0 - 300_000);
        restart(t0 - 600_000);
        const bound = db().prepare('SELECT at_ms, value FROM assistant_follower_wake_audit_bounds').get() as { at_ms: number; value: string };
        expect(bound.at_ms).toBe(t0 - 600_000);
        expect(JSON.parse(bound.value)).toMatchObject({ originalAtMs: future, firstNormalizedAtMs: t0, conflict: false });
        const stableBounds = bounds();
        restart(t0 - 539_000);
        expect(bounds()).toEqual(stableBounds);
        expect(snapshot()).toEqual(before);
        charge(t0 - 539_000);
        expect(reserveFollowerWakeSlot(meshId, sender, t0 - 478_000)).toMatchObject({ ok: false, reason: 'window_limit' });
    });
    it('keeps conflicting and duplicate wakeId charges separate after restart', () => {
        seedReceipt(future);
        seedAudit('conflicting-audit', future, 'wake', future + 60_000);
        seedAudit('duplicate-audit', future, 'wake');
        const before = snapshot();
        rebuildFollowerWakeRateLimitFromStore(t0);
        restart(t0 + 61_000);
        expect(snapshot()).toEqual(before);
        const bound = db().prepare('SELECT value FROM assistant_follower_wake_audit_bounds WHERE event_id = ?')
            .get('conflicting-audit') as { value: string };
        expect(JSON.parse(bound.value)).toMatchObject({ originalAtMs: future + 60_000, firstNormalizedAtMs: t0, conflict: true });
        expect(reserveFollowerWakeSlot(meshId, sender, t0 + 61_000)).toMatchObject({ ok: false, reason: 'window_limit' });
    });
    it('does not revive immutable future audits when relay receipt retention prunes normalization rows', () => {
        seedReceipt(future);
        seedAudit('audit', future, 'wake');
        const before = snapshot();
        rebuildFollowerWakeRateLimitFromStore(t0);
        const firstBounds = bounds();
        const day8 = t0 + 8 * 24 * 60 * 60_000;
        new SqliteAssistantRelayStore(db()).writeReceipt('unrelated', 'value', day8);
        expect(db().prepare("SELECT * FROM assistant_relay_receipts WHERE kind = 'follower_wake_quota_norm'").all()).toHaveLength(0);
        restart(day8);
        expect(snapshot()).toEqual(before);
        expect(bounds()).toEqual(firstBounds);
        charge(day8);
        charge(day8 + 61_000);
        expect(reserveFollowerWakeSlot(meshId, sender, day8 + 122_000)).toMatchObject({ ok: false, reason: 'window_limit' });
    });
    it.each(['same-event', 'unrelated-event'])('keeps two raw audit charges with corrupt %s provenance across restart', (target) => {
        seedAudit('recent-1', t0 - 122_000);
        seedAudit('recent-2', t0 - 61_000);
        seedAudit('unrelated', t0 - 30 * 60_000);
        // An expired bound must not suppress a still-current raw event when its JSON is corrupt.
        seedBound(target === 'same-event' ? 'recent-1' : 'unrelated', t0 - 30 * 60_000, '{');
        const before = snapshot();
        rebuildFollowerWakeRateLimitFromStore(t0);
        expect(reserveFollowerWakeSlot(meshId, sender, t0)).toMatchObject({ ok: false, reason: 'window_limit' });
        expect(snapshot()).toEqual(before);
        restart(t0);
        expect(reserveFollowerWakeSlot(meshId, sender, t0)).toMatchObject({ ok: false, reason: 'window_limit' });
        expect(snapshot()).toEqual(before);
    });
    it('repairs corrupt future provenance atomically so subsequent restarts do not renew the clamp', () => {
        seedAudit('future', future);
        seedAudit('recent', t0 - 61_000);
        seedBound('future', t0 - 30 * 60_000, '{');
        const before = snapshot();
        rebuildFollowerWakeRateLimitFromStore(t0);
        expect(reserveFollowerWakeSlot(meshId, sender, t0)).toMatchObject({ ok: false, reason: 'cooldown' });
        const repaired = bounds();
        restart(t0 + 61_000);
        expect(bounds()).toEqual(repaired);
        expect(reserveFollowerWakeSlot(meshId, sender, t0 + 61_000)).toMatchObject({ ok: false, reason: 'window_limit' });
        restart(t0 + 16 * 60_000);
        charge(t0 + 16 * 60_000);
        expect(snapshot()).toEqual(before);
    });
    it('prunes at most 128 expired or orphaned bounds per hydration, preserving active, margin and still-future source bounds', () => {
        const old = t0 - 30 * 60_000;
        seedAudit('expired', old);
        seedBound('expired', old);
        seedAudit('active', t0 - 61_000);
        seedBound('active', t0 - 61_000);
        seedAudit('margin', t0 - 15 * 60_000 - 30_000);
        seedBound('margin', t0 - 15 * 60_000 - 30_000);
        seedAudit('future', future);
        seedBound('future', old);
        seedBound('orphan-active', t0 - 61_000);
        for (let i = 0; i < 140; i++) seedBound(`orphan-${i}`, old);
        const before = snapshot();
        expect(bounds()).toHaveLength(145);
        rebuildFollowerWakeRateLimitFromStore(t0);
        expect(bounds()).toHaveLength(17);
        expect(db().prepare('SELECT event_id FROM assistant_follower_wake_audit_bounds WHERE event_id = ?').get('expired')).toBeUndefined();
        restart(t0);
        expect((bounds() as Array<{ event_id: string }>).map((row) => row.event_id)).toEqual(['active', 'future', 'margin', 'orphan-active']);
        charge(t0);
        expect(reserveFollowerWakeSlot(meshId, sender, t0 + 61_000)).toMatchObject({ ok: false, reason: 'window_limit' });
        expect(snapshot()).toEqual(before);
    });
    it.each(['receipt_update', 'audit_bound_insert', 'norm_insert'])('rolls back all normalization writes atomically on %s failure', (fault) => {
        seedReceipt(future);
        seedAudit('audit', future, 'wake');
        rebuildFollowerWakeRateLimitFromStore(future);
        const ledgerBefore = snapshot();
        const receiptsBefore = db().prepare('SELECT * FROM assistant_relay_receipts ORDER BY receipt_key').all();
        const target = fault === 'receipt_update' ? 'UPDATE ON assistant_relay_receipts'
            : fault === 'audit_bound_insert' ? 'INSERT ON assistant_follower_wake_audit_bounds'
                : 'INSERT ON assistant_relay_receipts';
        db().exec(`CREATE TEMP TRIGGER fail_normalization BEFORE ${target} BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
        rebuildFollowerWakeRateLimitFromStore(t0);
        expect(snapshot()).toEqual(ledgerBefore);
        expect(db().prepare('SELECT * FROM assistant_relay_receipts ORDER BY receipt_key').all()).toEqual(receiptsBefore);
        expect(bounds()).toHaveLength(0);
        db().exec('DROP TRIGGER fail_normalization');
        restart(t0 + 61_000);
        restart(t0 + 122_000);
        charge(t0 + 122_000);
        expect(reserveFollowerWakeSlot(meshId, sender, t0 + 183_000)).toMatchObject({ ok: false, reason: 'window_limit' });
        expect(snapshot()).toEqual(ledgerBefore);
    });
});
