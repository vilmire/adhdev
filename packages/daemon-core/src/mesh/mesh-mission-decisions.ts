/**
 * Owner decisions (structured-missions design 2026-10-28 §6): the owner-side
 * ANSWER path, the `ownerDecisions` projection and the deadline pass.
 *
 * Who may call what is decided by the command layer
 * (commands/high-family/mission-decisions.ts); this module is the pure state
 * machine over the mission item store:
 *
 *   open ──answer──▶ answered ──change──▶ answered (answer_changed)
 *     ▲                  │
 *     └─────undo─────────┘                (answer_undone)
 *
 * Every write: bumps the mission version, appends a mission event, clears the
 * coordinator-prompt watermark (`promptAckedAt`, so the coordinator prompt
 * shows the new answer again), arms `delivery` (`pending`, stable
 * messageId = `decision:<itemId>:r<revision>`; the delivery tick in
 * mesh-mission-decision-delivery.ts sends it exactly once) and notifies the
 * live dashboard. Nothing here is reachable from a coordinator/worker tool.
 */
import {
    MISSION_LIMITS,
    isCarryOverMissionRecord,
    truncateMissionText,
    type MissionDecision,
    type MissionDecisionAnswer,
    type MissionDecisionDelivery,
} from '@adhdev/mesh-shared';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import type { MissionEventType, MissionItemRecord } from './mesh-mission-items-store.js';
import { getMeshMission } from './mesh-missions.js';
import { notifyMissionChanged } from './mesh-mission-change-notifier.js';

export type DecisionAnswerVia = 'dashboard' | 'assistant' | 'push' | 'cli';
export const DECISION_ANSWER_VIAS: readonly DecisionAnswerVia[] = ['dashboard', 'assistant', 'push', 'cli'];

/** Free-text answer clamp (a long answer is truncated, never rejected). */
export const DECISION_ANSWER_TEXT_MAX = 1000;
export const DECISION_INTERPRETED_FROM_MAX = 500;

export type DecisionActor =
    | { by: 'owner'; via: DecisionAnswerVia }
    | { by: 'auto_recommended'; via: 'auto' };

export interface DecisionAnswerRequest {
    meshId: string;
    /** Optional cross-check only: an item moved to/from the carry-over mission is still found by id. */
    missionId?: string;
    itemId: string;
    optionId?: string;
    text?: string;
    interpretedFrom?: string;
    /** Clear the answer back to open (§6.4). */
    undo?: boolean;
}

export type DecisionAnswerResult =
    | {
        ok: true;
        action: 'answered' | 'changed' | 'undone' | 'unchanged';
        meshId: string;
        missionId: string;
        itemId: string;
        question: string;
        revision: number;
        answer?: MissionDecisionAnswer;
        /** The delivery armed by this write (absent for `unchanged`, or an undo the coordinator never heard about). */
        delivery?: MissionDecisionDelivery;
    }
    | { ok: false; code: string; error: string; validOptions?: string[] };

function store(): MeshRuntimeStore {
    return MeshRuntimeStore.getInstance();
}

export function decisionMessageId(itemId: string, revision: number): string {
    return `decision:${itemId}:r${revision}`;
}

/** The coordinator was (or is about to be) told something about this decision. */
function coordinatorWasTold(prev: MissionDecisionDelivery | undefined): boolean {
    return !!prev && (prev.state !== 'pending' || prev.kind !== 'answered');
}

function fail(code: string, error: string, extra?: { validOptions?: string[] }): DecisionAnswerResult {
    return { ok: false, code, error, ...(extra ?? {}) };
}

/** `a: Label` / free text / both — how an answer reads to a human or the coordinator. */
export function describeDecisionAnswer(d: MissionDecision): string {
    const a = d.answer;
    if (!a) return '(no answer)';
    const opt = a.optionId ? d.options.find(o => o.id === a.optionId) : undefined;
    const parts = [
        a.optionId ? `${a.optionId}${opt ? `: ${opt.label}` : ''}` : '',
        a.text ?? '',
    ].filter(Boolean);
    return parts.join(' — ') || '(no text)';
}

/**
 * Record, change or undo the answer of one decision item. Last-write-wins:
 * answering an answered item replaces it (`answer_changed`); the same answer
 * again is an idempotent `unchanged`.
 */
export function answerMissionDecision(
    req: DecisionAnswerRequest,
    actor: DecisionActor,
    nowMs: number = Date.now(),
): DecisionAnswerResult {
    const s = store();
    const result = s.transaction((): DecisionAnswerResult => {
        const items = s.missionItems();
        const item = items.getItem(req.meshId, req.itemId);
        if (!item || item.kind !== 'decision' || !item.decision) {
            return fail('decision_not_found', `no decision item '${req.itemId}' on this mesh`);
        }
        const d = item.decision;
        if (item.state !== 'open' && item.state !== 'answered') {
            return fail('decision_not_open', `decision is ${item.state} — it can no longer be answered`);
        }
        const nowIso = new Date(nowMs).toISOString();
        const prevRevision = d.answerRevision ?? (d.answer ? 1 : 0);
        const { promptAckedAt: _seen, ...dRest } = d;

        // ── undo ──
        if (req.undo === true) {
            if (item.state !== 'answered' || !d.answer) return fail('nothing_to_undo', 'this decision has no answer to undo');
            const revision = prevRevision + 1;
            const told = coordinatorWasTold(d.delivery) && d.delivery?.kind !== 'undone';
            const { answer: _a, delivery: _dl, ...rest } = dRest;
            const delivery: MissionDecisionDelivery | undefined = told
                ? { messageId: decisionMessageId(item.id, revision), state: 'pending', kind: 'undone' }
                : undefined;
            items.updateItem(req.meshId, item.id, {
                state: 'open',
                decision: { ...rest, answerRevision: revision, ...(delivery ? { delivery } : {}) },
            });
            items.appendEvent(req.meshId, item.missionId, 'decision_answer_undone', actor.by, {
                itemId: item.id, revision, via: actor.via, wasAnswer: truncateMissionText(describeDecisionAnswer(d), 200), notifyCoordinator: told,
            });
            items.bumpVersion(req.meshId, item.missionId, nowIso);
            return { ok: true, action: 'undone', meshId: req.meshId, missionId: item.missionId, itemId: item.id, question: d.question, revision, ...(delivery ? { delivery } : {}) };
        }

        // ── answer / change ──
        const optionId = typeof req.optionId === 'string' ? req.optionId.trim() : '';
        const rawText = typeof req.text === 'string' ? req.text.trim() : '';
        if (!optionId && !rawText) return fail('answer_required', 'give an optionId or a text answer');
        if (optionId && !d.options.some(o => o.id === optionId)) {
            return fail('unknown_option', `option '${optionId}' does not exist on this decision`, { validOptions: d.options.map(o => o.id) });
        }
        if (rawText && !optionId && !d.allowFreeText && d.options.length > 0) {
            return fail('free_text_not_allowed', 'this decision only accepts one of its options', { validOptions: d.options.map(o => o.id) });
        }
        const interpretedFrom = typeof req.interpretedFrom === 'string' ? req.interpretedFrom.trim() : '';
        if (actor.via === 'assistant' && !interpretedFrom) {
            return fail('interpreted_from_required', 'an assistant answer must carry the owner\'s words (interpretedFrom)');
        }
        const text = rawText ? truncateMissionText(rawText, DECISION_ANSWER_TEXT_MAX) : '';
        const same = item.state === 'answered' && d.answer
            && (d.answer.optionId ?? '') === optionId && (d.answer.text ?? '') === text;
        if (same) {
            return { ok: true, action: 'unchanged', meshId: req.meshId, missionId: item.missionId, itemId: item.id, question: d.question, revision: prevRevision, answer: d.answer! };
        }

        const wasAnswered = item.state === 'answered';
        const prev = d.delivery;
        const told = coordinatorWasTold(prev);
        // 'changed' = the coordinator holds an earlier answer it must now replace.
        const changed = told && (wasAnswered || prev?.kind === 'undone' && prev.state === 'pending');
        const kind: NonNullable<MissionDecisionDelivery['kind']> = changed ? 'changed' : 'answered';
        const revision = prevRevision + 1;
        const answer: MissionDecisionAnswer = {
            ...(optionId ? { optionId } : {}),
            ...(text ? { text } : {}),
            by: actor.by,
            via: actor.via,
            ...(interpretedFrom ? { interpretedFrom: truncateMissionText(interpretedFrom, DECISION_INTERPRETED_FROM_MAX) } : {}),
            at: nowIso,
        };
        const delivery: MissionDecisionDelivery = { messageId: decisionMessageId(item.id, revision), state: 'pending', kind };
        items.updateItem(req.meshId, item.id, {
            state: 'answered',
            decision: { ...dRest, answer, answerRevision: revision, delivery },
        });
        const eventType: MissionEventType = wasAnswered ? 'decision_answer_changed' : 'decision_answered';
        items.appendEvent(req.meshId, item.missionId, eventType, actor.by, {
            itemId: item.id, revision,
            ...(optionId ? { optionId } : {}),
            ...(text ? { text: truncateMissionText(text, 200) } : {}),
            via: actor.via,
            ...(interpretedFrom ? { interpretedFrom: truncateMissionText(interpretedFrom, 200) } : {}),
            ...(wasAnswered && d.answer ? { previous: truncateMissionText(describeDecisionAnswer(d), 200) } : {}),
        });
        items.bumpVersion(req.meshId, item.missionId, nowIso);
        return { ok: true, action: wasAnswered ? 'changed' : 'answered', meshId: req.meshId, missionId: item.missionId, itemId: item.id, question: d.question, revision, answer, delivery };
    });
    if (result.ok && result.action !== 'unchanged') notifyMissionChanged(req.meshId);
    return result;
}

// ─── projection (§6.1) ──────────────────────────────────────────────────────

export interface OwnerDecisionEntry {
    meshId: string;
    missionId: string;
    missionTitle: string;
    itemId: string;
    question: string;
    context?: string;
    options: Array<{ id: string; label: string; detail?: string }>;
    recommended?: string;
    allowFreeText: boolean;
    urgency: 'normal' | 'blocking';
    dueAt?: string;
    onDue: 'remind' | 'apply_recommended';
    /** Who asked: the coordinator, a worker report, or the daemon itself (owner-confirmation items). */
    source: 'coordinator' | 'worker' | 'daemon';
    createdAt: string;
    /** True when the item sits in the mesh's carry-over mission. */
    carryOver?: true;
    remindedAt?: string;
}

function sourceOf(createdBy: string | undefined): OwnerDecisionEntry['source'] {
    if (createdBy?.startsWith('worker')) return 'worker';
    if (createdBy?.startsWith('daemon')) return 'daemon';
    return 'coordinator';
}

function dueMs(iso: string | undefined): number {
    if (!iso) return Number.POSITIVE_INFINITY;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

/** Blocking first, then nearest dueAt, then oldest. Pure. */
export function compareOwnerDecisions(a: OwnerDecisionEntry, b: OwnerDecisionEntry): number {
    const ba = a.urgency === 'blocking' ? 0 : 1;
    const bb = b.urgency === 'blocking' ? 0 : 1;
    if (ba !== bb) return ba - bb;
    const da = dueMs(a.dueAt);
    const db = dueMs(b.dueAt);
    if (da !== db) return da < db ? -1 : 1;
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

function toEntry(item: MissionItemRecord, missionTitle: string, carryOver: boolean): OwnerDecisionEntry | null {
    const d = item.decision;
    if (!d) return null;
    return {
        meshId: item.meshId,
        missionId: item.missionId,
        missionTitle,
        itemId: item.id,
        question: d.question || item.text,
        ...(d.context ? { context: d.context } : {}),
        options: d.options.map(o => ({ id: o.id, label: o.label, ...(o.detail ? { detail: o.detail } : {}) })),
        ...(d.recommended ? { recommended: d.recommended } : {}),
        allowFreeText: d.allowFreeText,
        urgency: d.urgency,
        ...(d.dueAt ? { dueAt: d.dueAt } : {}),
        onDue: d.onDue,
        source: sourceOf(item.createdBy),
        createdAt: item.createdAt,
        ...(carryOver ? { carryOver: true as const } : {}),
        ...(d.remindedAt ? { remindedAt: d.remindedAt } : {}),
    };
}

/** Open (unanswered, not withdrawn/superseded) decisions of one mesh across all its missions, carry-over included. Computed at query time. */
export function buildOwnerDecisions(meshId: string): OwnerDecisionEntry[] {
    const items = store().missionItems().listOpenByKind(meshId, 'decision');
    const missionCache = new Map<string, { title: string; carryOver: boolean }>();
    const out: OwnerDecisionEntry[] = [];
    for (const item of items) {
        let m = missionCache.get(item.missionId);
        if (!m) {
            const rec = getMeshMission(meshId, item.missionId);
            m = { title: rec?.title ?? item.missionId, carryOver: rec ? isCarryOverMissionRecord(rec) : false };
            missionCache.set(item.missionId, m);
        }
        const e = toEntry(item, m.title, m.carryOver);
        if (e) out.push(e);
    }
    return out.sort(compareOwnerDecisions);
}

export interface RecentlyAnsweredDecision {
    meshId: string;
    missionId: string;
    itemId: string;
    question: string;
    answer: MissionDecisionAnswer;
    revision: number;
    deliveryState?: MissionDecisionDelivery['state'];
    /** Auto-applied answers are shown as such and stay undoable. */
    autoApplied: boolean;
}

/** Answers recorded within `sinceMs` (digest "auto-applied yesterday", undo affordance). Newest first. */
export function listRecentlyAnswered(meshId: string, sinceMs: number): RecentlyAnsweredDecision[] {
    const cutoff = new Date(sinceMs).toISOString();
    return store().missionItems().listByKindStates(meshId, 'decision', ['answered'])
        .filter(i => i.decision?.answer && i.decision.answer.at >= cutoff)
        .map(i => ({
            meshId, missionId: i.missionId, itemId: i.id,
            question: i.decision!.question,
            answer: i.decision!.answer!,
            revision: i.decision!.answerRevision ?? 1,
            ...(i.decision!.delivery ? { deliveryState: i.decision!.delivery.state } : {}),
            autoApplied: i.decision!.answer!.by === 'auto_recommended',
        }))
        .sort((a, b) => (a.answer.at < b.answer.at ? 1 : -1));
}

// ─── deadlines (§6.5) ───────────────────────────────────────────────────────

export interface DeadlinePassResult {
    autoApplied: string[];
    reminded: string[];
}

/**
 * One deadline pass over a mesh's OPEN decisions. Past `dueAt`:
 * `apply_recommended` (+ a valid recommended option) → auto-answered
 * (`by: auto_recommended`, `via: auto`, undoable, delivered like any answer);
 * otherwise `remind` → `remindedAt` stamped once per due crossing (the push /
 * nudge itself is the notification bundles' job). Withdrawn / superseded /
 * answered items are not open and never visited.
 */
export function processDecisionDeadlines(meshId: string, nowMs: number = Date.now()): DeadlinePassResult {
    const s = store();
    const out: DeadlinePassResult = { autoApplied: [], reminded: [] };
    const nowIso = new Date(nowMs).toISOString();
    for (const item of s.missionItems().listOpenByKind(meshId, 'decision')) {
        const d = item.decision;
        if (!d?.dueAt) continue;
        const due = Date.parse(d.dueAt);
        if (!Number.isFinite(due) || due > nowMs) continue;
        if (d.onDue === 'apply_recommended' && d.recommended && d.options.some(o => o.id === d.recommended)) {
            const r = answerMissionDecision({ meshId, itemId: item.id, optionId: d.recommended }, { by: 'auto_recommended', via: 'auto' }, nowMs);
            if (r.ok) out.autoApplied.push(item.id);
            continue;
        }
        // remind: once per due crossing (a later re-ask with a new dueAt re-arms it)
        if (d.remindedAt && d.remindedAt >= d.dueAt) continue;
        s.transaction(() => {
            const items = s.missionItems();
            items.updateItem(meshId, item.id, { decision: { ...d, remindedAt: nowIso } });
            items.appendEvent(meshId, item.missionId, 'decision_reminded', 'daemon', {
                itemId: item.id, dueAt: d.dueAt, urgency: d.urgency,
                question: truncateMissionText(d.question, MISSION_LIMITS.question),
            });
            items.bumpVersion(meshId, item.missionId, nowIso);
        });
        out.reminded.push(item.id);
        notifyMissionChanged(meshId);
    }
    return out;
}
