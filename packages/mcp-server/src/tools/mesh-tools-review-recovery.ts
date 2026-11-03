import type { MeshContext } from './mesh-tools-internal.js';

/** An explicit versioned branch of stage_decide/rereview, never a generic difficulty override. */
export const STAGE_REVIEW_RECOVERY_SCHEMA = {
    type: 'object' as const, additionalProperties: false,
    required: ['v', 'review_task_id', 'expected_parent_revision', 'expected_review_revision', 'expected_stage_head_sha', 'expected_head_sha', 'expected_workspace', 'owner_decision_id', 'owner_answer_revision', 'owner_option_id', 'difficulty', 'reviewer_provider', 'input_artifact_ids', 'dry_run'],
    properties: {
        v: { const: 1 }, review_task_id: { type: 'string' },
        expected_parent_revision: { type: 'integer', minimum: 0 }, expected_review_revision: { type: 'integer', minimum: 0 },
        expected_stage_head_sha: { type: 'string', pattern: '^[a-f0-9]{40,64}$' }, expected_head_sha: { type: 'string', pattern: '^[a-f0-9]{40,64}$' },
        expected_workspace: { type: 'string', description: 'Exact canonical source checkout, compared with authenticated local node context.' },
        owner_decision_id: { type: 'string' }, owner_answer_revision: { type: 'integer', minimum: 0 }, owner_option_id: { const: 'a', description: 'The persisted owner decision must explicitly offer option a as approval for this child only at medium.' },
        difficulty: { const: 'medium' }, reviewer_provider: { type: 'string' }, continuation_task_id: { type: 'string' },
        input_artifact_ids: { type: 'array', maxItems: 8, items: { type: 'string' } },
        expected_artifact_digest: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Apply only: exact artifact/provenance digest returned by dry_run.' },
        dry_run: { type: 'boolean' }, expected_fingerprint: { type: 'string', minLength: 1, maxLength: 4096, description: 'Apply only: exact fingerprint returned by dry_run.' },
    },
};
export interface StageReviewRecoveryArgs {
    v: 1; review_task_id: string; expected_parent_revision: number; expected_review_revision: number;
    expected_stage_head_sha: string; expected_head_sha: string; expected_workspace: string;
    owner_decision_id: string; owner_answer_revision: number; owner_option_id: string;
    difficulty: 'medium'; reviewer_provider: string; continuation_task_id?: string; input_artifact_ids: string[];
    dry_run: boolean; expected_fingerprint?: string; expected_artifact_digest?: string;
}
export async function meshRecoverPendingReview(ctx: MeshContext, parentTaskId: string, r: StageReviewRecoveryArgs): Promise<string> {
    if (!r || typeof r !== 'object' || Array.isArray(r)
        || Object.keys(r).some(k => !(k in STAGE_REVIEW_RECOVERY_SCHEMA.properties))
        || STAGE_REVIEW_RECOVERY_SCHEMA.required.some(k => !(k in r))
        || r.v !== 1 || r.difficulty !== 'medium' || r.owner_option_id !== 'a') return JSON.stringify({ success: false, error: 'invalid_stage_review_recovery' });
    return JSON.stringify(await ctx.transport.command('stage_recover_mesh_review', {
        v: r.v, meshId: ctx.mesh.id, parentTaskId, reviewTaskId: r.review_task_id,
        expectedParentRevision: r.expected_parent_revision, expectedReviewRevision: r.expected_review_revision,
        expectedStageHeadSha: r.expected_stage_head_sha, expectedHeadSha: r.expected_head_sha, expectedWorkspace: r.expected_workspace,
        ownerDecisionId: r.owner_decision_id, ownerAnswerRevision: r.owner_answer_revision, ownerOptionId: r.owner_option_id,
        difficulty: r.difficulty, reviewerProvider: r.reviewer_provider, inputArtifactIds: r.input_artifact_ids, dryRun: r.dry_run,
        ...(r.continuation_task_id !== undefined ? { continuationTaskId: r.continuation_task_id } : {}),
        ...(r.expected_artifact_digest !== undefined ? { expectedArtifactDigest: r.expected_artifact_digest } : {}),
        ...(r.expected_fingerprint !== undefined ? { expectedFingerprint: r.expected_fingerprint } : {}),
    }));
}
