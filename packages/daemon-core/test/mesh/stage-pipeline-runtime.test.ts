import { beforeEach, describe, expect, it } from 'vitest';
import { StagePipelineRuntime, selectStageInputArtifacts } from '../../src/mesh/stage-pipeline-runtime.js';
import { initialStageState } from '../../src/mesh/stage-state.js';
import { __resetStageReportStashForTests, stashStageReport } from '../../src/mesh/stage-report-stash.js';
import { __resetIndependenceTrackerForTests, noteReviewRefusal } from '../../src/mesh/stage-independence.js';
import type { StageRuntimePorts } from '../../src/mesh/stage-ports.js';
import type { MeshWorkQueueEntry } from '../../src/mesh/mesh-work-queue-types.js';
import type { SelfCheckResult } from '../../src/mesh/stage-ports.js';
import type { MeshReviewReport } from '@adhdev/mesh-shared';

const MESH = 'm1';
const PARENT = 'p1';

function harness(opts: { maxRevisions?: 0 | 1 | 2 | 3; selfChecks?: SelfCheckResult[]; diff?: boolean; independence?: 'different_provider' | 'fresh_session_ok' } = {}) {
    let nowMs = Date.parse('2026-11-01T00:00:00Z');
    const rows = new Map<string, MeshWorkQueueEntry>();
    const log = { progress: [] as string[], notices: [] as Array<{ status: string; report: string }>, commits: [] as Array<{ status: string; text: string }>, revisions: [] as string[], artifacts: [] as string[], cancelled: [] as string[], finished: [] as string[], sessions: new Set<string>(['impl-s', 'rev-s']) };
    const parent: MeshWorkQueueEntry = {
        id: PARENT, meshId: MESH, message: 'do the thing', status: 'assigned', taskMode: 'code_change', difficulty: 'medium',
        assignedSessionId: 'impl-s', assignedProviderType: 'claude-cli', missionId: 'mi1',
        stagePlan: { review: true, maxRevisions: opts.maxRevisions ?? 2, independence: opts.independence ?? 'fresh_session_ok' },
        stageState: initialStageState(new Date(nowMs).toISOString()), origin: 'coordinator', createdAt: '', updatedAt: '',
    };
    rows.set(PARENT, parent);
    const selfChecks = [...(opts.selfChecks ?? [])];
    let head = 0;
    const fp = { value: 'fp0' as string | null, legacyValue: undefined as string | null | undefined, legacyCalls: 0, queue: [] as Array<string | null | 'throw'> };
    const ports: StageRuntimePorts = {
        now: () => nowMs,
        selfCheck: { run: async () => selfChecks.shift() ?? { status: 'passed', log: 'ok' } },
        reviewerWorkspace: { prepare: async () => null },
        git: {
            baseSha: async () => 'base0000', headSha: async () => (opts.diff === false ? 'base0000' : `head${++head}`),
            diff: async () => 'diff text', isClean: async () => true, fingerprint: async (_w, limits) => { if (limits?.legacy) fp.legacyCalls++; const next = fp.queue.shift(); if (next === 'throw') throw new Error('git failed'); if (next !== undefined) return next; return limits?.legacy && fp.legacyValue !== undefined ? fp.legacyValue : fp.value; },
        },
        artifacts: { register: i => { const id = `art_${i.kind}_${log.artifacts.length}`; log.artifacts.push(id); return id; } },
        queue: {
            get: (_m, id) => rows.get(id) ?? null,
            mutate: (_m, id, fn) => { const e = rows.get(id); if (!e) return null; fn(e); return e; },
            listStageParents: () => [...rows.values()].filter(r => r.stagePlan),
            enqueueReviewChild: (p, spec) => {
                const id = `${p.id}:child${rows.size}`;
                const c: MeshWorkQueueEntry = { id, meshId: MESH, message: spec.message, status: 'pending', origin: 'stage', parentTaskId: p.id, stageRole: 'review', stageRound: spec.round, inputArtifactIds: spec.inputArtifactIds, readonly: true, review: { sourceTaskId: p.id, independence: spec.independence }, ...(spec.reviewerWorkspace ? { reviewerWorkspace: spec.reviewerWorkspace } : {}), createdAt: '', updatedAt: '' };
                rows.set(id, c); return c;
            },
            cancel: (_m, id, reason) => { const e = rows.get(id); if (e) { e.status = 'cancelled'; e.cancelReason = reason; } log.cancelled.push(id); },
            setChildIndependence: (_m, id, ind) => { rows.get(id)!.review = { sourceTaskId: PARENT, independence: ind }; },
            commitParent: (e, status, env) => { e.status = status; log.commits.push({ status, text: env.finalSummary }); },
            requeueForRevision: (e, memo) => { log.revisions.push(memo); e.status = 'assigned'; },
            sessionAlive: s => !!s && log.sessions.has(s),
        },
        events: { implementerFinished: p => { log.finished.push(p.id); }, progress: (_m, _t, t) => log.progress.push(t), notifyParentTerminal: (_p, status, report) => log.notices.push({ status, report }) },
        workspaceOf: () => '/opt/ws',
        pipelineCeilingMs: () => 4 * 3600_000,
    };
    const rt = new StagePipelineRuntime(ports);
    const implDone = async (attemptId: string, summary = 'implemented') => {
        stashStageReport(MESH, PARENT, { outcome: 'completed', summary, at: nowMs });
        await rt.onImplCompleted(MESH, PARENT, attemptId);
        await rt.idle();
    };
    const lastChild = () => rows.get(rows.get(PARENT)!.stageState!.reviewTaskIds.at(-1)!)!;
    const review = async (report: Partial<MeshReviewReport>, status: MeshWorkQueueEntry['status'] = 'completed') => {
        const c = lastChild();
        c.status = status; c.assignedSessionId = 'rev-s'; c.assignedProviderType = 'codex-cli';
        if (status === 'completed') stashStageReport(MESH, c.id, { outcome: 'completed', summary: 'reviewed', review: { verdict: 'approve', findings: [], checked: ['diff'], notChecked: ['perf'], ...report }, at: nowMs });
        await rt.onChildTerminal(MESH, c.id); await rt.idle();
    };
    const f = (id: string, severity: 'major' | 'nit' = 'major') => ({ id, severity, category: 'correctness' as const, claim: `claim ${id}`, evidence: 'ev' });
    return { ports, fp, rt, rows, log, parent: () => rows.get(PARENT)!, implDone, review, lastChild, advance: (ms: number) => { nowMs += ms; } , f };
}

beforeEach(() => { __resetStageReportStashForTests(); __resetIndependenceTrackerForTests(); });

describe('stage pipeline runtime', () => {
    it('grants worker evidence and registers the diff before a reviewer can be queued', async () => {
        const h = harness();
        h.parent().stageState!.workerArtifactIds = ['art_worker_report'];
        await h.implDone('a1');
        expect(h.lastChild().inputArtifactIds).toContain('art_worker_report');
        expect(h.lastChild().inputArtifactIds).toContain(h.parent().stageState!.artifacts.diff[0]);
        expect(selectStageInputArtifacts(h.parent().stageState!)).toEqual(h.lastChild().inputArtifactIds);
    });
    it('backfills a missing diff on self_checking restart before normal review enqueue', async () => {
        const h = harness();
        Object.assign(h.parent().stageState!, { phase: 'self_checking', baseSha: 'base0000', stageHeads: [{ round: 1, rootSha: 'head1' }] });
        await h.rt.tick(); await h.rt.idle();
        expect(h.lastChild().inputArtifactIds).toContain(h.parent().stageState!.artifacts.diff[0]);
        expect(h.parent().stageState!.reviewTaskIds).toHaveLength(1);
        await h.rt.tick(); await h.rt.idle();
        expect(h.parent().stageState!.reviewTaskIds).toHaveLength(1);
    });
    it('normal resume retries failed review creation without a new API or duplicate reviewer', async () => {
        const h = harness();
        const enqueue = h.ports.queue.enqueueReviewChild;
        let fail = true;
        h.ports.queue.enqueueReviewChild = (p, spec) => { if (fail) throw new Error('review_input_unavailable'); return enqueue(p, spec); };
        await h.implDone('a1');
        expect(h.parent().stageState!.reviewTaskIds).toEqual([]);
        fail = false;
        await h.rt.tick(); await h.rt.idle();
        expect(h.parent().stageState!.reviewTaskIds).toHaveLength(1);
        await h.rt.tick(); await h.rt.idle();
        expect(h.parent().stageState!.reviewTaskIds).toHaveLength(1);
    });
    it('a reviewer that cannot be created for invalid evidence blocks with the real reason, never by an earlier round\'s child', async () => {
        const h = harness();
        await h.implDone('a1');
        await h.review({ verdict: 'changes_requested', findings: [h.f('F1')] });
        expect(h.parent().stageState!.phase).toBe('revising');
        const enqueue = h.ports.queue.enqueueReviewChild;
        let fail = true;
        h.ports.queue.enqueueReviewChild = (p, spec) => { if (fail) throw new Error('review_input_artifact_hash: art_x'); return enqueue(p, spec); };
        await h.implDone('a2');
        expect(h.parent().status).toBe('blocked');
        expect(h.parent().stageState!.blockedReason).toBe('review_unavailable');
        expect(h.parent().stageState!.blockedDetail).toBe('review_input_artifact_hash: art_x');
        // The round-1 child stays the last id: a sweep must not re-judge it as this round's reviewer.
        await h.rt.tick(); await h.rt.idle();
        expect(h.parent().stageState!.blockedReason).toBe('review_unavailable');
        fail = false;
        expect((await h.rt.decide(MESH, PARENT, 'rereview')).ok).toBe(true);
        expect(h.parent().stageState!.blockedDetail).toBeUndefined();
        expect(h.lastChild().stageRound).toBe(h.parent().stageState!.round);
        expect(h.parent().stageState!.reviewTaskIds).toHaveLength(2);
    });
    it('a sweep with only an earlier round\'s finished child creates this round\'s reviewer instead of judging the old one', async () => {
        const h = harness();
        await h.implDone('a1');
        await h.review({ verdict: 'changes_requested', findings: [h.f('F1')] });
        const enqueue = h.ports.queue.enqueueReviewChild;
        let fail = true;
        h.ports.queue.enqueueReviewChild = (p, spec) => { if (fail) throw new Error('review_input_busy'); return enqueue(p, spec); };
        await h.implDone('a2');
        expect(h.parent().stageState!.phase).toBe('awaiting_review');
        await h.rt.tick(); await h.rt.idle();
        expect(h.parent().status).toBe('assigned');
        expect(h.parent().stageState!.blockedReason).toBeUndefined();
        fail = false;
        await h.rt.tick(); await h.rt.idle();
        expect(h.parent().stageState!.reviewTaskIds).toHaveLength(2);
        expect(h.lastChild().stageRound).toBe(2);
    });
    it('a review child ending after its parent already ended starts no new round', async () => {
        const h = harness();
        await h.implDone('a1');
        const before = h.parent().stageState!.reviewTaskIds.length;
        h.parent().status = 'completed';
        await h.review({ verdict: 'changes_requested', findings: [h.f('F1')] }, 'cancelled');
        expect(h.parent().stageState!.reviewTaskIds).toHaveLength(before);
        expect(h.log.revisions).toEqual([]);
        expect(h.log.commits).toEqual([]);
    });

    it('approve in round 1 releases the parent once with a verdict line', async () => {
        const h = harness();
        await h.implDone('a1');
        expect(h.parent().stageState!.phase).toBe('awaiting_review');
        expect(h.parent().stageState!.artifacts.diff).toHaveLength(1);
        await h.review({ verdict: 'approve' });
        expect(h.log.commits).toHaveLength(1);
        expect(h.log.commits[0].status).toBe('completed');
        expect(h.log.finished).toEqual([PARENT]); // implementer session recorded as finished only on the final release
        expect(h.log.commits[0].text).toContain('review: approve · 1 round');
        expect(h.log.notices).toHaveLength(1);
    });

    it('changes_requested → revise → approve (second impl report is not dropped)', async () => {
        const h = harness();
        await h.implDone('a1');
        await h.review({ verdict: 'changes_requested', findings: [h.f('f1')] });
        expect(h.log.revisions).toHaveLength(1);
        expect(h.log.revisions[0]).toContain('f1');
        expect(h.parent().stageState!.phase).toBe('revising');
        await h.implDone('a2', 'fixed it');
        expect(h.parent().stageState!.round).toBe(2);
        await h.review({ verdict: 'approve_with_nits', findings: [h.f('n1', 'nit')], priorFindings: [{ id: 'f1', status: 'resolved' }] });
        expect(h.log.commits).toHaveLength(1);
        expect(h.log.commits[0].text).toMatch(/2 rounds.*1 finding fixed, 1 nit open/);
    });

    it('claiming the review child moves the parent awaiting_review → reviewing and records the reviewer session', async () => {
        const h = harness();
        await h.implDone('a1');
        expect(h.parent().stageState!.phase).toBe('awaiting_review');
        const c = h.lastChild(); c.status = 'assigned'; c.assignedSessionId = 'rev-s';
        await h.rt.onChildClaimed(MESH, c.id); await h.rt.idle();
        expect(h.parent().stageState!.phase).toBe('reviewing');
        expect(h.parent().stageState!.reviewerSessionId).toBe('rev-s');
        await h.rt.onChildClaimed(MESH, c.id); await h.rt.idle(); // replay is a no-op
        expect(h.parent().stageState!.phase).toBe('reviewing');
        await h.review({ verdict: 'approve' });
        expect(h.log.commits[0].status).toBe('completed');
    });

    it('exhausted rounds block with review_unresolved; maxRevisions 0 blocks at once', async () => {
        const h = harness({ maxRevisions: 1 });
        await h.implDone('a1');
        await h.review({ verdict: 'changes_requested', findings: [h.f('f1')] });
        await h.implDone('a2');
        await h.review({ verdict: 'changes_requested', findings: [h.f('f1')], priorFindings: [{ id: 'f1', status: 'unresolved' }] });
        expect(h.parent().stageState!.blockedReason).toBe('review_unresolved');
        expect(h.log.commits[0].status).toBe('blocked');
        const z = harness({ maxRevisions: 0 });
        await z.implDone('a1');
        await z.review({ verdict: 'changes_requested', findings: [z.f('f1')] });
        expect(z.parent().stageState!.blockedReason).toBe('review_unresolved');
        expect(z.log.revisions).toHaveLength(0);
    });

    it('a read-lease reviewer that changed the checkout voids its verdict (reviewer_mutated_source)', async () => {
        const h = harness();
        await h.implDone('a1');
        expect(h.parent().stageState!.reviewFingerprint).toBe('fp0');
        h.fp.value = 'fp-changed';
        await h.review({ verdict: 'approve' });
        expect(h.parent().stageState!.blockedReason).toBe('reviewer_mutated_source');
        expect(h.log.commits[0].status).toBe('blocked');
        const ok = harness();
        await ok.implDone('a1');
        await ok.review({ verdict: 'approve' }); // unchanged fingerprint → verdict stands
        expect(ok.log.commits[0].status).toBe('completed');
    });

    it('a baseline written by the previous fingerprint format is verified in that format, not voided by the upgrade', async () => {
        const old = harness();
        old.fp.value = 'old-format-baseline'; // no version line: written before the format change
        await old.implDone('a1');
        await old.review({ verdict: 'approve' });
        expect(old.fp.legacyCalls).toBeGreaterThan(0);
        expect(old.log.commits[0].status).toBe('completed');
        const mutated = harness();
        mutated.fp.value = 'old-format-baseline';
        await mutated.implDone('a1');
        mutated.fp.legacyValue = 'old-format-after-mutation';
        await mutated.review({ verdict: 'approve' });
        expect(mutated.parent().stageState!.blockedReason).toBe('reviewer_mutated_source'); // still strict
        const current = harness();
        current.fp.value = 'fp2\ncurrent-format';
        await current.implDone('a1');
        await current.review({ verdict: 'approve' });
        expect(current.fp.legacyCalls).toBe(0);
        expect(current.log.commits[0].status).toBe('completed');
    });

    it('fails closed: an unreadable fingerprint at the end blocks with reviewer_integrity_unverifiable', async () => {
        for (const bad of [null, 'throw'] as const) {
            const h = harness();
            await h.implDone('a1');
            h.fp.queue.push(bad);
            await h.review({ verdict: 'approve' });
            expect(h.parent().stageState!.blockedReason).toBe('reviewer_integrity_unverifiable');
            expect(h.log.commits[0].status).toBe('blocked');
        }
    });

    it('fails closed: a baseline that cannot be taken (retried once) is flagged and blocks at the end', async () => {
        const h = harness();
        h.fp.queue.push(null, null); // both baseline attempts fail
        await h.implDone('a1');
        expect(h.parent().stageState!.reviewFingerprint).toBeUndefined();
        expect(h.parent().stageState!.reviewFingerprintUnavailable).toBe(true);
        await h.review({ verdict: 'approve' }); // the end fingerprint is readable, but there is nothing to compare with
        expect(h.parent().stageState!.blockedReason).toBe('reviewer_integrity_unverifiable');
        expect(h.log.commits[0].status).toBe('blocked');
        const r = harness();
        r.fp.queue.push('throw'); // first attempt throws, the retry succeeds
        await r.implDone('a1');
        expect(r.parent().stageState!.reviewFingerprint).toBe('fp0');
        expect(r.parent().stageState!.reviewFingerprintUnavailable).toBeUndefined();
        await r.review({ verdict: 'approve' });
        expect(r.log.commits[0].status).toBe('completed');
    });

    it('takes the baseline before the review child exists and records it with the child id', async () => {
        const h = harness();
        let order = '';
        const ports = (h.rt as unknown as { ports: StageRuntimePorts }).ports;
        const fpOrig = ports.git.fingerprint; const enqOrig = ports.queue.enqueueReviewChild;
        ports.git.fingerprint = async w => { order += 'F'; return fpOrig(w); };
        ports.queue.enqueueReviewChild = (p, spec) => { order += 'E'; return enqOrig(p, spec); };
        await h.implDone('a1');
        expect(order.startsWith('FE')).toBe(true);
        expect(h.parent().stageState!.reviewTaskIds).toHaveLength(1);
        expect(h.parent().stageState!.reviewFingerprint).toBe('fp0');
    });

    it('releases a prepared reviewer workspace when the review child ends, is cancelled, or enqueue fails', async () => {
        let released = 0;
        const withWs = (h: ReturnType<typeof harness>) => { (h.rt as unknown as { ports: StageRuntimePorts }).ports.reviewerWorkspace = { prepare: async () => ({ path: '/opt/light', headSha: 'h', release: async () => { released++; } }) }; };
        const a = harness(); withWs(a);
        await a.implDone('a1'); expect(released).toBe(0);
        await a.review({ verdict: 'approve' }); expect(released).toBe(1);
        const b = harness(); withWs(b);
        await b.implDone('a1'); b.advance(5 * 3600_000); await b.rt.tick(); await b.rt.idle();
        expect(released).toBe(2); // ceiling cancels the open child and releases its workspace
        const c = harness(); withWs(c);
        (c.rt as unknown as { ports: StageRuntimePorts }).ports.queue.enqueueReviewChild = () => { throw new Error('queue down'); };
        await c.implDone('a1');
        expect(released).toBe(3); // enqueue failed after prepare: nothing leaks
    });

    it('a prepared reviewer workspace is exempt from the mutation check', async () => {
        const h = harness();
        // swap in a provider that returns a light workspace
        (h.rt as unknown as { ports: StageRuntimePorts }).ports.reviewerWorkspace = { prepare: async () => ({ path: '/opt/light', headSha: 'h', release: async () => undefined }) };
        await h.implDone('a1');
        expect(h.parent().stageState!.reviewFingerprint).toBeUndefined();
        h.fp.value = 'fp-changed';
        await h.review({ verdict: 'approve' });
        expect(h.log.commits[0].status).toBe('completed');
    });

    it('reject_approach blocks immediately without a loop', async () => {
        const h = harness();
        await h.implDone('a1');
        await h.review({ verdict: 'reject_approach', findings: [h.f('f1')] });
        expect(h.parent().stageState!.blockedReason).toBe('review_rejected_approach');
        expect(h.log.finished).toEqual([]); // blocked: the session stays for a coordinator decision
        expect(h.log.revisions).toHaveLength(0);
    });

    it('self-check failure bounces twice then blocks; bounces do not use review rounds', async () => {
        const fail: SelfCheckResult = { status: 'failed', log: 'lint broke' };
        const h = harness({ selfChecks: [fail, fail, fail] });
        await h.implDone('a1'); expect(h.log.revisions).toHaveLength(1);
        await h.implDone('a2'); expect(h.log.revisions).toHaveLength(2);
        await h.implDone('a3');
        expect(h.parent().stageState!.blockedReason).toBe('self_check_failed');
        expect(h.parent().stageState!.round).toBe(0);
    });

    it('unavailable / not-configured self-check skips without bouncing', async () => {
        const h = harness({ selfChecks: [{ status: 'unavailable', log: 'n/a' }] });
        await h.implDone('a1');
        expect(h.parent().stageState!.phase).toBe('awaiting_review');
        expect(h.parent().stageState!.selfCheck).toBe('unavailable');
        expect(h.log.revisions).toHaveLength(0);
    });

    it('two consecutive reviewer failures → review_unavailable', async () => {
        const h = harness();
        await h.implDone('a1');
        await h.review({}, 'failed');
        expect(h.parent().stageState!.phase).toBe('awaiting_review');
        await h.review({}, 'blocked');
        expect(h.parent().stageState!.blockedReason).toBe('review_unavailable');
    });

    it('no diff → released completed with review skipped', async () => {
        const h = harness({ diff: false });
        await h.implDone('a1');
        expect(h.log.commits[0]).toMatchObject({ status: 'completed' });
        expect(h.log.commits[0].text).toContain('review: skipped_no_diff');
        expect(h.parent().stageState!.reviewTaskIds).toHaveLength(0);
    });

    it('duplicate impl report for one attempt is idempotent', async () => {
        const h = harness();
        await h.implDone('a1'); await h.implDone('a1');
        expect(h.parent().stageState!.reviewTaskIds).toHaveLength(1);
    });

    it('ceiling blocks the parent and cancels the open review child', async () => {
        const h = harness();
        await h.implDone('a1');
        const child = h.lastChild();
        h.advance(5 * 3600_000);
        await h.rt.tick(); await h.rt.idle();
        expect(h.parent().stageState!.blockedReason).toBe('stage_pipeline_ceiling');
        expect(child.status).toBe('cancelled');
    });

    it('a decision after a ceiling block opens a fresh window instead of re-blocking on the next sweep', async () => {
        // Live 2026-11-06 (c1cdb3f7): revise_once reopened the task and the next tick
        // re-blocked it at once, because the ceiling still counted from the original start.
        for (const action of ['revise_once', 'rereview'] as const) {
            const h = harness();
            await h.implDone('a1');
            h.advance(5 * 3600_000);
            await h.rt.tick(); await h.rt.idle();
            expect(h.parent().stageState!.blockedReason).toBe('stage_pipeline_ceiling');
            expect((await h.rt.decide(MESH, PARENT, action)).ok).toBe(true);
            await h.rt.idle();
            await h.rt.tick(); await h.rt.idle();
            expect(h.parent().stageState!.blockedReason).not.toBe('stage_pipeline_ceiling');
            expect(h.parent().status).toBe('assigned');
        }
    });

    it('independence fallback only after 10 minutes of independence-only refusals', async () => {
        const h = harness();
        await h.implDone('a1');
        const c = h.lastChild();
        const t0 = Date.parse('2026-11-01T00:00:00Z');
        noteReviewRefusal(c.id, 'review_independence_required', t0);
        h.advance(9 * 60_000);
        await h.rt.promoteIndependenceFallbacks();
        expect(c.review!.independence).toBe('different_provider');
        h.advance(2 * 60_000);
        await h.rt.promoteIndependenceFallbacks();
        expect(c.review!.independence).toBe('fresh_session');
        const strict = harness({ independence: 'different_provider' });
        await strict.implDone('a1');
        noteReviewRefusal(strict.lastChild().id, 'review_independence_required', t0);
        strict.advance(30 * 60_000);
        await strict.rt.promoteIndependenceFallbacks();
        expect(strict.lastChild().review!.independence).toBe('different_provider');
        // another refusal reason resets the window
        const r = harness();
        await r.implDone('a1');
        noteReviewRefusal(r.lastChild().id, 'review_independence_required', t0);
        noteReviewRefusal(r.lastChild().id, undefined);
        r.advance(30 * 60_000);
        await r.rt.promoteIndependenceFallbacks();
        expect(r.lastChild().review!.independence).toBe('different_provider');
    });

    it('decide: accept completes a blocked parent; revise_once reopens revising', async () => {
        const h = harness({ maxRevisions: 0 });
        await h.implDone('a1');
        await h.review({ verdict: 'changes_requested', findings: [h.f('f1')] });
        expect(h.parent().status).toBe('blocked');
        expect((await h.rt.decide(MESH, PARENT, 'revise_once')).ok).toBe(true);
        expect(h.parent().stageState!.phase).toBe('revising');
        expect(h.log.revisions).toHaveLength(1);
        const g = harness({ maxRevisions: 0 });
        await g.implDone('a1');
        await g.review({ verdict: 'changes_requested', findings: [g.f('f1')] });
        expect((await g.rt.decide(MESH, PARENT, 'accept')).ok).toBe(true);
        expect(g.parent().status).toBe('completed');
        expect((await g.rt.decide(MESH, PARENT, 'accept')).error).toBe('stage_task_not_blocked');
    });

    it('decide reports a refused write instead of a silent success', async () => {
        // Live 2026-11-06 (c1cdb3f7): the store refused blocked → assigned while the attempt was
        // still stopping, serial() swallowed the throw, and the coordinator was told rereview worked.
        const h = harness({ maxRevisions: 0 });
        await h.implDone('a1');
        await h.review({ verdict: 'changes_requested', findings: [h.f('f1')] });
        expect(h.parent().status).toBe('blocked');
        const mutate = h.ports.queue.mutate;
        h.ports.queue.mutate = (m, id, fn) => mutate(m, id, e => {
            const probe = { ...e }; fn(probe as typeof e);
            if (probe.status !== e.status) throw new Error('writer_checkpoint_pending: the physical writer claim cannot be released or rebound');
            fn(e);
        });
        const r = await h.rt.decide(MESH, PARENT, 'rereview');
        expect(r).toEqual({ ok: false, error: 'writer_checkpoint_pending: the physical writer claim cannot be released or rebound' });
        expect(h.parent().status).toBe('blocked');
    });

    it('decide recovers a review block a late completion overwrote, and an accepted one stays decided', async () => {
        const h = harness({ maxRevisions: 0 });
        await h.implDone('a1');
        await h.review({ verdict: 'changes_requested', findings: [h.f('f1')] });
        expect(h.parent().status).toBe('blocked');
        h.parent().status = 'completed'; // what the old daemon let the worker's late report do
        expect((await h.rt.decide(MESH, PARENT, 'rereview')).ok).toBe(true);
        expect(h.parent().status).toBe('assigned');
        // The same recovery for a late ledger `failed` (a writer settled after the block).
        const f = harness({ maxRevisions: 0 });
        await f.implDone('a1');
        await f.review({ verdict: 'changes_requested', findings: [f.f('f1')] });
        f.parent().status = 'failed';
        expect((await f.rt.decide(MESH, PARENT, 'rereview')).ok).toBe(true);
        expect(f.parent().status).toBe('assigned');
        expect(h.log.progress.some(p => /restored the review block/.test(p))).toBe(true);

        const g = harness({ maxRevisions: 0 });
        await g.implDone('a1');
        await g.review({ verdict: 'changes_requested', findings: [g.f('f1')] });
        g.parent().status = 'completed';
        expect((await g.rt.decide(MESH, PARENT, 'accept')).ok).toBe(true);
        expect(g.parent().status).toBe('completed');
        expect(g.parent().stageState!.blockedReason).toBeUndefined();
        expect((await g.rt.decide(MESH, PARENT, 'rereview')).error).toBe('stage_task_not_blocked');
    });
});

import { stageFooterInput } from '../../src/mesh/stage-state.js';
import { computeStageReviewStats } from '../../src/mesh/stage-stats.js';

describe('stage footer input + review stats', () => {
    const base = { stagePlan: { review: true as const, maxRevisions: 2 as const, independence: 'fresh_session_ok' as const } };
    it('maps rows to implement / revise / review footer variants', () => {
        const s0 = initialStageState('2026-11-01T00:00:00Z');
        expect(stageFooterInput({ ...base, stageState: s0 } as never)).toMatchObject({ role: 'implement', maxRevisions: 2 });
        expect(stageFooterInput({ ...base, stageState: { ...s0, round: 1 } } as never)).toMatchObject({ role: 'revise', round: 1 });
        expect(stageFooterInput({ origin: 'stage', parentTaskId: 'p', stageRole: 'review', stageRound: 2, reviewerWorkspace: { path: '/opt/ws', headSha: 'h' } } as never)).toEqual({ role: 'review', round: 2, maxRevisions: 0, workspace: '/opt/ws' });
        expect(stageFooterInput({} as never)).toBeUndefined();
    });
    it('derives coordinator-vs-all dispatch counts, rounds, blocked reasons and fallback share', () => {
        const parent = (id: string, status: string, patch: object) => ({ id, meshId: 'm', missionId: 'mi', status, ...base, stageState: { ...initialStageState('2026-11-01T00:00:00Z'), ...patch }, origin: 'coordinator' }) as never;
        const child = (id: string) => ({ id, meshId: 'm', missionId: 'mi', status: 'completed', origin: 'stage', parentTaskId: 'a', stageRole: 'review' }) as never;
        const stats = computeStageReviewStats([
            parent('a', 'completed', { round: 2, lastVerdict: 'approve', released: true, independenceUsed: 'fresh_session_fallback' }),
            parent('b', 'blocked', { round: 3, blockedReason: 'review_unresolved', released: true, independenceUsed: 'different_provider' }),
            parent('c', 'assigned', { round: 1 }),
            child('a:r1'), child('a:r2'),
        ]);
        expect(stats.coordinatorRowsByMission).toEqual({ mi: 3 });
        expect(stats.allRowsByMission).toEqual({ mi: 5 });
        expect(stats.roundsDistribution).toEqual({ '2': 1, '3': 1 });
        expect(stats.blockedByReason).toEqual({ review_unresolved: 1 });
        expect(stats.firstReviewFoundDefects).toBe(1);
        expect(stats.independenceFallback).toEqual({ used: 1, total: 2, share: 0.5 });
    });
});

import { setStageHookTarget, notifyStageChildClaimed } from '../../src/mesh/stage-hooks.js';
describe('claim hook forwarding', () => {
    it('forwards a claimed review child to the registered target and is a no-op without one', async () => {
        const seen: string[] = [];
        notifyStageChildClaimed('m', 'none');
        setStageHookTarget({ onImplCompleted: async () => undefined, onChildTerminal: async () => undefined, onChildClaimed: async (_m, id) => { seen.push(id); } });
        notifyStageChildClaimed('m', 'c1');
        await Promise.resolve();
        setStageHookTarget(null);
        expect(seen).toEqual(['c1']);
    });
});

describe('stage effect retry bound and stale parent (live 2026-11-07 c8b231ee)', () => {
    /** A port that mimics the production revision CAS, and a reviewer-workspace prepare during which another writer touches the row. */
    function racing() {
        const h = harness();
        const bump = () => { const p = h.rows.get(PARENT)!; p.revision = (p.revision ?? 0) + 1; };
        const enqueue = h.ports.queue.enqueueReviewChild;
        h.ports.queue.enqueueReviewChild = (p, spec) => {
            const cur = h.rows.get(PARENT)!;
            if ((cur.revision ?? 0) !== (p.revision ?? 0)) throw new Error('stage_review_stale_parent');
            return enqueue(p, spec);
        };
        // get() hands out a snapshot copy, like the production store (a fresh row per read).
        const get = h.ports.queue.get;
        h.ports.queue.get = (m, id) => { const r = get(m, id); return r ? { ...r } : r; };
        h.ports.reviewerWorkspace = { prepare: async () => { bump(); return null; } };
        return h;
    }
    it('creates the review child although the row is touched while the reviewer workspace is prepared', async () => {
        const h = racing();
        await h.implDone('a1');
        expect(h.parent().stageState!.reviewTaskIds).toHaveLength(1);
        expect(h.log.progress.filter(t => /stale_parent/.test(t))).toEqual([]);
    });
    it('a genuinely moved-on parent still refuses, escalates to one blocked outcome after N identical failures, and logs once', async () => {
        const h = harness();
        h.ports.queue.enqueueReviewChild = () => { throw new Error('stage_review_stale_parent'); };
        await h.implDone('a1');
        expect(h.parent().status).toBe('assigned');
        for (let i = 0; i < 20 && h.parent().status === 'assigned'; i++) { await h.rt.tick(); await h.rt.idle(); }
        expect(h.parent().status).toBe('blocked');
        expect(h.parent().stageState!.blockedReason).toBe('review_unavailable');
        expect(h.parent().stageState!.blockedDetail).toMatch(/failed 8x in a row: stage_review_stale_parent/);
        expect(h.log.notices.map(n => n.status)).toEqual(['blocked']);
        expect(h.log.progress.filter(t => /create_review_child failed: stage_review_stale_parent/.test(t))).toHaveLength(1);
        expect(h.log.progress.filter(t => /gave up/.test(t))).toHaveLength(1);
    });
    it('a busy reviewer checkout is an honest wait: logged once, never escalated', async () => {
        const h = harness();
        h.ports.queue.enqueueReviewChild = () => { throw new Error('review_input_busy'); };
        await h.implDone('a1');
        for (let i = 0; i < 15; i++) { await h.rt.tick(); await h.rt.idle(); }
        expect(h.parent().status).toBe('assigned');
        expect(h.log.progress.filter(t => /review_input_busy/.test(t))).toHaveLength(1);
    });
});
