// Review-in-task: the narrow ports the stage runtime talks through (docs/design/2026-11-01-review-in-task.md).
//
// Two of them are INTEGRATION SEAMS owned by the light-workspace work (companion doc
// 2026-11-01-same-machine-light-task.md):
//   - SelfCheckRunner            — run the `fast` validation profile in a directory.
//   - ReviewerWorkspaceProvider  — a light workspace pinned to a commit for the reviewer.
// Until those land, the production fallbacks are: self-check → 'unavailable' (skip, no bounce), reviewer
// workspace → null (the existing read-lease path, including the review_input_busy self-block fix).
// Connect them with `setStagePorts({ selfCheck, reviewerWorkspace })`.

import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';
import type { SelfCheckStatus } from './stage-pipeline.js';

export interface SelfCheckRequest { meshId: string; taskId: string; workspace: string; baseSha: string; profile: 'fast' }
export interface SelfCheckResult { status: SelfCheckStatus; log: string }

/** Run a named validation profile in a directory → pass/fail + log. Output-based judgement is the runner's job. */
export interface SelfCheckRunner { run(req: SelfCheckRequest): Promise<SelfCheckResult> }

export interface ReviewerWorkspaceRequest {
    meshId: string; parentTaskId: string; reviewTaskId: string; round: number;
    /** Round head the reviewer must see. */
    rootSha: string; baseSha: string; submodules?: Record<string, string>;
    /** The parent's own checkout (source of the commits). */
    sourceWorkspace: string;
}
export interface ReviewerWorkspace { path: string; headSha: string; release(): Promise<void> }

/** Light workspace at a commit, or null → fall back to the read lease on the parent's checkout. */
export interface ReviewerWorkspaceProvider { prepare(req: ReviewerWorkspaceRequest): Promise<ReviewerWorkspace | null> }

export interface StageGitPort {
    /** Merge-base of HEAD with the integration branch; null when it cannot be resolved. */
    baseSha(workspace: string): Promise<string | null>;
    headSha(workspace: string): Promise<string | null>;
    /** `git diff base..head` text (root only; bounded by the caller). */
    diff(workspace: string, base: string, head: string): Promise<string>;
    /** Opaque fingerprint of HEAD + working-tree status; equal fingerprints = the checkout did not change. Null when unreadable. */
    fingerprint(workspace: string, limits?: { budgetMs?: number; maxEntries?: number; concurrency?: number }): Promise<string | null>;
    /** True when the working tree has no uncommitted changes. */
    isClean(workspace: string): Promise<boolean>;
}

export interface StageArtifactInput {
    meshId: string; missionId?: string; taskId: string; kind: 'diff' | 'self_check' | 'review_verdict';
    title: string; content: string; ext: '.diff' | '.md' | '.json';
}
export interface StageArtifactPort { register(input: StageArtifactInput): string | null }

export interface StageQueuePort {
    get(meshId: string, taskId: string): MeshWorkQueueEntry | null;
    /** Mutate the parent row under the queue lock; returns the stored row. */
    mutate(meshId: string, taskId: string, fn: (entry: MeshWorkQueueEntry) => void): MeshWorkQueueEntry | null;
    listStageParents(): MeshWorkQueueEntry[];
    /** Revalidate read evidence before accepting a verdict (production read lease). */
    reviewInputValid?(parent: MeshWorkQueueEntry, child: MeshWorkQueueEntry): boolean;
    enqueueReviewChild(parent: MeshWorkQueueEntry, spec: {
        round: number; message: string; inputArtifactIds: string[];
        independence: 'different_provider' | 'fresh_session'; targetSessionId?: string;
        reviewerWorkspace?: { path: string; headSha: string };
        reviewFingerprint?: string;
    }): MeshWorkQueueEntry;
    cancel(meshId: string, taskId: string, reason: string): void;
    /** Rewrite a pending review child's constraint to the fresh-session fallback (R2). */
    setChildIndependence(meshId: string, childId: string, independence: 'different_provider' | 'fresh_session'): void;
    /** Final parent commit through the terminal choke point (hold already lifted by the caller). */
    commitParent(parent: MeshWorkQueueEntry, status: 'completed' | 'blocked', envelope: { finalSummary: string; evidence?: unknown }, reason: string): void;
    /** Re-dispatch the parent with a revise memo: same session when alive, else same provider. */
    requeueForRevision(parent: MeshWorkQueueEntry, memo: string, opts: { sameSessionId?: string; inputArtifactIds: string[] }): void;
    sessionAlive(sessionId: string | undefined): boolean;
}

export interface StageEventPort {
    /** Non-waking progress record (mesh_status / task history / dashboard only). */
    progress(meshId: string, taskId: string, text: string): void;
    /** The ONE coordinator wake: the parent's terminal notice. */
    notifyParentTerminal(parent: MeshWorkQueueEntry, status: 'completed' | 'blocked' | 'failed', report: string): void;
    /** The implementer session's work is finished (final release): let the session-lifetime reaper treat it like any finished worker. */
    implementerFinished?(parent: MeshWorkQueueEntry): void;
}

export interface StageRuntimePorts {
    now(): number;
    selfCheck: SelfCheckRunner;
    reviewerWorkspace: ReviewerWorkspaceProvider;
    git: StageGitPort;
    artifacts: StageArtifactPort;
    queue: StageQueuePort;
    events: StageEventPort;
    /** Workspace of the parent's node (where the implementer works). */
    workspaceOf(parent: MeshWorkQueueEntry): string | null;
    pipelineCeilingMs(): number;
}
