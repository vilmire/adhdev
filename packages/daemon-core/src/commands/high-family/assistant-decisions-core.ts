/**
 * Owner-decision inbox, assistant side (structured-missions design 2026-10-28
 * §5.2, §6.1, §6.3, §6.4): the host-side building blocks the assistant verbs and
 * the `assistant_remote_project` ops `decision_list` / `decision_answer` /
 * `decision_request` share.
 *
 * Everything here runs on the daemon that HOSTS the mesh (the decision store is
 * the host's). A remote followed project reaches it through the follow relay, so
 * the same code answers a local call and a relayed one.
 *
 * Authority is decided by the callers, not here: the verbs require the bound
 * assistant session credential plus an owner utterance in the current turn; the
 * relay ops are gated by the mesh-sender roster / follower ACL. This module
 * only records answers as `{by:'owner', via:'assistant'}` and always insists on
 * `interpretedFrom` (the owner's own words).
 */
import {
    describeDecisionAnswer,
    answerMissionDecision,
    buildOwnerDecisions,
    listRecentlyAnswered,
    type OwnerDecisionEntry,
    type RecentlyAnsweredDecision,
} from '../../mesh/mesh-mission-decisions.js';
import { createCoordinatorDecisionSender, deliverDecisionAnswer } from '../../mesh/mesh-mission-decision-delivery.js';
import { upsertStructuredMission } from '../../mesh/mesh-mission-structured.js';
import { getMeshMission } from '../../mesh/mesh-missions.js';
import { MeshRuntimeStore } from '../../mesh/mesh-runtime-store.js';
import { LOG } from '../../logging/logger.js';
import type { CompactDecision, CompactRecentAnswer, DecisionListing } from '../../assistant/decision-views.js';
import { projectPortsFor } from './assistant-store.js';
import type { HighFamilyContext } from './types.js';

/** Rows returned per list (the rest are counted, not sent). */
export const DECISION_ROWS_MAX = 10;
/** Answers accepted in one batch call. */
export const DECISION_ANSWERS_MAX = 10;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECENT_ROWS_MAX = 10;

export function compactDecision(e: OwnerDecisionEntry): CompactDecision {
    return {
        itemId: e.itemId,
        question: e.question,
        options: e.options.map(o => ({ id: o.id, label: o.label, ...(o.id === e.recommended ? { recommended: true as const } : {}) })),
        ...(e.recommended ? { recommended: e.recommended } : {}),
        allowFreeText: e.allowFreeText,
        urgency: e.urgency,
        ...(e.dueAt ? { dueAt: e.dueAt } : {}),
        onDue: e.onDue,
        source: e.source,
        missionId: e.missionId,
        ...(e.carryOver ? { carryOver: true as const } : {}),
        ...(e.remindedAt ? { remindedAt: e.remindedAt } : {}),
    };
}

function readableAnswer(meshId: string, r: RecentlyAnsweredDecision): string {
    const item = MeshRuntimeStore.getInstance().missionItems().getItem(meshId, r.itemId);
    return item?.decision ? describeDecisionAnswer(item.decision) : (r.answer.optionId ?? r.answer.text ?? '');
}

/** Open decisions of one hosted mesh (compact, capped) — `includeAnswered` adds the 24h auto-applied answers. */
export function listDecisionsForMesh(meshId: string, opts: { includeAutoApplied?: boolean; nowMs?: number } = {}): DecisionListing {
    const all = buildOwnerDecisions(meshId);
    const out: DecisionListing = {
        openDecisions: { count: all.length, blocking: all.filter(d => d.urgency === 'blocking').length },
        ownerDecisions: all.slice(0, DECISION_ROWS_MAX).map(compactDecision),
    };
    if (opts.includeAutoApplied) {
        const since = (opts.nowMs ?? Date.now()) - RECENT_WINDOW_MS;
        const auto = listRecentlyAnswered(meshId, since).filter(r => r.autoApplied).slice(0, RECENT_ROWS_MAX);
        if (auto.length) {
            out.autoApplied = auto.map((r): CompactRecentAnswer => ({
                itemId: r.itemId, question: r.question, answer: readableAnswer(meshId, r), by: r.answer.by, at: r.answer.at,
            }));
        }
    }
    return out;
}

/** What `project_status` carries for a hosted mesh: nothing when there is nothing to decide. */
export function decisionStatusFields(meshId: string): Record<string, unknown> {
    try {
        const l = listDecisionsForMesh(meshId);
        return l.openDecisions.count > 0 ? { openDecisions: l.openDecisions, ownerDecisions: l.ownerDecisions } : {};
    } catch (e) {
        LOG.warn('AssistantDecisions', `decision listing failed for ${meshId}: ${(e as Error)?.message ?? e}`);
        return {};
    }
}

/** `projects` row field for a hosted mesh: the open-decision counts, nothing when there are none. */
export function openDecisionCountsField(meshId: string): { openDecisions?: { count: number; blocking: number } } {
    try {
        const all = buildOwnerDecisions(meshId);
        return all.length ? { openDecisions: { count: all.length, blocking: all.filter(d => d.urgency === 'blocking').length } } : {};
    } catch {
        return {};
    }
}

// ─── answering (§6.3, §6.4) ─────────────────────────────────────────────────

export interface DecisionAnswerInput {
    itemId: string;
    optionId?: string;
    text?: string;
    interpretedFrom: string;
    undo?: boolean;
}

/** `answers[]` (batch) or the single-answer top-level fields → validated inputs, or an error string. */
export function parseDecisionAnswers(args: Record<string, unknown>): DecisionAnswerInput[] | string {
    const raw: unknown[] = Array.isArray(args.answers) ? args.answers : [args];
    if (raw.length === 0) return 'answers must not be empty';
    if (raw.length > DECISION_ANSWERS_MAX) return `at most ${DECISION_ANSWERS_MAX} answers per call`;
    const out: DecisionAnswerInput[] = [];
    const seen = new Set<string>();
    for (const r of raw) {
        if (!r || typeof r !== 'object' || Array.isArray(r)) return 'each answer must be an object';
        const a = r as Record<string, unknown>;
        const itemId = typeof a.itemId === 'string' ? a.itemId.trim() : '';
        if (!itemId) return 'each answer needs an itemId';
        if (seen.has(itemId)) return `itemId '${itemId}' appears twice`;
        seen.add(itemId);
        const interpretedFrom = typeof a.interpretedFrom === 'string' ? a.interpretedFrom.trim() : '';
        if (!interpretedFrom) return `interpretedFrom is required (the owner's own words) — missing for '${itemId}'`;
        out.push({
            itemId,
            interpretedFrom,
            ...(typeof a.optionId === 'string' && a.optionId.trim() ? { optionId: a.optionId.trim() } : {}),
            ...(typeof a.text === 'string' && a.text.trim() ? { text: a.text.trim() } : {}),
            ...(a.undo === true ? { undo: true } : {}),
        });
    }
    return out;
}

export interface RecordedDecisionAnswer {
    itemId: string;
    ok: boolean;
    action?: 'answered' | 'changed' | 'undone' | 'unchanged';
    code?: string;
    /** One human line per answer, ready to show (ends with the undo hint when undoable). */
    line: string;
    delivery?: string;
    validOptions?: string[];
}

function oneLine(s: string, max = 100): string {
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Record each answer as the assistant (`via: 'assistant'`) and hand it to the
 * coordinator exactly as a dashboard answer would be. One bad answer never
 * blocks the others; the result says which failed.
 */
export async function applyDecisionAnswers(
    ctx: HighFamilyContext,
    meshId: string,
    answers: readonly DecisionAnswerInput[],
): Promise<{ allOk: boolean; answers: RecordedDecisionAnswer[]; lines: string[] }> {
    const recorded: RecordedDecisionAnswer[] = [];
    for (const a of answers) {
        const r = answerMissionDecision({
            meshId, itemId: a.itemId, interpretedFrom: a.interpretedFrom,
            ...(a.optionId ? { optionId: a.optionId } : {}),
            ...(a.text ? { text: a.text } : {}),
            ...(a.undo ? { undo: true } : {}),
        }, { by: 'owner', via: 'assistant' });
        if (!r.ok) {
            recorded.push({
                itemId: a.itemId, ok: false, code: r.code,
                line: `✗ [${a.itemId}] ${r.code}: ${oneLine(r.error, 160)}`,
                ...(r.validOptions ? { validOptions: r.validOptions } : {}),
            });
            continue;
        }
        let delivery: string | undefined = r.delivery?.state;
        if (r.delivery) {
            try {
                const attempt = await deliverDecisionAnswer(meshId, a.itemId, createCoordinatorDecisionSender(() => projectPortsFor(ctx)));
                if (attempt === 'sent' || attempt === 'duplicate') delivery = 'sent';
                else if (attempt === 'queued') delivery = 'queued';
            } catch (e) {
                // Committed and still pending — the housekeeping tick retries.
                LOG.warn('AssistantDecisions', `immediate delivery of ${a.itemId} failed, left pending: ${(e as Error)?.message ?? e}`);
            }
        }
        const q = oneLine(r.question, 80);
        let line: string;
        if (r.action === 'undone') line = `↺ [${a.itemId}] "${q}" — answer withdrawn, the question is open again`;
        else {
            const item = MeshRuntimeStore.getInstance().missionItems().getItem(meshId, a.itemId);
            const what = item?.decision ? oneLine(describeDecisionAnswer(item.decision), 100) : oneLine(r.answer?.optionId ?? r.answer?.text ?? '', 100);
            const verb = r.action === 'unchanged' ? 'already recorded' : r.action === 'changed' ? 'changed to' : 'recorded';
            line = `✓ [${a.itemId}] "${q}" → ${what} (${verb})  [undo]`;
        }
        recorded.push({ itemId: a.itemId, ok: true, action: r.action, line, ...(delivery ? { delivery } : {}) });
    }
    return { allOk: recorded.every(x => x.ok), answers: recorded, lines: recorded.map(x => x.line) };
}

// ─── registering a plain-text question (§5.2) ───────────────────────────────

/**
 * Write a decision item for a question a coordinator put to the owner in plain
 * words. No `missionId` → the mesh's carry-over mission. Re-registering the same
 * question returns the earlier item (and its answer) — never a duplicate.
 * Written as the daemon (not `coordinator`): a coordinator write would advance the
 * coordinator's answered-decision prompt watermark, i.e. mark answers as seen
 * that the coordinator never saw.
 */
export function registerDecisionRequest(meshId: string, args: Record<string, unknown>): Record<string, unknown> {
    const question = typeof args.question === 'string' ? args.question.trim() : '';
    if (!question) return { success: false, code: 'invalid_args', error: 'question is required' };
    const missionId = typeof args.missionId === 'string' ? args.missionId.trim() : '';
    if (missionId && !getMeshMission(meshId, missionId)) {
        return { success: false, code: 'mission_not_found', error: `no mission '${missionId}' on this mesh — omit missionId to use the carry-over mission` };
    }
    const options = Array.isArray(args.options) ? args.options : [];
    const item: Record<string, unknown> = { kind: 'decision', question, options };
    for (const k of ['context', 'recommended', 'urgency', 'dueAt', 'onDue', 'allowFreeText'] as const) {
        if (args[k] !== undefined) item[k] = args[k];
    }
    const { result } = upsertStructuredMission(meshId, missionId ? { id: missionId, itemsAdd: [item] } : { toCarryOver: true, itemsAdd: [item] }, { actor: 'daemon' });
    const r = result.itemResults[0];
    if (!r || r.error) return { success: false, code: 'decision_rejected', error: r?.error ?? 'the decision was not recorded' };
    return {
        success: true,
        itemId: r.id,
        missionId: result.missionId,
        state: r.state,
        ...(r.deduped ? { deduped: true } : {}),
        ...(r.answer ? { answer: r.answer } : {}),
        ...(result.warnings.length ? { warnings: result.warnings } : {}),
    };
}
