// Review-in-task: production wiring of the stage ports (docs/design/2026-11-01-review-in-task.md).
//
// INTEGRATION SEAMS (connect at integration with the light-workspace work):
//   setStagePorts({ selfCheck })            — default reports 'unavailable' (the stage skips, no bounce).
//   setStagePorts({ reviewerWorkspace })    — default returns null (existing read-lease path is used).
// Everything else is implemented here against the real queue, git, artifact store and notice runtime.

import type { ArtifactKind } from '../artifacts/types.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { withQueueLock } from './mesh-work-queue.js';
import { enqueueTask } from './mesh-work-queue-enqueue.js';
import { cancelTask } from './mesh-work-queue.js';
import { commitTaskTerminal } from './mesh-task-terminal.js';
import { endTaskDispatchInFlight } from './mesh-task-inflight.js';
import { getConfigDir, getMachineId } from '../config/config.js';
import { getMesh, listMeshes } from '../config/mesh-config.js';
import { notifyMeshCoordinator } from './turn-ledger/deliver.js';
import { meshRecord } from './mesh-record.js';
import { recordAcceptedSessionCompletion } from './mesh-session-lifetime.js';
import { LOG } from '../logging/logger.js';
import { STAGE_PIPELINE_CEILING_DEFAULT_MS } from '@adhdev/mesh-shared';
import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';
import type { DaemonComponents } from '../boot/daemon-components.js';
import { StagePipelineRuntime } from './stage-pipeline-runtime.js';
import { setStageHookTarget } from './stage-hooks.js';
import { setStageNoticeLookup } from './stage-notice-silence.js';
import { isStageChild, isStageParent } from './stage-state.js';
import { FINGERPRINT_V2, type StageGitPort, type StageRuntimePorts, type SelfCheckRunner, type SelfCheckResult, type ReviewerWorkspaceProvider } from './stage-ports.js';
import { runMeshRefineValidationProfile } from './refine-profile-run.js';
import { prepareLightWorkspace, removeLightWorkspace } from './light-workspace.js';
import { loadLightWorkspaceConfig } from './light-workspace-config.js';
import { attestStageReviewInput, stageReviewArtifactGrantsWithheld, currentStageReviewScope } from './stage-review-input.js';
import { reviewInputBusy } from './mesh-task-routing-contract.js';
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { allowedClassifiedDifficultiesForSession, readSessionModel, taskMeetsSessionDifficultyFloor } from './mesh-difficulty-floor.js';
import { resolveNodeCapabilitySlots } from './mesh-node-slots.js';

const SELF_CHECK_LOG_MAX = 60_000;

const execFileAsync = promisify(execFile);
/** Past this many untracked files the stat hash is not attempted: the fingerprint is unavailable (fail closed). */
const MAX_FINGERPRINT_OTHER_FILES = 300_000;
/** Wall-clock budget and stat concurrency of the checkout fingerprint (fail closed past the budget). */
const FINGERPRINT_BUDGET_MS = 20_000;
const FINGERPRINT_STAT_CONCURRENCY = 32;

async function git(cwd: string, args: string[], maxBuffer = 8 * 1024 * 1024): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true, timeout: 30_000, maxBuffer });
    return stdout;
}

export const defaultStageGit: StageGitPort = {
    async baseSha(workspace) {
        for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
            try { return (await git(workspace, ['merge-base', 'HEAD', ref])).trim() || null; } catch { /* try next */ }
        }
        return null;
    },
    async headSha(workspace) { try { return (await git(workspace, ['rev-parse', 'HEAD'])).trim() || null; } catch { return null; } },
    async diff(workspace, base, head) { return git(workspace, ['diff', '--no-color', `${base}..${head}`], 16 * 1024 * 1024); },
    /**
     * Content-based checkout fingerprint (review-in-task §11). Covers: HEAD; porcelain status incl. untracked entries;
     * a hash of `git diff HEAD --binary` (tracked content); `git ls-files -v` (skip-worktree / assume-unchanged
     * bits); and a stat hash (path, size, mtime) of every untracked, non-ignored file. Git-IGNORED files are excluded on
     * purpose: a reviewer that runs the project's tests or build rewrites ignored output (dist/, caches, node_modules
     * state) and that is not a source mutation — counting it voided honest verdicts as `reviewer_mutated_source`.
     * Tracked source (diff, skip-worktree bits, HEAD) and untracked source files stay protected.
     * fsmonitor is disabled so a stale daemon cannot hide changes. Stats run asynchronously with
     * bounded concurrency under a wall-clock budget and an incremental file cap; any failure, cap or timeout → null (the
     * caller treats that as "cannot verify" and fails closed).
     */
    async fingerprint(workspace, limits: { budgetMs?: number; maxEntries?: number; concurrency?: number; legacy?: boolean } = {}) {
        const budgetMs = limits.budgetMs ?? FINGERPRINT_BUDGET_MS;
        const maxEntries = limits.maxEntries ?? MAX_FINGERPRINT_OTHER_FILES;
        const concurrency = limits.concurrency ?? FINGERPRINT_STAT_CONCURRENCY;
        const deadline = Date.now() + budgetMs;
        try {
            const g = (args: string[], max = 64 * 1024 * 1024) => git(workspace, ['-c', 'core.fsmonitor=false', ...args], max);
            const sha = (text: string) => createHash('sha256').update(text).digest('hex');
            const head = (await g(['rev-parse', 'HEAD'])).trim();
            // `legacy` reproduces the format written before git-ignored output was excluded (no version line, ignored
            // entries included), so a review that started before the upgrade is still verified like it would have been.
            const legacy = limits.legacy === true;
            const status = await g(['status', '--porcelain=v1', '--untracked-files=all', ...(legacy ? ['--ignored=matching'] : [])]);
            const diff = await g(['diff', 'HEAD', '--binary']);
            const lsv = await g(['ls-files', '-v']);
            const untracked = (await g(['ls-files', '-z', '-o', '--exclude-standard'])).split('\0').filter(Boolean);
            const ignored = legacy ? (await g(['ls-files', '-z', '-o', '-i', '--exclude-standard'])).split('\0').filter(Boolean) : [];
            const entries = [...untracked.map(p => `u:${p}`), ...ignored.map(p => `i:${p}`)];
            if (entries.length > maxEntries) return null;
            entries.sort();
            const lines: string[] = new Array(entries.length);
            let next = 0;
            let failed = false;
            const worker = async () => {
                for (;;) {
                    if (failed) return;
                    if (Date.now() > deadline) { failed = true; return; }
                    const i = next++;
                    if (i >= entries.length) return;
                    const rel = entries[i].slice(2);
                    try { const st = await fs.promises.lstat(path.join(workspace, rel)); lines[i] = `${entries[i]}\0${st.size}\0${st.mtimeMs}`; }
                    catch { lines[i] = `${entries[i]}\0gone`; }
                }
            };
            await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, entries.length)) }, worker));
            if (failed || Date.now() > deadline) return null;
            return [...(legacy ? [] : [FINGERPRINT_V2]), head, sha(status), sha(diff), sha(lsv), sha(lines.join('\n'))].join('\n');
        } catch { return null; }
    },
    async isClean(workspace) { try { return (await git(workspace, ['status', '--porcelain'])).trim() === ''; } catch { return false; } },
};

/** Mapping of the shared profile runner's summary onto the stage self-check result (docs: review-in-task §4.2). */
export function mapProfileSummary(summary: { status?: string; failureCode?: string; skippedReason?: string; commandsRun?: unknown[] }): SelfCheckResult {
    const log = (() => { try { return JSON.stringify(summary.commandsRun ?? [], null, 1).slice(-SELF_CHECK_LOG_MAX); } catch { return ''; } })();
    if (summary.status === 'passed') return { status: 'passed', log };
    if (summary.failureCode === 'validation_profile_unknown' || summary.status === 'skipped') {
        return { status: 'skipped_not_configured', log: summary.skippedReason ?? 'no validation.profiles.fast configured' };
    }
    return { status: 'failed', log: `${summary.failureCode ? `${summary.failureCode}\n` : ''}${log}` };
}

export interface SelfCheckDeps {
    getMesh: (meshId: string) => unknown;
    run: (mesh: unknown, workspace: string, profile: string, opts: { baseSha: string }) => Promise<Parameters<typeof mapProfileSummary>[0]>;
}

/**
 * Self-check through the shared `fast` validation profile (refine-profile-run.ts, the same runner light landing uses).
 * Config without `profiles.fast` → skipped_not_configured; a thrown error → skipped_infra_error (never bounces).
 */
export function createRefineProfileSelfCheck(deps: SelfCheckDeps = { getMesh: id => getMesh(id), run: (m, w, p, o) => runMeshRefineValidationProfile(m, w, p, o) as never }): SelfCheckRunner {
    return {
        async run(req) {
            try {
                return mapProfileSummary(await deps.run(deps.getMesh(req.meshId) ?? null, req.workspace, req.profile, { baseSha: req.baseSha }));
            } catch (e: any) {
                return { status: 'skipped_infra_error', log: `self-check runner error: ${e?.message || e}` };
            }
        },
    };
}

/** Fallback when no runner is connected: skip without bouncing. */
export const unavailableSelfCheck: SelfCheckRunner = {
    async run() { return { status: 'unavailable', log: 'no self-check runner is connected on this daemon (fast profile not available)' }; },
};

export interface LightReviewerDeps {
    loadConfig: typeof loadLightWorkspaceConfig;
    prepare: typeof prepareLightWorkspace;
    remove: typeof removeLightWorkspace;
}

/**
 * Reviewer workspace backed by main's light workspace (detached checkout of the round head, no branch). Returns null
 * for a repo without `.adhdev/light-workspace.json` or when preparation fails (→ read-lease fallback).
 *
 * ★NOT installed in production by default: a prepared workspace only helps if the review child's claim is routed to a
 * session launched INTO that path (main's light dispatcher does that for `light` rows at the default base sha, not at
 * an arbitrary round head). Without that routing a regular session would claim the child with the read lease skipped,
 * which would also disable the mutation detector. Install with `setStagePorts({ reviewerWorkspace: createLightReviewerWorkspaceProvider() })`
 * once the dispatcher can launch a session into a given path for a stage child.
 */
export function createLightReviewerWorkspaceProvider(deps: LightReviewerDeps = { loadConfig: loadLightWorkspaceConfig, prepare: prepareLightWorkspace, remove: removeLightWorkspace }): ReviewerWorkspaceProvider {
    return {
        async prepare(req) {
            const cfg = deps.loadConfig(req.sourceWorkspace);
            if (!cfg.ok) return null;
            try {
                const handle = await deps.prepare({
                    meshId: req.meshId, taskId: req.parentTaskId, checkoutRoot: req.sourceWorkspace, config: cfg.config,
                    rootBaseSha: req.rootSha, branch: false, keySuffix: `review-r${req.round}`,
                });
                return {
                    path: handle.path, headSha: handle.rootBaseSha,
                    release: async () => { await deps.remove({ path: handle.path, checkoutRoot: req.sourceWorkspace, config: cfg.config }); },
                };
            } catch (e: any) {
                LOG.warn('StagePipeline', `light reviewer workspace unavailable for ${req.parentTaskId}: ${e?.message || e}`);
                return null;
            }
        },
    };
}

/** Fallback until a reviewer workspace is routed: the reviewer reads the parent's checkout under the read lease. */
export const noReviewerWorkspace: ReviewerWorkspaceProvider = { async prepare() { return null; } };

/**
 * Artifact registration is injected: src/mesh must not value-import src/artifacts (import-boundary gate).
 * boot/stages/mesh-runtime.ts wires `registerSessionArtifact` bound to the mesh runtime DB.
 */
export type StageArtifactRegistrar = (input: { sessionId: string; workspaceRoot: string; path: string; taskId: string; meshId: string; missionId?: string; producerRole: string; title: string; kind?: ArtifactKind }) => string | null;
let artifactRegistrar: StageArtifactRegistrar | null = null;
export function setStageArtifactRegistrar(fn: StageArtifactRegistrar | null): void { artifactRegistrar = fn; }
/** The boot-installed registrar (also used by light-task result capture); null until boot wires it. */
export function getStageArtifactRegistrar(): StageArtifactRegistrar | null { return artifactRegistrar; }

const defaultSelfCheck = createRefineProfileSelfCheck();
let overrides: { selfCheck?: SelfCheckRunner; reviewerWorkspace?: ReviewerWorkspaceProvider } = {};
/** Connect the light-workspace seams. Call before (or after) installStagePipeline; read lazily per use. */
export function setStagePorts(next: { selfCheck?: SelfCheckRunner; reviewerWorkspace?: ReviewerWorkspaceProvider }): void { overrides = { ...overrides, ...next }; }

/** `ADHDEV_STAGE_PIPELINE_CEILING_MS`, clamped like the turn-policy knobs (1 min … 24 h). */
export function resolveStagePipelineCeilingMs(env: NodeJS.ProcessEnv = process.env): number {
    const raw = Number(env.ADHDEV_STAGE_PIPELINE_CEILING_MS);
    if (!Number.isFinite(raw) || raw <= 0) return STAGE_PIPELINE_CEILING_DEFAULT_MS;
    return Math.min(Math.max(Math.trunc(raw), 60_000), 24 * 60 * 60 * 1000);
}

function stageArtifactDir(taskId: string): string {
    return path.join(getConfigDir(), 'stage-artifacts', taskId.replace(/[^A-Za-z0-9_.-]/g, '_'));
}

export function createProductionStagePorts(components: Pick<DaemonComponents, 'sessionRegistry' | 'instanceManager' | 'statusInstanceId'>): StageRuntimePorts {
    const store = () => MeshRuntimeStore.getInstance();
    return {
        now: () => Date.now(),
        selfCheck: { run: req => (overrides.selfCheck ?? defaultSelfCheck).run(req) },
        reviewerWorkspace: { prepare: req => (overrides.reviewerWorkspace ?? noReviewerWorkspace).prepare(req) },
        git: defaultStageGit,
        artifacts: {
            register(input) {
                try {
                    const dir = stageArtifactDir(input.taskId);
                    fs.mkdirSync(dir, { recursive: true });
                    const name = `${input.kind}-${Date.now().toString(36)}${input.ext}`;
                    fs.writeFileSync(path.join(dir, name), input.content, 'utf8');
                    if (!artifactRegistrar) return null;
                    return artifactRegistrar({
                        sessionId: `stage:${input.taskId}`, workspaceRoot: dir, path: name, taskId: input.taskId, meshId: input.meshId,
                        ...(input.missionId ? { missionId: input.missionId } : {}), producerRole: 'pipeline', title: input.title,
                    });
                } catch (e: any) {
                    LOG.warn('StagePipeline', `artifact registration failed for ${input.taskId}: ${e?.message || e}`);
                    return null;
                }
            },
        },
        queue: {
            reviewInputValid: (parent, child) => !!currentStageReviewScope(parent, child),
            get: (meshId, taskId) => store().findQueueEntryById(meshId, taskId) ?? null,
            mutate: (meshId, taskId, fn) => withQueueLock(meshId, () => {
                const e = store().findQueueEntryById(meshId, taskId);
                if (!e) return null;
                fn(e);
                e.updatedAt = new Date().toISOString();
                store().updateQueueEntry(e);
                return e;
            }),
            listStageParents: () => {
                const out: MeshWorkQueueEntry[] = [];
                for (const mesh of listMeshes()) {
                    try { out.push(...store().getQueueEntries(mesh.id, ['assigned', 'pending']).filter(e => isStageParent(e) && !e.stageState!.released)); } catch { /* mesh without a queue */ }
                }
                return out;
            },
            enqueueReviewChild: (parent, spec) => {
                return withQueueLock(parent.meshId, () => {
                    const current = store().findQueueEntryById(parent.meshId, parent.id);
                    if (!current || current.status !== 'assigned' || current.stageState?.released
                        || (current.stageState?.phase !== 'awaiting_review' && current.stageState?.phase !== 'reviewing') || current.stageState.round !== spec.round
                        || (current.revision ?? 0) !== (parent.revision ?? 0)) throw new Error('stage_review_stale_parent');
                    // Transactional idempotency: a retry cannot create a second child for the same round.
                    const existing = current.stageState.reviewTaskIds.map(id => store().findQueueEntryById(parent.meshId, id))
                        .find(c => c?.stageRound === spec.round && (c.status === 'pending' || c.status === 'assigned'));
                    if (existing && (existing.status === 'assigned' || existing.assignedSessionId || existing.attemptId || existing.autoLaunch?.sessionId)) throw new Error('stage_review_already_started');
                    if (existing) return existing;
                    let proof;
                    let inputArtifactIds = spec.inputArtifactIds;
                    let message = spec.message;
                    // The read-lease reviewer must run in the PARENT's checkout. Without a node target the
                    // queue could hand the child to any idle session, and a claim from another checkout is
                    // then refused review_input_unavailable (a generic hold) instead of being routed here.
                    const reviewNodeId = current.assignedNodeId ?? current.targetNodeId;
                    if (!spec.reviewerWorkspace) {
                        const nodeId = reviewNodeId;
                        const mesh = getMesh(current.meshId);
                        const node = mesh?.nodes?.find(n => n.id === nodeId);
                        const machineId = getMachineId();
                        if (!nodeId || !node?.workspace || !mesh?.repoIdentity || !machineId
                            || !components.statusInstanceId || !daemonIdsEquivalent(node.daemonId, components.statusInstanceId)) throw new Error('review_input_local_context_required');
                        // An artifact the implementer only cited may have changed after it was registered: withhold
                        // it (and say so) rather than failing the review; the pipeline's own evidence stays required.
                        const { grants, withheld } = stageReviewArtifactGrantsWithheld(store(), current, spec.inputArtifactIds,
                            new Set(current.stageState.workerArtifactIds ?? []));
                        proof = attestStageReviewInput(current, { repoIdentity: mesh.repoIdentity, machineId, nodeId, workspace: node.workspace }, grants);
                        if (withheld.length) {
                            inputArtifactIds = grants.map(g => g.id);
                            message = `${message}\n\nNote: implementer artifact(s) ${withheld.join(', ')} changed or disappeared after they were registered, so they are withheld. Do not rely on them; read the code and the diff instead.`;
                            LOG.warn('StagePipeline', `review child for ${parent.id}: withheld changed implementer artifact(s) ${withheld.join(', ')}`);
                        }
                        if (reviewInputBusy(current, proof.checkout, store().getQueueEntries(current.meshId, ['assigned', 'pending']), true)) throw new Error('review_input_busy');
                    }
                    const child = enqueueTask(parent.meshId, message, {
                        stageChild: { parentTaskId: parent.id, round: spec.round, review: { sourceTaskId: parent.id, independence: spec.independence }, ...(spec.reviewerWorkspace ? { reviewerWorkspace: spec.reviewerWorkspace } : {}) },
                        difficulty: parent.difficulty === 'difficult' ? 'difficult' : 'medium',
                        ...(parent.missionId ? { missionId: parent.missionId } : {}),
                        inputArtifactIds, inheritArtifacts: false,
                        ...(spec.targetSessionId ? { targetSessionId: spec.targetSessionId } : {}),
                        ...(!spec.reviewerWorkspace && reviewNodeId ? { targetNodeId: reviewNodeId } : {}),
                        ...(parent.sourceCoordinatorSessionId ? { sourceCoordinatorSessionId: parent.sourceCoordinatorSessionId } : {}),
                    });
                    if (proof) { proof.childTaskId = child.id; current.stageReviewInput = proof; }
                    current.stageState.reviewTaskIds.push(child.id);
                    delete current.stageState.reviewFingerprint;
                    delete current.stageState.reviewFingerprintUnavailable;
                    if (spec.reviewFingerprint) current.stageState.reviewFingerprint = spec.reviewFingerprint;
                    else if (!spec.reviewerWorkspace) current.stageState.reviewFingerprintUnavailable = true;
                    store().updateQueueEntry(current);
                    return child;
                });
            },
            cancel: (meshId, taskId, reason) => { cancelTask(meshId, taskId, { reason, stageManaged: true }); },
            setChildIndependence: (meshId, childId, independence) => {
                withQueueLock(meshId, () => {
                    const c = store().findQueueEntryById(meshId, childId);
                    if (!c?.review || c.status !== 'pending') return;
                    c.review = { sourceTaskId: c.review.sourceTaskId, independence };
                    store().updateQueueEntry(c);
                });
            },
            commitParent: (parent, status, envelope, reason) => {
                commitTaskTerminal({
                    meshId: parent.meshId, taskId: parent.id, status, source: 'queue_policy', reason,
                    ...(parent.assignedSessionId ? { sessionId: parent.assignedSessionId } : {}),
                    envelope: { finalSummary: envelope.finalSummary, evidence: envelope.evidence, completedAt: new Date().toISOString() },
                });
            },
            requeueForRevision: (parent, memo, opts) => {
                withQueueLock(parent.meshId, () => {
                    const e = store().findQueueEntryById(parent.meshId, parent.id);
                    if (!e || !e.stageState) return;
                    e.stageState.originalMessage ??= e.message;
                    // Keep the checkout: pin to the same node, and to the same session when it is still alive.
                    if (e.assignedNodeId) e.targetNodeId = e.assignedNodeId;
                    if (opts.sameSessionId) e.targetSessionId = opts.sameSessionId; else delete e.targetSessionId;
                    delete e.assignedNodeId; delete e.assignedSessionId; delete e.assignedProviderType; delete e.assignedModel;
                    delete e.dispatchTimestamp; delete e.autoLaunch; delete e.attemptId;
                    e.dispatchNonce = (e.dispatchNonce || 0) + 1;
                    e.message = `${memo}\n\n(Original task, for reference:)\n${e.stageState.originalMessage}`;
                    e.inputArtifactIds = [...new Set([...(e.inputArtifactIds ?? []), ...opts.inputArtifactIds])];
                    e.status = 'pending';
                    // Re-anchor the target-pin TTL (it ages from requeuedAt/createdAt): without this a
                    // revision pinned back to the session that just finished the round inherits the
                    // task's original age and parks on the very next tick (live: 7491s ≥ 900s, 19 s
                    // after the round's report).
                    e.requeuedAt = new Date().toISOString();
                    e.updatedAt = e.requeuedAt;
                    store().updateQueueEntry(e);
                    endTaskDispatchInFlight(parent.meshId, parent.id);
                });
            },
            sessionAlive: sessionId => {
                if (!sessionId) return false;
                try { return !!(components.sessionRegistry?.has(sessionId) || components.instanceManager?.getInstance?.(sessionId)); } catch { return false; }
            },
            sessionMeetsDifficulty: (meshId, sessionId, difficulty) => {
                try {
                    const state: any = components.instanceManager?.getInstance?.(sessionId)?.getState?.();
                    if (!state) return true; // not observable here: let the claim side judge, as before
                    const settings = state.settings || {};
                    const nodeId = String(settings.meshNodeId || settings.nodeId || '');
                    const node = getMesh(meshId)?.nodes?.find(n => daemonIdsEquivalent(n.id, nodeId));
                    if (!node) return true;
                    const providerType = String(state.type || settings.providerType || '');
                    const allowed = allowedClassifiedDifficultiesForSession(node, resolveNodeCapabilitySlots(node, meshId), providerType, readSessionModel(state));
                    return taskMeetsSessionDifficultyFloor({ difficulty }, allowed);
                } catch { return true; }
            },
        },
        events: {
            progress: (meshId, taskId, text) => {
                try { meshRecord(meshId, 'stage_progress', { payload: { taskId, text: text.slice(0, 300) } }, { local: true }); } catch { /* audit only */ }
            },
            implementerFinished: parent => {
                // The worker-report hook skipped this while the report was held; record it now (same audit row the reaper reads).
                recordAcceptedSessionCompletion({ meshId: parent.meshId, taskId: parent.id, ...(parent.assignedSessionId ? { sessionId: parent.assignedSessionId } : {}), ...(parent.attemptId ? { attemptId: parent.attemptId } : {}) }, Date.now());
            },
            notifyParentTerminal: (parent, status, report) => {
                const message = `[System] Stage task ${parent.id} ${status}.\n${report}`;
                try {
                    notifyMeshCoordinator({
                        meshId: parent.meshId, event: 'mesh:stage_terminal', nodeLabel: parent.assignedNodeId ?? '',
                        ...(parent.assignedNodeId ? { nodeId: parent.assignedNodeId } : {}),
                        metadataEvent: { source: 'stage_pipeline', taskId: parent.id, status, coordinatorMessage: message },
                        coordinatorMessage: message, queuedAt: Date.now(),
                        eventId: `stage-terminal:${parent.id}:${status}`,
                        ...(parent.sourceCoordinatorSessionId ? { targetCoordinatorSessionId: parent.sourceCoordinatorSessionId } : {}),
                    });
                } catch (e: any) { LOG.warn('StagePipeline', `parent terminal notice failed for ${parent.id}: ${e?.message || e}`); }
            },
        },
        workspaceOf: parent => {
            const nodeId = parent.assignedNodeId ?? parent.targetNodeId;
            if (parent.ownershipScope?.worktree) return parent.ownershipScope.worktree;
            const mesh = getMesh(parent.meshId) as { nodes?: Array<{ id?: string; nodeId?: string; workspace?: string }> } | undefined;
            return mesh?.nodes?.find(n => (n.id ?? n.nodeId) === nodeId)?.workspace ?? null;
        },
        pipelineCeilingMs: () => resolveStagePipelineCeilingMs(),
    };
}


let installed: StagePipelineHandle | null = null;
/** The runtime installed for this daemon (undefined before boot) — used by the stage-decide command. */
export function getInstalledStagePipeline(): StagePipelineHandle | null { return installed; }

export interface StagePipelineHandle { runtime: StagePipelineRuntime; tick(): Promise<void>; dispose(): void }

/** Register the runtime with the terminal hooks and the notice-silence lookup. Idempotent per daemon boot. */
export function installStagePipeline(components: Pick<DaemonComponents, 'sessionRegistry' | 'instanceManager' | 'statusInstanceId'>, ports: StageRuntimePorts = createProductionStagePorts(components)): StagePipelineHandle {
    const runtime = new StagePipelineRuntime(ports);
    setStageHookTarget(runtime);
    setStageNoticeLookup((meshId, taskId) => {
        const e = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId);
        if (isStageChild(e)) return 'child';
        return isStageParent(e) && !e!.stageState!.released && e!.status === 'assigned' ? 'held_parent' : null;
    });
    installed = {
        runtime,
        tick: () => runtime.tick().catch(e => LOG.warn('StagePipeline', `tick failed: ${e?.message || e}`)),
        dispose() { setStageHookTarget(null); setStageNoticeLookup(null); installed = null; },
    };
    return installed;
}

