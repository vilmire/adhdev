// Review-in-task: production wiring of the stage ports (docs/design/2026-11-01-review-in-task.md).
//
// INTEGRATION SEAMS (connect at integration with the light-workspace work):
//   setStagePorts({ selfCheck })            — default reports 'unavailable' (the stage skips, no bounce).
//   setStagePorts({ reviewerWorkspace })    — default returns null (existing read-lease path is used).
// Everything else is implemented here against the real queue, git, artifact store and notice runtime.

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
import { getConfigDir } from '../config/config.js';
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
import type { StageGitPort, StageRuntimePorts, SelfCheckRunner, ReviewerWorkspaceProvider } from './stage-ports.js';

const execFileAsync = promisify(execFile);

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
    async fingerprint(workspace) {
        try {
            const head = (await git(workspace, ['rev-parse', 'HEAD'])).trim();
            const status = await git(workspace, ['status', '--porcelain=v1', '--untracked-files=all']);
            return `${head}\n${createHash('sha256').update(status).digest('hex')}`;
        } catch { return null; }
    },
    async isClean(workspace) { try { return (await git(workspace, ['status', '--porcelain'])).trim() === ''; } catch { return false; } },
};

/** Fallback until the light-workspace fast profile lands: skip without bouncing. */
export const unavailableSelfCheck: SelfCheckRunner = {
    async run() { return { status: 'unavailable', log: 'no self-check runner is connected on this daemon (fast profile not available)' }; },
};

/** Fallback until the light workspace lands: the reviewer reads the parent's checkout under the read lease. */
export const noReviewerWorkspace: ReviewerWorkspaceProvider = { async prepare() { return null; } };

/**
 * Artifact registration is injected: src/mesh must not value-import src/artifacts (import-boundary gate).
 * boot/stages/mesh-runtime.ts wires `registerSessionArtifact` bound to the mesh runtime DB.
 */
export type StageArtifactRegistrar = (input: { sessionId: string; workspaceRoot: string; path: string; taskId: string; meshId: string; missionId?: string; producerRole: string; title: string }) => string | null;
let artifactRegistrar: StageArtifactRegistrar | null = null;
export function setStageArtifactRegistrar(fn: StageArtifactRegistrar | null): void { artifactRegistrar = fn; }

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

export function createProductionStagePorts(components: Pick<DaemonComponents, 'sessionRegistry' | 'instanceManager'>): StageRuntimePorts {
    const store = () => MeshRuntimeStore.getInstance();
    return {
        now: () => Date.now(),
        selfCheck: { run: req => (overrides.selfCheck ?? unavailableSelfCheck).run(req) },
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
            enqueueReviewChild: (parent, spec) => enqueueTask(parent.meshId, spec.message, {
                stageChild: { parentTaskId: parent.id, round: spec.round, review: { sourceTaskId: parent.id, independence: spec.independence }, ...(spec.reviewerWorkspace ? { reviewerWorkspace: spec.reviewerWorkspace } : {}) },
                difficulty: parent.difficulty === 'difficult' ? 'difficult' : 'medium',
                ...(parent.missionId ? { missionId: parent.missionId } : {}),
                inputArtifactIds: spec.inputArtifactIds, inheritArtifacts: false,
                ...(spec.targetSessionId ? { targetSessionId: spec.targetSessionId } : {}),
                ...(parent.sourceCoordinatorSessionId ? { sourceCoordinatorSessionId: parent.sourceCoordinatorSessionId } : {}),
            }),
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
                    e.updatedAt = new Date().toISOString();
                    store().updateQueueEntry(e);
                    endTaskDispatchInFlight(parent.meshId, parent.id);
                });
            },
            sessionAlive: sessionId => {
                if (!sessionId) return false;
                try { return !!(components.sessionRegistry?.has(sessionId) || components.instanceManager?.getInstance?.(sessionId)); } catch { return false; }
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
export function installStagePipeline(components: Pick<DaemonComponents, 'sessionRegistry' | 'instanceManager'>, ports: StageRuntimePorts = createProductionStagePorts(components)): StagePipelineHandle {
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

