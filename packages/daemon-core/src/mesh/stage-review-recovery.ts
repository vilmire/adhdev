/** Owner-authorized repair of ONE never-started managed review or terminal-blocked stage parent; never releases a writer claim. */
import { execFileSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { meshNodeIdMatches } from '@adhdev/mesh-shared';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { enqueueTask } from './mesh-work-queue-enqueue.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';
import type { StageRuntimePorts } from './stage-ports.js';
import { attestStageReviewInput, stageReviewArtifactGrants } from './stage-review-input.js';
import { isStageBlockOverwritten, isStageChild, selectStageInputArtifacts } from './stage-state.js';
import { buildReviewerMessage } from './stage-synthesis.js';
import { reviewInputBusy } from './mesh-task-routing-contract.js';
import { isTaskDispatchInFlight } from './mesh-task-inflight.js';
import { findOpenQueueAttempt } from './mesh-queue-attempt-guard.js';

export interface StageReviewSourceProvenance {
    nodeId: string;
    sessionId: string;
    providerType: string;
    via: 'parent_row' | 'turn_attempt' | 'local_record' | 'task_output' | 'last_reclaim';
}

export interface StageReviewRecoveryRequest {
    v: 1 | 2; meshId: string; parentTaskId: string; reviewTaskId?: string;
    expectedParentRevision: number; expectedReviewRevision?: number;
    expectedStageHeadSha: string; expectedHeadSha: string; expectedWorkspace: string;
    ownerDecisionId: string; ownerAnswerRevision: number; ownerOptionId: string;
    difficulty: 'medium'; reviewerProvider: string;
    continuationTaskId?: string; inputArtifactIds: string[];
    dryRun: boolean; expectedFingerprint?: string; expectedArtifactDigest?: string;
}
export interface StageReviewRecoveryHost { actor: string; repoIdentity: string; machineId: string; nodeId: string; workspace: string }
export interface StageReviewRecoveryAudit {
    v?: 1 | 2;
    at: string; actor: string; parentRevision: number; appliedParentRevision?: number; reviewRevision: number;
    reviewTaskId?: string; round?: number;
    ownerDecisionId: string; ownerAnswerRevision: number; ownerOptionId: string;
    previousHeadSha: string; headSha: string; previousFingerprint?: string; previousFingerprintUnavailable?: boolean; fingerprint: string;
    previousProof?: MeshWorkQueueEntry['stageReviewInput']; previousSelfCheck?: string;
    previousStatus?: MeshWorkQueueEntry['status']; previousBlockedReason?: string; previousBlockedDetail?: string; previousRound?: number;
    previousChild?: Pick<MeshWorkQueueEntry, 'difficulty' | 'inputArtifactIds' | 'targetNodeId' | 'targetSessionId' | 'routingPreferences' | 'autoLaunch' | 'hold' | 'holdNoticeId'>;
    sourceProvenance?: StageReviewSourceProvenance; continuationTaskId?: string; reviewerProvider?: string; preApplyArtifactDigest?: string;
    artifactIds: string[]; artifactDigest: string; diffSha256: string;
}
const keys = ['v', 'meshId', 'parentTaskId', 'reviewTaskId', 'expectedParentRevision', 'expectedReviewRevision', 'expectedStageHeadSha', 'expectedHeadSha', 'expectedWorkspace', 'ownerDecisionId', 'ownerAnswerRevision', 'ownerOptionId', 'difficulty', 'reviewerProvider', 'continuationTaskId', 'inputArtifactIds', 'dryRun', 'expectedFingerprint', 'expectedArtifactDigest'];
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();

export function decodeStageReviewRecovery(value: unknown): StageReviewRecoveryRequest {
    const r = value as StageReviewRecoveryRequest;
    if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some(k => !keys.includes(k)) || (r.v !== 1 && r.v !== 2)
        || ['meshId', 'parentTaskId', 'ownerDecisionId', 'ownerOptionId', 'reviewerProvider'].some(k => typeof (r as any)[k] !== 'string' || !(r as any)[k].trim())
        || (r.v === 1 && (!nonEmpty(r.reviewTaskId) || !Number.isSafeInteger(r.expectedReviewRevision) || r.expectedReviewRevision! < 0))
        || (r.v === 2 && (r.reviewTaskId !== undefined || r.expectedReviewRevision !== undefined))
        || ![r.expectedParentRevision, r.ownerAnswerRevision].every(n => Number.isSafeInteger(n) && n >= 0)
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

/**
 * Prove the implementer's (nodeId, sessionId, providerType) from persisted parent audit/runtime records only.
 * Never accepts caller-supplied strings and never borrows a reviewer child's provider or session.
 */
export function resolveStageSourceProvenance(store: Pick<MeshRuntimeStore, 'db' | 'findQueueEntryById'>, parent: MeshWorkQueueEntry): StageReviewSourceProvenance | undefined {
    const reviewerSessions = new Set(
        (parent.stageState?.reviewTaskIds ?? [])
            .map(id => store.findQueueEntryById(parent.meshId, id)?.assignedSessionId)
            .filter(nonEmpty)
            .map(s => s.trim()),
    );
    const accept = (nodeId: unknown, sessionId: unknown, providerType: unknown, via: StageReviewSourceProvenance['via']): StageReviewSourceProvenance | undefined => {
        if (!nonEmpty(nodeId) || !nonEmpty(sessionId) || !nonEmpty(providerType)) return undefined;
        const cand: StageReviewSourceProvenance = { nodeId: nodeId.trim(), sessionId: sessionId.trim(), providerType: providerType.trim(), via };
        if (reviewerSessions.has(cand.sessionId)) return undefined;
        if (nonEmpty(parent.assignedNodeId) && !meshNodeIdMatches({ nodeId: parent.assignedNodeId }, cand.nodeId)) return undefined;
        if (nonEmpty(parent.assignedSessionId) && parent.assignedSessionId.trim() !== cand.sessionId) return undefined;
        if (nonEmpty(parent.assignedProviderType) && parent.assignedProviderType.trim() !== cand.providerType) return undefined;
        if (nonEmpty(parent.stageReviewInput?.checkout?.nodeId) && !meshNodeIdMatches({ nodeId: parent.stageReviewInput!.checkout.nodeId }, cand.nodeId)) return undefined;
        return cand;
    };
    const direct = accept(parent.assignedNodeId, parent.assignedSessionId, parent.assignedProviderType, 'parent_row');
    if (direct) return direct;
    try {
        const attempts = store.db.prepare(
            'SELECT node_id, session_id, provider_type FROM turn_attempts WHERE mesh_id = ? AND task_id = ? ORDER BY attempt_no DESC, rowid DESC',
        ).all(parent.meshId, parent.id) as Array<{ node_id: string | null; session_id: string | null; provider_type: string | null }>;
        for (const a of attempts) {
            const match = accept(a.node_id, a.session_id, a.provider_type, 'turn_attempt');
            if (match) return match;
        }
    } catch { /* table optional in minimal stores */ }
    try {
        const records = store.db.prepare(
            'SELECT node_id, session_id, provider_type, payload_json FROM mesh_local_records WHERE mesh_id = ? AND task_id = ? ORDER BY at_ms DESC, rowid DESC',
        ).all(parent.meshId, parent.id) as Array<{ node_id: string | null; session_id: string | null; provider_type: string | null; payload_json?: string }>;
        for (const rec of records) {
            let payload: Record<string, unknown> = {};
            try { payload = rec.payload_json ? JSON.parse(rec.payload_json) : {}; } catch { /* ignore */ }
            const match = accept(rec.node_id ?? payload.nodeId, rec.session_id ?? payload.sessionId, rec.provider_type ?? payload.providerType, 'local_record');
            if (match) return match;
        }
    } catch { /* table optional in minimal stores */ }
    try {
        const outputs = store.db.prepare(
            'SELECT envelope_json FROM mesh_task_outputs WHERE mesh_id = ? AND task_id = ? ORDER BY version DESC',
        ).all(parent.meshId, parent.id) as Array<{ envelope_json: string }>;
        for (const row of outputs) {
            let env: Record<string, any> = {};
            try { env = JSON.parse(row.envelope_json); } catch { continue; }
            const match = accept(env.nodeId ?? env.source?.node_id, env.source?.session_id ?? env.sessionId, env.providerType ?? env.source?.provider_type, 'task_output');
            if (match) return match;
        }
    } catch { /* table optional in minimal stores */ }
    if (parent.lastReclaim) {
        const match = accept(parent.lastReclaim.nodeId, parent.lastReclaim.sessionId, parent.lastReclaim.providerType, 'last_reclaim');
        if (match) return match;
    }
    return undefined;
}

export function resolveRecoverySourceNodeId(
    store: Pick<MeshRuntimeStore, 'db' | 'findQueueEntryById'>,
    request: StageReviewRecoveryRequest,
    parent: MeshWorkQueueEntry | null = store.findQueueEntryById(request.meshId, request.parentTaskId),
): string | undefined {
    if (!parent) return undefined;
    if (request.v === 1) return parent.assignedNodeId;
    return resolveStageSourceProvenance(store, parent)?.nodeId ?? parent.assignedNodeId ?? parent.stageReviewInput?.checkout?.nodeId;
}

export async function recoverPendingStageReview(request: StageReviewRecoveryRequest, host: StageReviewRecoveryHost, ports: Pick<StageRuntimePorts, 'git' | 'artifacts'> & Partial<Pick<StageRuntimePorts, 'now'>>) {
    const r = decodeStageReviewRecovery(request);
    if (!host.actor || !host.machineId || !host.repoIdentity || !host.nodeId || !host.workspace) throw new Error('authenticated_local_host_required');
    const store = MeshRuntimeStore.getInstance();
    if (r.v === 2) return recoverTerminalStageReview(r, host, ports, store);
    const check = () => {
        const parent = store.findQueueEntryById(r.meshId, r.parentTaskId);
        const child = store.findQueueEntryById(r.meshId, r.reviewTaskId!);
        if (!parent || !child || !parent.stagePlan || parent.status !== 'assigned' || parent.stageState?.phase !== 'awaiting_review' || parent.stageState.released
            || child.status !== 'pending' || !child.readonly || child.origin !== 'stage' || child.stageRole !== 'review'
            || child.parentTaskId !== parent.id || child.review?.sourceTaskId !== parent.id || child.stageRound !== parent.stageState.round
            || parent.stageState.reviewTaskIds.at(-1) !== child.id || child.reviewerWorkspace) throw new Error('pending_managed_review_required');
        if ((parent.revision ?? 0) !== r.expectedParentRevision || (child.revision ?? 0) !== r.expectedReviewRevision) throw new Error('stale_review_recovery_cas');
        if (parent.stageState.stageHeads.at(-1)?.rootSha !== r.expectedStageHeadSha) throw new Error('review_stage_head_mismatch');
        if (!meshNodeIdMatches({ nodeId: parent.assignedNodeId }, host.nodeId)) throw new Error('review_source_node_mismatch');
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
    const result = { success: true, dryRun: r.dryRun, parentTaskId: r.parentTaskId, reviewTaskId: r.reviewTaskId!,
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
        const audit: StageReviewRecoveryAudit = { v: 1, at: new Date().toISOString(), actor: host.actor, parentRevision: parent.revision ?? 0, reviewRevision: child.revision ?? 0,
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

async function recoverTerminalStageReview(
    r: StageReviewRecoveryRequest,
    host: StageReviewRecoveryHost,
    ports: Pick<StageRuntimePorts, 'git' | 'artifacts'> & Partial<Pick<StageRuntimePorts, 'now'>>,
    store: MeshRuntimeStore,
) {
    const nowIso = () => new Date(ports.now?.() ?? Date.now()).toISOString();
    const verifyCommon = (parent: MeshWorkQueueEntry, baseInputIds: string[]) => {
        const source = resolveStageSourceProvenance(store, parent);
        if (!source) throw new Error('review_unknown_source_provenance');
        if (!meshNodeIdMatches({ nodeId: source.nodeId }, host.nodeId)) throw new Error('review_source_node_mismatch');
        if (isTaskDispatchInFlight(r.meshId, parent.id) || findOpenQueueAttempt(store.turnStore(), r.meshId, parent.id)) throw new Error('review_source_attempt_active');
        if (r.reviewerProvider === source.providerType) throw new Error('review_independence_required');
        const item = store.missionItems().getItem(r.meshId, r.ownerDecisionId);
        if (!item || item.kind !== 'decision' || item.state !== 'answered' || item.missionId !== parent.missionId
            || item.decision?.answer?.by !== 'owner' || !['dashboard', 'cli'].includes(item.decision.answer.via ?? '')
            || item.decision.answer.optionId !== r.ownerOptionId || item.decision.answerRevision !== r.ownerAnswerRevision
            || !item.decision.options.some(o => o.id === r.ownerOptionId)
            || item.refs?.filter(ref => ref.kind === 'task').length !== 1 || !item.refs.some(ref => ref.kind === 'task' && ref.value === parent.id)) throw new Error('review_owner_authorization_required');
        if (!r.continuationTaskId) throw new Error('review_continuation_required');
        const continuation = store.findQueueEntryById(r.meshId, r.continuationTaskId) ?? undefined;
        if (!continuation || continuation.id === parent.id || isStageChild(continuation) || continuation.readonly
            || continuation.status !== 'completed' || continuation.taskMode !== 'code_change'
            || !parent.missionId || continuation.missionId !== parent.missionId
            || !nonEmpty(continuation.assignedSessionId) || !nonEmpty(continuation.assignedNodeId)
            || (!meshNodeIdMatches({ nodeId: continuation.assignedNodeId }, source.nodeId) && !meshNodeIdMatches({ nodeId: continuation.assignedNodeId }, host.nodeId))) throw new Error('review_continuation_evidence_mismatch');
        if (isTaskDispatchInFlight(r.meshId, continuation.id) || findOpenQueueAttempt(store.turnStore(), r.meshId, continuation.id)) throw new Error('review_source_attempt_active');
        if (!r.inputArtifactIds.length) throw new Error('review_recovery_artifact_unauthorized');
        let hasContinuationArt = false;
        for (const id of r.inputArtifactIds) {
            const artifact = store.db.prepare('SELECT task_id, mesh_id, session_id, producer_role FROM session_artifacts WHERE artifact_id = ?').get(id) as any;
            if (!artifact || artifact.mesh_id !== parent.meshId || ![parent.id, continuation.id].includes(artifact.task_id)
                || !['worker', 'pipeline'].includes(artifact.producer_role)
                || (artifact.task_id === continuation.id && artifact.producer_role === 'worker' && artifact.session_id !== continuation.assignedSessionId)) throw new Error('review_recovery_artifact_unauthorized');
            if (artifact.task_id === continuation.id) hasContinuationArt = true;
        }
        if (r.expectedHeadSha !== r.expectedStageHeadSha && !hasContinuationArt) throw new Error('review_continuation_evidence_mismatch');
        const prepared = structuredClone(parent);
        prepared.inputArtifactIds = [...new Set([...baseInputIds, ...r.inputArtifactIds])];
        return { source, continuation, prepared };
    };
    const assertNotBusy = (parent: MeshWorkQueueEntry, source: StageReviewSourceProvenance, checkout: import('@adhdev/mesh-shared').PhysicalOwnershipScope) => {
        const claims = store.assignedRowsMeshWide(r.meshId).map(row => ({ ...JSON.parse(row.payload), status: 'assigned' } as MeshWorkQueueEntry));
        if (reviewInputBusy(parent, checkout, [...claims, ...store.getQueueEntries(r.meshId, ['pending'])], true)) throw new Error('review_input_busy');
        const openAttempt = store.db.prepare(
            'SELECT task_id FROM turn_attempts WHERE mesh_id = ? AND node_id = ? AND terminal_outcome IS NULL LIMIT 1',
        ).get(r.meshId, source.nodeId) as { task_id: string | null } | undefined;
        if (openAttempt) throw new Error('review_input_busy');
    };
    const check = () => {
        const parent = store.findQueueEntryById(r.meshId, r.parentTaskId);
        if (!parent || !parent.stagePlan || !parent.stageState || parent.light) throw new Error('terminal_blocked_stage_review_required');
        const lastAudit = parent.stageReviewRecoveries?.at(-1);
        const isReplayState = !r.dryRun && parent.status === 'assigned' && parent.stageState.phase === 'awaiting_review' && !parent.stageState.released
            && lastAudit?.v === 2 && !!lastAudit.reviewTaskId
            && lastAudit.ownerDecisionId === r.ownerDecisionId && lastAudit.ownerAnswerRevision === r.ownerAnswerRevision && lastAudit.ownerOptionId === r.ownerOptionId
            && lastAudit.previousHeadSha === r.expectedStageHeadSha && lastAudit.headSha === r.expectedHeadSha
            && lastAudit.continuationTaskId === r.continuationTaskId && lastAudit.reviewerProvider === r.reviewerProvider;
        if (isReplayState) {
            if ((parent.revision ?? 0) !== lastAudit.appliedParentRevision
                || (r.expectedParentRevision !== lastAudit.parentRevision && r.expectedParentRevision !== lastAudit.appliedParentRevision)) throw new Error('stale_review_recovery_cas');
            const existingChild = store.findQueueEntryById(r.meshId, lastAudit.reviewTaskId!);
            if (!existingChild || parent.stageState.reviewTaskIds.at(-1) !== existingChild.id || existingChild.stageRound !== parent.stageState.round
                || !existingChild.readonly || existingChild.origin !== 'stage' || existingChild.stageRole !== 'review') throw new Error('terminal_blocked_stage_review_required');
            for (const cid of parent.stageState.reviewTaskIds.slice(0, -1)) {
                const c = store.findQueueEntryById(r.meshId, cid);
                if (!c || c.status !== 'completed' || !isStageChild(c) || c.parentTaskId !== parent.id) throw new Error('terminal_blocked_stage_review_required');
            }
            if (existingChild.status !== 'pending' || existingChild.assignedSessionId || existingChild.attemptId || existingChild.dispatchTimestamp
                || existingChild.autoLaunch?.sessionId || ['started', 'completed'].includes(existingChild.autoLaunch?.status ?? '')
                || isTaskDispatchInFlight(r.meshId, existingChild.id) || store.turnStore().findLatestAttemptForTask(r.meshId, existingChild.id)) throw new Error('review_already_started');
            const { source, prepared } = verifyCommon(parent, parent.inputArtifactIds ?? []);
            if (lastAudit.preApplyArtifactDigest !== r.expectedArtifactDigest && lastAudit.artifactDigest !== r.expectedArtifactDigest) throw new Error('review_artifact_digest_changed');
            const ids = [...(existingChild.inputArtifactIds ?? [])];
            const grants = stageReviewArtifactGrants(store, prepared, ids);
            const proof = attestStageReviewInput(prepared, host, grants);
            if (proof.checkout.worktree !== r.expectedWorkspace) throw new Error('review_workspace_mismatch');
            assertNotBusy(parent, source, proof.checkout);
            return {
                replay: true as const, parent, existingChild, source, prepared, ids, proof,
                artifactDigest: lastAudit.preApplyArtifactDigest ?? lastAudit.artifactDigest,
                nextRound: parent.stageState.round,
                preservedCompletedChildIds: parent.stageState.reviewTaskIds.slice(0, -1),
            };
        }
        const terminalBlocked = (parent.status === 'blocked' || isStageBlockOverwritten(parent))
            && parent.stageState.phase === 'done' && !!parent.stageState.released && !!parent.stageState.blockedReason;
        if (!terminalBlocked) throw new Error('terminal_blocked_stage_review_required');
        const childIds = parent.stageState.reviewTaskIds;
        if (!childIds.length) throw new Error('terminal_blocked_stage_review_required');
        const allChildren = store.getQueueEntries(r.meshId).filter(e => e.parentTaskId === parent.id);
        if (allChildren.length !== childIds.length || allChildren.some(e => !childIds.includes(e.id))) throw new Error('terminal_blocked_stage_review_required');
        for (const cid of childIds) {
            const c = store.findQueueEntryById(r.meshId, cid);
            if (!c || !c.readonly || c.origin !== 'stage' || c.stageRole !== 'review' || c.parentTaskId !== parent.id
                || c.review?.sourceTaskId !== parent.id || c.status !== 'completed') throw new Error('terminal_blocked_stage_review_required');
            if (isTaskDispatchInFlight(r.meshId, c.id) || findOpenQueueAttempt(store.turnStore(), r.meshId, c.id)) throw new Error('review_already_started');
        }
        if ((parent.revision ?? 0) !== r.expectedParentRevision) throw new Error('stale_review_recovery_cas');
        if (parent.stageState.stageHeads.at(-1)?.rootSha !== r.expectedStageHeadSha) throw new Error('review_stage_head_mismatch');
        const { source, prepared } = verifyCommon(parent, parent.inputArtifactIds ?? []);
        const nextRound = parent.stageState.round + 1;
        const at = nowIso();
        prepared.status = 'assigned';
        prepared.assignedNodeId = source.nodeId;
        prepared.assignedSessionId = source.sessionId;
        prepared.assignedProviderType = source.providerType;
        prepared.targetNodeId = source.nodeId;
        delete prepared.targetSessionId;
        prepared.stageState!.round = nextRound;
        prepared.stageState!.phase = 'awaiting_review';
        prepared.stageState!.phaseSince = at;
        prepared.stageState!.startedAt = at;
        prepared.stageState!.released = false;
        delete prepared.stageState!.blockedReason;
        delete prepared.stageState!.blockedDetail;
        delete prepared.stageState!.reviewerSessionId;
        prepared.stageState!.reviewerFailures = 0;
        prepared.stageState!.stageHeads.push({ round: nextRound, rootSha: r.expectedHeadSha });
        prepared.stageState!.selfCheck = 'unavailable';
        const ids = [...new Set([...selectStageInputArtifacts(parent.stageState), ...r.inputArtifactIds])];
        const grants = stageReviewArtifactGrants(store, prepared, ids);
        const artifactDigest = createHash('sha256').update(JSON.stringify(grants.map(grant => ({ ...grant, provenance: store.db.prepare('SELECT task_id, mesh_id, session_id, producer_role FROM session_artifacts WHERE artifact_id = ?').get(grant.id) })))).digest('hex');
        if (!r.dryRun && artifactDigest !== r.expectedArtifactDigest) throw new Error('review_artifact_digest_changed');
        const proof = attestStageReviewInput(prepared, host, grants);
        if (proof.checkout.worktree !== r.expectedWorkspace) throw new Error('review_workspace_mismatch');
        assertNotBusy(prepared, source, proof.checkout);
        return {
            replay: false as const, parent, existingChild: undefined, source, prepared, ids, proof, artifactDigest,
            nextRound, preservedCompletedChildIds: [...childIds],
        };
    };
    const before = store.transaction(check);
    if (r.expectedHeadSha !== r.expectedStageHeadSha) execFileSync('git', ['-C', host.workspace, 'merge-base', '--is-ancestor', r.expectedStageHeadSha, r.expectedHeadSha], { windowsHide: true, timeout: 5000, stdio: 'pipe' });
    const diff = await ports.git.diff(host.workspace, r.expectedStageHeadSha, r.expectedHeadSha);
    if (Buffer.byteLength(diff) > 4 * 1024 * 1024) throw new Error('review_recovery_diff_too_large');
    const diffSha256 = createHash('sha256').update(diff).digest('hex');
    const fingerprint = await ports.git.fingerprint(host.workspace);
    if (!fingerprint) throw new Error('review_fingerprint_unavailable');
    if (!r.dryRun && fingerprint !== r.expectedFingerprint) throw new Error('review_fingerprint_changed');
    const baseResult = {
        success: true, v: 2 as const, dryRun: r.dryRun, parentTaskId: r.parentTaskId,
        round: before.nextRound, parentRevision: before.parent.revision ?? 0,
        previousHeadSha: r.expectedStageHeadSha, headSha: r.expectedHeadSha,
        fingerprint, diffSha256, artifactDigest: before.artifactDigest, inputArtifactIds: before.ids,
        workspace: before.proof.checkout.worktree, sourceProvenance: before.source,
        preservedCompletedChildIds: before.preservedCompletedChildIds,
    };
    if (r.dryRun) { store.transaction(check); return baseResult; }
    if (before.replay) {
        const rechecked = store.transaction(check);
        if (!rechecked.replay || !rechecked.existingChild) throw new Error('stale_review_recovery_cas');
        return {
            ...baseResult, dryRun: false, idempotentReplay: true,
            reviewTaskId: rechecked.existingChild.id,
            parentRevision: rechecked.parent.revision ?? 0,
            reviewRevision: rechecked.existingChild.revision ?? 0,
            inputArtifactIds: rechecked.existingChild.inputArtifactIds ?? rechecked.ids,
        };
    }
    const diffId = ports.artifacts.register({ meshId: r.meshId, missionId: before.parent.missionId, taskId: r.parentTaskId, kind: 'diff', ext: '.diff',
        title: `Review recovery continuation ${r.expectedStageHeadSha}..${r.expectedHeadSha}`, content: diff });
    if (!diffId) throw new Error('review_recovery_diff_registration_failed');
    if (await ports.git.fingerprint(host.workspace) !== fingerprint) throw new Error('review_fingerprint_changed');
    return store.transaction(() => {
        const checked = check();
        if (checked.replay && checked.existingChild) {
            return {
                ...baseResult, dryRun: false, idempotentReplay: true,
                reviewTaskId: checked.existingChild.id,
                parentRevision: checked.parent.revision ?? 0,
                reviewRevision: checked.existingChild.revision ?? 0,
                inputArtifactIds: checked.existingChild.inputArtifactIds ?? checked.ids,
            };
        }
        const { parent, source, prepared, ids, proof, artifactDigest, nextRound } = checked;
        const diffGrant = stageReviewArtifactGrants(store, parent, [diffId]);
        if (diffGrant[0].sha256 !== diffSha256) throw new Error('review_recovery_diff_hash_mismatch');
        ids.push(diffId); proof.artifacts.push(...diffGrant);
        const msg = `${buildReviewerMessage({
            originalMessage: parent.stageState!.originalMessage ?? parent.message,
            implementerSummary: '(see artifacts)',
            round: nextRound,
            maxRevisions: parent.stagePlan!.maxRevisions,
            selfCheck: 'unavailable',
            priorOpenFindingIds: parent.stageState!.openFindingIds ?? [],
            baseSha: parent.stageState!.baseSha || r.expectedStageHeadSha,
            headSha: r.expectedHeadSha,
        })}\n\nOwner-authorized input recovery: review ${r.expectedHeadSha} in the authenticated local checkout. Continuation base ${r.expectedStageHeadSha}; historical pipeline base ${parent.stageState!.baseSha}. Prior self-check applies to the prior head; use the named continuation evidence for new validation. Artifact grants: ${ids.join(', ')}.`;
        const child = enqueueTask(r.meshId, msg, {
            stageChild: {
                parentTaskId: parent.id,
                round: nextRound,
                review: { sourceTaskId: parent.id, independence: 'different_provider' },
            },
            difficulty: 'medium',
            ...(parent.missionId ? { missionId: parent.missionId } : {}),
            inputArtifactIds: ids,
            inheritArtifacts: false,
            targetNodeId: host.nodeId,
            ...(parent.sourceCoordinatorSessionId ? { sourceCoordinatorSessionId: parent.sourceCoordinatorSessionId } : {}),
        });
        child.routingPreferences = { nodeIds: [host.nodeId], providers: [r.reviewerProvider] };
        store.updateQueueEntry(child);
        proof.childTaskId = child.id;
        const preParentRev = parent.revision ?? 0;
        const audit: StageReviewRecoveryAudit = {
            v: 2, at: nowIso(), actor: host.actor,
            parentRevision: preParentRev, appliedParentRevision: preParentRev + 1, reviewRevision: child.revision ?? 0,
            reviewTaskId: child.id, round: nextRound,
            ownerDecisionId: r.ownerDecisionId, ownerAnswerRevision: r.ownerAnswerRevision, ownerOptionId: r.ownerOptionId,
            previousHeadSha: r.expectedStageHeadSha, headSha: r.expectedHeadSha,
            previousFingerprint: parent.stageState!.reviewFingerprint, previousFingerprintUnavailable: parent.stageState!.reviewFingerprintUnavailable, fingerprint,
            previousProof: parent.stageReviewInput, previousSelfCheck: parent.stageState!.selfCheck,
            previousStatus: parent.status, previousBlockedReason: parent.stageState!.blockedReason,
            previousBlockedDetail: parent.stageState!.blockedDetail, previousRound: parent.stageState!.round,
            sourceProvenance: source, continuationTaskId: r.continuationTaskId, reviewerProvider: r.reviewerProvider,
            preApplyArtifactDigest: artifactDigest, artifactIds: ids, artifactDigest, diffSha256,
        };
        parent.stageReviewRecoveries = [...(parent.stageReviewRecoveries ?? []), audit];
        parent.status = 'assigned';
        parent.assignedNodeId = source.nodeId;
        parent.assignedSessionId = source.sessionId;
        parent.assignedProviderType = source.providerType;
        parent.targetNodeId = source.nodeId;
        delete parent.targetSessionId;
        delete parent.hold; delete parent.holdNoticeId; delete parent.autoLaunch; delete parent.parked;
        parent.stageState = prepared.stageState;
        parent.inputArtifactIds = prepared.inputArtifactIds;
        parent.stageState!.reviewTaskIds.push(child.id);
        parent.stageState!.artifacts.diff.push(diffId);
        parent.stageState!.reviewFingerprint = fingerprint;
        delete parent.stageState!.reviewFingerprintUnavailable;
        parent.stageReviewInput = proof;
        store.updateQueueEntry(parent);
        return {
            ...baseResult, dryRun: false, idempotentReplay: false,
            reviewTaskId: child.id,
            parentRevision: parent.revision,
            reviewRevision: child.revision,
            inputArtifactIds: ids,
        };
    });
}
