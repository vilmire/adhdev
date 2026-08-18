/**
 * M3: Mission persistence (minimal form).
 *
 * A mission is a persistent record of a multi-task goal so the plan lives in
 * the system rather than in the coordinator LLM's context. Coordinator
 * sessions can die or compact; a new coordinator reads the mission back at
 * launch and continues.
 *
 * Explicit non-goals (see docs/mesh-product-plan-v2.md Phase M3): this is not
 * a workflow engine and there is no automatic takeover daemon. Progress is
 * never stored — it is derived from queue task statuses (mission_id) at
 * query time.
 */

import { randomUUID } from 'crypto';
import { LOG } from '../logging/logger.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { getQueue } from './mesh-work-queue.js';
import { deriveDependencyFailures } from './mesh-graph-derived-failure.js';
import { computeMeshMissionStats, type MeshMissionStats } from './mesh-task-stats.js';
import { appendLedgerEntry } from './mesh-ledger.js';
import { queuePendingMeshCoordinatorEvent } from './mesh-events-pending.js';

/**
 * Max chars of mission goal text written into a ledger entry payload. Mission
 * goals can be hundreds–thousands of chars; the ledger is an append-only audit
 * stream, so we store a bounded summary (+ a length/truncated flag) rather than
 * the full text to keep the ledger from bloating on repeated goal rewrites.
 */
const LEDGER_GOAL_SUMMARY_MAX = 200;

function summarizeGoalForLedger(goal: string): string {
    return goal.length > LEDGER_GOAL_SUMMARY_MAX ? goal.slice(0, LEDGER_GOAL_SUMMARY_MAX) : goal;
}

export type MeshMissionStatus = 'active' | 'paused' | 'completed' | 'abandoned';

export const MESH_MISSION_STATUSES: MeshMissionStatus[] = ['active', 'paused', 'completed', 'abandoned'];

/**
 * Provenance of a mission. `magi` marks an inline mission auto-created by a
 * mesh_magi_review fan-out (one per cross-verification run). `coordinator` (the
 * default semantic for an unstamped/legacy mission) marks a coordinator- or
 * user-authored mission. Used to bound the accumulation of completed MAGI missions
 * out of the default mesh_mission_list surface — see listMeshMissionSummaries.
 */
export type MeshMissionSource = 'magi' | 'coordinator';

export interface MeshMissionRecord {
    id: string;
    meshId: string;
    title: string;
    goal: string;
    status: MeshMissionStatus;
    /**
     * Optional provenance tag. Absent on missions created before this field existed
     * and on coordinator/user missions that don't bother stamping it — both are
     * treated as coordinator missions (never auto-hidden). Only explicit `magi`
     * missions are bounded out of the default list once completed.
     */
    source?: MeshMissionSource;
    /**
     * G3: idempotency marker for the mission_close_candidate nudge. ISO timestamp of
     * the last emit; absent/undefined when the mission has not (or no longer) been in a
     * fully-terminal state. Owned by maybeEmitMissionCloseCandidate — never set by a
     * regular upsert. See summarizeMissionTasks / maybeEmitMissionCloseCandidate.
     */
    closeCandidateEmittedAt?: string;
    createdAt: string;
    updatedAt: string;
}

export interface MeshMissionTaskAggregate {
    total: number;
    pending: number;
    assigned: number;
    completed: number;
    failed: number;
    cancelled: number;
    /** Pending tasks held back by a dependency failure (explicit blockedReason or derived from predecessor statuses). */
    blocked: number;
    /** Latest updatedAt across the mission's tasks, or null with no tasks. */
    lastActivityAt: string | null;
}

export interface MeshMissionSummary extends MeshMissionRecord {
    tasks: MeshMissionTaskAggregate;
    /**
     * Operational rollup (durations / attempts) derived from the ledger via
     * computeMeshMissionStats. Optional: only populated by surfaces that opt in
     * (e.g. mesh_status), since the rollup scans a bounded ledger tail per
     * mission. Absent on the lightweight task-aggregate-only summaries.
     */
    stats?: MeshMissionStats;
}

/**
 * Slim mission summary for the mesh_status compact (default) surface. Drops the
 * full `goal` text — which can be hundreds of chars per mission and is repeated
 * for every mission on every status call — keeping only a short preview plus a
 * `goalTruncated` flag when the original was longer. The stored goal is never
 * mutated; this is an output-only projection. Coordinators that need the full
 * goal call mesh_status with verbose=true, or read the mission directly via
 * mesh_mission_upsert / getMeshMission.
 */
export interface MeshMissionSlimSummary extends Omit<MeshMissionSummary, 'goal'> {
    /** Short preview of the goal (≤ GOAL_PREVIEW_MAX chars), '' when goal empty. */
    goalPreview: string;
    /** True when the stored goal was longer than the preview (full text elided). */
    goalTruncated: boolean;
}

/** Max chars of goal text retained in the slim (compact) mission summary. */
export const GOAL_PREVIEW_MAX = 120;

/**
 * Shorter goal preview used by the mesh_status compact (LLM coordinator) surface.
 * The coordinator only needs to recognize a mission, not read its full goal, and
 * mesh_status repeats every live mission on every poll — so the status preview is
 * tighter than the dashboard / mesh_mission_list preview (GOAL_PREVIEW_MAX).
 */
export const COMPACT_STATUS_GOAL_PREVIEW_MAX = 80;

/**
 * mesh_mission_list default fold sizes. Without an explicit `statuses` filter the
 * tool returns non-terminal (active/paused) missions in full detail but folds the
 * completed/abandoned history into counts + a capped newest-first id list — a mesh
 * can accumulate hundreds of terminal missions and returning them all (each with a
 * ledger-scanned stats rollup) blew past the tool payload / token budget and spilled
 * to a file. When an explicit `statuses` filter IS given, the matching missions are
 * returned in detail but still bounded by MESH_MISSION_LIST_STATUS_LIMIT so a
 * status:["completed"] call on a huge history stays bounded (overflow → truncated).
 */
export const MESH_MISSION_LIST_HISTORY_ID_LIMIT = 30;
export const MESH_MISSION_LIST_STATUS_LIMIT = 50;

function normalizeMissionStatus(value: unknown): MeshMissionStatus {
    return MESH_MISSION_STATUSES.includes(value as MeshMissionStatus)
        ? value as MeshMissionStatus
        : 'active';
}

function normalizeMissionSource(value: unknown): MeshMissionSource | undefined {
    return value === 'magi' || value === 'coordinator' ? value : undefined;
}

export function upsertMeshMission(meshId: string, input: {
    id?: string;
    title: string;
    goal?: string;
    status?: string;
    source?: MeshMissionSource;
}): MeshMissionRecord {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title) throw new Error('mission_title_required: a mission needs a non-empty title');
    if (input.status !== undefined && !MESH_MISSION_STATUSES.includes(input.status as MeshMissionStatus)) {
        throw new Error(`invalid_mission_status: '${input.status}' (valid: ${MESH_MISSION_STATUSES.join(', ')})`);
    }
    const requestedId = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : undefined;
    const store = MeshRuntimeStore.getInstance();
    // MISSION-UPSERT-SILENT-CREATE: an id was explicitly supplied — the caller means
    // "update this mission" — but it doesn't resolve to any existing record (e.g. a
    // truncated/abbreviated id copied from a display view, or a typo). Silently falling
    // through to randomUUID()/INSERT would create an orphan mission under the wrong id
    // AND leave the caller's intended target unmodified, with no error either way. An
    // omitted id is the only legitimate "create new" signal.
    if (requestedId) {
        const target = store.getMission(meshId, requestedId);
        if (!target) {
            throw new Error(
                `mission_not_found: no mission with id '${requestedId}' on this mesh. `
                + `Omit mission_id to create a new mission, or use mesh_mission_list to get a valid full id.`,
            );
        }
    }
    const id = requestedId ?? randomUUID();
    const existing = requestedId ? store.getMission(meshId, id) : null;
    const prevStatus = existing ? normalizeMissionStatus(existing.status) : null;
    const prevGoal = existing?.goal ?? '';
    const record = {
        id,
        meshId,
        title,
        goal: typeof input.goal === 'string' ? input.goal : existing?.goal ?? '',
        status: normalizeMissionStatus(input.status ?? existing?.status),
        // source is write-once: only forwarded when the caller supplies one. The
        // store COALESCEs it against the existing value, so a later status/goal
        // upsert that omits source never clears a previously-stamped tag.
        ...(input.source ? { source: input.source } : {}),
    };
    store.upsertMission(record);
    const saved = store.getMission(meshId, id)!;
    const result: MeshMissionRecord = {
        ...saved,
        status: normalizeMissionStatus(saved.status),
        source: normalizeMissionSource(saved.source),
    };

    // Mission audit trail: record this mutation in the mesh ledger so mission
    // lifecycle (create, goal rewrite, status transition) is auditable alongside
    // task events and survives a coordinator restart. Best-effort: a ledger
    // failure must never break the primary mission write.
    appendMissionLedgerEntries(meshId, {
        isCreate: !existing,
        record: result,
        prevStatus,
        prevGoal,
    });

    return result;
}

/**
 * Append the relevant ledger entries for a mission upsert. Emits at most one
 * entry per distinct change:
 *  - new mission                       → mission_created
 *  - status differs from prior         → mission_status_changed
 *  - goal text differs from prior      → mission_goal_updated (no-op rewrites skipped)
 */
function appendMissionLedgerEntries(
    meshId: string,
    args: { isCreate: boolean; record: MeshMissionRecord; prevStatus: MeshMissionStatus | null; prevGoal: string },
): void {
    const { isCreate, record, prevStatus, prevGoal } = args;
    try {
        if (isCreate) {
            const goal = record.goal ?? '';
            appendLedgerEntry(meshId, {
                kind: 'mission_created',
                payload: {
                    missionId: record.id,
                    title: record.title,
                    goalSummary: summarizeGoalForLedger(goal),
                    goalLength: goal.length,
                    goalTruncated: goal.length > LEDGER_GOAL_SUMMARY_MAX,
                    status: record.status,
                },
            });
            return;
        }
        if (prevStatus !== null && prevStatus !== record.status) {
            appendLedgerEntry(meshId, {
                kind: 'mission_status_changed',
                payload: {
                    missionId: record.id,
                    title: record.title,
                    fromStatus: prevStatus,
                    toStatus: record.status,
                },
            });
        }
        const nextGoal = record.goal ?? '';
        if (nextGoal !== prevGoal) {
            appendLedgerEntry(meshId, {
                kind: 'mission_goal_updated',
                payload: {
                    missionId: record.id,
                    title: record.title,
                    prevGoalSummary: summarizeGoalForLedger(prevGoal),
                    nextGoalSummary: summarizeGoalForLedger(nextGoal),
                    prevGoalLength: prevGoal.length,
                    nextGoalLength: nextGoal.length,
                    goalTruncated: prevGoal.length > LEDGER_GOAL_SUMMARY_MAX || nextGoal.length > LEDGER_GOAL_SUMMARY_MAX,
                },
            });
        }
    } catch { /* audit trail is best-effort; never break the mission write */ }
}

export function getMeshMissions(meshId: string, statuses?: MeshMissionStatus[]): MeshMissionRecord[] {
    return MeshRuntimeStore.getInstance().getMissions(meshId, statuses)
        .map(m => ({ ...m, status: normalizeMissionStatus(m.status), source: normalizeMissionSource(m.source) }));
}

export function getMeshMission(meshId: string, missionId: string): MeshMissionRecord | null {
    const record = MeshRuntimeStore.getInstance().getMission(meshId, missionId);
    return record ? { ...record, status: normalizeMissionStatus(record.status), source: normalizeMissionSource(record.source) } : null;
}

/** Aggregate task statuses for a mission at query time (no stored progress). */
export function summarizeMissionTasks(meshId: string, missionId: string): MeshMissionTaskAggregate {
    const queue = getQueue(meshId);
    const tasks = queue.filter(task => task.missionId === missionId);
    // Dependency status lookup spans the whole queue: a mission task may depend
    // on a task outside the mission.
    const statusById = new Map(queue.map(task => [task.id, task.status] as const));
    const depMetaById = new Map(queue.map(task => [task.id, { blockedReason: task.blockedReason, cancelReason: task.cancelReason, status: task.status }] as const));
    const aggregate: MeshMissionTaskAggregate = {
        total: tasks.length,
        pending: 0,
        assigned: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        blocked: 0,
        lastActivityAt: null,
    };
    for (const task of tasks) {
        if (task.status === 'pending') aggregate.pending += 1;
        else if (task.status === 'assigned') aggregate.assigned += 1;
        else if (task.status === 'completed') aggregate.completed += 1;
        else if (task.status === 'failed') aggregate.failed += 1;
        else if (task.status === 'cancelled') aggregate.cancelled += 1;
        // C3: 'block' no longer writes blockedReason — a failed/cancelled
        // predecessor is derived at view time (design :522-533).
        if (task.status === 'pending'
            && (task.blockedReason || deriveDependencyFailures(task.dependsOn, statusById, depMetaById).length > 0)) {
            aggregate.blocked += 1;
        }
        if (task.updatedAt && (!aggregate.lastActivityAt || task.updatedAt > aggregate.lastActivityAt)) {
            aggregate.lastActivityAt = task.updatedAt;
        }
    }
    return aggregate;
}

export function summarizeMeshMission(meshId: string, mission: MeshMissionRecord): MeshMissionSummary {
    return { ...mission, tasks: summarizeMissionTasks(meshId, mission.id) };
}

/**
 * G3 — all-tasks-terminal detection: true when a mission has at least one task and
 * every task has reached a terminal status (no pending, no assigned). This is the
 * derived signal (never a stored flag) that a mission has no more work in flight and
 * is a candidate for the coordinator to close. A mission with zero tasks is NOT a
 * candidate — an empty mission is a freshly-created plan, not a finished one.
 */
export function isMissionAllTasksTerminal(aggregate: MeshMissionTaskAggregate): boolean {
    return aggregate.total > 0 && aggregate.pending === 0 && aggregate.assigned === 0;
}

/**
 * G3 (step ①) — emit a `mission_close_candidate` coordinator nudge the first time an
 * ACTIVE mission's tasks all become terminal, and reset the idempotency marker when a
 * mission leaves the terminal state. Call this after any task-status mutation that can
 * change a mission's aggregate (completion / failure / cancel / dependency-failure /
 * new task). Fire-and-forget and fully best-effort — a throw here must never break the
 * task mutation that triggered it.
 *
 * Design invariants (docs/MESH_PROMPT_ARCH_REVIEW_2026-07.md §9-1 G3):
 *  - NEVER transitions the mission status. This only publishes a "consider closing"
 *    hint; the coordinator/human decides via mesh_mission_upsert.
 *  - Idempotent per all-terminal EDGE. The mission's close_candidate_emitted_at marker
 *    guarantees exactly one emit per terminal transition; while the mission stays
 *    all-terminal, subsequent calls no-op (no per-tick spam). When the mission returns
 *    to non-terminal (a new/re-opened task), the marker is cleared so a later
 *    re-completion nudges again.
 *  - Only ACTIVE missions nudge. A paused/completed/abandoned mission is never a
 *    close candidate (already decided, or intentionally on hold).
 *
 * Returns true iff an event was emitted on this call.
 */
export function maybeEmitMissionCloseCandidate(meshId: string, missionId: string): boolean {
    try {
        const mission = getMeshMission(meshId, missionId);
        if (!mission) return false;
        const store = MeshRuntimeStore.getInstance();
        const aggregate = summarizeMissionTasks(meshId, missionId);
        const allTerminal = isMissionAllTasksTerminal(aggregate);
        const alreadyEmitted = typeof mission.closeCandidateEmittedAt === 'string' && mission.closeCandidateEmittedAt.length > 0;

        // Reset edge: mission is no longer all-terminal (new/re-opened task) but still
        // carries a stale marker → clear it so a future re-completion can nudge again.
        // Applies regardless of mission status (a re-opened completed mission also resets).
        if (!allTerminal) {
            if (alreadyEmitted) store.setMissionCloseCandidateEmittedAt(meshId, missionId, null);
            return false;
        }

        // All-terminal, but only an ACTIVE mission is a close candidate. A paused mission
        // is intentionally on hold; a completed/abandoned one is already decided. We do
        // NOT mark in these cases — if the mission is later reactivated while still
        // all-terminal, it should nudge then.
        if (mission.status !== 'active') return false;

        // Idempotency: already nudged for this terminal edge → no-op (no per-tick spam).
        if (alreadyEmitted) return false;

        const emittedAt = new Date().toISOString();
        emitMissionCloseCandidateEvent(meshId, mission, aggregate, emittedAt);
        // Mark AFTER a successful emit path so a mid-emit throw leaves the marker unset
        // and the next mutation retries rather than silently dropping the only nudge.
        store.setMissionCloseCandidateEmittedAt(meshId, missionId, emittedAt);
        return true;
    } catch (e: any) {
        LOG.warn('MeshMissions', `maybeEmitMissionCloseCandidate failed for mission ${missionId} on mesh ${meshId}: ${e?.message || e}`);
        return false;
    }
}

/**
 * Build and queue the mission_close_candidate pending coordinator event. Broadcast
 * scope (defaultScopeForEvent → 'broadcast' since it is neither a terminal-task nor a
 * system event), so it reaches any coordinator on the mesh without needing an
 * intendedFor identity — a mission-hygiene hint is not tied to a single dispatcher.
 */
function emitMissionCloseCandidateEvent(
    meshId: string,
    mission: MeshMissionRecord,
    aggregate: MeshMissionTaskAggregate,
    emittedAt: string,
): void {
    const coordinatorMessage =
        `Mission "${mission.title}" (id: ${mission.id}) has no tasks left in flight — all ${aggregate.total} `
        + `task(s) are terminal (${aggregate.completed} completed, ${aggregate.failed} failed, ${aggregate.cancelled} cancelled). `
        + `It is a candidate to close. Review its outcome and, if done, set its status with `
        + `mesh_mission_upsert(mission_id: "${mission.id}", status: "completed" | "abandoned"). `
        + `This is only a hint — the mission stays 'active' until you decide.`;
    queuePendingMeshCoordinatorEvent({
        event: 'mission_close_candidate',
        meshId,
        nodeLabel: '',
        metadataEvent: {
            missionId: mission.id,
            title: mission.title,
            status: mission.status,
            aggregate: {
                total: aggregate.total,
                completed: aggregate.completed,
                failed: aggregate.failed,
                cancelled: aggregate.cancelled,
            },
            lastActivityAt: aggregate.lastActivityAt,
            emittedAt,
        },
        coordinatorMessage,
        queuedAt: Date.parse(emittedAt) || 0,
    });
}

/** Active mission summaries for mesh_status / coordinator prompt injection. */
export function getActiveMeshMissionSummaries(meshId: string): MeshMissionSummary[] {
    return getMeshMissions(meshId, ['active']).map(mission => summarizeMeshMission(meshId, mission));
}

/** Project a full mission summary down to the slim (goal-elided) shape. */
function slimMissionSummary(summary: MeshMissionSummary, previewMax: number = GOAL_PREVIEW_MAX): MeshMissionSlimSummary {
    const goal = typeof summary.goal === 'string' ? summary.goal : '';
    const goalTruncated = goal.length > previewMax;
    const { goal: _omitGoal, ...rest } = summary;
    return {
        ...rest,
        goalPreview: goalTruncated ? goal.slice(0, previewMax) : goal,
        goalTruncated,
    };
}

/**
 * Mission summaries for the mesh_status dashboard surface: every active/paused
 * mission plus a capped, newest-first slice of completed/abandoned history so
 * the dashboard can render a collapsible "history" section without unbounded
 * payload growth. Returned newest-first within each group (active/paused first,
 * then history), so the frontend can split on `status` directly.
 *
 * Compact mode (the default) elides each mission's full `goal` text — which is
 * repeated verbatim on every status poll and dominates the payload when a mesh
 * has many missions — returning only a short `goalPreview` + `goalTruncated`
 * flag. Pass `verbose: true` to get the full `goal` text per mission. The stored
 * goal is untouched in both modes; this is an output-only projection.
 */
export function getMeshStatusMissionSummaries(
    meshId: string,
    options?: { historyLimit?: number; verbose?: boolean; withStats?: boolean },
): MeshMissionSummary[] | MeshMissionSlimSummary[] {
    const historyLimit = Math.max(0, options?.historyLimit ?? 10);
    const all = getMeshMissions(meshId);
    const live = all.filter(m => m.status === 'active' || m.status === 'paused');
    const history = all
        .filter(m => m.status === 'completed' || m.status === 'abandoned')
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
        .slice(0, historyLimit);
    let full = [...live, ...history].map(mission => summarizeMeshMission(meshId, mission));
    // Operational stats (durations / attempts) are an opt-in projection: each
    // mission's rollup scans a bounded ledger tail, so we only compute it for
    // the bounded set we are about to return (live + capped history), not for
    // every mission in the mesh. The dashboard graph opts in so mission detail
    // can show wall-clock / retries without a second round trip.
    if (options?.withStats) {
        full = full.map(summary => ({ ...summary, stats: computeMeshMissionStats(meshId, summary.id) }));
    }
    return options?.verbose ? full : full.map(summary => slimMissionSummary(summary));
}

/** Folded completed/abandoned history for the mesh_status compact surface. */
export interface MeshStatusMissionsHistoryFold {
    /** Total completed + abandoned missions. */
    count: number;
    /** Count by lifecycle status (e.g. { completed, abandoned }). */
    byStatus: Record<string, number>;
    /** Newest-first id list (capped) so each folded mission stays addressable. */
    missionIds: string[];
    note: string;
}

/** Compact mesh_status mission projection: live detail + folded history. */
export interface MeshStatusMissionsCompact {
    /**
     * Active + paused missions, goal-elided to COMPACT_STATUS_GOAL_PREVIEW_MAX and
     * WITHOUT the operational `stats` rollup — the `tasks` aggregate already carries
     * progress, and stats (durations/retries) is a verbose/dashboard concern.
     */
    live: MeshMissionSlimSummary[];
    /** Completed + abandoned missions folded to counts + ids; null when none. */
    historyFold: MeshStatusMissionsHistoryFold | null;
}

/**
 * Mission projection for the mesh_status COMPACT (LLM coordinator) surface.
 *
 * Unlike getMeshStatusMissionSummaries (which emits every live mission plus a
 * capped slice of full-detail history, each carrying a stats rollup), this keeps
 * per-mission detail ONLY for live (active/paused) missions and folds the whole
 * completed/abandoned history into a counts + id-list summary. Combined with the
 * tighter goal preview and dropped stats, this is what keeps the compact
 * mesh_status payload bounded as a mesh accumulates missions — the missions
 * section previously dominated the payload (full goalPreview + tasks + stats per
 * mission, for every live mission and up to 10 history missions, on every poll).
 *
 * The stored missions are untouched; this is an output-only projection. Full
 * mission detail (goal text + stats + history) stays available via
 * mesh_status verbose=true or mesh_mission_list.
 */
export function getMeshStatusMissionsCompact(
    meshId: string,
    options?: { previewMax?: number; historyIdLimit?: number },
): MeshStatusMissionsCompact {
    const previewMax = Math.max(0, options?.previewMax ?? COMPACT_STATUS_GOAL_PREVIEW_MAX);
    const historyIdLimit = Math.max(0, options?.historyIdLimit ?? 20);
    const all = getMeshMissions(meshId);
    const live = all
        .filter(m => m.status === 'active' || m.status === 'paused')
        .map(mission => slimMissionSummary(summarizeMeshMission(meshId, mission), previewMax));
    const history = all
        .filter(m => m.status === 'completed' || m.status === 'abandoned')
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    let historyFold: MeshStatusMissionsHistoryFold | null = null;
    if (history.length > 0) {
        const byStatus: Record<string, number> = {};
        for (const m of history) byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
        historyFold = {
            count: history.length,
            byStatus,
            missionIds: history.slice(0, historyIdLimit).map(m => m.id),
            note: 'Completed/abandoned missions are folded to counts + ids in compact mesh_status. Use mesh_mission_list or mesh_status verbose=true for their goal/task detail.',
        };
    }
    return { live, historyFold };
}

/**
 * Read-only mission listing for the mesh_mission_list tool. Returns summaries
 * (record + live task aggregate) for missions matching `statuses` — or every
 * mission when `statuses` is omitted/empty — newest-first by updatedAt. Unlike
 * getMeshStatusMissionSummaries this does NOT cap or group by lifecycle, so a
 * coordinator can deliberately surface paused/abandoned/completed missions that
 * the live status view would hide or truncate.
 *
 * MAGI bounding: by default this EXCLUDES completed MAGI missions (source==='magi'
 * && status==='completed') — a mesh_magi_review fan-out auto-creates one inline
 * mission per run and auto-closes it on collection, so without this they accumulate
 * unbounded and drown out coordinator missions in the list. In-progress MAGI missions
 * (active/paused) are still shown so a running cross-verification stays visible. Pass
 * `includeMagi: true` to return every mission including completed MAGI ones. A mission
 * with no `source` (legacy / coordinator) is never affected.
 *
 * Compact (the default) elides each goal to a capped preview + goalTruncated
 * flag; verbose returns the full goal text. The stored goal is never mutated.
 */
export function listMeshMissionSummaries(
    meshId: string,
    options?: { statuses?: MeshMissionStatus[]; verbose?: boolean; includeMagi?: boolean },
): MeshMissionSummary[] | MeshMissionSlimSummary[] {
    const statuses = options?.statuses && options.statuses.length > 0 ? options.statuses : undefined;
    const includeMagi = options?.includeMagi === true;
    const missions = getMeshMissions(meshId, statuses)
        // Bound completed-MAGI accumulation by default. Only a mission EXPLICITLY
        // tagged source==='magi' AND completed is hidden — coordinator/legacy
        // (source undefined) missions and in-progress MAGI missions always pass.
        .filter(m => includeMagi || !(m.source === 'magi' && m.status === 'completed'))
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const full = missions.map(mission => summarizeMeshMission(meshId, mission));
    return options?.verbose ? full : full.map(summary => slimMissionSummary(summary));
}

/** Shaped mesh_mission_list result: bounded detail list + optional folded history. */
export interface MeshMissionListResult {
    /** Detailed (slim or verbose) mission summaries — bounded, newest-first. */
    missions: MeshMissionSummary[] | MeshMissionSlimSummary[];
    /**
     * Completed/abandoned missions folded to counts + ids. Present (default path)
     * when no explicit status filter is given and terminal missions exist. Null when
     * an explicit status filter is active (those missions go into `missions`).
     */
    historyFold: MeshStatusMissionsHistoryFold | null;
    /** True when an explicit status filter matched more than `limit` missions. */
    truncated: boolean;
    /** Total missions matching the query BEFORE the detail-list cap was applied. */
    matched: number;
    /** Newest-first ids of missions dropped by the detail-list cap (truncated path). */
    overflowIds?: string[];
}

/**
 * mesh_mission_list projection: payload-bounded regardless of mesh mission count.
 *
 * Default (no explicit `statuses`): non-terminal missions (active/paused) return in
 * detail; completed/abandoned missions are folded to counts + a capped id list
 * (historyFold), NOT emitted one-by-one. This is what keeps the tool from returning
 * hundreds of terminal missions (each with a ledger stats rollup) and overflowing the
 * token budget.
 *
 * Explicit `statuses` (e.g. ["completed"]): the coordinator asked to see those
 * missions, so they ARE returned in detail — but still bounded by `limit` (default
 * MESH_MISSION_LIST_STATUS_LIMIT). Overflow beyond `limit` is reported via
 * truncated:true + overflowIds rather than silently dropped.
 *
 * MAGI + verbose semantics match listMeshMissionSummaries. `withStats` opts each
 * detailed mission into the ledger-scanned stats rollup (off by default — the tasks
 * aggregate is enough for a list view).
 */
export function listMeshMissionsForTool(
    meshId: string,
    options?: {
        statuses?: MeshMissionStatus[];
        verbose?: boolean;
        includeMagi?: boolean;
        withStats?: boolean;
        limit?: number;
        historyIdLimit?: number;
    },
): MeshMissionListResult {
    const explicitStatuses = options?.statuses && options.statuses.length > 0 ? options.statuses : undefined;
    const includeMagi = options?.includeMagi === true;
    const verbose = options?.verbose === true;
    const withStats = options?.withStats === true;
    const limit = Math.max(1, options?.limit ?? MESH_MISSION_LIST_STATUS_LIMIT);
    const historyIdLimit = Math.max(0, options?.historyIdLimit ?? MESH_MISSION_LIST_HISTORY_ID_LIMIT);

    const passesMagi = (m: MeshMissionRecord) => includeMagi || !(m.source === 'magi' && m.status === 'completed');
    const byUpdatedDesc = (a: MeshMissionRecord, b: MeshMissionRecord) => (b.updatedAt || '').localeCompare(a.updatedAt || '');

    const project = (mission: MeshMissionRecord): MeshMissionSummary | MeshMissionSlimSummary => {
        let summary = summarizeMeshMission(meshId, mission);
        if (withStats) {
            try {
                summary = { ...summary, stats: computeMeshMissionStats(meshId, mission.id) };
            } catch { /* stats optional — omit on failure */ }
        }
        return verbose ? summary : slimMissionSummary(summary);
    };

    const foldHistory = (history: MeshMissionRecord[]): MeshStatusMissionsHistoryFold | null => {
        if (history.length === 0) return null;
        const byStatus: Record<string, number> = {};
        for (const m of history) byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
        return {
            count: history.length,
            byStatus,
            missionIds: history.slice(0, historyIdLimit).map(m => m.id),
            note: 'Completed/abandoned missions are folded to counts + ids. Pass status (e.g. status:["completed"]) to list them in detail.',
        };
    };

    if (explicitStatuses) {
        // Explicit filter: return matching missions in detail, capped at `limit`.
        const matched = getMeshMissions(meshId, explicitStatuses)
            .filter(passesMagi)
            .sort(byUpdatedDesc);
        const shown = matched.slice(0, limit);
        const overflow = matched.slice(limit);
        return {
            missions: shown.map(project) as MeshMissionSummary[] | MeshMissionSlimSummary[],
            historyFold: null,
            truncated: overflow.length > 0,
            matched: matched.length,
            ...(overflow.length > 0 ? { overflowIds: overflow.map(m => m.id) } : {}),
        };
    }

    // Default: detail for non-terminal missions, fold terminal history.
    const all = getMeshMissions(meshId).filter(passesMagi);
    const live = all
        .filter(m => m.status === 'active' || m.status === 'paused')
        .sort(byUpdatedDesc);
    const history = all
        .filter(m => m.status === 'completed' || m.status === 'abandoned')
        .sort(byUpdatedDesc);
    const shown = live.slice(0, limit);
    const overflow = live.slice(limit);
    return {
        missions: shown.map(project) as MeshMissionSummary[] | MeshMissionSlimSummary[],
        historyFold: foldHistory(history),
        truncated: overflow.length > 0,
        matched: live.length,
        ...(overflow.length > 0 ? { overflowIds: overflow.map(m => m.id) } : {}),
    };
}

/**
 * M3-3: render active missions as a prompt section for {{mission}}.
 * Empty string when no active mission — the prompt stays byte-identical to
 * the pre-M3 output in that case (regression guarantee).
 */
export function buildMissionPromptSection(meshId: string): string {
    const summaries = getActiveMeshMissionSummaries(meshId);
    if (summaries.length === 0) return '';
    const lines: string[] = ['## Active Mission' + (summaries.length > 1 ? 's' : '')];
    for (const mission of summaries) {
        const t = mission.tasks;
        lines.push(
            `- **${mission.title}** (id: \`${mission.id}\`)`
            + (mission.goal ? `\n  Goal: ${mission.goal}` : '')
            + `\n  Tasks: ${t.total} total — ${t.pending} pending (${t.blocked} blocked), ${t.assigned} assigned, ${t.completed} completed, ${t.failed} failed, ${t.cancelled} cancelled`
            + (t.lastActivityAt ? `\n  Last activity: ${t.lastActivityAt}` : ''),
        );
    }
    lines.push(
        'Continue this mission from its current task state. Do not re-enqueue tasks that already exist — check mesh_view_queue first. '
        + 'Update the mission with mesh_mission_upsert when its goal changes or it reaches a terminal state (completed/abandoned).',
    );
    return lines.join('\n');
}
