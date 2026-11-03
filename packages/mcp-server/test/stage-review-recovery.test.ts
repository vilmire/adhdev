import assert from 'node:assert/strict';
import test from 'node:test';
import { ALL_MESH_TOOLS } from '../src/tools/mesh-tool-schemas.js';
import { meshTaskStageDecide } from '../src/tools/mesh-tools-queue-manage.js';
import { validateMeshToolArgs } from '../src/tools/validate-tool-args.js';
const recovery = { v: 1 as const, review_task_id: 'child', expected_parent_revision: 8, expected_review_revision: 26,
    expected_stage_head_sha: 'a'.repeat(40), expected_head_sha: 'b'.repeat(40), expected_workspace: '/fixture/checkout',
    owner_decision_id: 'owner-answer', owner_answer_revision: 1, owner_option_id: 'a', difficulty: 'medium' as const,
    reviewer_provider: 'antigravity-cli', continuation_task_id: 'continuation', input_artifact_ids: ['art_report'], dry_run: true };
test('existing stage decide advertises a strictly scoped versioned recovery schema without new global policy or a new tool', () => {
    const tool = ALL_MESH_TOOLS.find(t => t.name === 'mesh_task_stage_decide')!;
    const schema = (tool.inputSchema.properties as any).recovery;
    assert.equal(schema.additionalProperties, false); assert.equal(schema.properties.difficulty.const, 'medium');
    assert.equal(validateMeshToolArgs(tool.name, { task_id: 'parent', action: 'rereview', recovery }), null);
    assert.equal(schema.properties.v.const, 1);
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
test('apply fingerprint is transmitted unchanged; old-runtime refusal is surfaced without fallback or acceptance', async () => {
    const ctx = { mesh: { id: 'mesh' }, transport: { command: async (name: string, args: any) => {
        assert.equal(name, 'stage_recover_mesh_review'); assert.equal(args.expectedFingerprint, 'exact-preview'); assert.equal(args.dryRun, false); assert.equal(args.expectedArtifactDigest, 'c'.repeat(64));
        return { success: false, error: 'unknown command' };
    } } } as any;
    assert.deepEqual(JSON.parse(await meshTaskStageDecide(ctx, { task_id: 'parent', action: 'rereview', recovery: { ...recovery, dry_run: false, expected_fingerprint: 'exact-preview', expected_artifact_digest: 'c'.repeat(64) } })), { success: false, error: 'unknown command' });
});
