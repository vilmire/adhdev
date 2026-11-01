// Review-in-task: text the pipeline authors — reviewer/revision messages and the parent's final report (§4.3, §5.4).
// Pure. Reviewer- and implementer-authored text is wrapped as untrusted evidence, never as instructions.

import { formatStageVerdictLine, type MeshReviewVerdict, type MeshTaskStageState, type MeshStageIndependenceUsed } from '@adhdev/mesh-shared';

const wrap = (tag: string, body: string) => `<${tag}>\n${body.replace(/<\/?\s*(untrusted_[a-z_]+)\b[^>]*>/gi, '[tag removed]')}\n</${tag}>`;

export function buildReviewerMessage(opts: {
    originalMessage: string; implementerSummary: string; round: number; maxRevisions: number;
    selfCheck?: MeshTaskStageState['selfCheck']; priorOpenFindingIds: string[]; workspace?: string; baseSha: string; headSha: string;
}): string {
    return [
        `You are the independent reviewer (round ${opts.round}) of a code change. Do NOT modify the code; record findings.`,
        `Original task:\n${wrap('untrusted_task', opts.originalMessage)}`,
        `Implementer's final summary:\n${wrap('untrusted_implementer_summary', opts.implementerSummary)}`,
        `Review the change ${opts.baseSha.slice(0, 12)}..${opts.headSha.slice(0, 12)} (diff, self-check log and any previous verdict are in your input artifacts).`,
        `Self-check: ${opts.selfCheck ?? 'none'}${opts.selfCheck === 'skipped_not_configured' || opts.selfCheck === 'unavailable' ? ' (no automated self-check ran — run the relevant tests yourself)' : ''}.`,
        opts.priorOpenFindingIds.length
            ? `Round ${opts.round}: give a status in review.prior_findings for each earlier blocking/major finding: ${opts.priorOpenFindingIds.join(', ')} (resolved | unresolved | dispute_accepted | dispute_rejected).`
            : '',
        opts.workspace ? `Your workspace: ${opts.workspace}` : '',
    ].filter(Boolean).join('\n\n');
}

export function buildRevisionMemo(opts: {
    reason: 'self_check' | 'review'; round: number; findings: Array<{ id: string; severity: string; claim: string }>;
    selfCheckLog?: string; verdictArtifactIds: string[];
}): string {
    if (opts.reason === 'self_check') {
        return [
            'Your change failed the automated self-check. Fix it, commit, and report again.',
            wrap('untrusted_self_check_log', (opts.selfCheckLog ?? '').slice(-4000) || '(no log)'),
        ].join('\n\n');
    }
    const list = opts.findings.map(f => `- [${f.severity}] ${f.id}: ${f.claim}`).join('\n');
    return [
        `Independent review (round ${opts.round}) requested changes. Address every open blocking/major finding below, commit, and report again.`,
        'For each finding fill finding_responses[{id, response: fixed | disputed, note}] — disputed needs your reasoning; the reviewer judges it next round.',
        wrap('untrusted_review_findings', list || '(see verdict artifact)'),
        opts.verdictArtifactIds.length ? `Verdict artifact(s): ${opts.verdictArtifactIds.join(', ')}` : '',
    ].filter(Boolean).join('\n\n');
}

export function buildFinalReport(opts: {
    outcome: 'completed' | 'blocked'; implementerSummary: string; state: MeshTaskStageState;
    reviewerProvider?: string; skippedNoDiff?: boolean; blockedDetail?: string;
}): string {
    const s = opts.state;
    const verdict: MeshReviewVerdict | 'skipped_no_diff' | undefined = opts.skippedNoDiff ? 'skipped_no_diff' : s.lastVerdict;
    const lines = [opts.implementerSummary.trim()];
    if (verdict) {
        lines.push('', formatStageVerdictLine({
            verdict, rounds: s.round, reviewerProvider: opts.reviewerProvider,
            independenceUsed: s.independenceUsed as MeshStageIndependenceUsed | undefined,
            fixed: s.findingsFixed, openNits: s.openNits?.length,
        }));
    }
    if (s.blockedReason) lines.push(`blocked: ${s.blockedReason}${opts.blockedDetail ? ` — ${opts.blockedDetail}` : ''}`);
    if (s.openFindings?.length) lines.push('Unresolved blocking/major findings:', ...s.openFindings.map(f => `- [${f.severity}] ${f.id}: ${f.claim}`));
    if (s.openNits?.length) lines.push('Open nits:', ...s.openNits.map(f => `- [${f.severity}] ${f.id}: ${f.claim}`));
    if (s.selfCheck) lines.push(`self-check: ${s.selfCheck}`);
    const art = [...s.artifacts.diff.slice(-1), ...s.artifacts.selfCheck.slice(-1), ...s.artifacts.verdict.slice(-1)];
    if (art.length) lines.push(`stage artifacts: ${art.join(', ')}`);
    if (opts.outcome === 'blocked') lines.push('Decide with mesh_task_stage_decide {task_id, action: accept | revise_once | rereview | abandon}.');
    return lines.join('\n');
}
