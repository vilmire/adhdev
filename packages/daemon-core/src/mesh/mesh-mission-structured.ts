/**
 * Structured mission writes (design 2026-10-28 §5.1, §5.2): the orchestration
 * behind `mesh_mission_upsert`'s new fields — summary, outcome, items_add /
 * items_update, carry_over_to — on top of the plain mission row writer in
 * mesh-missions.ts and the SQL in mesh-mission-items-store.ts.
 *
 * Owner principle (design §0): convenience first, never reject. Closing a mission
 * with open items moves them; a missing outcome becomes 'unspecified'; over-long
 * text is clamped; an unusable item is reported per item and the rest still land.
 * The ONE hard rule: nothing in this file (or any coordinator/worker-reachable
 * path) can ANSWER a decision — `answer`/`delivery` are stripped from input
 * (mesh-shared normalizeDecisionInput) and `items_update` cannot set
 * `answered`/`expired`.
 */
import {
    CARRY_OVER_MISSION_TITLE,
    COORDINATOR_SETTABLE_ITEM_STATES,
    MISSION_LIMITS,
    OWNER_ABANDON_CONFIRM_KEY_PREFIX,
    OWNER_ABANDON_CONFIRM_OPTIONS,
    OWNER_ABANDON_CONFIRM_QUESTION,
    isCarryOverMissionRecord,
    isMissionOutcome,
    normalizeMissionItemInput,
    normalizeMissionItemUpdate,
    normalizeMissionSummary,
    normalizeOutcomeReason,
    normalizeDecisionInput,
    truncateMissionText,
    type MissionItemRef,
    type NormalizedMissionItem,
} from '@adhdev/mesh-shared';
import { randomUUID } from 'crypto';
import { LOG } from '../logging/logger.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { newMissionItemId, type MissionItemRecord, type MissionItemStore } from './mesh-mission-items-store.js';
import { getMeshMission, upsertMeshMission, type MeshMissionRecord } from './mesh-missions.js';
import { acknowledgeAnsweredDecisions } from './mesh-mission-prompt.js';

export type MissionWriteActor = 'coordinator' | 'worker' | 'daemon';

export interface StructuredMissionInput {
    id?: string;
    title?: string;
    goal?: string;
    status?: string;
    brief?: unknown;
    summary?: string;
    outcome?: string;
    outcomeReason?: string;
    carryOverTo?: string;
    /** Write into the mesh's carry-over mission (decision requests that name no mission). */
    toCarryOver?: boolean;
    itemsAdd?: unknown[];
    itemsUpdate?: unknown[];
}

export interface MissionItemResult {
    op: 'add' | 'update';
    id?: string;
    kind?: string;
    state?: string;
    deduped?: true;
    revived?: true;
    /** The stored answer, when a re-asked decision was already answered (acceptance #3). */
    answer?: unknown;
    truncated?: string[];
    error?: string;
}

export interface StructuredWriteResult {
    missionId: string;
    created: boolean;
    version: number;
    itemResults: MissionItemResult[];
    /** Open items moved by a close, and where they went. */
    movedItems?: number;
    movedTo?: string;
    /** Open items moved back by a reopen. */
    restoredItems?: number;
    foldedItems?: number;
    ownerConfirmationItemId?: string;
    warnings: string[];
}

const CLOSED = new Set(['completed', 'abandoned']);

function store(): MeshRuntimeStore {
    return MeshRuntimeStore.getInstance();
}

export const isCarryOverMission = isCarryOverMissionRecord;

/** The mesh's carry-over mission, created (once, active) on first need. */
export function ensureCarryOverMission(meshId: string): string {
    const items = store().missionItems();
    const existing = items.findCarryOverMissionId(meshId);
    if (existing) return existing;
    const id = randomUUID();
    const s = store();
    s.upsertMission({ id, meshId, title: CARRY_OVER_MISSION_TITLE, goal: '닫힌 미션에서 넘어온 열린 항목과 미션 없이 요청된 결정이 모이는 곳. 자동으로 관리됨 — 닫지 않는다.', status: 'active' });
    items.flagCarryOver(meshId, id);
    items.appendEvent(meshId, id, 'created', 'daemon', { title: CARRY_OVER_MISSION_TITLE, carryOver: true });
    return id;
}

// ─── items ──────────────────────────────────────────────────────────────────

function foldOverflow(items: MissionItemStore, meshId: string, missionId: string): number {
    const open = items.listItems(meshId, missionId, { states: ['open'] });
    if (open.length <= MISSION_LIMITS.openItemsPerMission) return 0;
    const FOLD_KEY = 'fold:remaining';
    const existingFold = open.find(i => i.dedupeKey === FOLD_KEY);
    // Make room for the fold item itself (+1 if it does not exist yet).
    const toFold = open.length - MISSION_LIMITS.openItemsPerMission + (existingFold ? 0 : 1);
    const candidates = open.filter(i => i.kind === 'remaining' && i.dedupeKey !== FOLD_KEY).slice(0, toFold);
    if (!candidates.length) return 0;
    for (const c of candidates) items.updateItem(meshId, c.id, { state: 'dropped' });
    const prevCount = existingFold ? Number(/(\d+)/.exec(existingFold.text)?.[1] ?? 0) : 0;
    const text = `이전 남은 일 ${prevCount + candidates.length}개 더 (한도 ${MISSION_LIMITS.openItemsPerMission}개를 넘어 접힘)`;
    if (existingFold) items.updateItem(meshId, existingFold.id, { text });
    else items.insertItem({ id: newMissionItemId(), missionId, meshId, kind: 'remaining', state: 'open', text, refs: [], dedupeKey: FOLD_KEY, createdBy: 'daemon:fold' });
    items.appendEvent(meshId, missionId, 'item_state_changed', 'daemon', { folded: candidates.map(c => c.id), foldItemText: text });
    return candidates.length;
}

/** Add one normalized item to a mission, applying dedupe (acceptance #3). Never throws on a duplicate. */
export function addNormalizedItem(
    meshId: string,
    missionId: string,
    n: NormalizedMissionItem,
    createdBy: string,
    actor: MissionWriteActor,
): MissionItemResult {
    const items = store().missionItems();
    const base: MissionItemResult = { op: 'add', kind: n.kind, ...(n.truncated.length ? { truncated: n.truncated } : {}) };
    // A decision re-asked ANYWHERE on the mesh returns the earlier item — and its answer if it has one.
    if (n.kind === 'decision') {
        const found = items.findDecisionByKey(meshId, n.dedupeKey, ['open', 'answered']);
        if (found) {
            return { ...base, id: found.id, state: found.state, deduped: true, ...(found.decision?.answer ? { answer: found.decision.answer } : {}) };
        }
    }
    const same = items.findByDedupeKey(missionId, n.dedupeKey);
    if (same) {
        const reviveFrom = n.kind === 'evidence' ? [] : (n.kind === 'decision' ? ['withdrawn', 'superseded', 'expired'] : ['done', 'dropped', 'moved']);
        if ((reviveFrom as string[]).includes(same.state)) {
            items.updateItem(meshId, same.id, { state: 'open', text: n.text, ...(n.decision ? { decision: n.decision } : {}), movedTo: null, ...(n.refs.length ? { refs: n.refs } : {}) });
            items.appendEvent(meshId, missionId, 'item_state_changed', actor, { itemId: same.id, from: same.state, to: 'open', revived: true });
            return { ...base, id: same.id, state: 'open', revived: true };
        }
        return { ...base, id: same.id, state: same.state, deduped: true, ...(same.decision?.answer ? { answer: same.decision.answer } : {}) };
    }
    const state = n.kind === 'evidence' ? 'done' : 'open';
    const rec = items.insertItem({
        id: newMissionItemId(), missionId, meshId, kind: n.kind, state, text: n.text,
        ...(n.machine ? { machine: n.machine } : {}),
        refs: n.refs, ...(n.decision ? { decision: n.decision } : {}),
        dedupeKey: n.dedupeKey, createdBy,
    });
    items.appendEvent(meshId, missionId, 'item_added', actor, { itemId: rec.id, kind: rec.kind, text: truncateMissionText(rec.text, 120), createdBy });
    return { ...base, id: rec.id, state };
}

function updateItem(meshId: string, rawUpdate: unknown, actor: MissionWriteActor): MissionItemResult {
    const parsed = normalizeMissionItemUpdate(rawUpdate);
    if ('error' in parsed) return { op: 'update', error: parsed.error };
    const { update, truncated } = parsed;
    const items = store().missionItems();
    const item = items.getItem(meshId, update.id);
    if (!item) return { op: 'update', id: update.id, error: 'item_not_found' };
    const out: MissionItemResult = { op: 'update', id: item.id, kind: item.kind, ...(truncated.length ? { truncated } : {}) };
    const patch: Parameters<MissionItemStore['updateItem']>[2] = {};
    if (update.state !== undefined && update.state !== item.state) {
        // ★The one hard rule: a coordinator/worker can never answer (or expire) a decision.
        if (!COORDINATOR_SETTABLE_ITEM_STATES[item.kind].includes(update.state)) {
            return { ...out, error: item.kind === 'decision' && (update.state === 'answered' || update.state === 'expired')
                ? 'decision_answer_not_allowed: only the owner (or the assistant on the owner\'s words) can answer a decision'
                : `state '${update.state}' cannot be set on a ${item.kind} item` };
        }
        if (item.kind === 'decision' && (item.state === 'answered' || item.state === 'expired')) {
            return { ...out, error: `decision already ${item.state} — ask a new question instead of editing it` };
        }
        patch.state = update.state;
    }
    if (item.kind === 'decision') {
        if (update.text !== undefined) return { ...out, error: 'decision question is immutable — withdraw/supersede it and ask a new one' };
    } else if (update.text !== undefined) {
        patch.text = update.text;
    }
    if (update.machine !== undefined) patch.machine = update.machine;
    if (update.refs !== undefined) patch.refs = update.refs;
    if (!Object.keys(patch).length) return { ...out, state: item.state };
    items.updateItem(meshId, item.id, patch);
    items.appendEvent(meshId, item.missionId, 'item_state_changed', actor, { itemId: item.id, from: item.state, to: patch.state ?? item.state, changes: Object.keys(patch) });
    return { ...out, state: patch.state ?? item.state };
}

// ─── close / reopen ─────────────────────────────────────────────────────────

/** Move a closing mission's open items to `targetId`. Same dedupe key already there → merged (source marked 'moved'). */
function moveOpenItems(meshId: string, fromId: string, targetId: string, actor: MissionWriteActor): { moved: number; ids: string[]; merged: string[] } {
    const items = store().missionItems();
    const open = items.listItems(meshId, fromId, { states: ['open'] });
    const ids: string[] = [];
    const merged: string[] = [];
    for (const it of open) {
        if (it.dedupeKey && items.findByDedupeKey(targetId, it.dedupeKey)) {
            items.updateItem(meshId, it.id, { state: 'moved', movedTo: targetId });
            merged.push(it.id);
        } else {
            items.updateItem(meshId, it.id, { missionId: targetId });
            ids.push(it.id);
        }
    }
    if (open.length) {
        items.appendEvent(meshId, fromId, 'items_moved', actor, { dir: 'out', to: targetId, ids, merged });
        items.appendEvent(meshId, targetId, 'items_moved', actor, { dir: 'in', from: fromId, ids });
        items.bumpVersion(meshId, targetId);
    }
    return { moved: open.length, ids, merged };
}

/** Reopen: put back what a close moved out. Items already handled at the destination stay there. */
function restoreMovedItems(meshId: string, missionId: string, actor: MissionWriteActor): number {
    const items = store().missionItems();
    const events = items.listEvents(meshId, missionId, { types: ['items_moved'], limit: 500 }).filter(e => e.payload.dir === 'out');
    let restored = 0;
    const seen = new Set<string>();
    for (const e of events.reverse()) {
        const to = typeof e.payload.to === 'string' ? e.payload.to : '';
        const moved = Array.isArray(e.payload.ids) ? e.payload.ids.filter((x): x is string => typeof x === 'string') : [];
        const merged = Array.isArray(e.payload.merged) ? e.payload.merged.filter((x): x is string => typeof x === 'string') : [];
        for (const id of moved) {
            if (seen.has(id)) continue;
            seen.add(id);
            const it = items.getItem(meshId, id);
            if (it && it.missionId !== missionId && it.state === 'open') {
                if (items.findByDedupeKey(missionId, it.dedupeKey ?? '\u0000')) continue;
                items.updateItem(meshId, id, { missionId });
                restored++;
            }
        }
        for (const id of merged) {
            if (seen.has(id)) continue;
            seen.add(id);
            const it = items.getItem(meshId, id);
            if (it && it.missionId === missionId && it.state === 'moved') {
                items.updateItem(meshId, id, { state: 'open', movedTo: null });
                restored++;
            }
        }
        if (to && restored > 0) items.bumpVersion(meshId, to);
    }
    if (restored > 0) items.appendEvent(meshId, missionId, 'items_moved', actor, { dir: 'restore', count: restored });
    return restored;
}

/** `owner_abandoned` close → one owner-confirmation decision in the carry-over mission (design §5.1). */
function createOwnerConfirmation(meshId: string, mission: MeshMissionRecord, actor: MissionWriteActor): string | undefined {
    const carryId = ensureCarryOverMission(meshId);
    const decision = normalizeDecisionInput({
        question: OWNER_ABANDON_CONFIRM_QUESTION,
        context: `미션 "${mission.title}" (${mission.id})${mission.outcomeReason ? ` — 사유: ${mission.outcomeReason}` : ''}`,
        options: OWNER_ABANDON_CONFIRM_OPTIONS.map(label => ({ label })),
        urgency: 'normal',
    }, []);
    if (!decision) return undefined;
    const key = `${OWNER_ABANDON_CONFIRM_KEY_PREFIX}${mission.id}`;
    const result = addNormalizedItem(meshId, carryId, {
        kind: 'decision', text: decision.question, refs: [{ kind: 'mission', value: mission.id, note: mission.title }],
        decision, dedupeKey: `k:${key}`, truncated: [],
    }, 'daemon:owner_abandoned_confirm', actor);
    return result.id;
}

function withdrawOwnerConfirmation(meshId: string, missionId: string, actor: MissionWriteActor): void {
    const items = store().missionItems();
    const found = items.findDecisionByKey(meshId, `k:${OWNER_ABANDON_CONFIRM_KEY_PREFIX}${missionId}`, ['open']);
    if (!found) return;
    items.updateItem(meshId, found.id, { state: 'withdrawn' });
    items.appendEvent(meshId, found.missionId, 'item_state_changed', actor, { itemId: found.id, from: 'open', to: 'withdrawn', reason: 'mission_reopened' });
}

// ─── the entry point ────────────────────────────────────────────────────────

export function upsertStructuredMission(
    meshId: string,
    input: StructuredMissionInput,
    opts?: { actor?: MissionWriteActor },
): { record: MeshMissionRecord; result: StructuredWriteResult } {
    const actor: MissionWriteActor = opts?.actor ?? 'coordinator';
    const s = store();
    const warnings: string[] = [];
    return s.transaction(() => {
        const items = s.missionItems();
        let missionId: string | undefined = input.id;
        let title = typeof input.title === 'string' ? input.title.trim() : '';
        if (input.toCarryOver) {
            missionId = ensureCarryOverMission(meshId);
            title = '';
        }
        const before = missionId ? getMeshMission(meshId, missionId) : null;
        if (before && !title) title = before.title;
        // The carry-over mission keeps its fixed title and never closes (it would have nowhere to carry to).
        let status = input.status;
        if (isCarryOverMission(before)) {
            title = before!.title;
            if (status && status !== 'active') { warnings.push('carry_over_mission_always_active'); status = 'active'; }
        }
        const prevStatus = before?.status;
        const wasClosed = prevStatus ? CLOSED.has(prevStatus) : false;

        const base = upsertMeshMission(meshId, {
            ...(missionId ? { id: missionId } : {}),
            title,
            ...(input.goal !== undefined ? { goal: input.goal } : {}),
            ...(status !== undefined ? { status } : {}),
            ...(input.brief !== undefined ? { brief: input.brief } : {}),
        }, { actor, bump: false });
        missionId = base.id;
        const created = !before;
        const itemResults: MissionItemResult[] = [];
        let wrote = false;

        // summary
        const summary = normalizeMissionSummary(input.summary);
        if (summary) {
            const prev = items.getStructured(meshId, missionId)?.summary ?? '';
            if (summary.value !== prev) {
                items.setStructured(meshId, missionId, { summary: summary.value || null });
                items.appendEvent(meshId, missionId, 'summary_changed', actor, { from: prev, to: summary.value });
                wrote = true;
            }
            if (summary.truncated) warnings.push(`summary truncated to ${MISSION_LIMITS.summary} chars`);
        }

        // items
        const addList = Array.isArray(input.itemsAdd) ? input.itemsAdd : [];
        const updList = Array.isArray(input.itemsUpdate) ? input.itemsUpdate : [];
        const createdBy = actor === 'worker' ? 'worker' : actor;
        for (const raw of addList.slice(0, MISSION_LIMITS.itemsPerCall)) {
            const n = normalizeMissionItemInput(raw);
            if ('error' in n) { itemResults.push({ op: 'add', error: n.error }); continue; }
            const r = addNormalizedItem(meshId, missionId, n.item, createdBy, actor);
            itemResults.push(r);
            if (!r.deduped) wrote = true;
        }
        if (addList.length > MISSION_LIMITS.itemsPerCall) warnings.push(`items_add: only the first ${MISSION_LIMITS.itemsPerCall} of ${addList.length} entries were applied — send the rest in another call`);
        for (const raw of updList.slice(0, MISSION_LIMITS.itemsPerCall)) {
            const r = updateItem(meshId, raw, actor);
            itemResults.push(r);
            if (!r.error) wrote = true;
        }
        if (updList.length > MISSION_LIMITS.itemsPerCall) warnings.push(`items_update: only the first ${MISSION_LIMITS.itemsPerCall} of ${updList.length} entries were applied`);
        const foldedItems = addList.length ? foldOverflow(items, meshId, missionId) : 0;

        // outcome
        const closingNow = !!status && CLOSED.has(status) && !wasClosed;
        const reopeningNow = !!status && !CLOSED.has(status) && wasClosed;
        let outcome: string | undefined;
        if (input.outcome !== undefined) {
            if (isMissionOutcome(input.outcome)) outcome = input.outcome;
            else { outcome = 'unspecified'; warnings.push(`unknown outcome '${String(input.outcome).slice(0, 40)}' recorded as 'unspecified'`); }
        } else if (closingNow) {
            outcome = 'unspecified';
        }
        const reason = normalizeOutcomeReason(input.outcomeReason);
        if (outcome !== undefined || reason) {
            const prev = items.getStructured(meshId, missionId);
            items.setStructured(meshId, missionId, {
                ...(outcome !== undefined ? { outcome } : {}),
                ...(reason ? { outcomeReason: reason.value || null } : {}),
            });
            if (outcome !== prev?.outcome || (reason && reason.value !== (prev?.outcomeReason ?? ''))) {
                items.appendEvent(meshId, missionId, 'outcome_set', actor, { outcome: outcome ?? prev?.outcome, ...(reason ? { reason: reason.value } : {}) });
            }
            wrote = true;
        }

        const result: StructuredWriteResult = { missionId, created, version: 0, itemResults, warnings };
        if (foldedItems) result.foldedItems = foldedItems;

        // close → carry open items over (never reject, design §5.1)
        if (closingNow) {
            let targetId: string | undefined;
            if (input.carryOverTo) {
                const t = getMeshMission(meshId, input.carryOverTo);
                if (t && t.id !== missionId) targetId = t.id;
                else warnings.push(`carry_over_to '${input.carryOverTo.slice(0, 40)}' is not another mission on this mesh — used the carry-over mission`);
            }
            const open = items.listItems(meshId, missionId, { states: ['open'] });
            if (open.length) {
                targetId = targetId ?? ensureCarryOverMission(meshId);
                const moved = moveOpenItems(meshId, missionId, targetId, actor);
                result.movedItems = moved.moved;
                result.movedTo = targetId;
                wrote = true;
            }
            if (outcome === 'owner_abandoned') {
                const record = { ...base, outcomeReason: reason?.value ?? items.getStructured(meshId, missionId)?.outcomeReason };
                result.ownerConfirmationItemId = createOwnerConfirmation(meshId, record, actor);
                wrote = true;
            }
        } else if (reopeningNow) {
            const restored = restoreMovedItems(meshId, missionId, actor);
            if (restored) result.restoredItems = restored;
            withdrawOwnerConfirmation(meshId, missionId, actor);
            items.setStructured(meshId, missionId, { outcome: null, outcomeReason: null });
            wrote = true;
        }

        // Every call is one write: exactly one version bump (last-write-wins, no conflict).
        void wrote;
        result.version = created ? (items.getStructured(meshId, missionId)?.version ?? 1) : items.bumpVersion(meshId, missionId);
        // A coordinator write on this mission means it has the mission's state: advance the
        // answered-decision prompt watermark (see mesh-mission-prompt.ts) so each answer is
        // shown once, not on every later prompt build.
        if (actor === 'coordinator' && !created) acknowledgeAnsweredDecisions(meshId, missionId);
        const record = getMeshMission(meshId, missionId)!;
        return { record, result };
    });
}

// ─── read projections ───────────────────────────────────────────────────────

export function itemToWire(i: MissionItemRecord): Record<string, unknown> {
    return {
        id: i.id, kind: i.kind, state: i.state, text: i.text,
        ...(i.machine ? { machine: i.machine } : {}),
        ...(i.refs.length ? { refs: i.refs } : {}),
        ...(i.decision ? { decision: i.decision } : {}),
        ...(i.createdBy ? { createdBy: i.createdBy } : {}),
        ...(i.movedTo ? { movedTo: i.movedTo } : {}),
        createdAt: i.createdAt, updatedAt: i.updatedAt,
    };
}

/** Structured fields for one mission row of mesh_mission_list / mission_upsert (only for `structured: true` callers). */
export function structuredWireFields(
    meshId: string,
    record: { id: string; summary?: string; outcome?: string; outcomeReason?: string; version?: number; isCarryOver?: boolean },
    opts?: { items?: boolean; history?: boolean; counts?: Map<string, { remaining: number; live_check: number; decision: number; evidence: number }> },
): Record<string, unknown> {
    const items = store().missionItems();
    const counts = opts?.counts?.get(record.id) ?? (opts?.counts ? { remaining: 0, live_check: 0, decision: 0, evidence: 0 } : items.openCounts(meshId, record.id));
    return {
        ...(record.summary ? { summary: record.summary } : {}),
        ...(record.outcome ? { outcome: record.outcome } : {}),
        ...(record.outcomeReason ? { outcomeReason: record.outcomeReason } : {}),
        version: record.version ?? 1,
        ...(record.isCarryOver ? { carryOver: true } : {}),
        openItems: counts,
        ...(opts?.items ? { items: items.listItems(meshId, record.id).map(itemToWire) } : {}),
        ...(opts?.history ? { history: items.listEvents(meshId, record.id, { limit: 50 }).map(e => ({ seq: e.seq, type: e.type, ...(e.actor ? { actor: e.actor } : {}), payload: e.payload, at: e.at })) } : {}),
    };
}

// ─── worker report / refinery hooks (design §4.4, §5.2) ─────────────────────

function taskMissionId(meshId: string, taskId: string): string | undefined {
    try { return store().findQueueEntryById(meshId, taskId)?.missionId || undefined; } catch { return undefined; }
}

/**
 * Called after a worker's `report_completion` was accepted: registers
 * `decisions_needed[]` (worker-requested) and attaches `evidence` items from the
 * report's structured fields. NEVER parses the free-text summary for SHAs.
 * Best-effort — a failure here must not turn an accepted report into a refusal.
 */
export function applyWorkerReportToMission(
    meshId: string,
    taskId: string,
    report: { decisionsNeeded?: unknown[]; commits?: string[]; branchState?: string; touchedFiles?: string[]; outcome?: string },
): { decisions: MissionItemResult[]; evidence: MissionItemResult[]; missionId?: string } {
    const out: { decisions: MissionItemResult[]; evidence: MissionItemResult[]; missionId?: string } = { decisions: [], evidence: [] };
    try {
        const s = store();
        const missionId = taskMissionId(meshId, taskId);
        const hasDecisions = Array.isArray(report.decisionsNeeded) && report.decisionsNeeded.length > 0;
        const evidenceWanted = !!missionId && (report.branchState || report.touchedFiles?.length || report.commits?.length);
        if (!hasDecisions && !evidenceWanted) return out;
        s.transaction(() => {
            const items = s.missionItems();
            const mission = missionId ? s.getMission(meshId, missionId) : null;
            if (hasDecisions) {
                const targetId = mission ? mission.id : ensureCarryOverMission(meshId);
                out.missionId = targetId;
                for (const raw of (report.decisionsNeeded as unknown[]).slice(0, 3)) {
                    const n = normalizeMissionItemInput({ ...(raw && typeof raw === 'object' ? raw as object : {}), kind: 'decision' });
                    if ('error' in n) { out.decisions.push({ op: 'add', error: n.error }); continue; }
                    // The worker's own task is the provenance a card shows ("워커가 요청").
                    const taskRef: MissionItemRef = { kind: 'task', value: taskId };
                    n.item.refs = [taskRef, ...n.item.refs].slice(0, MISSION_LIMITS.refs);
                    out.decisions.push(addNormalizedItem(meshId, targetId, n.item, `worker:${taskId}`, 'worker'));
                }
            }
            if (mission && evidenceWanted) {
                out.missionId = out.missionId ?? mission.id;
                const taskRef: MissionItemRef = { kind: 'task', value: taskId };
                const parts: string[] = [];
                if (report.outcome) parts.push(`outcome=${report.outcome}`);
                if (report.branchState) parts.push(`branch_state=${report.branchState}`);
                if (report.touchedFiles?.length) {
                    const shown = report.touchedFiles.slice(0, 5).join(', ');
                    parts.push(`touched ${report.touchedFiles.length} file(s): ${shown}${report.touchedFiles.length > 5 ? ', …' : ''}`);
                }
                if (parts.length) {
                    const n = normalizeMissionItemInput({ kind: 'evidence', text: `worker report — ${parts.join('; ')}`, refs: [taskRef], dedupe_key: `report:${taskId}` });
                    if (!('error' in n)) out.evidence.push(addNormalizedItem(meshId, mission.id, n.item, `daemon:report:${taskId}`, 'daemon'));
                }
                for (const sha of (report.commits ?? []).slice(0, 20)) {
                    const n = normalizeMissionItemInput({ kind: 'evidence', text: `commit ${sha.slice(0, 12)} (worker-reported)`, refs: [{ kind: 'commit', value: sha }, taskRef] });
                    if (!('error' in n)) out.evidence.push(addNormalizedItem(meshId, mission.id, n.item, `daemon:report:${taskId}`, 'daemon'));
                }
            }
            if (out.decisions.some(d => !d.deduped && !d.error) || out.evidence.some(e => !e.deduped && !e.error)) {
                if (out.missionId) items.bumpVersion(meshId, out.missionId);
            }
        });
    } catch (e: any) {
        LOG.warn('MeshMissions', `worker report → mission hook failed for task ${taskId}: ${e?.message || e}`);
    }
    return out;
}

/**
 * Refinery recorded a merge → attach an `evidence` item to the mission that EXACTLY owns the work.
 * A refine job names a node and a branch, not a task, so "latest completed task on that node" was
 * a guess that could land on the wrong mission. The attribution therefore needs an exact link,
 * else nothing is attached: a mission item whose ref is this `branch` (kind=branch, same value), or
 * a `commit` ref (e.g. a worker-reported commits[] entry) that the merged SHA equals/abbreviates.
 * Links to more than one mission are ambiguous → nothing.
 */
export function attachRefineMergeEvidence(
    meshId: string,
    nodeId: string | undefined,
    result: Record<string, unknown> | undefined,
): { missionId: string; itemId?: string } | null {
    try {
        if (!result || result.merged !== true) return null;
        const s = store();
        const branchName = typeof result.branch === 'string' ? result.branch : '';
        const mergedSha = typeof result.mergedSha === 'string' ? result.mergedSha.toLowerCase() : '';
        if (!branchName && !mergedSha) return null;
        const linked = new Set<string>();
        let linkedTaskId: string | undefined;
        for (const it of s.missionItems().listItemsWithRefs(meshId)) {
            if (it.kind === 'evidence' && it.createdBy === 'daemon:refinery') continue; // our own earlier output is not a link
            for (const r of it.refs) {
                const v = r.value.toLowerCase();
                const hit = (r.kind === 'branch' && branchName !== '' && r.value === branchName)
                    || (r.kind === 'commit' && mergedSha !== '' && v.length >= 7 && (mergedSha.startsWith(v) || v.startsWith(mergedSha)));
                if (hit && s.getMission(meshId, it.missionId)) {
                    linked.add(it.missionId);
                    linkedTaskId = linkedTaskId ?? it.refs.find(x => x.kind === 'task')?.value;
                }
            }
        }
        if (linked.size !== 1) return null;
        const missionId = [...linked][0];
        const task = { id: linkedTaskId, missionId };
        const branch = typeof result.branch === 'string' ? result.branch : '';
        const into = typeof result.into === 'string' ? result.into : '';
        const sha = typeof result.mergedSha === 'string' ? result.mergedSha : '';
        const refs: MissionItemRef[] = [];
        if (sha) refs.push({ kind: 'commit', value: sha, ...(into ? { note: `merged into ${into}` } : {}) });
        if (branch) refs.push({ kind: 'branch', value: branch });
        if (task.id) refs.push({ kind: 'task', value: task.id });
        const n = normalizeMissionItemInput({
            kind: 'evidence',
            text: `Refinery merged ${branch || 'branch'}${into ? ` into ${into}` : ''}${sha ? ` (${sha.slice(0, 12)})` : ''}${result.pushed === true ? ', pushed' : ''}`,
            refs,
            dedupe_key: `refine-merge:${nodeId ?? ''}:${sha || branch}`,
        });
        if ('error' in n) return null;
        let itemId: string | undefined;
        s.transaction(() => {
            const r = addNormalizedItem(meshId, missionId, n.item, 'daemon:refinery', 'daemon');
            itemId = r.id;
            if (!r.deduped) s.missionItems().bumpVersion(meshId, missionId);
        });
        return { missionId, itemId };
    } catch (e: any) {
        LOG.warn('MeshMissions', `refine merge → mission evidence failed: ${e?.message || e}`);
        return null;
    }
}

