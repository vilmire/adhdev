import assert from 'node:assert/strict';
import test from 'node:test';
import { ALL_MESH_TOOLS } from '../src/tools/mesh-tool-schemas.js';
import { meshTaskStageDecide } from '../src/tools/mesh-tools-queue-manage.js';
import { validateMeshToolArgs } from '../src/tools/validate-tool-args.js';
const recovery = { v: 1 as const, review_task_id: 'child', expected_parent_revision: 8, expected_review_revision: 26,
    expected_stage_head_sha: 'a'.repeat(40), expected_head_sha: 'b'.repeat(40), expected_workspace: '/fixture/checkout',
    owner_decision_id: 'owner-answer', owner_answer_revision: 1, owner_option_id: 'a', difficulty: 'medium' as const,
    reviewer_provider: 'antigravity-cli', continuation_task_id: 'continuation', input_artifact_ids: ['art_report'], dry_run: true };
const terminalResume = { v: 2 as const, expected_parent_revision: 118,
    expected_stage_head_sha: 'fb928c2a4bba8d7b47d7ffdd79cc7a0f8c65f59b',
    expected_head_sha: 'd919a78f7c9e1fce8a891a394dd3224a74ae3944',
    expected_workspace: '/fixture/terminal-review-checkout',
    owner_decision_id: 'mi_cf4d2178ff17', owner_answer_revision: 1, owner_option_id: 'a', difficulty: 'medium' as const,
    reviewer_provider: 'antigravity-cli', continuation_task_id: 'fbb189f7-d149-4964-bbab-7e0dc812ac20',
    input_artifact_ids: ['art_e4ec721b0297e1aa'], dry_run: true };
test('existing stage decide advertises a strictly scoped versioned recovery schema without new global policy or a new tool', () => {
    const tool = ALL_MESH_TOOLS.find(t => t.name === 'mesh_task_stage_decide')!;
    const schema = (tool.inputSchema.properties as any).recovery;
    assert.equal(schema.additionalProperties, false); assert.equal(schema.properties.difficulty.const, 'medium');
    assert.equal(validateMeshToolArgs(tool.name, { task_id: 'parent', action: 'rereview', recovery }), null);
    assert.equal(validateMeshToolArgs(tool.name, { task_id: 'parent', action: 'rereview', recovery: terminalResume }), null);
    assert.deepEqual(schema.properties.v.enum, [1, 2]);
});
test('recovery preserves both CAS revisions, owner answer and exact input/head/cwd binding; never triggers or dispatches', async () => {
    const calls: any[] = [];
    const ctx = { mesh: { id: 'mesh' }, transport: { command: async (name: string, args: unknown) => { calls.push({ name, args }); return { success: true, dryRun: true, fingerprint: 'preview' }; } } } as any;
    const result = JSON.parse(await meshTaskStageDecide(ctx, { task_id: 'parent', action: 'rereview', recovery }));
    assert.equal(result.fingerprint, 'preview'); assert.equal(calls.length, 1); assert.equal(calls[0].name, 'stage_recover_mesh_review');
    assert.deepEqual(calls[0].args, { v: 1, meshId: 'mesh', parentTaskId: 'parent', reviewTaskId: 'child', expectedParentRevision: 8, expectedReviewRevision: 26,
        expectedStageHeadSha: 'a'.repeat(40), expectedHeadSha: 'b'.repeat(40), expectedWorkspace: '/fixture/checkout', ownerDecisionId: 'owner-answer', ownerAnswerRevision: 1, ownerOptionId: 'a',
        difficulty: 'medium', reviewerProvider: 'antigravity-cli', continuationTaskId: 'continuation', inputArtifactIds: ['art_report'], dryRun: true });
    const denied = JSON.parse(await meshTaskStageDecide(ctx, { task_id: 'parent', action: 'accept', recovery }));
    assert.equal(denied.error, 'review_recovery_requires_rereview'); assert.equal(calls.length, 1);
    const forced = JSON.parse(await meshTaskStageDecide(ctx, { task_id: 'parent', action: 'rereview', recovery: { ...recovery, force: true } as any }));
    assert.equal(forced.error, 'invalid_stage_review_recovery'); assert.equal(calls.length, 1);
});
test('forwards terminal review resume (v2) wire args and rejects review_task_id, missing continuation or caller source-anchor fields', async () => {
    const calls: any[] = [];
    const ctx = { mesh: { id: 'mesh' }, transport: { command: async (name: string, args: unknown) => { calls.push({ name, args }); return { success: true, v: 2, dryRun: true, round: 6, fingerprint: 'fp2' }; } } } as any;
    const preview = JSON.parse(await meshTaskStageDecide(ctx, { task_id: '3e2b83f3-b933-4c73-bd27-186c2720fb16', action: 'rereview', recovery: terminalResume }));
    assert.equal(preview.round, 6); assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, {
        v: 2, meshId: 'mesh', parentTaskId: '3e2b83f3-b933-4c73-bd27-186c2720fb16',
        expectedParentRevision: 118,
        expectedStageHeadSha: 'fb928c2a4bba8d7b47d7ffdd79cc7a0f8c65f59b',
        expectedHeadSha: 'd919a78f7c9e1fce8a891a394dd3224a74ae3944',
        expectedWorkspace: '/fixture/terminal-review-checkout',
        ownerDecisionId: 'mi_cf4d2178ff17', ownerAnswerRevision: 1, ownerOptionId: 'a',
        difficulty: 'medium', reviewerProvider: 'antigravity-cli',
        continuationTaskId: 'fbb189f7-d149-4964-bbab-7e0dc812ac20',
        inputArtifactIds: ['art_e4ec721b0297e1aa'], dryRun: true,
    });
    for (const bad of [
        { ...terminalResume, review_task_id: 'child' },
        { ...terminalResume, expected_review_revision: 5 },
        { ...terminalResume, continuation_task_id: undefined },
        { ...terminalResume, source_provider: 'claude-cli' },
        { ...terminalResume, implementer_session_id: 'impl' },
        { ...terminalResume, v: 3 },
    ]) {
        const res = JSON.parse(await meshTaskStageDecide(ctx, { task_id: 'parent', action: 'rereview', recovery: bad as any }));
        assert.equal(res.error, 'invalid_stage_review_recovery');
    }
    assert.equal(calls.length, 1);
});
test('apply fingerprint is transmitted unchanged; old-runtime refusal is surfaced without fallback or acceptance', async () => {
    const ctx = { mesh: { id: 'mesh' }, transport: { command: async (name: string, args: any) => {
        assert.equal(name, 'stage_recover_mesh_review'); assert.equal(args.expectedFingerprint, 'exact-preview'); assert.equal(args.dryRun, false); assert.equal(args.expectedArtifactDigest, 'c'.repeat(64));
        return { success: false, error: 'unknown command' };
    } } } as any;
    assert.deepEqual(JSON.parse(await meshTaskStageDecide(ctx, { task_id: 'parent', action: 'rereview', recovery: { ...recovery, dry_run: false, expected_fingerprint: 'exact-preview', expected_artifact_digest: 'c'.repeat(64) } })), { success: false, error: 'unknown command' });
});
