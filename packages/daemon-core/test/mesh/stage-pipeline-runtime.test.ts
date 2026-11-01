import { beforeEach, describe, expect, it } from 'vitest';
import { StagePipelineRuntime } from '../../src/mesh/stage-pipeline-runtime.js';
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
    const ports: StageRuntimePorts = {
        now: () => nowMs,
        selfCheck: { run: async () => selfChecks.shift() ?? { status: 'passed', log: 'ok' } },
        reviewerWorkspace: { prepare: async () => null },
        git: {
            baseSha: async () => 'base0000', headSha: async () => (opts.diff === false ? 'base0000' : `head${++head}`),
            diff: async () => 'diff text', isClean: async () => true,
        },
        artifacts: { register: i => { const id = `art_${i.kind}_${log.artifacts.length}`; log.artifacts.push(id); return id; } },
        queue: {
            get: (_m, id) => rows.get(id) ?? null,
            mutate: (_m, id, fn) => { const e = rows.get(id); if (!e) return null; fn(e); return e; },
            listStageParents: () => [...rows.values()].filter(r => r.stagePlan),
            enqueueReviewChild: (p, spec) => {
                const id = `${p.id}:child${rows.size}`;
                const c: MeshWorkQueueEntry = { id, meshId: MESH, message: spec.message, status: 'pending', origin: 'stage', parentTaskId: p.id, stageRole: 'review', stageRound: spec.round, readonly: true, review: { sourceTaskId: p.id, independence: spec.independence }, createdAt: '', updatedAt: '' };
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
    return { rt, rows, log, parent: () => rows.get(PARENT)!, implDone, review, lastChild, advance: (ms: number) => { nowMs += ms; } , f };
}

beforeEach(() => { __resetStageReportStashForTests(); __resetIndependenceTrackerForTests(); });

describe('stage pipeline runtime', () => {
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
