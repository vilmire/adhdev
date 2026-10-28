import assert from 'node:assert/strict';
import test from 'node:test';

import { getMeshMission } from '@adhdev/daemon-core';
import { meshMissionList, meshMissionUpsert } from '../src/tools/mesh-tools.js';
import { reportCompletion } from '../src/tools/worker-tools.js';
import { MeshRuntimeStore } from '../../daemon-core/src/mesh/mesh-runtime-store.js';
import { makeFakeTurnIpcTransport } from './fake-turn-ipc-transport.js';
import { validateMeshToolArgs } from '../src/tools/validate-tool-args.js';

// Structured missions bundle A, through the REAL tool → IPC → daemon-handler path
// (design 2026-10-28 §5.1, §5.2, §13.1 "버전 혼재").

function buildCtx(meshId: string, transport: any = makeFakeTurnIpcTransport()): any {
    return { mesh: { id: meshId }, transport, localDaemonId: 'daemon-A', localMachineId: 'machine-A' };
}
function cleanup(meshId: string): void {
    try { MeshRuntimeStore.getInstance().clearMissionsForMesh(meshId); } catch { /* fresh store */ }
}
const parse = (raw: string) => JSON.parse(raw);

/** A daemon that predates structured missions: its strict wire guard refuses any request carrying a new key. */
function legacyDaemonTransport(sent: Array<{ type: string; args: any }>) {
    const real = makeFakeTurnIpcTransport() as any;
    const NEW_KEYS = ['structured', 'summary', 'outcome', 'outcomeReason', 'carryOverTo', 'toCarryOver', 'itemsAdd', 'itemsUpdate', 'items', 'history'];
    return {
        async command(type: string, args: Record<string, unknown> = {}) {
            sent.push({ type, args });
            if (NEW_KEYS.some((k) => k in args)) return { success: false, error: `${type}: request failed decode (bad shape)` };
            return real.command(type, args);
        },
        async ping() { return true; },
    } as any;
}

test('close with open items: not rejected, movedItems/movedTo reported, reopen restores them (acceptance #1)', async () => {
    const meshId = 'mesh-structured-close';
    cleanup(meshId);
    try {
        const ctx = buildCtx(meshId);
        const created = parse(await meshMissionUpsert(ctx, {
            title: 'Ship it', summary: 'half done',
            items_add: [{ text: 'write docs' }, { kind: 'live_check', text: 'verify on mac', machine: 'mac' }],
        } as any));
        assert.equal(created.success, true);
        assert.equal(created.mission.summary, 'half done');
        assert.deepEqual(created.mission.openItems, { remaining: 1, live_check: 1, decision: 0, evidence: 0 });
        assert.equal(created.itemResults.length, 2);

        const closed = parse(await meshMissionUpsert(ctx, { mission_id: created.mission.id, status: 'completed', outcome: 'merged' } as any));
        assert.equal(closed.success, true);
        assert.equal(closed.mission.status, 'completed');
        assert.equal(closed.movedItems, 2);
        assert.ok(closed.movedTo);
        assert.equal(closed.mission.outcome, 'merged');
        assert.equal(getMeshMission(meshId, closed.movedTo)?.isCarryOver, true);

        const reopened = parse(await meshMissionUpsert(ctx, { mission_id: created.mission.id, status: 'active' } as any));
        assert.equal(reopened.restoredItems, 2);
        assert.deepEqual(reopened.mission.openItems, { remaining: 1, live_check: 1, decision: 0, evidence: 0 });
    } finally { cleanup(meshId); }
});

test('bulk close follows the same carry-over rules and reports per-mission movedItems', async () => {
    const meshId = 'mesh-structured-bulk';
    cleanup(meshId);
    try {
        const ctx = buildCtx(meshId);
        const a = parse(await meshMissionUpsert(ctx, { title: 'A', items_add: [{ text: 'a-left' }] } as any));
        const b = parse(await meshMissionUpsert(ctx, { title: 'B' } as any));
        const res = parse(await meshMissionUpsert(ctx, { mission_ids: [a.mission.id, b.mission.id], status: 'abandoned', outcome: 'not_needed' } as any));
        assert.equal(res.success, true);
        assert.equal(res.results.find((r: any) => r.id === a.mission.id).movedItems, 1);
        assert.equal(res.results.find((r: any) => r.id === b.mission.id).movedItems, undefined);
        assert.equal(getMeshMission(meshId, a.mission.id)?.outcome, 'not_needed');
    } finally { cleanup(meshId); }
});

test('decision requests dedupe; no mission_id/title files into the carry-over mission (acceptance #3)', async () => {
    const meshId = 'mesh-structured-decision';
    cleanup(meshId);
    try {
        const ctx = buildCtx(meshId);
        const first = parse(await meshMissionUpsert(ctx, { items_add: [{ kind: 'decision', question: 'Ship the budget?', options: [{ label: 'yes' }, { label: 'no' }], recommended: 'a', urgency: 'blocking' }] } as any));
        assert.equal(first.success, true);
        assert.equal(first.mission.carryOver, true);
        const id = first.itemResults[0].id;
        const second = parse(await meshMissionUpsert(ctx, { items_add: [{ kind: 'decision', question: 'ship the budget' }] } as any));
        assert.equal(second.itemResults[0].id, id);
        assert.equal(second.itemResults[0].deduped, true);
        // a coordinator tries to answer its own question — refused
        const cheat = parse(await meshMissionUpsert(ctx, { mission_id: first.mission.id, items_update: [{ id, state: 'answered' }] } as any));
        assert.match(cheat.itemResults[0].error, /decision_answer_not_allowed/);
        // camelCase aliases are accepted on the nested items, like on the rest of the schema
        assert.equal(validateMeshToolArgs('mesh_mission_upsert', { items_add: [{ kind: 'decision', question: 'q', dueAt: '2026-11-01T00:00:00Z', onDue: 'remind', allowFreeText: true }] }), null);
        assert.match(validateMeshToolArgs('mesh_mission_upsert', { items_add: [{ text: 'x', bogus: 1 }] }) ?? '', /Unknown parameter/);
        assert.match(validateMeshToolArgs('mesh_mission_upsert', { outcome: 'because' }) ?? '', /Invalid value/);
    } finally { cleanup(meshId); }
});

test('a single upsert with neither title nor mission_id nor items is still refused', async () => {
    const meshId = 'mesh-structured-notitle';
    const res = parse(await meshMissionUpsert(buildCtx(meshId), { summary: 'x' } as any));
    assert.equal(res.success, false);
    assert.equal(res.code, 'mission_title_required');
});

test('mesh_mission_list: summary / outcome / openItems by default, items:true and history:true on request', async () => {
    const meshId = 'mesh-structured-list';
    cleanup(meshId);
    try {
        const ctx = buildCtx(meshId);
        const m = parse(await meshMissionUpsert(ctx, { title: 'Listed', goal: 'g1', summary: 'one line', items_add: [{ text: 'left' }, { kind: 'decision', question: 'Q?' }] } as any));
        await meshMissionUpsert(ctx, { mission_id: m.mission.id, goal: 'g2' } as any);
        const plain = parse(await meshMissionList(ctx, {} as any));
        const row = plain.missions.find((x: any) => x.id === m.mission.id);
        assert.equal(row.summary, 'one line');
        assert.deepEqual(row.openItems, { remaining: 1, live_check: 0, decision: 1, evidence: 0 });
        assert.equal(row.items, undefined);
        assert.equal(row.history, undefined);

        const full = parse(await meshMissionList(ctx, { items: true, history: true } as any));
        const frow = full.missions.find((x: any) => x.id === m.mission.id);
        assert.equal(frow.items.length, 2);
        assert.ok(frow.history.some((e: any) => e.type === 'goal_changed' && e.payload.previousGoal === 'g1'));

        const closed = parse(await meshMissionUpsert(ctx, { mission_id: m.mission.id, status: 'completed', outcome: 'verified_live', outcome_reason: 'checked on prod' } as any));
        assert.equal(closed.success, true);
        const done = parse(await meshMissionList(ctx, { status: ['completed'] } as any));
        assert.equal(done.missions[0].outcome, 'verified_live');
        assert.equal(done.missions[0].outcomeReason, 'checked on prod');
    } finally { cleanup(meshId); }
});

test('mixed versions: a plain call reaches an OLDER daemon without any new key; a structured call fails with a clear message', async () => {
    const meshId = 'mesh-structured-legacy-daemon';
    cleanup(meshId);
    try {
        const sent: Array<{ type: string; args: any }> = [];
        const ctx = buildCtx(meshId, legacyDaemonTransport(sent));
        const plain = parse(await meshMissionUpsert(ctx, { title: 'Plain on old daemon', goal: 'g' } as any));
        assert.equal(plain.success, true);
        // first attempt carried only the capability flag; the retry carried nothing new
        assert.equal(sent.length, 2);
        assert.equal(sent[0].args.structured, true);
        assert.equal('structured' in sent[1].args, false);
        assert.deepEqual(Object.keys(plain.mission).sort(), ['goal', 'id', 'meshId', 'status', 'title']);

        const list = parse(await meshMissionList(ctx, {} as any));
        assert.equal(list.success, true);
        assert.equal(list.missions.length, 1);
        assert.equal(list.missions[0].summary, undefined);

        const structured = parse(await meshMissionUpsert(ctx, { title: 'Needs new daemon', items_add: [{ text: 'x' }] } as any));
        assert.equal(structured.success, false);
        assert.match(structured.error, /predates structured missions/);
    } finally { cleanup(meshId); }
});

test('mixed versions: an OLD mcp-server (no capability flag) gets responses with exactly the legacy keys', async () => {
    const meshId = 'mesh-structured-legacy-client';
    cleanup(meshId);
    try {
        const transport = makeFakeTurnIpcTransport() as any;
        const created = await transport.command('mission_upsert', { v: 1, meshId, title: 'Old client' });
        // Write some structured state from a "new" client, then read it through the old client's request.
        await transport.command('mission_upsert', { v: 1, meshId, id: created.mission.id, title: 'Old client', structured: true, summary: 'new thing', itemsAdd: [{ text: 'x' }] });
        const again = await transport.command('mission_upsert', { v: 1, meshId, id: created.mission.id, title: 'Old client', goal: 'edited by old client' });
        assert.deepEqual(Object.keys(again.mission).sort(), ['goal', 'id', 'meshId', 'status', 'title']);
        assert.equal(again.result, undefined);
        const list = await transport.command('mission_list_query', { v: 1, meshId });
        assert.deepEqual(Object.keys(list.missions[0]).sort(), ['goalPreview', 'goalTruncated', 'id', 'meshId', 'status', 'tasks', 'title']);
    } finally { cleanup(meshId); }
});

// ─── report_completion: decisions_needed / commits ───────────────────────────

function capturingTransport(capture: { last?: any }) {
    return {
        async command(_type: string, args: any) { capture.last = args; return { success: true, taskId: 't1', outcome: 'completed' }; },
        async ping() { return true; },
    } as any;
}

test('report_completion: new optional fields are forwarded only when the worker used them (old owner daemons see an ordinary report)', async () => {
    const plain: { last?: any } = {};
    await reportCompletion(capturingTransport(plain), { bind: 'wsb_x' }, { outcome: 'completed', summary: 'done', touched_files: ['a.ts'] });
    assert.deepEqual(Object.keys(plain.last.report).sort(), ['outcome', 'summary', 'touchedFiles']);

    const rich: { last?: any } = {};
    await reportCompletion(capturingTransport(rich), { bind: 'wsb_x' }, {
        outcome: 'completed', summary: 'done', touched_files: ['a.ts'],
        decisions_needed: [{ question: 'Which DB?', options: [{ label: 'sqlite' }, { label: 'pg' }] }],
        commits: ['abc1234'],
    });
    assert.deepEqual(rich.last.report.commits, ['abc1234']);
    assert.equal(rich.last.report.decisionsNeeded[0].question, 'Which DB?');
});
