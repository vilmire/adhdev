import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Structured missions, bundle A (design 2026-10-28 §4, §5.1/§5.2, §4.4): storage, writes,
// carry-over, decision dedupe, evidence. Isolate config/ledger I/O to a temp dir.
const testConfigDir = join(tmpdir(), `adhdev-mission-structured-${randomUUID().slice(0, 8)}`, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));

import { rmSync } from 'fs';
import { dirname } from 'path';
import { CARRY_OVER_MISSION_TITLE, MISSION_LIMITS } from '@adhdev/mesh-shared';
import { getMeshMission, getMeshMissions, upsertMeshMission } from '../../src/mesh/mesh-missions.js';
import {
    applyWorkerReportToMission,
    attachRefineMergeEvidence,
    ensureCarryOverMission,
    upsertStructuredMission,
} from '../../src/mesh/mesh-mission-structured.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { migrate } from '../../src/mesh/mesh-runtime-store-schema.js';
import { MISSION_EVENTS_PER_MESH_CAP } from '../../src/mesh/mesh-mission-items-store.js';
import { pruneMeshRuntimeRetention } from '../../src/mesh/mesh-runtime-store.js';
import { maybeInjectIdleActiveMissionReminder } from '../../src/mesh/mesh-idle-reminder.js';
import { compactProjectStatus } from '../../src/assistant/project-views.js';
import { validateWorkerCompletionReport } from '../../src/mesh/worker-report-validation.js';
import { enqueueTask, __clearMeshQueueForTests } from '../../src/mesh/mesh-work-queue.js';
import type { MeshWorkQueueEntry } from '../../src/mesh/mesh-work-queue.js';
import { turnLedgerIpcHandlers } from '../../src/commands/low-family/turn-ledger-ipc.js';

let meshId = '';
const store = () => MeshRuntimeStore.getInstance();
const items = (missionId: string) => store().missionItems().listItems(meshId, missionId);
const events = (missionId: string, types?: any[]) => store().missionItems().listEvents(meshId, missionId, { types, limit: 500 });

beforeEach(() => { meshId = `mission-structured-${randomUUID().slice(0, 8)}`; });
afterEach(() => {
    __clearMeshQueueForTests(meshId);
    try { store().clearMissionsForMesh(meshId); } catch { /* fresh store */ }
    MeshRuntimeStore.resetForTests();
});
afterEach(() => { try { rmSync(dirname(testConfigDir), { recursive: true, force: true }); } catch { /* best effort */ } });

function write(input: Parameters<typeof upsertStructuredMission>[1]) {
    return upsertStructuredMission(meshId, input);
}

describe('acceptance #12 — migration preserves rows and is idempotent', () => {
    it('adds the structured columns/tables to a legacy DB without touching existing rows; re-running changes nothing', () => {
        const s = store();
        const legacy = upsertMeshMission(meshId, { title: 'Legacy mission', goal: 'old goal', status: 'paused' });
        // Rewind to the pre-structured schema.
        for (const col of ['summary', 'outcome', 'outcome_reason', 'version', 'is_carry_over']) s.db.exec(`ALTER TABLE mesh_missions DROP COLUMN ${col}`);
        s.db.exec('DROP TABLE mesh_mission_items; DROP TABLE mesh_mission_events;');
        const before = s.db.prepare('SELECT id, mesh_id, title, goal, status, created_at FROM mesh_missions WHERE id = ?').get(legacy.id);

        migrate(s);
        const snapshot = () => JSON.stringify([
            s.db.prepare("SELECT name, sql FROM sqlite_master WHERE name LIKE 'mesh_mission%' OR name LIKE 'idx_mesh_mission%' ORDER BY name").all(),
            s.db.prepare('SELECT * FROM mesh_missions WHERE id = ?').get(legacy.id),
        ]);
        const first = snapshot();
        migrate(s);
        migrate(s);
        expect(snapshot()).toBe(first); // nothing changes on re-open

        expect(s.db.prepare('SELECT id, mesh_id, title, goal, status, created_at FROM mesh_missions WHERE id = ?').get(legacy.id)).toEqual(before);
        const reread = getMeshMission(meshId, legacy.id)!;
        expect(reread).toMatchObject({ title: 'Legacy mission', goal: 'old goal', status: 'paused', version: 1 });
        expect(reread.summary).toBeUndefined();
        const idx = s.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_mesh_mission_items_dedupe'").get() as { sql: string };
        expect(idx.sql).toMatch(/UNIQUE INDEX/);
        expect(s.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_mesh_mission_items_mesh_kind_state'").get()).toBeTruthy();
    });
});

describe('every mission write bumps the version and appends an event (last-write-wins)', () => {
    it('legacy upsert path too; concurrent edits are never rejected', () => {
        const m = upsertMeshMission(meshId, { title: 'T', goal: 'g1' });
        expect(getMeshMission(meshId, m.id)!.version).toBe(2); // create is write #1 on a version-1 row
        upsertMeshMission(meshId, { id: m.id, title: 'T', goal: 'g2' });
        upsertMeshMission(meshId, { id: m.id, title: 'T', goal: 'g3' }); // "stale" writer: still accepted
        expect(getMeshMission(meshId, m.id)!.version).toBe(4);
        expect(getMeshMission(meshId, m.id)!.goal).toBe('g3');
        expect(events(m.id).map(e => e.type)).toEqual(['created', 'goal_changed', 'goal_changed']);
    });
});

describe('acceptance #2 — goal edits keep the previous full text in the history', () => {
    it('goal_changed carries the previous goal verbatim', () => {
        const long = 'A long goal. '.repeat(120);
        const m = upsertMeshMission(meshId, { title: 'T', goal: long });
        upsertMeshMission(meshId, { id: m.id, title: 'T', goal: 'rewritten' });
        const ev = events(m.id, ['goal_changed']);
        expect(ev).toHaveLength(1);
        expect(ev[0].payload.previousGoal).toBe(long);
        expect(ev[0].payload.goal).toBe('rewritten');
        expect(ev[0].actor).toBe('coordinator');
    });

    it('a no-op rewrite appends no goal_changed event', () => {
        const m = upsertMeshMission(meshId, { title: 'T', goal: 'same' });
        upsertMeshMission(meshId, { id: m.id, title: 'T', goal: 'same' });
        expect(events(m.id, ['goal_changed'])).toHaveLength(0);
    });
});

describe('acceptance #1 — closing with open items never rejects; items carry over; reopen restores', () => {
    it('moves open items to the auto carry-over mission, reports movedItems/movedTo, and reopening moves them back', () => {
        const { record } = write({ title: 'Ship X', itemsAdd: [
            { kind: 'remaining', text: 'wire the thing' },
            { kind: 'live_check', text: 'verify on win32', machine: 'win-node' },
            { kind: 'decision', question: 'Keep the flag?', options: [{ label: 'keep' }, { label: 'drop' }] },
            { kind: 'remaining', text: 'already finished' },
        ] });
        const doneId = items(record.id).find(i => i.text === 'already finished')!.id;
        write({ id: record.id, itemsUpdate: [{ id: doneId, state: 'done' }] });

        const closed = write({ id: record.id, status: 'completed', outcome: 'merged' });
        expect(closed.record.status).toBe('completed'); // not rejected
        expect(closed.result.movedItems).toBe(3);
        const carryId = closed.result.movedTo!;
        expect(carryId).toBeTruthy();
        const carry = getMeshMission(meshId, carryId)!;
        expect(carry.title).toBe(CARRY_OVER_MISSION_TITLE);
        expect(carry.isCarryOver).toBe(true);
        expect(carry.status).toBe('active');
        expect(items(carryId).map(i => i.text).sort()).toEqual(['Keep the flag?', 'verify on win32', 'wire the thing'].sort());
        // the finished item stays with the closed mission
        expect(items(record.id).map(i => i.text)).toEqual(['already finished']);

        // one carry-over mission per mesh, reused by the next close
        const other = write({ title: 'Other', itemsAdd: [{ text: 'leftover' }] });
        const closed2 = write({ id: other.record.id, status: 'abandoned' });
        expect(closed2.result.movedTo).toBe(carryId);
        expect(getMeshMissions(meshId).filter(m => m.isCarryOver)).toHaveLength(1);

        const reopened = write({ id: record.id, status: 'active' });
        expect(reopened.result.restoredItems).toBe(3);
        expect(items(record.id).filter(i => i.state === 'open').map(i => i.text).sort()).toEqual(['Keep the flag?', 'verify on win32', 'wire the thing'].sort());
        expect(items(carryId).map(i => i.text)).toEqual(['leftover']); // the other mission's item is untouched
        expect(getMeshMission(meshId, record.id)!.outcome).toBeUndefined();
    });

    it('carry_over_to sends the items to a named mission instead', () => {
        const target = upsertMeshMission(meshId, { title: 'Next phase' });
        const { record } = write({ title: 'Phase 1', itemsAdd: [{ text: 'a' }, { text: 'b' }] });
        const closed = write({ id: record.id, status: 'completed', carryOverTo: target.id });
        expect(closed.result.movedItems).toBe(2);
        expect(closed.result.movedTo).toBe(target.id);
        expect(items(target.id)).toHaveLength(2);
        expect(getMeshMissions(meshId).some(m => m.isCarryOver)).toBe(false);
    });

    it('an unknown carry_over_to falls back to the carry-over mission with a warning (never rejects)', () => {
        const { record } = write({ title: 'P', itemsAdd: [{ text: 'a' }] });
        const closed = write({ id: record.id, status: 'completed', carryOverTo: 'nope' });
        expect(closed.result.warnings.join(' ')).toMatch(/carry_over_to/);
        expect(getMeshMission(meshId, closed.result.movedTo!)!.isCarryOver).toBe(true);
    });

    it('a duplicate already in the destination is merged, and reopen revives it', () => {
        const a = write({ title: 'A', itemsAdd: [{ text: 'same task' }] });
        const b = write({ title: 'B', itemsAdd: [{ text: 'same task' }] });
        const closeA = write({ id: a.record.id, status: 'completed' });
        const carryId = closeA.result.movedTo!;
        const closeB = write({ id: b.record.id, status: 'completed' });
        expect(closeB.result.movedItems).toBe(1);
        expect(items(carryId)).toHaveLength(1); // not duplicated
        expect(items(b.record.id)[0].state).toBe('moved');
        write({ id: b.record.id, status: 'active' });
        expect(items(b.record.id)[0].state).toBe('open');
    });

    it('a missing outcome is recorded as unspecified; an unknown one too (with a warning)', () => {
        const a = write({ title: 'A' });
        write({ id: a.record.id, status: 'completed' });
        expect(getMeshMission(meshId, a.record.id)!.outcome).toBe('unspecified');
        const b = write({ title: 'B' });
        const r = write({ id: b.record.id, status: 'abandoned', outcome: 'because' as any });
        expect(getMeshMission(meshId, b.record.id)!.outcome).toBe('unspecified');
        expect(r.result.warnings.join(' ')).toMatch(/unknown outcome/);
    });

    it('the carry-over mission itself can never be closed or renamed', () => {
        const carryId = ensureCarryOverMission(meshId);
        const r = write({ id: carryId, title: 'renamed', status: 'completed' });
        expect(r.record.status).toBe('active');
        expect(r.record.title).toBe(CARRY_OVER_MISSION_TITLE);
        expect(r.result.warnings).toContain('carry_over_mission_always_active');
    });

    it('items added in the same call that closes the mission are carried over too', () => {
        const { record } = write({ title: 'P' });
        const closed = write({ id: record.id, status: 'completed', itemsAdd: [{ text: 'last minute' }] });
        expect(closed.result.movedItems).toBe(1);
    });
});

describe('acceptance #11 — owner_abandoned asks the owner to confirm; reopen restores everything', () => {
    it('creates one confirmation decision in the carry-over mission; reopening restores mission + items and withdraws it', () => {
        const { record } = write({ title: 'Big refactor', itemsAdd: [{ text: 'left over' }] });
        const closed = write({ id: record.id, status: 'abandoned', outcome: 'owner_abandoned', outcomeReason: '오너가 중단하라고 함' });
        const confirmId = closed.result.ownerConfirmationItemId!;
        expect(confirmId).toBeTruthy();
        const confirm = store().missionItems().getItem(meshId, confirmId)!;
        expect(confirm.kind).toBe('decision');
        expect(confirm.state).toBe('open');
        expect(confirm.decision!.question).toBe("코디가 '오너 결정으로 중단'이라고 닫음 — 맞나요?");
        expect(confirm.decision!.options.map(o => o.label)).toEqual(['맞음', '다시 열기']);
        expect(confirm.refs[0]).toMatchObject({ kind: 'mission', value: record.id });
        expect(confirm.decision!.answer).toBeUndefined();
        expect(confirm.missionId).toBe(closed.result.movedTo); // lives in the carry-over mission
        expect(getMeshMission(meshId, record.id)).toMatchObject({ status: 'abandoned', outcome: 'owner_abandoned', outcomeReason: '오너가 중단하라고 함' });

        // closing again does not create a second confirmation
        write({ id: record.id, status: 'abandoned', outcome: 'owner_abandoned' });
        expect(store().missionItems().listItems(meshId, closed.result.movedTo!, { kinds: ['decision'] })).toHaveLength(1);

        // "다시 열기" — the mission and its items come back
        const reopened = write({ id: record.id, status: 'active' });
        expect(reopened.record.status).toBe('active');
        expect(reopened.result.restoredItems).toBe(1);
        expect(items(record.id).find(i => i.text === 'left over')!.state).toBe('open');
        expect(store().missionItems().getItem(meshId, confirmId)!.state).toBe('withdrawn');

        // re-closing as owner_abandoned revives (does not collide with) the withdrawn confirmation
        const again = write({ id: record.id, status: 'abandoned', outcome: 'owner_abandoned' });
        expect(again.result.ownerConfirmationItemId).toBe(confirmId);
        expect(store().missionItems().getItem(meshId, confirmId)!.state).toBe('open');
    });

    it('other outcomes create no confirmation', () => {
        const { record } = write({ title: 'X' });
        expect(write({ id: record.id, status: 'completed', outcome: 'merged' }).result.ownerConfirmationItemId).toBeUndefined();
    });

    it('bulk-style close (several missions, same rules) carries each one over', () => {
        const a = write({ title: 'A', itemsAdd: [{ text: 'a1' }] });
        const b = write({ title: 'B', itemsAdd: [{ text: 'b1' }] });
        for (const id of [a.record.id, b.record.id]) {
            const r = upsertStructuredMission(meshId, { id, title: '', status: 'abandoned', outcome: 'not_needed' });
            expect(r.result.movedItems).toBe(1);
        }
        expect(items(ensureCarryOverMission(meshId)).map(i => i.text).sort()).toEqual(['a1', 'b1']);
    });
});

describe('acceptance #3 — decision requests dedupe and return the earlier answer', () => {
    it('same question → same item (deduped); answered → the answer comes back; no mission_id → carry-over mission', () => {
        const m = write({ title: 'M' });
        const first = write({ id: m.record.id, itemsAdd: [{ kind: 'decision', question: 'Ship the budget as is?', options: [{ label: 'yes' }, { label: 'no' }], recommended: 'a' }] });
        const r1 = first.result.itemResults[0];
        expect(r1.id).toBeTruthy();
        expect(r1.deduped).toBeUndefined();

        const second = write({ id: m.record.id, itemsAdd: [{ kind: 'decision', question: '  ship the budget as is ' }] });
        expect(second.result.itemResults[0]).toMatchObject({ id: r1.id, deduped: true, state: 'open' });
        expect(items(m.record.id).filter(i => i.kind === 'decision')).toHaveLength(1);

        // Simulate the owner's answer (the answer path itself is a later bundle; the daemon owns it).
        const it = store().missionItems().getItem(meshId, r1.id!)!;
        store().missionItems().updateItem(meshId, r1.id!, {
            state: 'answered',
            decision: { ...it.decision!, answer: { optionId: 'a', by: 'owner', via: 'dashboard', at: new Date().toISOString() } },
        });
        const third = write({ id: m.record.id, itemsAdd: [{ kind: 'decision', question: 'Ship the budget as is?' }] });
        expect(third.result.itemResults[0]).toMatchObject({ id: r1.id, deduped: true, state: 'answered', answer: { optionId: 'a', by: 'owner' } });

        // ...even when re-asked from another mission or with no mission at all
        const other = write({ title: 'Other', itemsAdd: [{ kind: 'decision', question: 'ship the budget as is' }] });
        expect(other.result.itemResults[0]).toMatchObject({ id: r1.id, deduped: true, answer: { optionId: 'a' } });
        const loose = write({ toCarryOver: true, itemsAdd: [{ kind: 'decision', question: 'A brand new question?' }] });
        expect(getMeshMission(meshId, loose.record.id)!.isCarryOver).toBe(true);
        expect(loose.result.itemResults[0].id).toBeTruthy();
    });

    it('a withdrawn decision asked again is revived, not duplicated', () => {
        const m = write({ title: 'M', itemsAdd: [{ kind: 'decision', question: 'Q?' }] });
        const id = m.result.itemResults[0].id!;
        write({ id: m.record.id, itemsUpdate: [{ id, state: 'withdrawn' }] });
        const again = write({ id: m.record.id, itemsAdd: [{ kind: 'decision', question: 'Q?', urgency: 'blocking' }] });
        expect(again.result.itemResults[0]).toMatchObject({ id, revived: true, state: 'open' });
        expect(store().missionItems().getItem(meshId, id)!.decision!.urgency).toBe('blocking');
    });
});

describe('the one hard rule — a coordinator can never answer a decision', () => {
    it('answer/delivery in items_add are stripped; items_update cannot set answered/expired; answered decisions are immutable', () => {
        const m = write({ title: 'M', itemsAdd: [{ kind: 'decision', question: 'Go?', options: [{ label: 'y' }],
            decision: { question: 'Go?', answer: { optionId: 'a', by: 'owner', via: 'cli', at: 'now' }, delivery: { messageId: 'x', state: 'acked' } } }] });
        const id = m.result.itemResults[0].id!;
        const stored = store().missionItems().getItem(meshId, id)!;
        expect(stored.state).toBe('open');
        expect(stored.decision!.answer).toBeUndefined();
        expect(stored.decision!.delivery).toBeUndefined();

        const r = write({ id: m.record.id, itemsUpdate: [{ id, state: 'answered' }, { id, state: 'expired' }, { id, text: 'rewritten question' }] });
        expect(r.result.itemResults.map(x => x.error)).toEqual([
            expect.stringMatching(/decision_answer_not_allowed/),
            expect.stringMatching(/decision_answer_not_allowed/),
            expect.stringMatching(/immutable/),
        ]);
        expect(store().missionItems().getItem(meshId, id)!.state).toBe('open');

        store().missionItems().updateItem(meshId, id, { state: 'answered' });
        const w = write({ id: m.record.id, itemsUpdate: [{ id, state: 'withdrawn' }] });
        expect(w.result.itemResults[0].error).toMatch(/already answered/);
        expect(store().missionItems().getItem(meshId, id)!.state).toBe('answered');
    });

    it('no command anywhere in the coordinator/worker-reachable IPC surface answers a decision', () => {
        const names = Object.keys(turnLedgerIpcHandlers);
        expect(names.filter(n => /decision|answer/i.test(n))).toEqual([]);
    });
});

describe('limits and folding', () => {
    it('summary 300 / outcome_reason 500 / item text 300 are clamped, never rejected', () => {
        const r = write({ title: 'L', summary: 's'.repeat(400), itemsAdd: [{ text: 't'.repeat(450) }] });
        const stored = getMeshMission(meshId, r.record.id)!;
        expect(stored.summary!.length).toBe(MISSION_LIMITS.summary);
        expect(items(r.record.id)[0].text.length).toBe(MISSION_LIMITS.itemText);
        expect(r.result.itemResults[0].truncated).toContain('text');
        const c = write({ id: r.record.id, status: 'completed', outcomeReason: 'r'.repeat(800) });
        expect(getMeshMission(meshId, c.record.id)!.outcomeReason!.length).toBe(MISSION_LIMITS.outcomeReason);
    });

    it('beyond 200 open items the oldest remaining fold into one "N more" item (no rejection)', () => {
        const m = write({ title: 'Many' });
        for (let chunk = 0; chunk < 5; chunk++) {
            write({ id: m.record.id, itemsAdd: Array.from({ length: 50 }, (_, i) => ({ text: `task ${chunk * 50 + i}` })) });
        }
        const open1 = items(m.record.id).filter(i => i.state === 'open');
        expect(open1.length).toBe(MISSION_LIMITS.openItemsPerMission);
        const fold = open1.find(i => i.dedupeKey === 'fold:remaining')!;
        expect(fold.text).toMatch(/51개 더/); // 250 added: 51 folded so 199 + the fold item = 200
        // the oldest ones were the ones folded; the newest are still there
        expect(open1.some(i => i.text === 'task 249')).toBe(true);
        expect(open1.some(i => i.text === 'task 0')).toBe(false);
        // folding again updates the same fold item
        write({ id: m.record.id, itemsAdd: [{ text: 'one more' }] });
        const open2 = items(m.record.id).filter(i => i.state === 'open');
        expect(open2.length).toBe(MISSION_LIMITS.openItemsPerMission);
        expect(open2.filter(i => i.dedupeKey === 'fold:remaining')).toHaveLength(1);
    });

    it('per-item errors do not block the rest of the call', () => {
        const r = write({ title: 'P', itemsAdd: [{ kind: 'remaining' }, { text: 'ok' }, { kind: 'bogus', text: 'x' }] as any });
        expect(r.result.itemResults.map(x => !!x.error)).toEqual([true, false, true]);
        expect(items(r.record.id)).toHaveLength(1);
    });

    it('an event payload larger than 16 KiB is bounded', () => {
        const m = upsertMeshMission(meshId, { title: 'G', goal: 'a'.repeat(60_000) });
        upsertMeshMission(meshId, { id: m.id, title: 'G', goal: 'b' });
        const row = store().db.prepare("SELECT payload_json FROM mesh_mission_events WHERE mission_id = ? AND type = 'goal_changed'").get(m.id) as { payload_json: string };
        expect(row.payload_json.length).toBeLessThanOrEqual(16 * 1024);
    });
});

describe('carry-over mission is excluded from the idle reminder and the stale lists', () => {
    const makeCoordinator = () => {
        const calls: string[] = [];
        return {
            calls,
            instance: { sessionId: 'coord-1', input: { submit: async (msg: any) => { calls.push(msg.input.textFallback); return { kind: 'delivered' }; } } } as any,
        };
    };

    it('the idle reminder never names (or fires for) the carry-over mission', async () => {
        ensureCarryOverMission(meshId);
        const coord = makeCoordinator();
        expect(await maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000)).toBe(false);
        expect(coord.calls).toHaveLength(0);

        upsertMeshMission(meshId, { title: 'Real work', goal: 'x' });
        expect(await maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 2_000)).toBe(true);
        expect(coord.calls[0]).toContain('Real work');
        expect(coord.calls[0]).not.toContain(CARRY_OVER_MISSION_TITLE);
    });

    it('project status stale list skips it even when it is old', () => {
        const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
        const view = { missions: { list: { missions: [
            { id: 'c1', title: CARRY_OVER_MISSION_TITLE, status: 'active', updatedAt: old, tasks: { lastActivityAt: null } },
            { id: 'r1', title: 'Real stale', status: 'active', updatedAt: old, tasks: { lastActivityAt: null } },
        ] } } };
        const out = compactProjectStatus(view as any, { queue: null, pendingApprovals: 0, coordinator: {} as any, threadOpen: null, lastRelayAt: null } as any) as any;
        expect(out.staleMissions.map((m: any) => m.id)).toEqual(['r1']);
    });
});

describe('report_completion: decisions_needed + commits (worker-requested, evidence)', () => {
    const base = { outcome: 'completed', summary: 'did it — see abcdef1234567 in the text' };

    it('the validator accepts the new optional fields and still accepts a report without them (old-peer shape)', () => {
        const old = validateWorkerCompletionReport({ ...base, touchedFiles: ['a.ts'] });
        expect(old.errors).toEqual([]);
        expect(old.report!.decisionsNeeded).toBeUndefined();
        expect(old.report!.commits).toBeUndefined();

        const next = validateWorkerCompletionReport({ ...base, commits: ['ABCDEF1234567'], decisionsNeeded: [{ question: 'Which DB?', options: [{ label: 'sqlite' }] }] });
        expect(next.errors).toEqual([]);
        expect(next.report!.commits).toEqual(['abcdef1234567']);
        expect(next.report!.decisionsNeeded).toHaveLength(1);
    });

    it('rejects more than 3 decisions, a decision without a question, and non-SHA commits', () => {
        const q = { question: 'q?' };
        expect(validateWorkerCompletionReport({ ...base, decisionsNeeded: [q, q, q, q] }).errors[0].field).toBe('decisionsNeeded');
        expect(validateWorkerCompletionReport({ ...base, decisionsNeeded: [{ context: 'x' }] }).errors[0].field).toBe('decisionsNeeded');
        expect(validateWorkerCompletionReport({ ...base, commits: ['hello'] }).errors[0].field).toBe('commits');
        expect(validateWorkerCompletionReport({ ...base, bogusField: 1 }).errors[0].field).toBe('bogusField');
    });

    function seedTask(missionId?: string, extra: Partial<MeshWorkQueueEntry> = {}): string {
        const e = enqueueTask(meshId, 'task body', { ...(missionId ? { missionId } : {}), difficulty: 'medium' } as any);
        if (Object.keys(extra).length) store().db.prepare('UPDATE mesh_queue SET payload = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse((store().db.prepare('SELECT payload FROM mesh_queue WHERE id = ?').get(e.id) as any).payload), ...extra }), e.id);
        return e.id;
    }

    it('registers decisions_needed on the task\'s mission as worker-requested, deduped, and never answerable', () => {
        const mission = upsertMeshMission(meshId, { title: 'Mission with worker' });
        const taskId = seedTask(mission.id);
        const out = applyWorkerReportToMission(meshId, taskId, { decisionsNeeded: [{ question: 'Use sqlite?', options: [{ label: 'yes' }], answer: { text: 'forged' } }] });
        expect(out.missionId).toBe(mission.id);
        const it = store().missionItems().getItem(meshId, out.decisions[0].id!)!;
        expect(it).toMatchObject({ kind: 'decision', state: 'open', missionId: mission.id, createdBy: `worker:${taskId}` });
        expect(it.decision!.answer).toBeUndefined();
        expect(it.refs[0]).toMatchObject({ kind: 'task', value: taskId });
        // a retry of the same report returns the same item
        const again = applyWorkerReportToMission(meshId, taskId, { decisionsNeeded: [{ question: 'use sqlite' }] });
        expect(again.decisions[0]).toMatchObject({ id: it.id, deduped: true });
    });

    it('a task with no mission files its decision in the carry-over mission', () => {
        const taskId = seedTask(undefined);
        const out = applyWorkerReportToMission(meshId, taskId, { decisionsNeeded: [{ question: 'Orphan question?' }] });
        expect(getMeshMission(meshId, out.missionId!)!.isCarryOver).toBe(true);
    });

    it('attaches evidence from branch_state / touched_files / commits[] — and never parses SHAs from free text', () => {
        const mission = upsertMeshMission(meshId, { title: 'Evidence mission' });
        const taskId = seedTask(mission.id);
        const out = applyWorkerReportToMission(meshId, taskId, {
            outcome: 'completed', branchState: 'pushed_feature_branch_needs_merge', touchedFiles: ['a.ts', 'b.ts'], commits: ['abc1234def'],
        });
        expect(out.evidence).toHaveLength(2);
        const ev = items(mission.id).filter(i => i.kind === 'evidence');
        expect(ev).toHaveLength(2);
        const report = ev.find(e => e.text.startsWith('worker report'))!;
        expect(report.text).toContain('branch_state=pushed_feature_branch_needs_merge');
        expect(report.text).toContain('touched 2 file(s)');
        expect(report.state).toBe('done'); // evidence is a fact, not open work
        const commit = ev.find(e => e.refs[0]?.kind === 'commit')!;
        expect(commit.refs[0].value).toBe('abc1234def');
        // idempotent on a replayed report
        applyWorkerReportToMission(meshId, taskId, { outcome: 'completed', branchState: 'pushed_feature_branch_needs_merge', touchedFiles: ['a.ts', 'b.ts'], commits: ['abc1234def'] });
        expect(items(mission.id).filter(i => i.kind === 'evidence')).toHaveLength(2);
        // no structured fields → no evidence, and a SHA in prose is not harvested
        const t2 = seedTask(mission.id);
        expect(applyWorkerReportToMission(meshId, t2, {}).evidence).toEqual([]);
        expect(items(mission.id).some(i => i.refs.some(r => r.value.includes('abcdef1234567')))).toBe(false);
        // open counts exclude evidence
        expect(store().missionItems().openCounts(meshId, mission.id).evidence).toBe(0);
    });

    it('a report on a mission-less task attaches no evidence', () => {
        const taskId = seedTask(undefined);
        expect(applyWorkerReportToMission(meshId, taskId, { branchState: 'merged_to_main', commits: ['abc1234'] }).evidence).toEqual([]);
        expect(getMeshMissions(meshId)).toHaveLength(0);
    });
});

describe('Refinery merge evidence', () => {
    it('attaches an evidence item to the mission of the latest completed task on that node; nothing without a node match', () => {
        const mission = upsertMeshMission(meshId, { title: 'Refined' });
        const task = enqueueTask(meshId, 'work', { missionId: mission.id, difficulty: 'medium' } as any);
        const row = store().db.prepare('SELECT payload FROM mesh_queue WHERE id = ?').get(task.id) as { payload: string };
        store().db.prepare("UPDATE mesh_queue SET status = 'completed', assigned_node_id = ?, payload = ? WHERE id = ?")
            .run('node-7', JSON.stringify({ ...JSON.parse(row.payload), status: 'completed', assignedNodeId: 'node-7' }), task.id);

        expect(attachRefineMergeEvidence(meshId, 'node-other', { merged: true, branch: 'feat/x', into: 'main', mergedSha: 'deadbeef12' })).toBeNull();
        expect(attachRefineMergeEvidence(meshId, 'node-7', { merged: false, branch: 'feat/x' })).toBeNull();
        const hit = attachRefineMergeEvidence(meshId, 'node-7', { merged: true, branch: 'feat/x', into: 'main', mergedSha: 'deadbeef12', pushed: true })!;
        expect(hit.missionId).toBe(mission.id);
        const ev = store().missionItems().getItem(meshId, hit.itemId!)!;
        expect(ev.kind).toBe('evidence');
        expect(ev.text).toContain('Refinery merged feat/x into main');
        expect(ev.refs.map(r => r.kind)).toEqual(['commit', 'branch', 'task']);
        // the same merge is not recorded twice
        attachRefineMergeEvidence(meshId, 'node-7', { merged: true, branch: 'feat/x', into: 'main', mergedSha: 'deadbeef12', pushed: true });
        expect(items(mission.id).filter(i => i.kind === 'evidence')).toHaveLength(1);
    });
});

describe('retention (design §4.3, §13.1)', () => {
    it('closed missions older than 180 days collapse to one summary event; the per-mesh cap drops the oldest; hooked into the sweep', () => {
        const s = store();
        const m = write({ title: 'Ancient', itemsAdd: [{ text: 'x' }] });
        write({ id: m.record.id, status: 'completed', outcome: 'merged' });
        expect(events(m.record.id).length).toBeGreaterThan(2);
        s.db.prepare('UPDATE mesh_missions SET updated_at = ? WHERE id = ?').run(new Date(Date.now() - 200 * 86_400_000).toISOString(), m.record.id);

        const live = write({ title: 'Recent' });
        const liveBefore = events(live.record.id).length;

        const swept = pruneMeshRuntimeRetention();
        expect(swept.missionEvents).toBeGreaterThan(0);
        const left = events(m.record.id);
        expect(left).toHaveLength(1);
        expect(left[0].type).toBe('collapsed');
        expect(left[0].payload).toMatchObject({ status: 'completed', outcome: 'merged' });
        expect(events(live.record.id)).toHaveLength(liveBefore); // untouched
        // idempotent
        pruneMeshRuntimeRetention();
        expect(events(m.record.id)).toHaveLength(1);

        // per-mesh cap
        const ins = s.db.prepare("INSERT INTO mesh_mission_events (mission_id, mesh_id, type, actor, payload_json, at) VALUES (?, ?, 'item_added', 'test', '{}', ?)");
        s.db.transaction(() => { for (let i = 0; i < MISSION_EVENTS_PER_MESH_CAP + 50; i++) ins.run(live.record.id, meshId, new Date().toISOString()); })();
        s.missionItems().pruneEvents();
        const total = (s.db.prepare('SELECT COUNT(*) AS n FROM mesh_mission_events WHERE mesh_id = ?').get(meshId) as { n: number }).n;
        expect(total).toBe(MISSION_EVENTS_PER_MESH_CAP);
    });
});

describe('legacy mission_upsert IPC stays byte-compatible for callers that never send the capability flag', () => {
    it('a plain request answers with exactly the legacy mission keys; structured:true adds the new ones', async () => {
        const handler = turnLedgerIpcHandlers['mission_upsert'];
        const legacy: any = await handler({} as any, { v: 1, meshId, title: 'Plain', goal: 'g' });
        expect(legacy.success).toBe(true);
        expect(Object.keys(legacy.mission).sort()).toEqual(['goal', 'id', 'meshId', 'status', 'title']);
        expect(legacy.result).toBeUndefined();

        const structured: any = await handler({} as any, { v: 1, meshId, id: legacy.mission.id, title: 'Plain', structured: true, summary: 'now', itemsAdd: [{ text: 'a' }] });
        expect(structured.success).toBe(true);
        expect(structured.mission).toMatchObject({ summary: 'now', openItems: { remaining: 1, live_check: 0, decision: 0, evidence: 0 } });
        expect(structured.result.itemResults).toHaveLength(1);
        // an older-shaped request with an unknown key is still refused by the strict guard (unchanged behaviour)
        const bad: any = await handler({} as any, { v: 1, meshId, title: 'x', mystery: 1 });
        expect(bad.success).toBe(false);
    });
});
