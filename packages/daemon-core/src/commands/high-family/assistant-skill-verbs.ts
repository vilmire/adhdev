/**
 * Procedure-skill additions to the assistant verbs (design
 * 2026-11-01-procedure-skills.md): usage counters + metrics, `project_send`
 * skill hints and recurring-request signals, save proposals, the owner skills
 * list and the directory import. Kept out of `assistant-store.ts` /
 * `assistant.ts` so those files only gain one-line call sites.
 */

import { randomUUID } from 'crypto';
import { resolveAssistantProject } from '../../assistant/assistant-projects.js';
import type { AssistantServices } from '../../assistant/assistant-services.js';
import type { AssistantMetricRow } from '../../assistant/assistant-relay-sqlite-store.js';
import { getSkillHintTracker } from '../../assistant/skills/skill-hints.js';
import { skillHintsFor } from '../../assistant/skills/skill-match.js';
import {
    DIR_IMPORT_SUBDIRS, importFromDirectory, resolveSkillDirectory, scanSkillDirectory,
} from '../../assistant/skills/dir-import.js';
import type { SkillManageOp, SkillManageResult, SkillViewResult } from '../../assistant/skills/skill-store.js';
import type { CommandRouterResult } from '../router.js';

/** Owner-only verb: skill summaries (with attach counts), save proposals and recent skill metrics. */
export const ASSISTANT_SKILLS_LIST_COMMAND = 'assistant_skills_list' as const;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function bump(svc: AssistantServices, column: Parameters<NonNullable<AssistantServices['skillMetrics']>['bump']>[0], meshId = '', n = 1): void {
    try { svc.skillMetrics?.bump(column, meshId, Date.now(), n); } catch { /* metrics never fail a verb */ }
}

// ── skill_view / skill_manage ───────────────────────────────────────────────

/** `skill_views`: a successful named read (a list or a refusal is not a view). */
export function noteSkillView(svc: AssistantServices, name: string, out: SkillViewResult): void {
    if (out.result === 'ok' && name !== 'list') bump(svc, 'skill_views');
}

/**
 * Validate `proposalId` before the write: it must name a candidate that is
 * still open, and only a create can carry one. Null = fine.
 */
export function proposalRefusal(svc: AssistantServices, op: SkillManageOp): CommandRouterResult | null {
    if (op.action !== 'create' || op.proposalId === undefined) return null;
    if (!op.proposalId || !svc.procedureSignals || !svc.procedureSignals.isOpenCandidate(op.proposalId)) {
        return { success: false, code: 'skill_invalid_format', result: 'skill_invalid_format', reason: 'bad_proposal' };
    }
    return null;
}

/** After `skill_manage`: `skill_writes` for applied / staged, and the candidate → proposed link. */
export function noteSkillManage(svc: AssistantServices, op: SkillManageOp, out: SkillManageResult): void {
    if (out.result !== 'applied' && out.result !== 'staged') return;
    bump(svc, 'skill_writes');
    if (out.result === 'staged' && op.action === 'create' && op.proposalId && svc.procedureSignals?.markProposed(op.proposalId, out.stagedId, Date.now())) {
        bump(svc, 'skill_proposals');
    }
}

/** Staged skill proposal settled (apply / discard / expiry): metrics + candidate state. Installed on `skills.onStagedSettled`. */
export function settleProposal(svc: AssistantServices, stagedId: string, how: 'applied' | 'discarded' | 'expired'): void {
    const r = svc.procedureSignals?.settleStaged(stagedId, how, Date.now());
    if (!r) return;
    bump(svc, r.outcome === 'saved' ? 'skill_proposal_saves' : 'skill_proposal_dismisses');
}

// ── project_send ────────────────────────────────────────────────────────────

export interface SkillHint { name: string; score: number; why: string }

/** Hints for a send that named no skills (computed before the send, applied after it succeeds). */
export function computeSendHints(svc: AssistantServices, slug: string, message: string, supplement: unknown, skillsGiven: boolean): SkillHint[] {
    if (skillsGiven) return [];
    try {
        const text = [message, typeof supplement === 'string' ? supplement : ''].join('\n');
        return skillHintsFor(text, svc.skills.list(), { project: slug });
    } catch {
        return [];
    }
}

export interface SendSkillNoteInput {
    meshId: string;
    messageId: string;
    message: string;
    attached: readonly string[];
    hints: readonly SkillHint[];
    /** `assistantSessionId` arg of the verb (origin classification). */
    sessionId: string;
}

/**
 * A `project_send` was accepted: count the attached skills as used, settle
 * hint acceptance, return the hints for the response, and record the request
 * as a recurring-procedure signal when a person (not a relay) started the turn.
 */
export function noteSendSkills(svc: AssistantServices, input: SendSkillNoteInput): { skillHints?: SkillHint[]; skillHintNote?: string } {
    const now = Date.now();
    try {
        if (input.attached.length) {
            svc.skills.recordAttach(input.attached, input.messageId);
            for (const name of getSkillHintTracker().accepted(input.meshId, input.attached, now)) {
                svc.skills.recordHint(name, 'accepted');
                bump(svc, 'skill_hint_accepts', input.meshId);
            }
        }
        if (input.hints.length) {
            getSkillHintTracker().shown(input.meshId, input.hints.map((h) => h.name), now);
            for (const h of input.hints) svc.skills.recordHint(h.name, 'shown');
            bump(svc, 'skill_hints', input.meshId, input.hints.length);
        }
        if (svc.procedureSignals) {
            const w = svc.inputLog.writeContext(input.sessionId);
            // Only a turn a person started: a relay-started (tainted) turn is not the owner's repeated request.
            if (w.origin === 'human') {
                svc.procedureSignals.record({
                    text: input.message, source: 'project_send', meshId: input.meshId, turnKey: `${w.sessionId}:${w.turnId}`,
                    attached: input.attached, at: now,
                });
            }
        }
    } catch { /* instrumentation never fails a send */ }
    return input.hints.length
        ? {
            skillHints: [...input.hints],
            skillHintNote: 'Skills that may fit this request. To use one, pass skills:["name"] on your next project_send for it.',
        }
        : {};
}

export const newMessageId = (): string => randomUUID();

// ── owner skills list ───────────────────────────────────────────────────────

const SUMMARY_DAYS = 14;

/** M-S1…M-S3 over the last N days (ratios are null with a zero denominator). */
export function summarizeSkillMetrics(rows: readonly AssistantMetricRow[]) {
    const sum = (c: keyof AssistantMetricRow) => rows.reduce((n, r) => n + (Number(r[c]) || 0), 0);
    const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) / 100 : null);
    const t = {
        sends: sum('assistant_sends'), attaches: sum('skill_attaches'), views: sum('skill_views'), writes: sum('skill_writes'),
        hints: sum('skill_hints'), hintAccepts: sum('skill_hint_accepts'),
        proposals: sum('skill_proposals'), proposalSaves: sum('skill_proposal_saves'), proposalDismisses: sum('skill_proposal_dismisses'),
    };
    return {
        days: SUMMARY_DAYS, ...t,
        reuseRate: ratio(t.attaches, t.sends),
        proposalAcceptRate: ratio(t.proposalSaves, t.proposals),
        hintHitRate: ratio(t.hintAccepts, t.hints),
    };
}

/** `assistant_skills_list` (owner): skill summaries, save proposals and recent metrics. Reads only — no counter moves. */
export function skillsListResponse(svc: AssistantServices): CommandRouterResult {
    const staged = svc.skills.listStaged();
    const proposals = svc.procedureSignals?.evidenceFor(staged.filter((r) => r.proposalId).map((r) => r.id)) ?? [];
    let metrics = null;
    try {
        const since = new Date(Date.now() - SUMMARY_DAYS * 86_400_000);
        const p = (n: number) => String(n).padStart(2, '0');
        const rows = svc.skillMetrics?.rows?.(`${since.getFullYear()}-${p(since.getMonth() + 1)}-${p(since.getDate())}`) ?? null;
        metrics = rows ? summarizeSkillMetrics(rows) : null;
    } catch { /* no metrics table */ }
    return {
        success: true, result: 'ok',
        skills: svc.skills.list(),
        proposals,
        metrics,
        candidates: svc.procedureSignals?.candidateCounts?.() ?? null,
    };
}

// ── owner store admin + directory import ────────────────────────────────────

/** Owner `assistant_store_admin {target:'skill'}` actions added by this feature: `archive`, `create`. Null = not one of them. */
export function skillAdminExtra(svc: AssistantServices, action: string, args: any): CommandRouterResult | null {
    if (action === 'archive') {
        const out = svc.skills.manage({ action: 'archive', name: str(args?.name) }, 'owner', null);
        return { success: out.result === 'applied', ...(out.result === 'applied' ? {} : { code: out.result }), ...out };
    }
    if (action === 'create') {
        // "Edit, then save" on a proposal card: the owner's own text, applied as an owner write; the staged proposal it answers is retired.
        const stagedId = str(args?.stagedId);
        const op: SkillManageOp = {
            action: 'create', name: str(args?.name), description: typeof args?.description === 'string' ? args.description : '',
            body: typeof args?.body === 'string' ? args.body : '',
            ...(str(args?.project) ? { project: str(args.project) } : {}),
            ...(Array.isArray(args?.triggers) ? { triggers: args.triggers.filter((t: unknown): t is string => typeof t === 'string') } : {}),
        };
        const out = svc.skills.manage(op, 'owner', null);
        if (out.result === 'applied' && stagedId.startsWith('skl-')) svc.skills.resolveStaged(stagedId, 'discard', 'applied');
        return { success: out.result === 'applied', ...(out.result === 'applied' ? {} : { code: out.result }), ...out };
    }
    return null;
}

/** `assistant_import_skills {source:'dir'}`: scan (default) or import skills from a known project's `docs/skills` / `.claude/skills`. */
export function importSkillsFromProjectDir(svc: AssistantServices, args: any): CommandRouterResult {
    const r = resolveAssistantProject(args?.project, svc.listMeshes());
    if (!r.ok) return { success: false, code: r.code, error: r.code };
    const wanted = str(args?.subdir);
    if (wanted && !(DIR_IMPORT_SUBDIRS as readonly string[]).includes(wanted)) {
        return { success: false, code: 'invalid_args', error: `subdir must be one of ${DIR_IMPORT_SUBDIRS.join(', ')}` };
    }
    const roots = ((r.mesh as { nodes?: Array<{ repoRoot?: string; workspace?: string }> }).nodes ?? [])
        .map((n) => n.repoRoot || n.workspace).filter((x): x is string => typeof x === 'string' && !!x);
    for (const root of roots) {
        for (const sub of wanted ? [wanted] : DIR_IMPORT_SUBDIRS) {
            const dir = resolveSkillDirectory(root, sub);
            if (!dir) continue;
            const names = Array.isArray(args?.skills) ? args.skills.filter((s: unknown): s is string => typeof s === 'string') : [];
            if (!names.length || str(args?.action) === 'scan') {
                return { success: true, result: 'scan', project: r.slug, subdir: sub, skills: scanSkillDirectory(dir, svc.skills) };
            }
            const out = importFromDirectory({ dir, skills: names, dryRun: args?.dryRun !== false }, svc.skills);
            return { success: true, project: r.slug, subdir: sub, ...out };
        }
    }
    return { success: false, code: 'skill_dir_not_found', error: `no ${DIR_IMPORT_SUBDIRS.join(' or ')} directory in project ${r.slug}` };
}
