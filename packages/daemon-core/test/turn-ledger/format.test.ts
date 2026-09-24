// Golden tests: `renderTurnNotify` (C-W3, mesh/turn-ledger/format.ts) must
// reproduce today's live coordinator text byte-for-byte for every shape that
// has a legacy predecessor, and must be new-but-sane for the two shapes that
// don't (`cancelled`, `late_completion` — C1 R27/R27a, no legacy template).
//
// Golden fixtures call the CURRENT production builders (`buildMeshSystemMessage`,
// `buildWorkerProgressNotice`) directly — imported here ONLY, never from
// format.ts itself — so a future edit to either side is caught by a diff
// instead of two copies quietly drifting apart.
import { describe, expect, it } from 'vitest';
import { buildMeshSystemMessage } from '../../src/mesh/mesh-events-utils.js';
import { buildWorkerProgressNotice } from '../../src/mesh/worker-report.js';
import {
    renderTurnNotify,
    type RenderTurnNotifyInput,
    type ResolveSummaryRef,
    type TurnNotifyRefs,
    type TurnNotifyScalars,
} from '../../src/mesh/turn-ledger/format.js';
import type { NotifyKind, SummaryRef } from '@adhdev/mesh-shared';

const REF = (seq: number): SummaryRef => ({ topic: 'mesh.m1.handoff', writer: 'w1', seq });

function resolverFor(map: Record<number, string>): ResolveSummaryRef {
    return (ref: SummaryRef) => (ref.seq in map ? map[ref.seq] : null);
}

const NEVER_RESOLVES: ResolveSummaryRef = () => null;

function render(
    notify: NotifyKind,
    scalars: TurnNotifyScalars,
    refs: TurnNotifyRefs = {},
    resolveRef: ResolveSummaryRef = NEVER_RESOLVES,
    statusLine: string | null | undefined = undefined,
): ReturnType<typeof renderTurnNotify> {
    const input: RenderTurnNotifyInput = { notify, scalars, refs, resolveRef, statusLine };
    return renderTurnNotify(input);
}

const NODE_LABEL = "Node 'w1'";

describe('renderTurnNotify — golden parity with buildMeshSystemMessage', () => {
    it('completion, genuine, with summary — byte-identical', () => {
        const legacy = buildMeshSystemMessage({
            event: 'agent:generating_completed',
            nodeLabel: NODE_LABEL,
            metadataEvent: {
                finalSummary: 'Did the thing. All tests pass.',
                targetSessionId: 's1',
                providerType: 'claude-cli',
            },
        });
        const { text, kind, contentRefsMissing } = render(
            'completed',
            { nodeLabel: NODE_LABEL, sessionId: 's1', providerType: 'claude-cli' },
            { summary: REF(1) },
            resolverFor({ 1: 'Did the thing. All tests pass.' }),
        );
        expect(text).toBe(legacy);
        expect(kind).toBe('completed');
        expect(contentRefsMissing).toEqual([]);
    });

    it('completion, genuine, with summary — truncated at 16,000 chars', () => {
        const longSummary = 'x'.repeat(20000);
        const legacy = buildMeshSystemMessage({
            event: 'agent:generating_completed',
            nodeLabel: NODE_LABEL,
            metadataEvent: { finalSummary: longSummary },
        });
        const { text } = render('completed', { nodeLabel: NODE_LABEL }, { summary: REF(1) }, resolverFor({ 1: longSummary }));
        expect(text).toBe(legacy);
        expect(text).toContain('…[truncated — call mesh_read_chat once for the full transcript]');
    });

    it('completion, no summary — byte-identical', () => {
        const legacy = buildMeshSystemMessage({
            event: 'agent:generating_completed',
            nodeLabel: NODE_LABEL,
            metadataEvent: {},
        });
        const { text } = render('completed', { nodeLabel: NODE_LABEL }, {});
        expect(text).toBe(legacy);
    });

    it('completion, weak/candidate — byte-identical', () => {
        const legacy = buildMeshSystemMessage({
            event: 'agent:generating_completed',
            nodeLabel: NODE_LABEL,
            metadataEvent: { evidenceLevel: 'weak', finalSummary: 'partial result' },
        });
        const { text, kind } = render(
            'candidate',
            { nodeLabel: NODE_LABEL, strength: 'weak', completionMetadata: { evidenceLevel: 'weak' } },
            { summary: REF(1) },
            resolverFor({ 1: 'partial result' }),
        );
        expect(text).toBe(legacy);
        expect(kind).toBe('candidate');
    });

    it('completion, weak, review recommended, no summary — byte-identical', () => {
        const legacy = buildMeshSystemMessage({
            event: 'agent:generating_completed',
            nodeLabel: NODE_LABEL,
            metadataEvent: { reviewRecommended: true },
        });
        const { text } = render('completed', { nodeLabel: NODE_LABEL, strength: 'weak', reviewRecommended: true }, {});
        expect(text).toBe(legacy);
    });

    it('hollow completion, requeued — byte-identical', () => {
        const legacy = buildMeshSystemMessage({
            event: 'agent:generating_completed',
            nodeLabel: NODE_LABEL,
            metadataEvent: { hollowCompletion: { detected: true, requeueCount: 1, maxRetries: 3, maxRetriesExhausted: false } },
        });
        const { text } = render('completed', { nodeLabel: NODE_LABEL, hollow: { requeueCount: 1, maxRetries: 3, maxRetriesExhausted: false } }, {});
        expect(text).toBe(legacy);
    });

    it('hollow completion, max retries exhausted — byte-identical', () => {
        const legacy = buildMeshSystemMessage({
            event: 'agent:generating_completed',
            nodeLabel: NODE_LABEL,
            metadataEvent: { hollowCompletion: { detected: true, requeueCount: 3, maxRetries: 3, maxRetriesExhausted: true } },
        });
        const { text } = render('completed', { nodeLabel: NODE_LABEL, hollow: { requeueCount: 3, maxRetries: 3, maxRetriesExhausted: true } }, {});
        expect(text).toBe(legacy);
    });

    it('forced-timeout termination — byte-identical', () => {
        const legacy = buildMeshSystemMessage({
            event: 'agent:generating_completed',
            nodeLabel: NODE_LABEL,
            metadataEvent: { completionDiagnostic: { timedOutWithoutFinalAssistant: true } },
        });
        const { text } = render(
            'completed',
            { nodeLabel: NODE_LABEL, forcedTimeoutNoResponse: true, completionMetadata: { diagnosticReason: 'present' } },
            {},
        );
        expect(text).toBe(legacy);
    });

    it('no-progress reconciliation completion — byte-identical', () => {
        const legacy = buildMeshSystemMessage({
            event: 'agent:generating_completed',
            nodeLabel: NODE_LABEL,
            metadataEvent: { source: 'no_progress_reconciliation' },
        });
        const { text } = render('completed', { nodeLabel: NODE_LABEL, noProgressReconciled: true }, {});
        expect(text).toBe(legacy);
    });

    it('approval needed — byte-identical, no modalMessage embedded', () => {
        const legacy = buildMeshSystemMessage({
            event: 'agent:waiting_approval',
            nodeLabel: NODE_LABEL,
            metadataEvent: { modalMessage: 'rm -rf build/ — proceed?' },
        });
        const { text } = render('approval', { nodeLabel: NODE_LABEL }, {});
        expect(text).toBe(legacy);
        expect(text).not.toContain('rm -rf');
    });

    it('choice needed, with questions — byte-identical', () => {
        const metadataEvent = {
            promptId: 'p1',
            interactivePrompt: {
                promptId: 'p1',
                questions: [
                    { header: 'Which approach', question: 'Pick one', multiSelect: false, options: [{ label: 'A', description: 'first' }, { label: 'B' }] },
                ],
            },
        };
        const legacy = buildMeshSystemMessage({ event: 'agent:waiting_choice', nodeLabel: NODE_LABEL, metadataEvent });
        const { text } = render(
            'choice',
            { nodeLabel: NODE_LABEL, promptId: 'p1', questions: [{ header: 'Which approach', question: 'Pick one', multiSelect: false, options: [{ label: 'A', description: 'first' }, { label: 'B' }] }] },
            {},
        );
        expect(text).toBe(legacy);
    });

    it('choice needed, no questions, modalMessage fallback via ref — byte-identical', () => {
        const legacy = buildMeshSystemMessage({
            event: 'agent:waiting_choice',
            nodeLabel: NODE_LABEL,
            metadataEvent: { modalMessage: 'Pick a color' },
        });
        const { text } = render('choice', { nodeLabel: NODE_LABEL }, { summary: REF(1) }, resolverFor({ 1: 'Pick a color' }));
        expect(text).toBe(legacy);
    });

    it('approval resolved — silent locally, both sides empty string', () => {
        const { text } = render('approval_resolved', { nodeLabel: NODE_LABEL }, {});
        expect(text).toBe('');
    });

    it('failure: auth_failed — byte-identical', () => {
        const legacy = buildMeshSystemMessage({
            event: 'agent:stopped',
            nodeLabel: NODE_LABEL,
            metadataEvent: { completionDiagnostic: { reason: 'auth_failed', errorMessage: 'token expired' } },
        });
        const { text } = render(
            'stopped',
            { nodeLabel: NODE_LABEL, stopReason: 'auth_failed', completionMetadata: { diagnosticReason: 'present' } },
            { error: REF(1) }, resolverFor({ 1: 'token expired' }),
        );
        expect(text).toBe(legacy);
    });

    it('failure: billing_failed — byte-identical', () => {
        const legacy = buildMeshSystemMessage({
            event: 'agent:stopped',
            nodeLabel: NODE_LABEL,
            metadataEvent: { completionDiagnostic: { reason: 'billing_failed', errorMessage: 'card declined' } },
        });
        const { text } = render(
            'stopped',
            { nodeLabel: NODE_LABEL, stopReason: 'billing_failed', completionMetadata: { diagnosticReason: 'present' } },
            { error: REF(1) }, resolverFor({ 1: 'card declined' }),
        );
        expect(text).toBe(legacy);
    });

    it('failure: quota_exceeded — byte-identical', () => {
        const legacy = buildMeshSystemMessage({
            event: 'agent:stopped',
            nodeLabel: NODE_LABEL,
            metadataEvent: { completionDiagnostic: { reason: 'quota_exceeded', errorMessage: 'window exhausted' } },
        });
        const { text } = render(
            'stopped',
            { nodeLabel: NODE_LABEL, stopReason: 'quota_exceeded', completionMetadata: { diagnosticReason: 'present' } },
            { error: REF(1) }, resolverFor({ 1: 'window exhausted' }),
        );
        expect(text).toBe(legacy);
    });

    it('failure: recovery context, retry recommended — byte-identical', () => {
        const legacy = buildMeshSystemMessage({
            event: 'agent:stopped',
            nodeLabel: NODE_LABEL,
            metadataEvent: {},
            recoveryContext: {
                consecutiveNodeFailures: 2,
                taskAttemptCount: 1,
                advice: 'Retry once more.',
                retryRecommended: true,
                lastTaskMessage: 'Implement the login flow',
            } as any,
        });
        const { text } = render(
            'stopped',
            {
                nodeLabel: NODE_LABEL, stopReason: 'recovery_context',
                recoveryContext: { consecutiveNodeFailures: 2, taskAttemptCount: 1, advice: 'Retry once more.', retryRecommended: true },
            },
            { lastTaskMessage: REF(1) },
            resolverFor({ 1: 'Implement the login flow' }),
        );
        expect(text).toBe(legacy);
    });

    it('failure: recovery context, retry recommended, prompt > 300 chars — truncated identically', () => {
        const longPrompt = 'y'.repeat(500);
        const legacy = buildMeshSystemMessage({
            event: 'agent:stopped', nodeLabel: NODE_LABEL, metadataEvent: {},
            recoveryContext: { consecutiveNodeFailures: 1, taskAttemptCount: 1, advice: 'Retry.', retryRecommended: true, lastTaskMessage: longPrompt } as any,
        });
        const { text } = render(
            'stopped',
            { nodeLabel: NODE_LABEL, stopReason: 'recovery_context', recoveryContext: { consecutiveNodeFailures: 1, taskAttemptCount: 1, advice: 'Retry.', retryRecommended: true } },
            { lastTaskMessage: REF(1) },
            resolverFor({ 1: longPrompt }),
        );
        expect(text).toBe(legacy);
    });

    it('failure: recovery context, retry NOT recommended — byte-identical', () => {
        const legacy = buildMeshSystemMessage({
            event: 'agent:stopped', nodeLabel: NODE_LABEL, metadataEvent: {},
            recoveryContext: { consecutiveNodeFailures: 3, taskAttemptCount: 2, advice: 'Reassign to another node.', retryRecommended: false } as any,
        });
        const { text } = render(
            'stopped',
            { nodeLabel: NODE_LABEL, stopReason: 'recovery_context', recoveryContext: { consecutiveNodeFailures: 3, taskAttemptCount: 2, advice: 'Reassign to another node.', retryRecommended: false } },
            {},
        );
        expect(text).toBe(legacy);
    });

    it('failure: plain — byte-identical', () => {
        const legacy = buildMeshSystemMessage({ event: 'agent:stopped', nodeLabel: NODE_LABEL, metadataEvent: {} });
        const { text } = render('stopped', { nodeLabel: NODE_LABEL, stopReason: 'plain' }, {});
        expect(text).toBe(legacy);
    });

    it('no-progress/stall notice, generic — byte-identical', () => {
        const legacy = buildMeshSystemMessage({ event: 'monitor:no_progress', nodeLabel: NODE_LABEL, metadataEvent: {} });
        const { text } = render('no_progress', { nodeLabel: NODE_LABEL }, {});
        expect(text).toBe(legacy);
    });

    it('no-progress/stall notice, worker-stall — byte-identical', () => {
        const legacy = buildMeshSystemMessage({
            event: 'monitor:no_progress',
            nodeLabel: NODE_LABEL,
            metadataEvent: { meshWorkerStall: true, stalledMs: 45000, observedStatus: 'idle' },
        });
        const { text } = render('no_progress', { nodeLabel: NODE_LABEL, meshWorkerStall: true, stalledMs: 45000, observedStatus: 'idle' }, {});
        expect(text).toBe(legacy);
    });

    it('worker progress — byte-identical to buildWorkerProgressNotice', () => {
        const legacy = buildWorkerProgressNotice({ taskId: 't1', nodeLabel: NODE_LABEL, note: 'Wired up the API client.' });
        const { text, kind } = render('progress', { nodeLabel: NODE_LABEL, progressTaskId: 't1' }, { note: REF(1) }, resolverFor({ 1: 'Wired up the API client.' }));
        expect(text).toBe(legacy);
        expect(kind).toBe('progress');
    });

    it('worktree bootstrap complete, with queued task — byte-identical', () => {
        const legacy = buildMeshSystemMessage({
            event: 'worktree_bootstrap_complete', nodeLabel: NODE_LABEL,
            metadataEvent: { worktreePath: '/tmp/wt-1', durationMs: 4200 }, worktreeHasQueuedTask: true,
        });
        const { text } = render('mesh_event', { nodeLabel: NODE_LABEL, worktreeOutcome: 'complete', worktreePath: '/tmp/wt-1', durationMs: 4200, worktreeHasQueuedTask: true }, {});
        expect(text).toBe(legacy);
    });

    it('worktree bootstrap complete, no queued task — byte-identical', () => {
        const legacy = buildMeshSystemMessage({ event: 'worktree_bootstrap_complete', nodeLabel: NODE_LABEL, metadataEvent: {} });
        const { text } = render('mesh_event', { nodeLabel: NODE_LABEL, worktreeOutcome: 'complete' }, {});
        expect(text).toBe(legacy);
    });

    it('worktree bootstrap failed — byte-identical', () => {
        const legacy = buildMeshSystemMessage({ event: 'worktree_bootstrap_failed', nodeLabel: NODE_LABEL, metadataEvent: { error: 'git clone failed' } });
        const { text } = render('mesh_event', { nodeLabel: NODE_LABEL, worktreeOutcome: 'failed' }, { error: REF(1) }, resolverFor({ 1: 'git clone failed' }));
        expect(text).toBe(legacy);
    });

    it('refine accepted — byte-identical', () => {
        const legacy = buildMeshSystemMessage({ event: 'refine:accepted', nodeLabel: NODE_LABEL, metadataEvent: { jobId: 'job-1' } });
        const { text } = render('mesh_event', { nodeLabel: NODE_LABEL, refineOutcome: 'accepted', jobId: 'job-1' }, {});
        expect(text).toBe(legacy);
    });

    it('refine completed — byte-identical', () => {
        const metadataEvent = {
            jobId: 'job-2',
            result: {
                validationSummary: { status: 'passed' }, patchEquivalence: { status: 'passed' },
                into: 'main', branch: 'fix/x', merged: true, finalBranchConvergenceState: { status: 'merged_to_main' },
                nextStep: 'Deploy when ready.',
            },
        };
        const legacy = buildMeshSystemMessage({ event: 'refine:completed', nodeLabel: NODE_LABEL, metadataEvent });
        const { text } = render('mesh_event', {
            nodeLabel: NODE_LABEL, refineOutcome: 'completed', jobId: 'job-2', refineBranch: 'fix/x', refineInto: 'main',
            validationStatus: 'passed', patchEquivalenceStatus: 'passed', mergeStatus: 'merged', convergenceStatus: 'merged_to_main',
            refineNextStep: 'Deploy when ready.',
        }, {});
        expect(text).toBe(legacy);
    });

    it('refine failed, batch with per-node failures — byte-identical', () => {
        const metadataEvent = {
            jobId: 'job-3',
            result: {
                code: 'patch_equivalence_failed', error: 'two nodes diverged',
                batch: true, merged: false,
                results: [
                    { nodeId: 'n1', convergence: 'merged_to_main' },
                    { nodeId: 'n2', convergence: 'blocked_review', code: 'conflict', stage: 'merge', error: 'x'.repeat(250) },
                ],
                nextStep: 'Resolve n2 manually.',
            },
        };
        const legacy = buildMeshSystemMessage({ event: 'refine:failed', nodeLabel: NODE_LABEL, metadataEvent });
        const { text } = render('mesh_event', {
            nodeLabel: NODE_LABEL, refineOutcome: 'failed', jobId: 'job-3', refineCode: 'patch_equivalence_failed',
            refineNextStep: 'Resolve n2 manually.',
            refineFailedNodes: [{ nodeId: 'n2', convergence: 'blocked_review', code: 'conflict', stage: 'merge', error: 'x'.repeat(250) }],
        }, { error: REF(1) }, resolverFor({ 1: 'two nodes diverged' }));
        expect(text).toBe(legacy);
    });

    it('report-shadowed completion, summary held — byte-identical shape', () => {
        // findPriorWorkerReport's exact wrapper text (mesh-event-forwarding.ts:1601-1602),
        // reproduced directly here since it lives outside buildMeshSystemMessage.
        const legacy = `[System] ${NODE_LABEL} reported task t1 as 'completed' via report_completion: All done, tests green.`;
        const { text } = render(
            'mesh_event',
            { nodeLabel: NODE_LABEL, reportTaskId: 't1', reportOutcome: 'completed', reportHasSummary: true },
            { report: REF(1) },
            resolverFor({ 1: 'All done, tests green.' }),
        );
        expect(text).toBe(legacy);
    });

    it('report-shadowed completion, no summary held — falls back to scraped text with label', () => {
        const { text } = render(
            'mesh_event',
            { nodeLabel: NODE_LABEL, reportTaskId: 't1', reportOutcome: 'completed', reportHasSummary: false },
            {},
        );
        expect(text).toContain(`already reported task t1 as 'completed' via report_completion`);
        expect(text).toContain('Screen-scraped text follows and may be truncated:');
    });
});

describe('renderTurnNotify — new shapes with no legacy precedent (C1 R27/R27a)', () => {
    it('cancelled — deterministic wording, includes reason', () => {
        const { text, kind } = render('cancelled', { nodeLabel: NODE_LABEL, taskId: 't9', cancelReason: 'operator_cancel' }, {});
        expect(kind).toBe('cancelled');
        expect(text).toBe(`[System] ${NODE_LABEL} task t9 was cancelled (operator_cancel)`);
    });

    it('failed — a direct dispatch that was not redelivered names the cause and says to resend', () => {
        const { text, kind } = render('failed', { nodeLabel: NODE_LABEL, taskId: 't9', stopReason: 'direct_not_redelivered', directFailureCause: 'dispatch_failed' }, {});
        expect(kind).toBe('failed');
        expect(text).toContain(`[System] ${NODE_LABEL}: direct dispatch of task t9 failed (dispatch_failed)`);
        expect(text).toContain('never redelivered automatically');
        expect(text).toContain('mesh_send_task');
        expect(text).not.toContain('has stopped');
    });

    it('late_completion — with resolved g-1 summary', () => {
        const { text, kind, contentRefsMissing } = render(
            'late_completion',
            { nodeLabel: NODE_LABEL, taskId: 't9', priorGeneration: 2 },
            { summary: REF(1) },
            resolverFor({ 1: 'Salvageable partial output.' }),
        );
        expect(kind).toBe('late_completion');
        expect(text).toContain('reported a late completion for task t9 from a superseded attempt (generation g2)');
        expect(text).toContain('the current attempt continues');
        expect(text).toContain('Salvageable partial output.');
        expect(contentRefsMissing).toEqual([]);
    });

    it('late_completion — ref not yet resolved falls back to pointer line and records the miss', () => {
        const { text, contentRefsMissing } = render('late_completion', { nodeLabel: NODE_LABEL, taskId: 't9', priorGeneration: 1 }, { summary: REF(1) });
        expect(text).toContain('mesh_task_report');
        expect(contentRefsMissing).toEqual([REF(1)]);
    });
});

describe('renderTurnNotify — sentinel: no scalar field can carry sentinel text into the output', () => {
    const SENTINEL = 'SENTINEL_FREE_TEXT_MUST_NOT_APPEAR';

    // Every NotifyKind exercised with the sentinel placed in every plausible
    // scalar slot; only `refs` (via resolveRef) may ever surface it.
    // Cases where NO scalar is set to the sentinel: proves the renderer never
    // manufactures free text out of nothing (no hidden default strings, no
    // leaked internal identifiers) when every ref is unresolved.
    const cleanCases: Array<{ notify: NotifyKind; scalars: TurnNotifyScalars }> = [
        { notify: 'completed', scalars: { nodeLabel: NODE_LABEL } },
        { notify: 'failed', scalars: { nodeLabel: NODE_LABEL, stopReason: 'plain' } },
        { notify: 'cancelled', scalars: { nodeLabel: NODE_LABEL, taskId: 't1' } },
        { notify: 'stopped', scalars: { nodeLabel: NODE_LABEL, stopReason: 'plain' } },
        { notify: 'approval', scalars: { nodeLabel: NODE_LABEL } },
        { notify: 'no_progress', scalars: { nodeLabel: NODE_LABEL, meshWorkerStall: true, observedStatus: 'idle' } },
        { notify: 'candidate', scalars: { nodeLabel: NODE_LABEL, strength: 'weak' } },
        { notify: 'late_completion', scalars: { nodeLabel: NODE_LABEL, taskId: 't1', priorGeneration: 3 } },
    ];
    for (const { notify, scalars } of cleanCases) {
        it(`${notify}: with no scalar set to the sentinel, it never appears in the output`, () => {
            const { text } = render(notify, scalars, {}, NEVER_RESOLVES);
            expect(text).not.toContain(SENTINEL);
        });
    }

    // Cases where an IDENTIFIER/ENUM scalar (not a free-text field — there is
    // no free-text scalar class by construction) is set to the sentinel: it
    // is expected to appear, verbatim, exactly as many times as the template
    // embeds that field.
    it('cancelled: an identifier scalar set to the sentinel appears verbatim (expected — identifiers are not free text)', () => {
        const { text } = render('cancelled', { nodeLabel: NODE_LABEL, taskId: SENTINEL, cancelReason: SENTINEL }, {}, NEVER_RESOLVES);
        expect(text).toContain(`task ${SENTINEL}`);
        expect(text).toContain(`(${SENTINEL})`);
    });

    it('late_completion: taskId scalar set to the sentinel appears verbatim in both the lead and the pointer line (same field, two template positions — not a leak)', () => {
        const { text } = render('late_completion', { nodeLabel: NODE_LABEL, taskId: SENTINEL, priorGeneration: 3 }, {}, NEVER_RESOLVES);
        expect(text.split(SENTINEL).length - 1).toBe(2);
    });

    it('a ref that never resolves NEVER leaks its topic/writer/seq identifiers as prose text', () => {
        const ref: SummaryRef = { topic: 'mesh.m1.handoff', writer: 'writer-zz9', seq: 42 };
        const { text } = render('completed', { nodeLabel: NODE_LABEL, taskId: 't1' }, { summary: ref }, NEVER_RESOLVES);
        expect(text).not.toContain('42');
        expect(text).not.toContain('writer-zz9');
        expect(text).not.toContain('mesh.m1.handoff');
    });
});

describe('renderTurnNotify — break-once (one assertion removed/inverted per shape family)', () => {
    it('breaks: completion weak-lead wording must differ from genuine-lead wording', () => {
        const genuine = render('completed', { nodeLabel: NODE_LABEL }, {}).text;
        const weak = render('completed', { nodeLabel: NODE_LABEL, strength: 'weak' }, {}).text;
        expect(genuine).not.toBe(weak);
    });

    it('breaks: hollow requeued vs max-retries-exhausted must render different text', () => {
        const requeued = render('completed', { nodeLabel: NODE_LABEL, hollow: { requeueCount: 1, maxRetries: 3, maxRetriesExhausted: false } }, {}).text;
        const exhausted = render('completed', { nodeLabel: NODE_LABEL, hollow: { requeueCount: 3, maxRetries: 3, maxRetriesExhausted: true } }, {}).text;
        expect(requeued).not.toBe(exhausted);
    });

    it('breaks: auth_failed vs billing_failed use different failure-kind wording', () => {
        const auth = render('stopped', { nodeLabel: NODE_LABEL, stopReason: 'auth_failed' }, {}).text;
        const billing = render('stopped', { nodeLabel: NODE_LABEL, stopReason: 'billing_failed' }, {}).text;
        expect(auth).toContain('authentication');
        expect(billing).toContain('billing/subscription');
        expect(auth).not.toBe(billing);
    });

    it('breaks: approval_resolved must stay silent (empty string), not fall through to the mesh_event default', () => {
        const { text } = render('approval_resolved', { nodeLabel: NODE_LABEL }, {});
        expect(text).toBe('');
        expect(text).not.toContain('[System]');
    });

    it('breaks: statusLine is appended for every notify kind except approval_resolved', () => {
        const withLine = render('completed', { nodeLabel: NODE_LABEL }, {}, NEVER_RESOLVES, '[Mesh] active 1: 1 generating');
        expect(withLine.text.endsWith('[Mesh] active 1: 1 generating')).toBe(true);
        const resolvedWithLine = render('approval_resolved', { nodeLabel: NODE_LABEL }, {}, NEVER_RESOLVES, '[Mesh] active 1: 1 generating');
        expect(resolvedWithLine.text).toBe('');
    });

    it('breaks: cancelled without a reason omits the parenthetical, with a reason includes it', () => {
        const noReason = render('cancelled', { nodeLabel: NODE_LABEL, taskId: 't1' }, {}).text;
        const withReason = render('cancelled', { nodeLabel: NODE_LABEL, taskId: 't1', cancelReason: 'superseded' }, {}).text;
        expect(noReason).not.toContain('(');
        expect(withReason).toContain('(superseded)');
    });

    it('breaks: late_completion only reports a missing ref (contentRefsMissing) when a summary ref was actually declared', () => {
        const noRefDeclared = render('late_completion', { nodeLabel: NODE_LABEL, taskId: 't1', priorGeneration: 1 }, {});
        expect(noRefDeclared.contentRefsMissing).toEqual([]);
        const refDeclaredUnresolved = render('late_completion', { nodeLabel: NODE_LABEL, taskId: 't1', priorGeneration: 1 }, { summary: REF(9) });
        expect(refDeclaredUnresolved.text).toContain('mesh_task_report');
        expect(refDeclaredUnresolved.contentRefsMissing).toEqual([REF(9)]);
    });
});
