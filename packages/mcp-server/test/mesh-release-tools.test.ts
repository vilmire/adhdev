import assert from 'node:assert/strict';
import test from 'node:test';

import { ALL_MESH_TOOLS, meshReleaseChangelogDraft, meshReleaseList, meshReleaseRecordDeploy, meshReleaseScope, meshReleaseUpsert } from '../src/tools/mesh-tools.js';
import { MESH_TOOL_DISPATCH } from '../src/tools/mesh-tool-dispatch.js';
import { TOOL_ANNOTATIONS } from '../src/tools/tool-annotations.js';
import { CANONICAL_MESH_TOOL_NAMES } from '@adhdev/mesh-shared';
import { canonicalizeMeshToolArgs, validateMeshToolArgs } from '../src/tools/validate-tool-args.js';

// Design 2026-11-01-release-objects §5: the five tools are thin wrappers; authority is the daemon's.
const NAMES = ['mesh_release_upsert', 'mesh_release_scope', 'mesh_release_list', 'mesh_release_record_deploy', 'mesh_release_changelog_draft'];

function ctxWith(handler: (command: string, args: any) => unknown) {
    const calls: Array<{ command: string; args: any }> = [];
    const ctx: any = {
        mesh: { id: 'mesh-1', name: 'm', nodes: [], updatedAt: new Date().toISOString() },
        transport: { command: async (command: string, args: any) => { calls.push({ command, args }); return handler(command, args); } },
    };
    return { ctx, calls };
}

test('the release tools are published, named canonically, dispatchable and annotated', () => {
    for (const name of NAMES) {
        assert.ok(ALL_MESH_TOOLS.some(t => t.name === name), `${name} published`);
        assert.ok((CANONICAL_MESH_TOOL_NAMES as readonly string[]).includes(name), `${name} canonical`);
        assert.equal(typeof (MESH_TOOL_DISPATCH as any)[name], 'function', `${name} dispatchable`);
        assert.ok(TOOL_ANNOTATIONS[name], `${name} annotated`);
        assert.equal(TOOL_ANNOTATIONS[name].destructiveHint, false);
    }
    assert.equal(TOOL_ANNOTATIONS.mesh_release_list.readOnlyHint, true);
    const mission = ALL_MESH_TOOLS.find(t => t.name === 'mesh_mission_upsert') as any;
    assert.equal(mission.inputSchema.properties.release_note.type, 'string');
});

test('daemon command names match the tools (script <-> daemon name contract)', async () => {
    const seen: string[] = [];
    const { ctx } = ctxWith((command) => { seen.push(command); return { success: true }; });
    await meshReleaseUpsert(ctx, { name: 'x', channel: 'preview' });
    await meshReleaseScope(ctx, { release_id: 'rel_1', add: ['m'] });
    await meshReleaseList(ctx, {});
    await meshReleaseRecordDeploy(ctx, { channel: 'preview' });
    await meshReleaseChangelogDraft(ctx, { release_id: 'rel_1' });
    assert.deepEqual(seen, ['release_upsert', 'release_scope', 'release_list', 'release_record_deploy', 'release_changelog_draft']);
});

test('scope: forwards add/move/remove with camel-cased ids, refuses a missing release_id, passes daemon refusals through', async () => {
    const { ctx, calls } = ctxWith(() => ({ success: true, meshId: 'mesh-1', release: { id: 'rel_1' }, changes: [{ missionId: 'm', op: 'added' }], suggestedMissions: [] }));
    const out = JSON.parse(await meshReleaseScope(ctx, { release_id: 'rel_1', add: ['a', ' '], move: [{ mission_id: 'b', to_release_id: 'rel_2' }], remove: ['c'] }));
    assert.equal(out.success, true);
    assert.equal(out.changes[0].op, 'added');
    assert.deepEqual(calls[0].args, { meshId: 'mesh-1', releaseId: 'rel_1', add: ['a'], move: [{ missionId: 'b', toReleaseId: 'rel_2' }], remove: ['c'] });
    assert.equal(JSON.parse(await meshReleaseScope(ctx, {})).success, false);
    const denied = ctxWith(() => ({ success: false, code: 'release_not_allowed', error: 'worker credentials cannot change release state' }));
    assert.deepEqual(JSON.parse(await meshReleaseScope(denied.ctx, { release_id: 'rel_1', add: ['a'] })), { success: false, error: 'worker credentials cannot change release state', code: 'release_not_allowed' });
});

test('record_deploy defaults to auto, only forwards actor script, and carries the target snapshot', async () => {
    const { ctx, calls } = ctxWith(() => ({ success: true, release: { id: 'rel_1' }, warnings: ['no CHANGELOG draft yet'], needsNote: [] }));
    const out = JSON.parse(await meshReleaseRecordDeploy(ctx, { channel: 'preview', version: '1.0.82-rc.34', commit: 'abc', targets: { npm: { commit: 'abc' } }, actor: 'script' }));
    assert.deepEqual(out.warnings, ['no CHANGELOG draft yet']);
    assert.deepEqual(calls[0].args, { meshId: 'mesh-1', releaseId: 'auto', channel: 'preview', version: '1.0.82-rc.34', commit: 'abc', targets: { npm: { commit: 'abc' } }, actor: 'script' });
    await meshReleaseRecordDeploy(ctx, { channel: 'stable', actor: 'owner' as any });
    assert.equal('actor' in calls[1].args, false);
});

test('the argument validator canonicalizes camelCase and rejects unknown keys for the release tools', () => {
    const canon = canonicalizeMeshToolArgs('mesh_release_scope', { releaseId: 'rel_1', add: ['m'], move: [{ missionId: 'a', toReleaseId: 'b' }] }) as any;
    assert.equal(canon.release_id, 'rel_1');
    assert.deepEqual(canon.move, [{ mission_id: 'a', to_release_id: 'b' }]);
    assert.equal(validateMeshToolArgs('mesh_release_scope', { release_id: 'rel_1', add: ['m'] }), null);
    assert.match(String(validateMeshToolArgs('mesh_release_scope', { release_id: 'rel_1', mission: 'm' })), /mission/);
});
