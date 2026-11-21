/**
 * Versioned light → integration continuation (owner-approved Contract A).
 *
 * Host-only: CAS on the source row, attest realpath / private index / HEAD / patch+log,
 * refuse open writers, dry-run with zero mutations, mint at most one integration successor
 * that reuses the existing light workspace (no new clone). Original source task / attempt /
 * history stay; only integrationTaskId + revision bookkeeping are updated on apply.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { realpathSync } from 'node:fs';
import { attestLocalOwnership } from './mesh-physical-ownership.js';
import { lightGit, lightGitOk } from './light-git.js';
import { getLightWorkspace } from './mesh-light-workspace-store.js';
import { findOpenQueueAttempt } from './mesh-queue-attempt-guard.js';
import { isTaskDispatchInFlight } from './mesh-task-inflight.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { withQueueLock } from './mesh-work-queue.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';
import type { MeshSourceCandidate } from '@adhdev/mesh-shared';

export interface LightContinuationHostContext {
    actor: string;
    repoIdentity: string;
    machineId: string;
    nodeId: string;
    /** Registered node workspace (base checkout). Never caller-supplied as the light path. */
    workspace: string;
    dryRun?: boolean;
    /** Identifies the persisted answer to verify on the host. */
    ownerDecisionId: string;
    ownerOptionId: string;
    ownerAnswerRevision: number;
}

export interface LightContinuationRequest {
    meshId: string;
    sourceTaskId: string;
    expectedRevision: number;
}

export type LightContinuationRefusal =
    | { code: 'task_not_found' }
    | { code: 'stale_revision'; expected: number; actual: number }
    | { code: 'not_light_source' }
    | { code: 'source_candidate_required' }
    | { code: 'open_writer_refused' }
    | { code: 'workspace_unproven'; detail: string }
    | { code: 'attestation_mismatch'; detail: string }
    | { code: 'owner_decision_required' }
    | { code: 'owner_authorization_required' }
    | { code: 'authenticated_host_required' }
    | { code: 'active_writer_on_workspace' };

export interface LightContinuationPlan {
    sourceTaskId: string;
    successorTaskId: string;
    lightWorkspaceId: string;
    lightWorkspacePath: string;
    phase: 'integration';
    readiness: MeshSourceCandidate['readiness'];
    patchSha256: string;
    rootHeadSha: string | null;
    idempotent: boolean;
    dryRun: boolean;
}

function refuse(code: LightContinuationRefusal['code'], extra: Record<string, unknown> = {}): never {
    const err = new Error(code) as Error & { refusal: LightContinuationRefusal };
    err.refusal = { code, ...extra } as LightContinuationRefusal;
    throw err;
}

function requireOwnerAnswer(store: MeshRuntimeStore, source: MeshWorkQueueEntry, host: LightContinuationHostContext): void {
    const item = store.missionItems().getItem(source.meshId, host.ownerDecisionId);
    const decision = item?.decision;
    const answer = decision?.answer;
    const taskRefs = item?.refs?.filter(ref => ref.kind === 'task');
    if (!source.missionId || item?.kind !== 'decision' || item.state !== 'answered' || item.missionId !== source.missionId
        || answer?.by !== 'owner' || !['dashboard', 'cli'].includes(answer.via)
        || answer.optionId !== host.ownerOptionId || decision?.answerRevision !== host.ownerAnswerRevision
        || !decision.options.some(option => option.id === host.ownerOptionId)
        || taskRefs?.length !== 1 || taskRefs[0].value !== source.id) {
        refuse('owner_authorization_required');
    }
}

/** Same dirty packet body shape as captureLightTaskResult (tracked + staged + untracked-as-new). */
async function rebuildDirtyPatchBody(repo: string): Promise<string> {
    const tracked = (await lightGit(repo, ['diff', 'HEAD', '--binary'], { timeoutMs: 50_000 })).stdout;
    const staged = (await lightGit(repo, ['diff', '--cached', '--binary'], { timeoutMs: 50_000 })).stdout;
    const untracked = (await lightGitOk(repo, ['ls-files', '-z', '-o', '--exclude-standard']))?.split('\0').filter(Boolean) ?? [];
    const parts: string[] = [];
    if (tracked) parts.push(tracked.endsWith('\n') ? tracked : `${tracked}\n`);
    if (staged) parts.push(staged.endsWith('\n') ? staged : `${staged}\n`);
    const empty = process.platform === 'win32' ? 'NUL' : '/dev/null';
    for (const rel of untracked) {
        const abs = path.join(repo, rel);
        const u = await lightGit(repo, ['diff', '--no-index', '--binary', '--', empty, abs], { timeoutMs: 50_000 });
        if (u.stdout) {
            const rewritten = u.stdout
                .replace(new RegExp(`(a/)${empty.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), `a/${rel}`)
                .replace(new RegExp(`(b/)${abs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), `b/${rel}`)
                .replace(new RegExp(abs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), rel);
            parts.push(rewritten.endsWith('\n') ? rewritten : `${rewritten}\n`);
        }
    }
    return parts.join('');
}

async function attestWorkspaceAgainstCandidate(
    lwPath: string,
    candidate: MeshSourceCandidate,
    subs: string[],
): Promise<{ rootHead: string | null; patchSha256: string }> {
    let rootReal: string;
    try { rootReal = realpathSync.native(lwPath); } catch (e: any) { refuse('workspace_unproven', { detail: `realpath: ${e?.message || e}` }); }
    if (candidate.canonicalWorktree) {
        let want: string;
        try { want = realpathSync.native(candidate.canonicalWorktree); } catch { want = candidate.canonicalWorktree; }
        if (want !== rootReal) refuse('attestation_mismatch', { detail: 'canonical_worktree_mismatch' });
    }
    const rootHead = await lightGitOk(lwPath, ['rev-parse', 'HEAD']);
    const gitDir = await lightGitOk(lwPath, ['rev-parse', '--absolute-git-dir']);
    const indexPath = await lightGitOk(lwPath, ['rev-parse', '--git-path', 'index']);
    if (!gitDir || !indexPath) refuse('workspace_unproven', { detail: 'private_git_identity_missing' });
    if (!fs.existsSync(path.resolve(lwPath, indexPath))) refuse('workspace_unproven', { detail: 'private_index_missing' });

    if (candidate.readiness === 'verified_source_candidate') {
        if (!candidate.rootCandidateSha || candidate.rootCandidateSha !== rootHead) {
            refuse('attestation_mismatch', { detail: 'root_head_mismatch' });
        }
        for (const s of subs) {
            const subHead = await lightGitOk(path.join(lwPath, s), ['rev-parse', 'HEAD']);
            if (s === 'oss' && candidate.ossCandidateSha && candidate.ossCandidateSha !== subHead) {
                refuse('attestation_mismatch', { detail: 'oss_head_mismatch' });
            }
        }
        // Committed candidate: patch hash is over committed range; re-diff base..HEAD.
        const rootPatch = (await lightGit(lwPath, ['diff', '--binary', `${candidate.rootBaseSha}..${rootHead}`], { timeoutMs: 50_000 })).stdout;
        const subPatches: string[] = [];
        for (const s of subs) {
            const base = s === 'oss' ? candidate.ossBaseSha : undefined;
            if (!base) continue;
            const h = await lightGitOk(path.join(lwPath, s), ['rev-parse', 'HEAD']);
            if (!h) continue;
            subPatches.push((await lightGit(path.join(lwPath, s), ['diff', '--binary', `${base}..${h}`], { timeoutMs: 50_000 })).stdout);
        }
        const patchSha256 = crypto.createHash('sha256').update(rootPatch).update(subPatches.join('\n')).digest('hex');
        if (patchSha256 !== candidate.patchSha256) refuse('attestation_mismatch', { detail: 'patch_sha256_mismatch' });
        return { rootHead, patchSha256 };
    }

    // Uncommitted packet: recompute dirty hash for root + each submodule that still looks dirty.
    const units = [lwPath, ...subs.map(s => path.join(lwPath, s))];
    if (!candidate.patchSha256) refuse('attestation_mismatch', { detail: 'missing_patch_sha' });
    // Capture joins full dirty packets (tracked+staged+untracked) with '\n'. Rebuild identically.
    const fullParts: string[] = [];
    for (const dir of units) {
        const st = await lightGit(dir, ['status', '--porcelain=v1', '--untracked-files=all']);
        if (st.code !== 0 || st.stdout.replace(/\n$/, '')) {
            fullParts.push(await rebuildDirtyPatchBody(dir));
        }
    }
    const patchSha256 = crypto.createHash('sha256').update(fullParts.join('\n')).digest('hex');
    if (patchSha256 !== candidate.patchSha256) {
        refuse('attestation_mismatch', { detail: 'uncommitted_patch_sha256_mismatch' });
    }
    for (const t of candidate.tests ?? []) {
        if (!t.logSha256) continue;
        // Require host-captured log evidence fields; do not invent hashes.
        if (!t.command || typeof t.exit !== 'number') refuse('attestation_mismatch', { detail: 'test_log_incomplete' });
    }
    return { rootHead, patchSha256: candidate.patchSha256 };
}

function otherActiveWriter(store: MeshRuntimeStore, meshId: string, sourceId: string, worktree: string): boolean {
    const want = (() => { try { return realpathSync.native(worktree); } catch { return worktree; } })();
    for (const row of store.getQueueEntries(meshId, ['assigned', 'pending'])) {
        if (row.id === sourceId) continue;
        if (row.status !== 'assigned') continue;
        const scope = row.ownershipScope?.worktree;
        if (!scope) continue;
        let other: string;
        try { other = realpathSync.native(scope); } catch { other = scope; }
        if (other === want) return true;
    }
    return false;
}

/**
 * Validate (and optionally apply) a host-attested continuation from a finished light source
 * row onto a single integration successor that reuses the same light workspace.
 */
export async function continueLightSourceToIntegration(
    req: LightContinuationRequest,
    host: LightContinuationHostContext,
): Promise<{ plan: LightContinuationPlan; source: MeshWorkQueueEntry; successor: MeshWorkQueueEntry }> {
    if (!host?.actor || !host.repoIdentity || !host.machineId || !host.nodeId || !host.workspace) {
        refuse('authenticated_host_required');
    }
    if (!host.ownerDecisionId?.trim() || !host.ownerOptionId?.trim()
        || !Number.isSafeInteger(host.ownerAnswerRevision) || host.ownerAnswerRevision < 1) {
        refuse('owner_decision_required');
    }
    if (!Number.isSafeInteger(req.expectedRevision) || req.expectedRevision < 0) refuse('stale_revision', { expected: req.expectedRevision, actual: -1 });

    const store = MeshRuntimeStore.getInstance();
    const before = store.findQueueEntryById(req.meshId, req.sourceTaskId);
    if (!before) refuse('task_not_found');
    if (!before.light || !before.lightWorkspaceId) refuse('not_light_source');
    if ((before.revision ?? 0) !== req.expectedRevision) {
        refuse('stale_revision', { expected: req.expectedRevision, actual: before.revision ?? 0 });
    }
    const candidate = before.lightResult?.sourceCandidate;
    if (!candidate) refuse('source_candidate_required');
    requireOwnerAnswer(store, before, host);
    if (isTaskDispatchInFlight(req.meshId, req.sourceTaskId) || findOpenQueueAttempt(store.turnStore(), req.meshId, req.sourceTaskId)) {
        refuse('open_writer_refused');
    }

    const ws = getLightWorkspace(store.db, before.lightWorkspaceId);
    if (!ws) refuse('workspace_unproven', { detail: 'light_workspace_missing' });
    const subs = Object.keys(ws.submoduleBases);

    // Idempotent: an already-linked live successor is returned without minting another.
    if (candidate.integrationTaskId) {
        const existing = store.findQueueEntryById(req.meshId, candidate.integrationTaskId);
        if (existing && existing.status !== 'cancelled' && existing.status !== 'failed') {
            const plan: LightContinuationPlan = {
                sourceTaskId: before.id, successorTaskId: existing.id, lightWorkspaceId: ws.workspaceId,
                lightWorkspacePath: ws.path, phase: 'integration', readiness: candidate.readiness,
                patchSha256: candidate.patchSha256, rootHeadSha: candidate.rootCandidateSha ?? null,
                idempotent: true, dryRun: host.dryRun === true,
            };
            return { plan, source: before, successor: existing };
        }
    }

    if (otherActiveWriter(store, req.meshId, before.id, ws.path)) refuse('active_writer_on_workspace');
    if (!before.ownedPaths?.paths?.length) refuse('workspace_unproven', { detail: 'owned_paths_required' });

    const attested = await attestWorkspaceAgainstCandidate(ws.path, candidate, subs);
    const ownershipScope = attestLocalOwnership({
        repoIdentity: host.repoIdentity, machineId: host.machineId, nodeId: host.nodeId,
        workspace: ws.path, phase: 'integration',
        paths: before.ownedPaths,
    });

    const plan: LightContinuationPlan = {
        sourceTaskId: before.id,
        successorTaskId: `${before.id}:integration:1`,
        lightWorkspaceId: ws.workspaceId,
        lightWorkspacePath: ws.path,
        phase: 'integration',
        readiness: candidate.readiness,
        patchSha256: attested.patchSha256,
        rootHeadSha: attested.rootHead,
        idempotent: false,
        dryRun: host.dryRun === true,
    };

    if (host.dryRun) {
        // Fabricate a dry-run successor snapshot without inserting.
        const ghost: MeshWorkQueueEntry = {
            ...structuredClone(before),
            id: plan.successorTaskId, status: 'pending', phase: 'integration',
            ownershipScope, lightWorkspaceId: ws.workspaceId, dependsOn: [before.id],
            revision: 0, revisionHistory: undefined,
            message: `Integration continuation of light source ${before.id} (owner ${host.ownerDecisionId.trim()}). Reuse workspace; normal hooks/commits allowed.`,
        };
        return { plan, source: before, successor: ghost };
    }

    // Apply: re-check CAS + writers inside the queue lock, then mint exactly one successor.
    // updateQueueEntry itself bumps revision (+1 from persisted); do not set it manually.
    return withQueueLock(req.meshId, () => {
        const fresh = store.findQueueEntryById(req.meshId, req.sourceTaskId);
        if (!fresh) refuse('task_not_found');
        if ((fresh.revision ?? 0) !== req.expectedRevision) {
            refuse('stale_revision', { expected: req.expectedRevision, actual: fresh.revision ?? 0 });
        }
        requireOwnerAnswer(store, fresh, host);
        if (isTaskDispatchInFlight(req.meshId, req.sourceTaskId) || findOpenQueueAttempt(store.turnStore(), req.meshId, req.sourceTaskId)) {
            refuse('open_writer_refused');
        }
        const cand = fresh.lightResult?.sourceCandidate;
        if (!cand) refuse('source_candidate_required');
        if (cand.integrationTaskId) {
            const existing = store.findQueueEntryById(req.meshId, cand.integrationTaskId);
            if (existing && existing.status !== 'cancelled' && existing.status !== 'failed') {
                return {
                    plan: { ...plan, successorTaskId: existing.id, idempotent: true, dryRun: false },
                    source: fresh, successor: existing,
                };
            }
        }
        if (otherActiveWriter(store, req.meshId, fresh.id, ws.path)) refuse('active_writer_on_workspace');

        const successorId = plan.successorTaskId;
        if (store.findQueueEntryById(req.meshId, successorId)) {
            const existing = store.findQueueEntryById(req.meshId, successorId)!;
            cand.integrationTaskId = existing.id;
            if (fresh.lightResult) fresh.lightResult = { ...fresh.lightResult, sourceCandidate: { ...cand } };
            store.updateQueueEntry(fresh);
            return { plan: { ...plan, idempotent: true, dryRun: false }, source: fresh, successor: existing };
        }

        const successor: MeshWorkQueueEntry = {
            id: successorId,
            meshId: req.meshId,
            message: `Integration continuation of light source ${fresh.id} (owner ${host.ownerDecisionId.trim()}). Reuse existing light workspace; normal hooks and commits are in scope. Preserve source history; do not rewrite the source row.`,
            status: 'pending',
            taskMode: fresh.taskMode ?? 'code_change',
            light: true,
            ...(fresh.lightBaseNodeId ? { lightBaseNodeId: fresh.lightBaseNodeId } : {}),
            lightWorkspaceId: ws.workspaceId,
            targetNodeId: fresh.targetNodeId ?? host.nodeId,
            ...(fresh.ownedPaths ? { ownedPaths: fresh.ownedPaths } : {}),
            dependsOn: [fresh.id],
            ...(fresh.missionId ? { missionId: fresh.missionId } : {}),
            difficulty: fresh.difficulty ?? 'difficult',
            phase: 'integration',
            ownershipScope,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        store.insertQueueEntry(successor);

        fresh.revisionHistory = [...(fresh.revisionHistory ?? []), {
            revision: req.expectedRevision,
            at: new Date().toISOString(),
            actor: host.actor,
            before: {
                message: fresh.message,
                ownedPaths: fresh.ownedPaths,
                phase: fresh.phase,
                dependsOn: fresh.dependsOn,
                ownershipScope: fresh.ownershipScope,
            },
        }];
        cand.integrationTaskId = successorId;
        if (fresh.lightResult) {
            fresh.lightResult = {
                ...fresh.lightResult,
                sourceCandidate: { ...cand, integrationTaskId: successorId },
            };
        }
        store.updateQueueEntry(fresh);
        return { plan: { ...plan, dryRun: false }, source: fresh, successor };
    });
}
