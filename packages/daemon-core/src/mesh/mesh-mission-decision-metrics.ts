/**
 * Decision-inbox metrics (structured-missions design 2026-10-28 §3 "지표").
 *
 * Computed on demand from existing rows — the decision items (current answers,
 * creation times) and the append-only `mesh_mission_events` — so the hot paths
 * pay nothing. The one exception is blocked re-asks (dedupe hits): a deduped write must
 * leave the event history untouched, so they are an in-memory per-mesh counter that
 * resets with the daemon (`dedupeHitsSinceStart`). Consumers: `mission_decisions_list { includeMetrics }` and the
 * assistant digest. Sunset: with the decision inbox itself (§3 폐기 조건).
 */
import { isCarryOverMissionRecord } from '@adhdev/mesh-shared';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { getMeshMissions } from './mesh-missions.js';
import { INFERRED_DECISION_CONTEXT } from './coordinator-inferred-decision.js';

const dedupeHits = new Map<string, number>();
/** Called by the mission writer when a decision re-ask was answered with the existing item. */
export function recordDecisionDedupeHit(meshId: string): void {
    dedupeHits.set(meshId, (dedupeHits.get(meshId) ?? 0) + 1);
}
export function resetDecisionDedupeHitsForTests(): void { dedupeHits.clear(); }

export interface DecisionMetrics {
    meshId: string;
    windowMs: number;
    /** Decisions currently open / answered (all time on this mesh). */
    open: number;
    answered: number;
    /** Time from creation to the CURRENT answer, over decisions answered inside the window (excludes auto-applied). */
    turnaroundMs: { count: number; medianMs: number | null; p90Ms: number | null };
    /** Answers recorded in the window by channel (`decision_answered` + `decision_answer_changed` events). */
    answersByVia: Record<string, number>;
    /** Of the decisions answered in the window: answered with the recommended option (the "추천대로" signal) and auto-applied at the deadline. */
    answeredWithRecommended: number;
    autoApplied: number;
    /** Re-asks blocked by dedupe since this daemon started (in memory; not windowed). */
    dedupeHitsSinceStart: number;
    /** Answer undos; `assistantAnswersUndone` = undos of an answer the assistant had interpreted (its misreading signal). */
    undone: number;
    assistantAnswersUndone: number;
    assistantAnswers: number;
    /** Decisions the daemon registered from a coordinator's plain-text question (the prompt rule failed; target 0). */
    inferredFromPlainText: number;
    /** Items auto-moved into the carry-over mission by closing missions. */
    carriedOver: number;
}

function quantile(sorted: number[], q: number): number | null {
    if (!sorted.length) return null;
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

export function computeDecisionMetrics(meshId: string, windowMs: number, nowMs: number = Date.now()): DecisionMetrics {
    const items = MeshRuntimeStore.getInstance().missionItems();
    const sinceIso = new Date(nowMs - windowMs).toISOString();
    const decisions = items.listByKindStates(meshId, 'decision', ['open', 'answered']);
    const out: DecisionMetrics = {
        meshId, windowMs,
        open: decisions.filter(d => d.state === 'open').length,
        answered: decisions.filter(d => d.state === 'answered').length,
        turnaroundMs: { count: 0, medianMs: null, p90Ms: null },
        answersByVia: {}, answeredWithRecommended: 0, autoApplied: 0,
        dedupeHitsSinceStart: dedupeHits.get(meshId) ?? 0, undone: 0, assistantAnswersUndone: 0, assistantAnswers: 0, carriedOver: 0,
        inferredFromPlainText: decisions.filter(d => d.decision?.context === INFERRED_DECISION_CONTEXT).length,
    };
    const waits: number[] = [];
    for (const i of decisions) {
        const a = i.decision?.answer;
        if (i.state !== 'answered' || !a || a.at < sinceIso) continue;
        if (a.by === 'auto_recommended') { out.autoApplied++; continue; }
        if (a.optionId && a.optionId === i.decision?.recommended) out.answeredWithRecommended++;
        const wait = Date.parse(a.at) - Date.parse(i.createdAt);
        if (Number.isFinite(wait) && wait >= 0) waits.push(wait);
    }
    waits.sort((x, y) => x - y);
    out.turnaroundMs = { count: waits.length, medianMs: quantile(waits, 0.5), p90Ms: quantile(waits, 0.9) };

    const carryIds = new Set(getMeshMissions(meshId).filter(m => isCarryOverMissionRecord(m)).map(m => m.id));
    const events = items.listMeshEvents(meshId, ['decision_answered', 'decision_answer_changed', 'decision_answer_undone', 'items_moved'], sinceIso);
    for (const e of events) {
        const p = e.payload;
        if (e.type === 'decision_answered' || e.type === 'decision_answer_changed') {
            const via = typeof p.via === 'string' ? p.via : 'unknown';
            out.answersByVia[via] = (out.answersByVia[via] ?? 0) + 1;
            if (via === 'assistant') out.assistantAnswers++;
        } else if (e.type === 'decision_answer_undone') {
            out.undone++;
            if (p.wasVia === 'assistant') out.assistantAnswersUndone++;
        } else if (e.type === 'items_moved' && p.dir === 'in' && carryIds.has(e.missionId)) {
            out.carriedOver += Array.isArray(p.ids) ? p.ids.length : 0;
        }
    }
    return out;
}
