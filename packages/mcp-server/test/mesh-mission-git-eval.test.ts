import assert from 'node:assert/strict';
import test from 'node:test';

import { ALL_MESH_TOOLS, meshMissionGitEval, meshMissionList } from '../src/tools/mesh-tools.js';
import { MESH_TOOL_DISPATCH } from '../src/tools/mesh-tool-dispatch.js';
import { TOOL_ANNOTATIONS } from '../src/tools/tool-annotations.js';

// Design 2026-11-01-mission-git-refs §6: the single-mission evaluation tool and `git: true` on the list.

function ctxWith(handler: (command: string, args: any) => unknown) {
    const calls: Array<{ command: string; args: any }> = [];
    const ctx: any = {
        mesh: { id: 'mesh-1', name: 'm', nodes: [{ id: 'n', workspace: '/repo' }], updatedAt: new Date().toISOString() },
        transport: {
            command: async (command: string, args: any) => { calls.push({ command, args }); return handler(command, args); },
        },
    };
    return { ctx, calls };
}

test('mesh_mission_git_eval is published, dispatchable and annotated read-only', () => {
    const tool = ALL_MESH_TOOLS.find(t => t.name === 'mesh_mission_git_eval') as any;
    assert.ok(tool, 'tool must be in ALL_MESH_TOOLS');
    assert.deepEqual(tool.inputSchema.required, ['mission_id']);
    assert.equal(typeof (MESH_TOOL_DISPATCH as any).mesh_mission_git_eval, 'function');
    assert.equal(TOOL_ANNOTATIONS.mesh_mission_git_eval.readOnlyHint, true);
    assert.equal(TOOL_ANNOTATIONS.mesh_mission_git_eval.destructiveHint, false);
    assert.match(tool.description, /never changes any mission/);
    const list = ALL_MESH_TOOLS.find(t => t.name === 'mesh_mission_list') as any;
    assert.equal(list.inputSchema.properties.git.type, 'boolean');
});

test('mesh_mission_git_eval: sends mission/refresh/verbose to the daemon and states what landed does not mean', async () => {
    const { ctx, calls } = ctxWith(() => ({ success: true, meshId: 'mesh-1', gitState: { missionId: 'mis-1', state: 'landed', counts: { total: 1, contained: 1, notContained: 0, unknown: 0 }, stale: false, refs: [] } }));
    const out = JSON.parse(await meshMissionGitEval(ctx, { mission_id: 'mis-1', refresh: true }));
    assert.equal(out.success, true);
    assert.equal(out.gitState.state, 'landed');
    assert.match(out.note, /not completion/);
    assert.equal(calls[0].command, 'mesh_mission_git_eval');
    assert.equal(calls[0].args.missionId, 'mis-1');
    assert.equal(calls[0].args.refresh, true);
    assert.equal(calls[0].args.meshId, 'mesh-1');
});

test('mesh_mission_git_eval: unknown is explained as "not an answer", a missing mission_id is refused, daemon errors pass through', async () => {
    const unknown = ctxWith(() => ({ success: true, gitState: { missionId: 'm', state: 'unknown', refs: [] } }));
    assert.match(JSON.parse(await meshMissionGitEval(unknown.ctx, { mission_id: 'm' })).note, /does not mean "not landed"/);
    const none = ctxWith(() => ({ success: true }));
    assert.equal(JSON.parse(await meshMissionGitEval(none.ctx, {})).success, false);
    assert.equal(none.calls.length, 0);
    const bad = ctxWith(() => ({ success: false, code: 'mission_not_found', error: 'mission \'x\' does not exist on this mesh' }));
    const res = JSON.parse(await meshMissionGitEval(bad.ctx, { mission_id: 'x' }));
    assert.equal(res.success, false);
    assert.equal(res.code, 'mission_not_found');
});

test('mesh_mission_list git:true attaches gitState/gitRefs from the daemon; without the flag no git command is sent; an old daemon does not break the list', async () => {
    const missionRow = { id: 'mis-1', meshId: 'mesh-1', title: 'T', goalPreview: 'g', goalTruncated: false, status: 'active', tasks: { total: 0, pending: 0, assigned: 0, completed: 0, failed: 0, cancelled: 0, blocked: 0, lastActivityAt: null } };
    const listResponse = { success: true, missions: [missionRow], historyFold: null, truncated: false, matched: 1 };
    const withGit = ctxWith((command) => command === 'mission_list_query'
        ? listResponse
        : { success: true, gitStates: { 'mis-1': { state: 'partial', partialUnknown: true, stale: true, refs: [{ refKey: 'commit::abc', status: 'unknown' }] } } });
    const out = JSON.parse(await meshMissionList(withGit.ctx, { git: true }));
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.missions[0].gitState, 'partial');
    assert.equal(out.missions[0].gitPartialUnknown, true);
    assert.equal(out.missions[0].gitStale, true);
    assert.equal(out.missions[0].gitRefs[0].status, 'unknown');
    const gitCall = withGit.calls.find(c => c.command === 'mesh_mission_git_eval');
    assert.deepEqual(gitCall?.args.missionIds, ['mis-1']);

    const plain = ctxWith(() => listResponse);
    const plainOut = JSON.parse(await meshMissionList(plain.ctx, {}));
    assert.equal(plainOut.missions[0].gitState, undefined);
    assert.equal(plain.calls.some(c => c.command === 'mesh_mission_git_eval'), false);

    const old = ctxWith((command) => { if (command === 'mission_list_query') return listResponse; throw new Error('unknown command'); });
    const oldOut = JSON.parse(await meshMissionList(old.ctx, { git: true }));
    assert.equal(oldOut.success, true);
    assert.equal(oldOut.missions[0].gitState, undefined);
});
