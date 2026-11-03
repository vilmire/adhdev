/** Owner-authorized repair of ONE never-started managed review; never releases a writer claim. */
import { execFileSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';
import type { StageRuntimePorts } from './stage-ports.js';
import { attestStageReviewInput, stageReviewArtifactGrants } from './stage-review-input.js';
import { selectStageInputArtifacts } from './stage-state.js';
import { reviewInputBusy } from './mesh-task-routing-contract.js';
import { isTaskDispatchInFlight } from './mesh-task-inflight.js';
import { findOpenQueueAttempt } from './mesh-queue-attempt-guard.js';

export interface StageReviewRecoveryRequest {
    v: 1; meshId: string; parentTaskId: string; reviewTaskId: string;
    expectedParentRevision: number; expectedReviewRevision: number;
    expectedStageHeadSha: string; expectedHeadSha: string; expectedWorkspace: string;
    ownerDecisionId: string; ownerAnswerRevision: number; ownerOptionId: string;
    difficulty: 'medium'; reviewerProvider: string;
    continuationTaskId?: string; inputArtifactIds: string[];
    dryRun: boolean; expectedFingerprint?: string; expectedArtifactDigest?: string;
}
export interface StageReviewRecoveryHost { actor: string; repoIdentity: string; machineId: string; nodeId: string; workspace: string }
export interface StageReviewRecoveryAudit {
    at: string; actor: string; parentRevision: number; reviewRevision: number;
    ownerDecisionId: string; ownerAnswerRevision: number; ownerOptionId: string;
    previousHeadSha: string; headSha: string; previousFingerprint?: string; previousFingerprintUnavailable?: boolean; fingerprint: string;
    previousProof?: MeshWorkQueueEntry['stageReviewInput']; previousSelfCheck?: string;
    previousChild: Pick<MeshWorkQueueEntry, 'difficulty' | 'inputArtifactIds' | 'targetNodeId' | 'targetSessionId' | 'routingPreferences' | 'autoLaunch' | 'hold' | 'holdNoticeId'>;
    artifactIds: string[]; artifactDigest: string; diffSha256: string;
}
const keys = ['v', 'meshId', 'parentTaskId', 'reviewTaskId', 'expectedParentRevision', 'expectedReviewRevision', 'expectedStageHeadSha', 'expectedHeadSha', 'expectedWorkspace', 'ownerDecisionId', 'ownerAnswerRevision', 'ownerOptionId', 'difficulty', 'reviewerProvider', 'continuationTaskId', 'inputArtifactIds', 'dryRun', 'expectedFingerprint', 'expectedArtifactDigest'];
export function decodeStageReviewRecovery(value: unknown): StageReviewRecoveryRequest {
    const r = value as StageReviewRecoveryRequest;
    if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some(k => !keys.includes(k)) || r.v !== 1
        || ['meshId', 'parentTaskId', 'reviewTaskId', 'ownerDecisionId', 'ownerOptionId', 'reviewerProvider'].some(k => typeof (r as any)[k] !== 'string' || !(r as any)[k].trim())
        || ![r.expectedParentRevision, r.expectedReviewRevision, r.ownerAnswerRevision].every(n => Number.isSafeInteger(n) && n >= 0)
        || ![r.expectedStageHeadSha, r.expectedHeadSha].every(s => typeof s === 'string' && /^[a-f0-9]{40,64}$/.test(s))
        || typeof r.expectedWorkspace !== 'string' || !isAbsolute(r.expectedWorkspace)
        || r.ownerOptionId !== 'a' || r.difficulty !== 'medium' || typeof r.dryRun !== 'boolean'
        || !Array.isArray(r.inputArtifactIds) || r.inputArtifactIds.length > 8 || r.inputArtifactIds.some(s => typeof s !== 'string' || !s.trim())
        || (r.continuationTaskId !== undefined && (typeof r.continuationTaskId !== 'string' || !r.continuationTaskId.trim()))
        || (!r.dryRun && (typeof r.expectedArtifactDigest !== 'string' || !/^[a-f0-9]{64}$/.test(r.expectedArtifactDigest)))
        || (r.expectedArtifactDigest !== undefined && (typeof r.expectedArtifactDigest !== 'string' || !/^[a-f0-9]{64}$/.test(r.expectedArtifactDigest)))
        || (!r.dryRun && (typeof r.expectedFingerprint !== 'string' || !r.expectedFingerprint))
        || (r.expectedFingerprint !== undefined && (typeof r.expectedFingerprint !== 'string' || r.expectedFingerprint.length > 4096))) throw new Error('invalid_stage_review_recovery');
    return r;
}

export async function recoverPendingStageReview(request: StageReviewRecoveryRequest, host: StageReviewRecoveryHost, ports: Pick<StageRuntimePorts, 'git' | 'artifacts'>) {
    const r = decodeStageReviewRecovery(request);
    if (!host.actor || !host.machineId || !host.repoIdentity || !host.nodeId || !host.workspace) throw new Error('authenticated_local_host_required');
    const store = MeshRuntimeStore.getInstance();
    const check = () => {
        const parent = store.findQueueEntryById(r.meshId, r.parentTaskId);
        const child = store.findQueueEntryById(r.meshId, r.reviewTaskId);
        if (!parent || !child || !parent.stagePlan || parent.status !== 'assigned' || parent.stageState?.phase !== 'awaiting_review' || parent.stageState.released
            || child.status !== 'pending' || !child.readonly || child.origin !== 'stage' || child.stageRole !== 'review'
            || child.parentTaskId !== parent.id || child.review?.sourceTaskId !== parent.id || child.stageRound !== parent.stageState.round
            || parent.stageState.reviewTaskIds.at(-1) !== child.id || child.reviewerWorkspace) throw new Error('pending_managed_review_required');
        if ((parent.revision ?? 0) !== r.expectedParentRevision || (child.revision ?? 0) !== r.expectedReviewRevision) throw new Error('stale_review_recovery_cas');
        if (parent.stageState.stageHeads.at(-1)?.rootSha !== r.expectedStageHeadSha) throw new Error('review_stage_head_mismatch');
        if (parent.assignedNodeId !== host.nodeId) throw new Error('review_source_node_mismatch');
        if (child.assignedSessionId || child.attemptId || child.dispatchTimestamp || child.autoLaunch?.sessionId
            || ['started', 'completed'].includes(child.autoLaunch?.status ?? '') || isTaskDispatchInFlight(r.meshId, child.id)
            || store.turnStore().findLatestAttemptForTask(r.meshId, child.id)) throw new Error('review_already_started');
        if (isTaskDispatchInFlight(r.meshId, parent.id) || findOpenQueueAttempt(store.turnStore(), r.meshId, parent.id)) throw new Error('review_source_attempt_active');
        if (child.difficulty !== 'difficult') throw new Error('review_difficulty_transition_required');
        if (child.review.independence !== 'fresh_session' && r.reviewerProvider === parent.assignedProviderType) throw new Error('review_independence_required');
        // An authoritative owner answer, scoped to this exact task and answer revision. Never accepts a caller's by/via assertion.
        const item = store.missionItems().getItem(r.meshId, r.ownerDecisionId);
        if (!item || item.kind !== 'decision' || item.state !== 'answered' || item.missionId !== parent.missionId
            || item.decision?.answer?.by !== 'owner' || !['dashboard', 'cli'].includes(item.decision.answer.via ?? '')
            || item.decision.answer.optionId !== r.ownerOptionId || item.decision.answerRevision !== r.ownerAnswerRevision
            || !item.decision.options.some(o => o.id === r.ownerOptionId)
            || item.refs?.filter(ref => ref.kind === 'task').length !== 1 || !item.refs.some(ref => ref.kind === 'task' && ref.value === child.id)) throw new Error('review_owner_authorization_required');
        let continuation: MeshWorkQueueEntry | undefined;
        if (r.continuationTaskId) {
            continuation = store.findQueueEntryById(r.meshId, r.continuationTaskId) ?? undefined;
            if (!continuation || continuation.id === parent.id || continuation.status !== 'completed' || continuation.taskMode !== 'code_change'
                || continuation.missionId !== parent.missionId || !parent.assignedSessionId || continuation.assignedSessionId !== parent.assignedSessionId
                || continuation.assignedNodeId !== parent.assignedNodeId) throw new Error('review_continuation_evidence_mismatch');
        }
        if (r.expectedHeadSha !== r.expectedStageHeadSha && !continuation) throw new Error('review_continuation_required');
        for (const id of r.inputArtifactIds) {
            const artifact = store.db.prepare('SELECT task_id, mesh_id, producer_role FROM session_artifacts WHERE artifact_id = ?').get(id) as any;
            if (!artifact || artifact.mesh_id !== parent.meshId || ![parent.id, continuation?.id].includes(artifact.task_id)
                || !['worker', 'pipeline'].includes(artifact.producer_role)) throw new Error('review_recovery_artifact_unauthorized');
        }
        const prepared = structuredClone(parent);
        if (r.expectedHeadSha !== r.expectedStageHeadSha) prepared.stageState!.stageHeads.push({ round: child.stageRound!, rootSha: r.expectedHeadSha });
        prepared.inputArtifactIds = [...new Set([...(parent.inputArtifactIds ?? []), ...r.inputArtifactIds])];
        const ids = [...new Set([...selectStageInputArtifacts(parent.stageState), ...(child.inputArtifactIds ?? []), ...r.inputArtifactIds])];
        const grants = stageReviewArtifactGrants(store, prepared, ids);
        const artifactDigest = createHash('sha256').update(JSON.stringify(grants.map(grant => ({ ...grant, provenance: store.db.prepare('SELECT task_id, mesh_id, session_id, producer_role FROM session_artifacts WHERE artifact_id = ?').get(grant.id) })))).digest('hex');
        if (!r.dryRun && artifactDigest !== r.expectedArtifactDigest) throw new Error('review_artifact_digest_changed');
        const proof = attestStageReviewInput(prepared, host, grants);
        if (proof.checkout.worktree !== r.expectedWorkspace) throw new Error('review_workspace_mismatch');
        const claims = store.assignedRowsMeshWide(r.meshId).map(row => ({ ...JSON.parse(row.payload), status: 'assigned' } as MeshWorkQueueEntry));
        if (reviewInputBusy(parent, proof.checkout, [...claims, ...store.getQueueEntries(r.meshId, ['pending'])], true)) throw new Error('review_input_busy');
        return { parent, child, prepared, ids, proof, artifactDigest };
    };
    // No lock is held during the potentially expensive fingerprint; every predicate is checked again inside CAS.
    const before = store.transaction(check);
    if (r.expectedHeadSha !== r.expectedStageHeadSha) execFileSync('git', ['-C', host.workspace, 'merge-base', '--is-ancestor', r.expectedStageHeadSha, r.expectedHeadSha], { windowsHide: true, timeout: 5000, stdio: 'pipe' });
    const diff = await ports.git.diff(host.workspace, r.expectedStageHeadSha, r.expectedHeadSha);
    if (Buffer.byteLength(diff) > 4 * 1024 * 1024) throw new Error('review_recovery_diff_too_large');
    const diffSha256 = createHash('sha256').update(diff).digest('hex');
    const fingerprint = await ports.git.fingerprint(host.workspace);
    if (!fingerprint) throw new Error('review_fingerprint_unavailable');
    if (!r.dryRun && fingerprint !== r.expectedFingerprint) throw new Error('review_fingerprint_changed');
    const result = { success: true, dryRun: r.dryRun, parentTaskId: r.parentTaskId, reviewTaskId: r.reviewTaskId,
        parentRevision: before.parent.revision ?? 0, reviewRevision: before.child.revision ?? 0, headSha: r.expectedHeadSha,
        fingerprint, diffSha256, artifactDigest: before.artifactDigest, inputArtifactIds: before.ids, workspace: before.proof.checkout.worktree };
    if (r.dryRun) { store.transaction(check); return result; }
    // Pipeline artifacts live outside the checkout. A later CAS refusal can leave an ungranted evidence record, never a partial queue repair.
    const diffId = ports.artifacts.register({ meshId: r.meshId, missionId: before.parent.missionId, taskId: r.parentTaskId, kind: 'diff', ext: '.diff',
        title: `Review recovery continuation ${r.expectedStageHeadSha}..${r.expectedHeadSha}`, content: diff });
    if (!diffId) throw new Error('review_recovery_diff_registration_failed');
    // Recheck after artifact I/O as well; source or ignored-file changes cannot refresh the baseline silently.
    if (await ports.git.fingerprint(host.workspace) !== fingerprint) throw new Error('review_fingerprint_changed');
    return store.transaction(() => {
        const { parent, child, prepared, ids, proof, artifactDigest } = check();
        const diffGrant = stageReviewArtifactGrants(store, parent, [diffId]);
        if (diffGrant[0].sha256 !== diffSha256) throw new Error('review_recovery_diff_hash_mismatch');
        ids.push(diffId); proof.artifacts.push(...diffGrant); proof.childTaskId = child.id;
        const audit: StageReviewRecoveryAudit = { at: new Date().toISOString(), actor: host.actor, parentRevision: parent.revision ?? 0, reviewRevision: child.revision ?? 0,
            ownerDecisionId: r.ownerDecisionId, ownerAnswerRevision: r.ownerAnswerRevision, ownerOptionId: r.ownerOptionId,
            previousHeadSha: r.expectedStageHeadSha, headSha: r.expectedHeadSha, previousFingerprint: parent.stageState!.reviewFingerprint, previousFingerprintUnavailable: parent.stageState!.reviewFingerprintUnavailable, fingerprint,
            previousProof: parent.stageReviewInput, previousSelfCheck: parent.stageState!.selfCheck,
            previousChild: { difficulty: child.difficulty, inputArtifactIds: child.inputArtifactIds, targetNodeId: child.targetNodeId, targetSessionId: child.targetSessionId,
                routingPreferences: child.routingPreferences, autoLaunch: child.autoLaunch, hold: child.hold, holdNoticeId: child.holdNoticeId }, artifactIds: ids, artifactDigest, diffSha256 };
        parent.stageReviewRecoveries = [...(parent.stageReviewRecoveries ?? []), audit];
        parent.stageState = prepared.stageState;
        if (r.expectedHeadSha !== r.expectedStageHeadSha) parent.stageState!.selfCheck = 'unavailable'; // old pass remains in history/artifacts, never attributed to the new head
        parent.inputArtifactIds = prepared.inputArtifactIds;
        parent.stageState!.artifacts.diff.push(diffId);
        parent.stageState!.reviewFingerprint = fingerprint; delete parent.stageState!.reviewFingerprintUnavailable;
        parent.stageReviewInput = proof;
        child.difficulty = 'medium'; child.inputArtifactIds = ids; child.targetNodeId = host.nodeId; delete child.targetSessionId;
        child.routingPreferences = { nodeIds: [host.nodeId], providers: [r.reviewerProvider] };
        child.message += `\n\nOwner-authorized input recovery: review ${r.expectedHeadSha} in the authenticated local checkout. Continuation base ${r.expectedStageHeadSha}; historical pipeline base ${parent.stageState!.baseSha}. Prior self-check applies to the prior head; use the named continuation evidence for new validation. Artifact grants: ${ids.join(', ')}.`;
        delete child.hold; delete child.holdNoticeId; delete child.autoLaunch;
        store.updateQueueEntry(parent); store.updateQueueEntry(child);
        return { ...result, dryRun: false, parentRevision: parent.revision, reviewRevision: child.revision, inputArtifactIds: ids };
    });
}
