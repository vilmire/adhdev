// Review-in-task: effect executor for the stage reducer (docs/design/2026-11-01-review-in-task.md §3–§8).
// All I/O goes through StageRuntimePorts (stage-ports.ts); production wiring is stage-ports-default.ts.
// The runtime never emits turn states — it reads what the ledger already committed and writes queue rows.

import { recoverPendingStageReview, type StageReviewRecoveryHost, type StageReviewRecoveryRequest } from './stage-review-recovery.js';
import { reviewIndependenceOf, type MeshReviewReport, type MeshTaskStageState } from '@adhdev/mesh-shared';
import { reduceStage, type StageEffect, type StageEvent } from './stage-pipeline.js';
import { FINGERPRINT_V2, type StageRuntimePorts } from './stage-ports.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';
import { dropStageReport, peekStageReport } from './stage-report-stash.js';
import { buildFinalReport, buildReviewerMessage, buildRevisionMemo } from './stage-synthesis.js';
import { isStageBlockOverwritten, isStageChild, isStageParent, selectStageInputArtifacts } from './stage-state.js';
import { independenceRefusalExceeded } from './stage-independence.js';
import { StageEffectFailureTracker } from './stage-effect-failures.js';

const STAGE_PARENT_ENDED = new Set(['completed', 'failed', 'blocked', 'cancelled']);

const SELF_CHECK_LOG_MAX = 60_000;
const DIFF_MAX = 1_500_000;

/**
 * create_review_child failures that retrying cannot fix: the required input evidence is unauthorized, gone or
 * changed. Everything else (busy checkout, missing local context, a raced parent) is retried on the next tick.
 */
const isLastingReviewInputError = (detail: string): boolean => /^(review_input_artifact(s_missing|_unauthorized|_path|_hash)|review_unsupported_for_light_task)\b/.test(detail);

export class StagePipelineRuntime {
    /** Parents with an effect chain in flight (serializes per parent; events arriving meanwhile queue behind it). */
    private readonly chains = new Map<string, Promise<void>>();
    /** Prepared reviewer workspaces by review child id; released when the child ends (or is cancelled). In-memory: a daemon restart leaves them to the light-workspace sweep. */
    private readonly reviewerWorkspaces = new Map<string, { release(): Promise<void> }>();
    private readonly failures = new StageEffectFailureTracker();
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

    /** Same per-parent chain as claims/reports/resume; never enqueues or replaces a child. */
    async recoverPendingReview(request: StageReviewRecoveryRequest, host: StageReviewRecoveryHost) {
        let result: Awaited<ReturnType<typeof recoverPendingStageReview>> | undefined;
        let error: unknown;
        await this.serial(request.meshId, request.parentTaskId, async () => {
            try { result = await recoverPendingStageReview(request, host, this.ports); } catch (e) { error = e; }
        });
        if (error) throw error;
        if (!result) throw new Error('review_recovery_unavailable');
        return result;
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
            if (workspace && hasDiff && base && head) await this.registerDiff(parentId, workspace, base, head);
            await this.apply(meshId, parentId, { kind: 'impl_completed', hasDiff, ...(attemptId ? { attemptId } : {}), ...(head ? { headSha: head } : {}), at: this.iso() }, state => {
                if (base && !state.baseSha) state.baseSha = base;
                if (stash?.artifactIds?.length) state.workerArtifactIds = [...new Set([...(state.workerArtifactIds ?? []), ...stash.artifactIds])].slice(-8);
            });
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
            await this.releaseReviewerWorkspace(childId); // the review child ended: its workspace is no longer needed
            // A parent that already ended (or was released) takes no further rounds: cancelling an orphaned
            // review child must not start a new review for a finished task.
            if (STAGE_PARENT_ENDED.has(parent.status) || parent.stageState!.released) return;
            const st = parent.stageState!;
            if (st.phase !== 'reviewing' && st.phase !== 'awaiting_review') return;
            if (!st.reviewTaskIds.includes(childId) || st.reviewTaskIds[st.reviewTaskIds.length - 1] !== childId) return; // a superseded child
            const fresh = this.ports.queue.get(meshId, childId)!;
            // A child from an earlier round already delivered its outcome; after a rereview/revision whose
            // new child could not be created it is still the last id, and must never judge the new round.
            if (typeof fresh.stageRound === 'number' && fresh.stageRound !== st.round) return;
            const report = peekStageReport(meshId, childId);
            const independenceUsed = reviewIndependenceOf(fresh.review ?? {}) === 'fresh_session' ? 'fresh_session_fallback' as const : 'different_provider' as const;
            // §11 (fail closed): a read-lease reviewer must leave the checkout exactly as it found it. No baseline, an
            // unreadable current fingerprint, or any difference all void the verdict. Light-workspace reviewers are exempt.
            if (!fresh.reviewerWorkspace && fresh.status === 'completed') {
                const workspace = this.ports.workspaceOf(parent);
                // A baseline written before the fingerprint format changed carries no version line: verify it in
                // its own (stricter) format rather than voiding a review that was already in flight.
                const legacyBaseline = !!st.reviewFingerprint && !st.reviewFingerprint.startsWith(`${FINGERPRINT_V2}\n`);
                const now = workspace ? await this.safeFingerprint(workspace, legacyBaseline) : null;
                if (!st.reviewFingerprint || st.reviewFingerprintUnavailable || !now
                    || this.ports.queue.reviewInputValid?.(parent, fresh) === false) {
                    dropStageReport(meshId, childId);
                    await this.apply(meshId, parentId, { kind: 'reviewer_integrity_unverifiable', childTaskId: childId, at: this.iso() });
                    return;
                }
                if (now !== st.reviewFingerprint) {
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
        if (!parent || !isStageParent(parent) || STAGE_PARENT_ENDED.has(parent.status)) return;
        const st = parent.stageState!;
        if (st.phase === 'self_checking') await this.runEffects(meshId, parentId, [{ kind: 'run_self_check' }]);
        else if (st.phase === 'awaiting_review' || st.phase === 'reviewing') {
            const last = st.reviewTaskIds[st.reviewTaskIds.length - 1];
            const child = last ? this.ports.queue.get(meshId, last) : null;
            if (!child || (typeof child.stageRound === 'number' && child.stageRound !== st.round)) {
                // No child for THIS round yet (none at all, or only an earlier round's): create it.
                await this.runEffects(meshId, parentId, [{ kind: 'create_review_child', round: st.round }]);
            }
            else if (child.status === 'completed' || child.status === 'failed' || child.status === 'blocked' || child.status === 'cancelled') {
                void this.onChildTerminal(meshId, child.id);
            }
        }
    }

    /** `mesh_task_stage_decide` (§9.4) on a blocked stage parent. */
    decide(meshId: string, parentId: string, action: 'accept' | 'revise_once' | 'rereview' | 'abandon', note?: string): Promise<{ ok: boolean; error?: string }> {
        let result: { ok: boolean; error?: string } = { ok: true };
        return this.serial(meshId, parentId, async () => {
            // serial() swallows a throw, so a refused write (writer_checkpoint_pending while the
            // attempt is still stopping) must surface here, or the caller hears success with
            // nothing changed (live 2026-11-06: c1cdb3f7 rereview).
            try {
                let parent = this.ports.queue.get(meshId, parentId);
                if (!parent || !isStageParent(parent)) { result = { ok: false, error: 'not_a_stage_task' }; return; }
                // A late `completed` overwrote the review's `blocked` (before isStageBlockLocked):
                // restore the review's verdict so the decision runs exactly as on a blocked row.
                if (isStageBlockOverwritten(parent)) {
                    parent = this.ports.queue.mutate(meshId, parentId, e => { e.status = 'blocked'; }) ?? parent;
                    this.ports.events.progress(meshId, parentId, 'restored the review block a late completion had overwritten');
                }
                // Review is opt-in (2026-11-08): a review that never started — parked on its pin, quota-gated,
                // or waiting for a reviewer that cannot claim it — must not hold the work hostage. The
                // coordinator may accept (skip the review) or abandon such a task without the review running.
                const pendingChild = parent.status === 'assigned' && parent.stageState!.phase === 'awaiting_review'
                    ? this.ports.queue.get(meshId, parent.stageState!.reviewTaskIds.at(-1) ?? '') : null;
                const reviewNeverStarted = !!pendingChild && pendingChild.status === 'pending' && !pendingChild.assignedSessionId;
                if ((action === 'accept' || action === 'abandon') && reviewNeverStarted) {
                    // Settle the parent FIRST, so the child's terminal hook finds a finished parent and does not
                    // react to the cancelled review (e.g. by queueing a replacement reviewer).
                    if (action === 'accept') {
                        this.ports.queue.commitParent(parent, 'completed', { finalSummary: `Accepted by coordinator without review${note ? `: ${note}` : ''}` }, 'stage_decide:accept_unreviewed');
                    } else {
                        this.ports.queue.cancel(meshId, parentId, `stage_decide:abandon${note ? `: ${note}` : ''}`);
                    }
                    this.ports.queue.cancel(meshId, pendingChild!.id, `stage_decide:${action}: review skipped before it started`);
                    return;
                }
                if (parent.status !== 'blocked' || !parent.stageState!.blockedReason) { result = { ok: false, error: 'stage_task_not_blocked' }; return; }
                if (action === 'accept' || action === 'abandon') {
                    if (action === 'accept') {
                        // Clearing the reason marks the block decided, so it can never be reopened as overwritten.
                        parent = this.ports.queue.mutate(meshId, parentId, e => { delete e.stageState!.blockedReason; delete e.stageState!.blockedDetail; }) ?? parent;
                        this.ports.queue.commitParent(parent, 'completed', { finalSummary: `Accepted by coordinator${note ? `: ${note}` : ''}` }, 'stage_decide:accept');
                    } else {
                        this.ports.queue.cancel(meshId, parentId, `stage_decide:abandon${note ? `: ${note}` : ''}`);
                    }
                    return;
                }
                // Reopen: blocked → assigned (the reducer re-enters revising / awaiting_review).
                this.ports.queue.mutate(meshId, parentId, e => { e.status = 'assigned'; });
                await this.apply(meshId, parentId, { kind: action === 'revise_once' ? 'decide_revise_once' : 'decide_rereview', at: this.iso() });
            } catch (e: any) { result = { ok: false, error: String(e?.message || e) }; }
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
            try { await this.runEffect(parent, effect); this.failures.clear(meshId, parentId, effect.kind); }
            catch (e: any) {
                const detail = String(e?.message || e);
                const verdict = this.failures.record(meshId, parentId, effect.kind, detail);
                // One ledger row per failure streak (not per retry); the escalation below adds the closing row.
                if (verdict.log && !verdict.escalate) this.ports.events.progress(meshId, parentId, `stage effect ${effect.kind} failed: ${detail}`);
                // A reviewer whose required evidence is invalid would otherwise retry silently forever (and an
                // earlier round's child would look like this round's): block with the real reason instead.
                if (effect.kind === 'create_review_child' && isLastingReviewInputError(detail)) {
                    await this.apply(meshId, parentId, { kind: 'review_input_failed', detail, at: this.iso() });
                    this.failures.clear(meshId, parentId);
                } else if (effect.kind === 'create_review_child' && verdict.escalate) {
                    // The same error N ticks in a row is not transient: block the stage (blocked_review for the
                    // coordinator, via the normal release/notice path) instead of retrying for ever.
                    const text = `create_review_child failed ${verdict.count}x in a row: ${detail}`;
                    this.ports.events.progress(meshId, parentId, `stage effect ${effect.kind} gave up: ${text}`);
                    await this.apply(meshId, parentId, { kind: 'review_input_failed', detail: text, at: this.iso() });
                    this.failures.clear(meshId, parentId);
                }
            }
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
                    await this.releaseReviewerWorkspace(cid);
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
                // A restart in self_checking may not have registered the round diff yet.
                const head = st.stageHeads.at(-1)?.rootSha;
                if (workspace && st.baseSha && head && !st.artifacts.diff.length) await this.registerDiff(id, workspace, st.baseSha, head);
                await this.apply(meshId, id, { kind: 'self_check_done', status: result.status, at: this.iso() }, s => { if (art) s.artifacts.selfCheck.push(art); });
                return;
            }
            case 'create_review_child': {
                // A persisted child owns its original baseline; retries must never refresh a started review.
                if (st.reviewTaskIds.some(cid => { const c = this.ports.queue.get(meshId, cid); return c?.stageRound === effect.round && (c.status === 'pending' || c.status === 'assigned'); })) return;
                // A reviewer must claim from the reviewed checkout, and none can be launched into a light worktree.
                if (parent.light) throw new Error('review_unsupported_for_light_task');
                const workspace = this.ports.workspaceOf(parent);
                const head = st.stageHeads[st.stageHeads.length - 1]?.rootSha ?? '';
                const plan = parent.stagePlan!;
                const child0 = st.reviewTaskIds.length;
                const reviewId = `${id}:review:${effect.round}:${child0}`;
                const ws = workspace && head
                    ? await this.ports.reviewerWorkspace.prepare({ meshId, parentTaskId: id, reviewTaskId: reviewId, round: effect.round, rootSha: head, baseSha: st.baseSha, sourceWorkspace: workspace })
                    : null;
                // Reuse the prior reviewer only when it can actually claim this round: a session below the
                // review's difficulty floor would sit pinned, never claim, and park the review after the TTL.
                const reviewDifficulty = parent.difficulty === 'difficult' ? 'difficult' as const : 'medium' as const;
                const reuse = effect.reuseSessionId && this.ports.queue.sessionAlive(effect.reuseSessionId)
                    && (this.ports.queue.sessionMeetsDifficulty?.(meshId, effect.reuseSessionId, reviewDifficulty) ?? true) ? effect.reuseSessionId : undefined;
                const stash = peekStageReport(meshId, id);
                const msg = buildReviewerMessage({
                    originalMessage: st.originalMessage ?? parent.message, implementerSummary: stash?.summary ?? '(see artifacts)', round: effect.round,
                    maxRevisions: plan.maxRevisions, selfCheck: st.selfCheck, priorOpenFindingIds: st.openFindingIds, ...(ws ? { workspace: ws.path } : {}),
                    baseSha: st.baseSha || '(unknown)', headSha: head || '(unknown)',
                });
                const inputs = selectStageInputArtifacts(st);
                // §11 (fail closed): a read-lease reviewer works IN the parent's checkout. Take the baseline fingerprint
                // BEFORE the child exists so it cannot act first; retry once, else flag it unavailable (the verdict is then never accepted).
                const readLease = !ws;
                let fingerprint: string | null = null;
                if (readLease && workspace) {
                    fingerprint = await this.safeFingerprint(workspace);
                    if (!fingerprint) fingerprint = await this.safeFingerprint(workspace);
                }
                let child: MeshWorkQueueEntry;
                try {
                    // The reads above are async (reviewer workspace, fingerprint) and other writers touch the row
                    // meanwhile; a snapshot taken before them is stale by construction, so every retry would be
                    // refused `stage_review_stale_parent`. Re-read right before the (synchronous, locked) enqueue;
                    // the port still refuses when the stage genuinely moved on (phase/round/released).
                    const current = this.ports.queue.get(meshId, id);
                    if (!current || !isStageParent(current)) throw new Error('stage_review_stale_parent');
                    child = this.ports.queue.enqueueReviewChild(current, {
                        round: effect.round, message: msg, inputArtifactIds: inputs,
                        independence: 'different_provider',
                        ...(readLease && fingerprint ? { reviewFingerprint: fingerprint } : {}),
                        ...(reuse ? { targetSessionId: reuse } : {}),
                        ...(ws ? { reviewerWorkspace: { path: ws.path, headSha: ws.headSha } } : {}),
                    });
                } catch (e) {
                    if (ws) await ws.release().catch(() => undefined);
                    throw e;
                }
                if (ws) this.reviewerWorkspaces.set(child.id, ws);
                this.ports.queue.mutate(meshId, id, e => {
                    if (e.stageState!.reviewTaskIds.includes(child.id)) return; // production persisted child + baseline atomically
                    e.stageState!.reviewTaskIds.push(child.id);
                    delete e.stageState!.reviewFingerprint;
                    delete e.stageState!.reviewFingerprintUnavailable;
                    if (readLease) { if (fingerprint) e.stageState!.reviewFingerprint = fingerprint; else e.stageState!.reviewFingerprintUnavailable = true; }
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

    private async releaseReviewerWorkspace(childId: string): Promise<void> {
        const ws = this.reviewerWorkspaces.get(childId);
        if (!ws) return;
        this.reviewerWorkspaces.delete(childId);
        try { await ws.release(); } catch { /* the light-workspace sweep reclaims leftovers */ }
    }

    private async safeFingerprint(workspace: string, legacy = false): Promise<string | null> {
        try { return (await this.ports.git.fingerprint(workspace, legacy ? { legacy: true } : undefined)) || null; } catch { return null; }
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

export { selectStageInputArtifacts } from './stage-state.js';

export type { MeshReviewReport };
