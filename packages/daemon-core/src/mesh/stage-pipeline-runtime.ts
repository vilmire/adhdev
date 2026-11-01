// Review-in-task: effect executor for the stage reducer (docs/design/2026-11-01-review-in-task.md §3–§8).
// All I/O goes through StageRuntimePorts (stage-ports.ts); production wiring is stage-ports-default.ts.
// The runtime never emits turn states — it reads what the ledger already committed and writes queue rows.

import { reviewIndependenceOf, type MeshReviewReport, type MeshTaskStageState } from '@adhdev/mesh-shared';
import { reduceStage, type StageEffect, type StageEvent } from './stage-pipeline.js';
import type { StageRuntimePorts } from './stage-ports.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';
import { dropStageReport, peekStageReport } from './stage-report-stash.js';
import { buildFinalReport, buildReviewerMessage, buildRevisionMemo } from './stage-synthesis.js';
import { isStageChild, isStageParent } from './stage-state.js';
import { independenceRefusalExceeded } from './stage-independence.js';

const SELF_CHECK_LOG_MAX = 60_000;
const DIFF_MAX = 1_500_000;

export class StagePipelineRuntime {
    /** Parents with an effect chain in flight (serializes per parent; events arriving meanwhile queue behind it). */
    private readonly chains = new Map<string, Promise<void>>();
    constructor(private readonly ports: StageRuntimePorts) {}

    private iso(): string { return new Date(this.ports.now()).toISOString(); }
    private key(meshId: string, taskId: string) { return `${meshId}\u0000${taskId}`; }

    /** Run `fn` after any in-flight work for this parent; resolves when done. */
    private serial(meshId: string, taskId: string, fn: () => Promise<void>): Promise<void> {
        const k = this.key(meshId, taskId);
        const next = (this.chains.get(k) ?? Promise.resolve()).then(fn, fn).catch(() => undefined);
        this.chains.set(k, next);
        void next.finally(() => { if (this.chains.get(k) === next) this.chains.delete(k); });
        return next;
    }

    /** Settle every in-flight chain (tests / shutdown). */
    async idle(): Promise<void> { while (this.chains.size) await Promise.all([...this.chains.values()]); }

    // ── entry points ────────────────────────────────────────────────

    /** A held `completed` terminal arrived for an implementing/revising stage parent. */
    onImplCompleted(meshId: string, parentId: string, attemptId?: string): Promise<void> {
        return this.serial(meshId, parentId, async () => {
            const parent = this.ports.queue.get(meshId, parentId);
            if (!parent || !isStageParent(parent) || parent.stageState!.released) return;
            const phase = parent.stageState!.phase;
            if (phase !== 'implementing' && phase !== 'revising') return;
            const workspace = this.ports.workspaceOf(parent);
            let head: string | null = null;
            let base = parent.stageState!.baseSha || null;
            let hasDiff = true;
            if (workspace) {
                base ??= await this.ports.git.baseSha(workspace);
                head = await this.ports.git.headSha(workspace);
                if (base && head) hasDiff = base !== head;
            }
            const stash = peekStageReport(meshId, parentId);
            await this.apply(meshId, parentId, { kind: 'impl_completed', hasDiff, ...(attemptId ? { attemptId } : {}), ...(head ? { headSha: head } : {}), at: this.iso() }, state => {
                if (base && !state.baseSha) state.baseSha = base;
                if (stash?.artifactIds?.length) state.workerArtifactIds = [...new Set([...(state.workerArtifactIds ?? []), ...stash.artifactIds])].slice(-8);
            });
            if (workspace && hasDiff && base && head) await this.registerDiff(parentId, workspace, base, head);
        });
    }

    /** A review child reached a terminal status (called from the terminal choke point's post-commit hook). */
    onChildTerminal(meshId: string, childId: string): Promise<void> {
        const child = this.ports.queue.get(meshId, childId);
        if (!child || !isStageChild(child)) return Promise.resolve();
        const parentId = child.parentTaskId!;
        return this.serial(meshId, parentId, async () => {
            const parent = this.ports.queue.get(meshId, parentId);
            if (!parent || !isStageParent(parent)) return;
            const st = parent.stageState!;
            if (st.phase !== 'reviewing' && st.phase !== 'awaiting_review') return;
            if (!st.reviewTaskIds.includes(childId) || st.reviewTaskIds[st.reviewTaskIds.length - 1] !== childId) return; // a superseded child
            const fresh = this.ports.queue.get(meshId, childId)!;
            const report = peekStageReport(meshId, childId);
            const independenceUsed = reviewIndependenceOf(fresh.review ?? {}) === 'fresh_session' ? 'fresh_session_fallback' as const : 'different_provider' as const;
            // §11: the reviewer must leave a read-lease checkout exactly as it found it (light workspaces are exempt: no fingerprint).
            if (st.reviewFingerprint) {
                const workspace = this.ports.workspaceOf(parent);
                const now = workspace ? await this.ports.git.fingerprint(workspace) : null;
                if (now && now !== st.reviewFingerprint) {
                    dropStageReport(meshId, childId);
                    await this.apply(meshId, parentId, { kind: 'reviewer_mutated_source', childTaskId: childId, at: this.iso() });
                    return;
                }
            }
            if (fresh.status === 'completed' && report?.review) {
                const verdictArt = this.ports.artifacts.register({
                    meshId, ...(parent.missionId ? { missionId: parent.missionId } : {}), taskId: parentId, kind: 'review_verdict',
                    title: `Review verdict r${st.round}: ${report.review.verdict}`, ext: '.json',
                    content: JSON.stringify({ round: st.round, reviewTaskId: childId, independenceUsed, ...report.review }, null, 2),
                });
                dropStageReport(meshId, childId);
                await this.apply(meshId, parentId, {
                    kind: 'review_verdict', childTaskId: childId, report: report.review, independenceUsed,
                    ...(fresh.assignedSessionId ? { reviewerSessionId: fresh.assignedSessionId } : {}), at: this.iso(),
                }, state => { if (verdictArt) state.artifacts.verdict.push(verdictArt); (state as MeshTaskStageState & { reviewerProvider?: string }).reviewerProvider = fresh.assignedProviderType; });
                return;
            }
            if (fresh.status === 'cancelled' && st.phase === 'awaiting_review' && fresh.cancelReason?.startsWith('stage_')) return;
            await this.apply(meshId, parentId, { kind: 'reviewer_unavailable', childTaskId: childId, at: this.iso() });
        });
    }

    /** A review child was claimed (phase awaiting_review → reviewing). */
    onChildClaimed(meshId: string, childId: string): Promise<void> {
        const child = this.ports.queue.get(meshId, childId);
        if (!child || !isStageChild(child)) return Promise.resolve();
        return this.serial(meshId, child.parentTaskId!, () => this.apply(meshId, child.parentTaskId!, {
            kind: 'review_started', childTaskId: childId, ...(child.assignedSessionId ? { reviewerSessionId: child.assignedSessionId } : {}), at: this.iso(),
        }));
    }

    /** Ceiling sweep + restart resume (§8.3, §8.4). Safe to call repeatedly. */
    async tick(): Promise<void> {
        await this.promoteIndependenceFallbacks();
        for (const parent of this.ports.queue.listStageParents()) {
            const st = parent.stageState!;
            if (st.released || st.phase === 'done') continue;
            const age = this.ports.now() - Date.parse(st.startedAt);
            // Never block the housekeeping tick on a long self-check; skip parents with work already in flight.
            if (this.chains.has(this.key(parent.meshId, parent.id))) continue;
            if (age > this.ports.pipelineCeilingMs()) {
                void this.serial(parent.meshId, parent.id, () => this.apply(parent.meshId, parent.id, { kind: 'ceiling', at: this.iso() }));
                continue;
            }
            void this.serial(parent.meshId, parent.id, () => this.resumeOne(parent.meshId, parent.id));
        }
    }

    /**
     * R2: promote a review child to the `fresh_session` fallback once it has been refused ONLY for
     * `review_independence_required` for the fallback window (tracked by stage-independence.ts).
     */
    async promoteIndependenceFallbacks(): Promise<number> {
        let promoted = 0;
        for (const parent of this.ports.queue.listStageParents()) {
            const st = parent.stageState!;
            if (parent.stagePlan!.independence !== 'fresh_session_ok' || st.phase !== 'awaiting_review') continue;
            const last = st.reviewTaskIds[st.reviewTaskIds.length - 1];
            const child = last ? this.ports.queue.get(parent.meshId, last) : null;
            if (!child || child.status !== 'pending' || child.review?.independence === 'fresh_session') continue;
            if (!independenceRefusalExceeded(child.id, this.ports.now())) continue;
            this.ports.queue.setChildIndependence(parent.meshId, child.id, 'fresh_session');
            this.ports.events.progress(parent.meshId, parent.id, 'stage: no other-provider reviewer available — falling back to a fresh same-provider session');
            promoted++;
        }
        return promoted;
    }

    private async resumeOne(meshId: string, parentId: string): Promise<void> {
        const parent = this.ports.queue.get(meshId, parentId);
        if (!parent || !isStageParent(parent)) return;
        const st = parent.stageState!;
        if (st.phase === 'self_checking') await this.runEffects(meshId, parentId, [{ kind: 'run_self_check' }]);
        else if (st.phase === 'awaiting_review' || st.phase === 'reviewing') {
            const last = st.reviewTaskIds[st.reviewTaskIds.length - 1];
            const child = last ? this.ports.queue.get(meshId, last) : null;
            if (!child) await this.runEffects(meshId, parentId, [{ kind: 'create_review_child', round: st.round }]);
            else if (child.status === 'completed' || child.status === 'failed' || child.status === 'blocked' || child.status === 'cancelled') {
                void this.onChildTerminal(meshId, child.id);
            }
        }
    }

    /** `mesh_task_stage_decide` (§9.4) on a blocked stage parent. */
    decide(meshId: string, parentId: string, action: 'accept' | 'revise_once' | 'rereview' | 'abandon', note?: string): Promise<{ ok: boolean; error?: string }> {
        let result: { ok: boolean; error?: string } = { ok: true };
        return this.serial(meshId, parentId, async () => {
            const parent = this.ports.queue.get(meshId, parentId);
            if (!parent || !isStageParent(parent)) { result = { ok: false, error: 'not_a_stage_task' }; return; }
            if (parent.status !== 'blocked' || !parent.stageState!.blockedReason) { result = { ok: false, error: 'stage_task_not_blocked' }; return; }
            if (action === 'accept' || action === 'abandon') {
                if (action === 'accept') {
                    this.ports.queue.commitParent(parent, 'completed', { finalSummary: `Accepted by coordinator${note ? `: ${note}` : ''}` }, 'stage_decide:accept');
                } else {
                    this.ports.queue.cancel(meshId, parentId, `stage_decide:abandon${note ? `: ${note}` : ''}`);
                }
                return;
            }
            // Reopen: blocked → assigned (the reducer re-enters revising / awaiting_review).
            this.ports.queue.mutate(meshId, parentId, e => { e.status = 'assigned'; });
            await this.apply(meshId, parentId, { kind: action === 'revise_once' ? 'decide_revise_once' : 'decide_rereview', at: this.iso() });
        }).then(() => result);
    }

    // ── reducer driver ──────────────────────────────────────────────

    private async apply(meshId: string, parentId: string, event: StageEvent, pre?: (s: MeshTaskStageState) => void): Promise<void> {
        let effects: StageEffect[] = [];
        this.ports.queue.mutate(meshId, parentId, e => {
            if (!e.stagePlan || !e.stageState) return;
            const r = reduceStage(e.stagePlan, e.stageState, event);
            if (r.state === e.stageState) return;
            effects = r.effects;
            e.stageState = r.state;
            pre?.(e.stageState);
            if (event.kind === 'review_verdict' || event.kind === 'review_started') { /* ids recorded by create_review_child */ }
        });
        if (effects.length) await this.runEffects(meshId, parentId, effects);
    }

    private async runEffects(meshId: string, parentId: string, effects: StageEffect[]): Promise<void> {
        for (const effect of effects) {
            const parent = this.ports.queue.get(meshId, parentId);
            if (!parent || !isStageParent(parent)) return;
            try { await this.runEffect(parent, effect); }
            catch (e: any) { this.ports.events.progress(meshId, parentId, `stage effect ${effect.kind} failed: ${e?.message || e}`); }
        }
    }

    private async runEffect(parent: MeshWorkQueueEntry, effect: StageEffect): Promise<void> {
        const { meshId, id } = parent;
        const st = parent.stageState!;
        switch (effect.kind) {
            case 'progress': this.ports.events.progress(meshId, id, effect.text); return;
            case 'cancel_review_children':
                for (const cid of st.reviewTaskIds) {
                    const c = this.ports.queue.get(meshId, cid);
                    if (c && (c.status === 'pending' || c.status === 'assigned')) this.ports.queue.cancel(meshId, cid, 'stage_parent_closed');
                }
                return;
            case 'run_self_check': {
                this.ports.events.progress(meshId, id, 'stage: self-check');
                const workspace = this.ports.workspaceOf(parent);
                let result: { status: import('./stage-pipeline.js').SelfCheckStatus; log: string };
                if (!workspace) result = { status: 'unavailable', log: 'no workspace resolvable for the stage parent' };
                else if (!(await this.ports.git.isClean(workspace))) result = { status: 'failed', log: 'uncommitted changes: commit all work before reporting' };
                else {
                    try { result = await this.ports.selfCheck.run({ meshId, taskId: id, workspace, baseSha: st.baseSha, profile: 'fast' }); }
                    catch (e: any) { result = { status: 'skipped_infra_error', log: `self-check runner error: ${e?.message || e}` }; }
                }
                const art = this.ports.artifacts.register({
                    meshId, ...(parent.missionId ? { missionId: parent.missionId } : {}), taskId: id, kind: 'self_check',
                    title: `Self-check: ${result.status}`, ext: '.md', content: `# Self-check (${result.status})\n\n${result.log.slice(-SELF_CHECK_LOG_MAX)}\n`,
                });
                await this.apply(meshId, id, { kind: 'self_check_done', status: result.status, at: this.iso() }, s => { if (art) s.artifacts.selfCheck.push(art); });
                return;
            }
            case 'create_review_child': {
                const workspace = this.ports.workspaceOf(parent);
                const head = st.stageHeads[st.stageHeads.length - 1]?.rootSha ?? '';
                const plan = parent.stagePlan!;
                const child0 = st.reviewTaskIds.length;
                const reviewId = `${id}:review:${effect.round}:${child0}`;
                const ws = workspace && head
                    ? await this.ports.reviewerWorkspace.prepare({ meshId, parentTaskId: id, reviewTaskId: reviewId, round: effect.round, rootSha: head, baseSha: st.baseSha, sourceWorkspace: workspace })
                    : null;
                const reuse = effect.reuseSessionId && this.ports.queue.sessionAlive(effect.reuseSessionId) ? effect.reuseSessionId : undefined;
                const stash = peekStageReport(meshId, id);
                const msg = buildReviewerMessage({
                    originalMessage: st.originalMessage ?? parent.message, implementerSummary: stash?.summary ?? '(see artifacts)', round: effect.round,
                    maxRevisions: plan.maxRevisions, selfCheck: st.selfCheck, priorOpenFindingIds: st.openFindingIds, ...(ws ? { workspace: ws.path } : {}),
                    baseSha: st.baseSha || '(unknown)', headSha: head || '(unknown)',
                });
                const inputs = selectStageInputArtifacts(st);
                const child = this.ports.queue.enqueueReviewChild(parent, {
                    round: effect.round, message: msg, inputArtifactIds: inputs,
                    independence: 'different_provider',
                    ...(reuse ? { targetSessionId: reuse } : {}),
                    ...(ws ? { reviewerWorkspace: { path: ws.path, headSha: ws.headSha } } : {}),
                });
                // §11: a read-lease reviewer works IN the parent's checkout — fingerprint it so a mutation is detectable.
                const fingerprint = !ws && workspace ? await this.ports.git.fingerprint(workspace) : null;
                this.ports.queue.mutate(meshId, id, e => {
                    e.stageState!.reviewTaskIds = [...e.stageState!.reviewTaskIds, child.id];
                    if (fingerprint) e.stageState!.reviewFingerprint = fingerprint; else delete e.stageState!.reviewFingerprint;
                });
                this.ports.events.progress(meshId, id, `stage: review round ${effect.round} queued`);
                return;
            }
            case 'send_revision': {
                const stash = peekStageReport(meshId, id);
                const memo = buildRevisionMemo({
                    reason: effect.reason, round: effect.round, findings: st.openFindings ?? [],
                    verdictArtifactIds: st.artifacts.verdict.slice(-1), selfCheckLog: effect.reason === 'self_check' ? 'see self-check artifact: ' + (st.artifacts.selfCheck.slice(-1)[0] ?? '') : undefined,
                });
                void stash;
                this.ports.queue.mutate(meshId, id, e => { e.stageState!.originalMessage ??= e.message; });
                this.ports.queue.requeueForRevision(parent, memo, {
                    ...(this.ports.queue.sessionAlive(parent.assignedSessionId) ? { sameSessionId: parent.assignedSessionId } : {}),
                    inputArtifactIds: [...selectStageInputArtifacts(st), ...(st.workerArtifactIds ?? []).slice(-4)],
                });
                this.ports.events.progress(meshId, id, `stage: revising (${effect.reason})`);
                return;
            }
            case 'release': {
                const skipped = st.round === 0 && effect.status === 'completed';
                const summary = peekStageReport(meshId, id)?.summary ?? 'Stage task finished.';
                const text = buildFinalReport({
                    outcome: effect.status, implementerSummary: summary, state: st, skippedNoDiff: skipped,
                    reviewerProvider: (st as MeshTaskStageState & { reviewerProvider?: string }).reviewerProvider,
                });
                const lifted = this.ports.queue.mutate(meshId, id, e => { e.stageState!.released = true; });
                if (!lifted) return;
                this.ports.queue.commitParent(lifted, effect.status, { finalSummary: text, evidence: { stage: { phase: 'done', rounds: st.round, lastVerdict: st.lastVerdict, blockedReason: st.blockedReason } } }, `stage_${effect.status}`);
                this.ports.events.notifyParentTerminal(lifted, effect.status, text);
                if (effect.status === 'completed') this.ports.events.implementerFinished?.(lifted);
                dropStageReport(meshId, id);
                return;
            }
        }
    }

    private async registerDiff(parentId: string, workspace: string, base: string, head: string): Promise<void> {
        const parent = this.findParentById(parentId);
        if (!parent) return;
        let diff = '';
        try { diff = (await this.ports.git.diff(workspace, base, head)).slice(0, DIFF_MAX); } catch { return; }
        const id = this.ports.artifacts.register({
            meshId: parent.meshId, ...(parent.missionId ? { missionId: parent.missionId } : {}), taskId: parentId, kind: 'diff',
            title: `Diff ${base.slice(0, 8)}..${head.slice(0, 8)}`, ext: '.diff', content: diff,
        });
        if (id) this.ports.queue.mutate(parent.meshId, parentId, e => { e.stageState!.artifacts.diff.push(id); });
    }

    private findParentById(parentId: string): MeshWorkQueueEntry | null {
        return this.ports.queue.listStageParents().find(p => p.id === parentId) ?? null;
    }
}

/** §7: latest diff + latest self-check + latest verdict + one previous verdict (max 4). */
export function selectStageInputArtifacts(st: MeshTaskStageState): string[] {
    const v = st.artifacts.verdict;
    return [...new Set([
        ...st.artifacts.diff.slice(-1), ...st.artifacts.selfCheck.slice(-1), ...v.slice(-1), ...(v.length > 1 ? v.slice(-2, -1) : []),
    ])];
}

export type { MeshReviewReport };
