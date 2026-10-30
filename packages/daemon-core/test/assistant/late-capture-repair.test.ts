import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ensureAssistantRelaySchema } from '../../src/mesh/mesh-runtime-store-schema.js';
import { InMemoryAssistantRelayStore, ATTEMPT_BODY_TTL_MS, type AssistantRelayStore, type AssistantRelayRow } from '../../src/assistant/assistant-relay-store.js';
import { SqliteAssistantRelayStore } from '../../src/assistant/assistant-relay-sqlite-store.js';
import { repairLateCaptures, settleLateCapture, readLateCaptureState } from '../../src/assistant/late-capture-repair.js';
import { receiptKey } from '../../src/assistant/relay-gap-tracker.js';
import { reportBodyId } from '../../src/assistant/report-continuation.js';

function rig(kind: string) {
    const path = kind === 'sqlite' ? join(mkdtempSync(join(tmpdir(), 'late-capture-')), 'relay.db') : null;
    let db: Database.Database | undefined;
    const open = (): AssistantRelayStore => {
        if (!path) return new InMemoryAssistantRelayStore();
        db = new Database(path); ensureAssistantRelaySchema(db);
        return new SqliteAssistantRelayStore(db);
    };
    let store = open();
    return {
        get store() { return store; },
        restart() { if (path) { db!.close(); store = open(); } return store; },
        close() { db?.close(); },
        get db() { return db; },
    };
}
function add(store: AssistantRelayStore, attemptId = 'attempt', committedAt = 100, meshId = 'mesh', reason?: string) {
    store.openThread(meshId, 100);
    store.recordCommitted({ attemptId, meshId, coordinatorSessionId: 'coord', committedAt, kind: 'relay', outcome: 'completed' });
    settleLateCapture(store, attemptId, 200, { surfacedMissing: true, committedAt, rendered: false, reason });
    store.markDelivered([attemptId], 200, [attemptId]);
}
function patch(store: AssistantRelayStore, id: string, value: object) {
    store.writeReceipt(receiptKey('late-capture', id), JSON.stringify({ ...readLateCaptureState(store, id, 200), ...value }), 200, 'capture');
}
const report = { body: 'Verified same-attempt final', completeness: 'final_native' as const };

for (const kind of ['memory', 'sqlite']) describe(`${kind} durable late capture boundaries`, () => {
    for (const now of [61_000, 120_000, 3_600_000, 86_000_000]) {
        for (const blocked of ['done', 'rejected', 'not-due', 'inactive', 'exhausted', 'covered', 'no-notice']) {
            it(`finds older eligible rows behind 129 ${blocked} notices at ${now}`, async () => {
                const r = rig(kind);
                try {
                    for (let i = 0; i < 9; i++) add(r.store, `old-${i}`);
                    for (let i = 0; i < 129; i++) {
                        const id = `new-${i}`;
                        add(r.store, id, 101 + i, blocked === 'inactive' ? 'closed' : 'mesh', blocked === 'rejected' ? 'attempt_mesh_mismatch' : undefined);
                        if (blocked === 'done') patch(r.store, id, { done: true });
                        if (blocked === 'not-due') patch(r.store, id, { nextAt: now + 1 });
                        if (blocked === 'exhausted') patch(r.store, id, { probes: 24 });
                        if (blocked === 'covered') {
                            r.store.reopenUncovered?.(id);
                            r.store.markDelivered([id], 201, [id], [{ attemptId: id, coordinatorSessionId: 'coord', replies: [] }]);
                        }
                        if (blocked === 'no-notice') r.store.writeReceipt(receiptKey('late-capture', id), 'null', 201, 'capture');
                    }
                    if (blocked === 'inactive') r.store.closeThread('closed', 300);
                    const store = r.restart();
                    const read = vi.fn(async (_row: AssistantRelayRow) => ({ body: null, completeness: 'envelope_unverified' as const }));
                    const ready = vi.fn();
                    for (const count of [4, 8, 9]) {
                        await repairLateCaptures({ store, now, live: () => true, read, ready });
                        expect(read).toHaveBeenCalledTimes(count);
                    }
                    expect(read.mock.calls.every(([row]) => row.attemptId.startsWith('old-'))).toBe(true);
                    expect(ready).not.toHaveBeenCalled();
                    await repairLateCaptures({ store, now: 1000 + ATTEMPT_BODY_TTL_MS, live: () => true, read, ready });
                    expect(read).toHaveBeenCalledTimes(9);
                } finally { r.close(); }
            });
        }
    }
    it('traverses a 132-row due backlog with four actual probes per scan', async () => {
        const r = rig(kind);
        try {
            for (let i = 0; i < 132; i++) add(r.store, `due-${i}`, 100 + i);
            const seen = new Set<string>();
            const read = vi.fn(async (row: { attemptId: string }) => {
                expect(seen.has(row.attemptId)).toBe(false); seen.add(row.attemptId);
                return { body: null, completeness: 'envelope_unverified' as const };
            });
            const store = r.restart();
            for (let i = 1; i <= 33; i++) {
                await repairLateCaptures({ store, now: 61_000, live: () => true, read, ready: vi.fn() });
                expect(read).toHaveBeenCalledTimes(i * 4);
            }
            expect(seen.size).toBe(132);
        } finally { r.close(); }
    });
    it('cold restart after last-probe commit keeps identity and one pending row despite repeated callback crashes', async () => {
        const r = rig(kind);
        try {
            add(r.store); patch(r.store, 'attempt', { probes: 23 });
            const ready = vi.fn(() => { throw new Error('crash after atomic commit'); });
            const read = vi.fn(async () => report);
            await expect(repairLateCaptures({ store: r.store, now: 61_000, live: () => true, read, ready })).rejects.toThrow('crash after atomic commit');
            for (let i = 0; i < 3; i++) {
                const store = r.restart();
                expect(store.readReceipt(receiptKey('late-capture', 'attempt'), 62_000)).not.toContain(report.body);
                expect(readLateCaptureState(store, 'attempt', 62_000)).toMatchObject({ probes: 24, sourceComplete: true, reportId: reportBodyId(report.body) });
                expect(store.listUndelivered().map(row => row.attemptId)).toEqual(['attempt']);
                expect(store.reopenUncovered?.('attempt', { key: receiptKey('late-capture', 'attempt'), value: '{}', at: 62_000 })).toBe(false);
                await repairLateCaptures({ store, now: 3_600_000, live: () => true, read, ready });
            }
            expect(read).toHaveBeenCalledTimes(1); expect(ready).toHaveBeenCalledTimes(1);
            const coverage = [{ attemptId: 'attempt', coordinatorSessionId: 'coord', replies: [] }];
            r.store.markDelivered(['attempt'], 63_000, ['attempt'], coverage);
            r.store.markDelivered(['attempt'], 64_000, ['attempt'], coverage);
            const store = r.restart();
            expect(store.listUndelivered()).toEqual([]);
            expect(store.listDeliveredCoverage(65_000)).toEqual([{ ...coverage[0], renderedAt: 63_000 }]);
            await repairLateCaptures({ store, now: 3_600_000, live: () => true, read, ready });
            expect(ready).toHaveBeenCalledTimes(1);
        } finally { r.close(); }
    });
    it('rejects a changed report identity from an interrupted pre-atomic receipt', async () => {
        const r = rig(kind);
        try {
            add(r.store); patch(r.store, 'attempt', { sourceComplete: true, reportId: reportBodyId('Original verified report') });
            const ready = vi.fn();
            await repairLateCaptures({ store: r.restart(), now: 61_000, live: () => true, read: async () => report, ready });
            expect(ready).not.toHaveBeenCalled(); expect(readLateCaptureState(r.store, 'attempt', 61_000)?.done).toBe(true);
        } finally { r.close(); }
    });
    it.each([{ body: report.body, completeness: 'envelope_unverified' as const }, { body: '  ', completeness: 'final_native' as const }])('never persists identity or reopens for unavailable report %j on probe 24', async unavailable => {
        const r = rig(kind);
        try {
            add(r.store); patch(r.store, 'attempt', { probes: 23 });
            const read = vi.fn(async () => unavailable);
            const ready = vi.fn();
            await repairLateCaptures({ store: r.store, now: 61_000, live: () => true, read, ready });
            await repairLateCaptures({ store: r.restart(), now: 3_600_000, live: () => true, read, ready });
            expect(read).toHaveBeenCalledTimes(1); expect(ready).not.toHaveBeenCalled();
            expect(readLateCaptureState(r.store, 'attempt', 3_600_000)).toMatchObject({ probes: 24, sourceComplete: false, reportId: null });
            expect(r.store.listUndelivered()).toEqual([]);
        } finally { r.close(); }
    });
});

it('SQLite rolls identity and reopen back together across repeated transaction failures', async () => {
    const r = rig('sqlite');
    try {
        add(r.store);
        for (let i = 0; i < 3; i++) {
            r.db!.exec(`CREATE TRIGGER fail_identity BEFORE UPDATE ON assistant_relay_receipts
                WHEN NEW.receipt_key = '${receiptKey('late-capture', 'attempt')}' BEGIN SELECT RAISE(ABORT, 'synthetic crash'); END`);
            expect(() => r.store.reopenUncovered?.('attempt', { key: receiptKey('late-capture', 'attempt'), at: 61_000,
                value: JSON.stringify({ ...readLateCaptureState(r.store, 'attempt', 200), probes: 24, sourceComplete: true, reportId: reportBodyId(report.body) }) })).toThrow('synthetic crash');
            const store = r.restart();
            expect(store.listUndelivered()).toEqual([]);
            expect(readLateCaptureState(store, 'attempt', 61_000)?.sourceComplete).toBe(false);
            r.db!.exec('DROP TRIGGER fail_identity');
        }
        patch(r.store, 'attempt', { probes: 23 });
        const ready = vi.fn();
        await repairLateCaptures({ store: r.store, now: 61_000, live: () => true, read: async () => report, ready });
        expect(ready).toHaveBeenCalledTimes(1);
        expect(r.restart().listUndelivered()).toHaveLength(1);
    } finally { r.close(); }
});
