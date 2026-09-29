// MAGI group lifecycle around a fan-out: the dispatched / synthesis ledger records,
// replica discovery by consensus group, stale-replica classification, the inline
// mission auto-close and the post-collection session cleanup. Split out of
// mesh-tools-magi.ts.

import { type MeshContext, findOptionalNodeWithRefresh, commandForNode } from './mesh-tools-internal.js';
import { unwrapCommandPayload } from './mesh-session-helpers.js';
import type { MagiTaskKind, MagiSynthesis } from '@adhdev/daemon-core';
import { type RepoMeshMagiSessionCleanupMode, resolveMagiSessionCleanupMode } from '@adhdev/daemon-core';
import {
    recordLocal,
    ledgerQuery,
    missionQuery,
    missionUpsert,
} from '../ipc/turn-commands.js';
import { normalizeMagiTaskKind, DEFAULT_TASK_KIND } from './mesh-tools-magi-core.js';
import { readString } from '@adhdev/mesh-shared';

export const MAGI_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * Discover the replica tasks of a MAGI fan-out by their shared consensus group id.
 * Drives poll-by-group collection (mesh_magi_collect): a wait=false review returns
 * the group id, and a later call rediscovers the replicas straight from the queue —
 * no need to thread the original task-id list back through the caller. Pure given a
 * queue snapshot.
 */
export function findMagiReplicaTasks(queue: any[], consensusGroupId: string): any[] {
    const groupId = typeof consensusGroupId === 'string' ? consensusGroupId.trim() : '';
    if (!groupId) return [];
    return (Array.isArray(queue) ? queue : []).filter((t: any) => readString(t?.consensusGroupId) === groupId);
}

// ─── Post-review auto-cleanup of MAGI-launched worker sessions ──────────────
//
// MAGI fans a question out to N independent (node × provider) replicas. For a pinned
// target with no idle session the QUEUE auto-launches a fresh worker session, stamping
// settings.autoLaunchedForQueueTaskId = task.id onto it (mesh-queue-assignment.ts) which
// the cli-manager mirrors onto the session-host record meta. Those auto-launched workers
// stay idle-LIVE after their turn, so repeated reviews pile up idle sessions.
//
// SAFETY: we compute the cleanup target set ONLY from the replica queue tasks themselves —
// each replica contributes ITS OWN session ids (autoLaunch.sessionId once the auto-launch
// completed, and assignedSessionId once it claimed), paired with the replica's task id as the
// expected autoLaunchedForQueueTaskId marker. We never enumerate arbitrary sessions. The
// daemon then double-checks the per-session marker (requireAutoLaunchedForTaskIds) before
// touching anything: a REUSED idle session carries no marker → preserved; the COORDINATOR
// session carries no marker → preserved; a session whose marker points at a DIFFERENT task
// (re-assignment skew) → preserved. So only the sessions THIS fan-out actually spawned are
// stopped+deleted. assignedSessionId is intentionally included even though it can be a reused
// session — the marker gate filters reused ones out; an auto-launched-then-claimed session
// has assignedSessionId === autoLaunch.sessionId and IS the one we want gone.

/**
 * Pure: derive the per-node cleanup target set from the replica queue tasks. Returns a map
 * keyed by nodeId → { sessionIds, requireAutoLaunchedForTaskIds }. Session ids are pulled
 * ONLY from each replica task's own autoLaunch.sessionId (when status 'completed') and
 * assignedSessionId — never from an external session listing — and each id is paired with
 * THAT replica's task id as the expected marker (so a re-assignment skew can't smuggle in a
 * sibling's session). A replica with no resolvable node id or no candidate session is skipped.
 */
export function computeMagiCleanupTargets(replicaTasks: any[]): Map<string, {
    sessionIds: string[];
    requireAutoLaunchedForTaskIds: Record<string, string>;
}> {
    const byNode = new Map<string, { sessionIds: Set<string>; requireAutoLaunchedForTaskIds: Record<string, string> }>();
    for (const task of Array.isArray(replicaTasks) ? replicaTasks : []) {
        const replicaTaskId = readString(task?.id);
        if (!replicaTaskId) continue;
        const nodeId = readString(task?.assignedNodeId)
            || readString(task?.autoLaunch?.nodeId)
            || readString(task?.targetNodeId);
        if (!nodeId) continue;
        const candidateSessionIds: string[] = [];
        // The session the queue auto-launched for this replica (authoritative auto-launch id).
        if (readString(task?.autoLaunch?.status) === 'completed') {
            const al = readString(task?.autoLaunch?.sessionId);
            if (al) candidateSessionIds.push(al);
        }
        // The session that actually claimed/ran it. May equal the auto-launched id (then it's
        // the same session) or be a reused idle session (filtered out by the marker gate).
        const assigned = readString(task?.assignedSessionId);
        if (assigned) candidateSessionIds.push(assigned);
        if (candidateSessionIds.length === 0) continue;
        let entry = byNode.get(nodeId);
        if (!entry) {
            entry = { sessionIds: new Set<string>(), requireAutoLaunchedForTaskIds: {} };
            byNode.set(nodeId, entry);
        }
        for (const sid of candidateSessionIds) {
            entry.sessionIds.add(sid);
            // Pair each session id with THIS replica's task id. If two replicas somehow named
            // the same session id (shared-session collision), the marker on the live record can
            // only equal one task id, so at most one replica legitimately owns it; recording the
            // first is fine because the daemon re-verifies the marker == expectedTaskId per id.
            if (!(sid in entry.requireAutoLaunchedForTaskIds)) {
                entry.requireAutoLaunchedForTaskIds[sid] = replicaTaskId;
            }
        }
    }
    const out = new Map<string, { sessionIds: string[]; requireAutoLaunchedForTaskIds: Record<string, string> }>();
    for (const [nodeId, entry] of byNode) {
        out.set(nodeId, {
            sessionIds: Array.from(entry.sessionIds),
            requireAutoLaunchedForTaskIds: entry.requireAutoLaunchedForTaskIds,
        });
    }
    return out;
}

/**
 * Resolve whether MAGI post-review auto-cleanup is enabled for this call. Per-call
 * auto_cleanup override (boolean) beats the mesh policy (magiSessionCleanup), which
 * defaults ON ('stop_and_delete'). Returns the effective mode.
 */
export function resolveMagiAutoCleanupMode(
    ctx: MeshContext,
    perCallOverride: boolean | undefined,
): RepoMeshMagiSessionCleanupMode {
    if (perCallOverride === true) return 'stop_and_delete';
    if (perCallOverride === false) return 'preserve';
    return resolveMagiSessionCleanupMode((ctx.mesh as any)?.policy?.magiSessionCleanup);
}

/**
 * Best-effort post-review cleanup. Stops+deletes ONLY the worker sessions THIS MAGI fan-out
 * auto-launched (marker-verified daemon-side). Only runs when `terminal` is true — a partial
 * collect must NOT kill replicas that are still generating. Never throws: cleanup failure
 * never blocks returning the synthesis. Returns a small summary (or null when skipped/disabled).
 */
export async function cleanupMagiAutoLaunchedSessions(
    ctx: MeshContext,
    args: { replicaTasks: any[]; terminal: boolean; mode: RepoMeshMagiSessionCleanupMode },
): Promise<{ cleanedSessionCount: number; perNode: Array<Record<string, unknown>> } | null> {
    if (args.mode === 'preserve') return null;
    if (!args.terminal) return null; // never cleanup a partial collection — replicas may still be live
    const targets = computeMagiCleanupTargets(args.replicaTasks);
    if (targets.size === 0) return null;

    let cleanedSessionCount = 0;
    const perNode: Array<Record<string, unknown>> = [];
    // OFFLINE-NODE-BLOCKING: run the per-node cleanup fan-out concurrently with per-node
    // error isolation (Promise.allSettled) so one offline replica node no longer serializes
    // the rest. cleanup_mesh_sessions is a MUTATION (not a pure read), but it is idempotent
    // and safe to skip for an unreachable node — an offline replica has no live sessions we
    // could reach anyway. Stamp it with the status-origin marker ({ statusProbe: true }): the
    // marker is used ONLY to grant the daemon-cloud relay's SHORT connect-wait budget (so an
    // offline node fails fast in ~2s instead of the 90s connect deadline) and is stripped
    // before the command executes, so the server-side cleanup semantics are unchanged.
    const cleanupNode = async (
        nodeId: string,
        group: { sessionIds: string[]; requireAutoLaunchedForTaskIds?: unknown },
    ): Promise<{ cleaned: number; entry: Record<string, unknown> }> => {
        try {
            const node = await findOptionalNodeWithRefresh(ctx, nodeId);
            if (!node) {
                // Node gone from the live mesh — its sessions are unreachable; report, don't fail.
                return { cleaned: 0, entry: { nodeId, skipped: 'node_not_in_live_mesh', sessionIds: group.sessionIds } };
            }
            const result = await commandForNode(ctx, node, 'cleanup_mesh_sessions', {
                meshId: ctx.mesh.id,
                nodeId,
                mode: 'stop_and_delete',
                sessionIds: group.sessionIds,
                source: 'magi_session_cleanup',
                requireAutoLaunchedForTaskIds: group.requireAutoLaunchedForTaskIds,
                inlineMesh: ctx.mesh,
            }, { statusProbe: true });
            const payload = unwrapCommandPayload(result) as any;
            const deleted = Array.isArray(payload?.deletedSessionIds) ? payload.deletedSessionIds.length : 0;
            const stopped = Array.isArray(payload?.stoppedSessionIds) ? payload.stoppedSessionIds.length : 0;
            return {
                cleaned: deleted + stopped,
                entry: {
                    nodeId,
                    requested: group.sessionIds.length,
                    deleted,
                    ...(stopped ? { stopped } : {}),
                    ...(Array.isArray(payload?.skippedMarkerMismatchSessionIds) && payload.skippedMarkerMismatchSessionIds.length
                        ? { skippedMarkerMismatch: payload.skippedMarkerMismatchSessionIds }
                        : {}),
                    ...(payload?.deleteUnsupported ? { deleteUnsupported: true } : {}),
                },
            };
        } catch (e: any) {
            return { cleaned: 0, entry: { nodeId, error: e?.message || String(e), sessionIds: group.sessionIds } };
        }
    };

    const cleanupTargets = Array.from(targets).filter(([, group]) => group.sessionIds.length > 0);
    const settled = await Promise.allSettled(
        cleanupTargets.map(([nodeId, group]) => cleanupNode(nodeId, group)),
    );
    settled.forEach((outcome, idx) => {
        if (outcome.status === 'fulfilled') {
            cleanedSessionCount += outcome.value.cleaned;
            perNode.push(outcome.value.entry);
        } else {
            // cleanupNode swallows its own errors, so a rejection here is unexpected.
            const [nodeId, group] = cleanupTargets[idx];
            perNode.push({ nodeId, error: outcome.reason?.message ?? String(outcome.reason), sessionIds: group.sessionIds });
        }
    });
    return { cleanedSessionCount, perNode };
}

/**
 * FIX#1 (MAGI tangle): is THIS replica's transcript session also bound to ANOTHER replica of
 * the same fan-out? collect used to resolve a replica's transcript purely by
 * task.assignedSessionId and parse the NEWEST kind-valid JSON across that whole session. But
 * assignedSessionId is NOT unique per replica — it is never cleared on completion, and a
 * provider can reuse one session for >1 replica (sequential idle→claim reuse). When two
 * replicas share a session both resolve to the SAME newest turn → one is dropped as
 * unparseable_output / mis-attributed. There is no per-bubble taskId in the transcript to
 * disambiguate them (the dispatch stamps meshContext.taskId, but bubbles carry only a
 * positional _turnKey, and every MAGI replica is sent the IDENTICAL prompt so the user-bubble
 * text can't separate them either). So we FAIL CLOSED on a detected share: the colliding
 * replica is not attributed the ambiguous turn — it re-waits, and at the deadline finalizes as
 * a `cross_wired_shared_session` error instead of returning another replica's answer.
 *
 * Session ids are node-local, so a match only collides on the SAME node; a coincidental id
 * match across two nodes is not a real share. Pure given a task snapshot.
 */
export function sessionSharedWithAnotherReplica(task: any, allTasks: any[]): boolean {
    const sid = readString(task?.assignedSessionId);
    if (!sid) return false;
    const nodeId = readString(task?.assignedNodeId);
    return (Array.isArray(allTasks) ? allTasks : []).some((other: any) => other?.id !== task?.id
        && readString(other?.assignedSessionId) === sid
        && (!nodeId || !readString(other?.assignedNodeId) || readString(other?.assignedNodeId) === nodeId));
}

/**
 * Classify which non-terminal replica tasks are STALE — assigned to a node/session
 * absent from the live mesh (so they will never reach a terminal state). Reuses the
 * shared queue staleness annotation (annotateQueueStaleness) so MAGI and the queue
 * tools agree on what "stale" means. Pure given tasks already annotated. Returns the
 * set of stale (won't-progress) non-terminal task ids and their reasons.
 */
export function classifyStaleReplicas(
    annotatedTasks: any[],
    terminal: Set<string> = MAGI_TERMINAL_STATUSES,
): { staleTaskIds: Set<string>; staleReasons: Record<string, string> } {
    const staleTaskIds = new Set<string>();
    const staleReasons: Record<string, string> = {};
    for (const t of Array.isArray(annotatedTasks) ? annotatedTasks : []) {
        if (terminal.has(String(t?.status))) continue;
        if (t?.staleAssigned === true) {
            const id = readString(t.id);
            if (!id) continue;
            staleTaskIds.add(id);
            staleReasons[id] = readString(t.staleReason) || 'assigned node/session is not present in the live mesh';
        }
    }
    return { staleTaskIds, staleReasons };
}

// ─── Persistence (deltaE) ───────────────────────

/**
 * Persist the MAGI fan-out as a `magi_dispatched` ledger entry so the consensus group
 * is visible in mesh_status (status=running) and survives a coordinator restart even
 * before any synthesis is collected. Best-effort — a ledger write failure never aborts
 * the review.
 */
export async function persistMagiDispatched(
    ctx: MeshContext,
    args: { consensusGroupId: string; missionId?: string; panel?: string; question?: string; replicaCount: number; taskKind?: MagiTaskKind; autoCleanup?: boolean; requireIndependentEvidence?: boolean },
): Promise<void> {
    try {
        await recordLocal(ctx.transport, { meshId: ctx.mesh.id,
            kind: 'magi_dispatched',
            payload: {
                source: 'magi',
                consensusGroupId: args.consensusGroupId,
                ...(args.missionId ? { missionId: args.missionId } : {}),
                ...(args.panel ? { panel: args.panel } : {}),
                ...(args.question ? { question: args.question.slice(0, 300) } : {}),
                replicaCount: args.replicaCount,
                // MAGI-REDESIGN: persist the task_kind so a later mesh_magi_collect
                // (which rediscovers replicas from the queue, not the original call)
                // re-derives the right schema parser for this group.
                ...(args.taskKind ? { taskKind: args.taskKind } : {}),
                // The per-call choices mesh_magi_collect must honour for a wait:false review.
                ...(typeof args.autoCleanup === 'boolean' ? { autoCleanup: args.autoCleanup } : {}),
                ...(typeof args.requireIndependentEvidence === 'boolean' ? { requireIndependentEvidence: args.requireIndependentEvidence } : {}),
            },
        });
    } catch { /* ledger write is best-effort */ }
}

/**
 * Recover the settings a MAGI fan-out was dispatched with (task_kind, and the per-call
 * auto_cleanup / require_independent_evidence choices) from its `magi_dispatched`
 * ledger entry (mesh_magi_collect rediscovers replicas from the queue and has no kind in
 * hand). Defaults to claim_audit (the backward-compatible kind) when no entry / no kind
 * is recorded. Best-effort: an unreadable ledger returns the default.
 */
export async function recoverMagiDispatchSettings(
    ctx: MeshContext,
    consensusGroupId: string,
): Promise<{ taskKind: MagiTaskKind; autoCleanup?: boolean; requireIndependentEvidence?: boolean }> {
    try {
        const { entries } = await ledgerQuery(ctx.transport, { meshId: ctx.mesh.id, kind: ['magi_dispatched'], tail: 200 });
        for (let i = entries.length - 1; i >= 0; i -= 1) {
            const payload = (entries[i] as any)?.payload;
            if (!payload || typeof payload !== 'object') continue;
            if (readString(payload.consensusGroupId) !== consensusGroupId) continue;
            return {
                taskKind: normalizeMagiTaskKind(payload.taskKind),
                ...(typeof payload.autoCleanup === 'boolean' ? { autoCleanup: payload.autoCleanup } : {}),
                ...(typeof payload.requireIndependentEvidence === 'boolean' ? { requireIndependentEvidence: payload.requireIndependentEvidence } : {}),
            };
        }
    } catch { /* unreadable ledger → defaults */ }
    return { taskKind: DEFAULT_TASK_KIND };
}

/**
 * Strip per-replica rawAnswer (the captured raw end-user text) from a synthesis's
 * replicas[]. rawAnswer can be up to MAGI_RAW_ANSWER_CAP chars × N replicas, so it is
 * gated: omitted from the persisted ledger entry (bounds ledger payload growth) and from
 * the default mesh_magi_collect response. Returns a shallow copy with rawAnswer/
 * rawAnswerTruncated removed from every replica; the original is never mutated.
 */
export function stripRawAnswers(synthesis: MagiSynthesis): MagiSynthesis {
    if (!Array.isArray(synthesis.replicas) || synthesis.replicas.length === 0) return synthesis;
    return {
        ...synthesis,
        replicas: synthesis.replicas.map(r => {
            if (r.rawAnswer === undefined && r.rawAnswerTruncated === undefined) return r;
            const { rawAnswer: _omitRaw, rawAnswerTruncated: _omitTrunc, ...rest } = r;
            return rest;
        }),
    };
}

/**
 * Persist the synthesis as a `magi_synthesis` ledger entry, retrievable by
 * consensusGroupId (getMeshMagiActivityByGroup) and foldable into mesh_status. The full
 * synthesis is stored MINUS per-replica rawAnswer (the caller strips it to bound ledger
 * payload growth); mesh_status bounds it further on read. Best-effort.
 */
export async function persistMagiSynthesis(
    ctx: MeshContext,
    args: { consensusGroupId: string; missionId?: string; panel?: string; question?: string; staleReplicas?: number; synthesis: MagiSynthesis },
): Promise<void> {
    try {
        await recordLocal(ctx.transport, { meshId: ctx.mesh.id,
            kind: 'magi_synthesis',
            payload: {
                source: 'magi',
                consensusGroupId: args.consensusGroupId,
                ...(args.missionId ? { missionId: args.missionId } : {}),
                ...(args.panel ? { panel: args.panel } : {}),
                ...(args.question ? { question: args.question.slice(0, 300) } : {}),
                ...(typeof args.staleReplicas === 'number' ? { staleReplicas: args.staleReplicas } : {}),
                synthesis: args.synthesis,
            },
        });
    } catch { /* ledger write is best-effort */ }
}

/**
 * FIX#3 — auto-close the inline MAGI mission once all replicas are terminal.
 *
 * Every mesh_magi_review auto-creates an inline mission (status defaults 'active') for the
 * fan-out; nothing ever closed it, so 'MAGI: …' missions accumulated forever (mission status
 * is, by design, never derived from task status). Call this at the collect-terminal point:
 * when collection is terminal (all replicas reached a terminal verdict) and the synthesis has
 * been persisted, transition the OWNING mission active→completed.
 *
 * Guards:
 *  - (a) MAGI-owned only — the caller MUST pass the replica tasks' OWN missionId (never a
 *    coordinator-supplied id), so we only ever close the inline MAGI mission.
 *  - (b) Never clobber a manual terminal/paused status — upsertMeshMission has NO no-clobber
 *    semantics (it overwrites status), so we read the current status first and ONLY transition
 *    from 'active'. An 'abandoned'/'paused'/'completed' mission is left untouched.
 * Idempotent: a re-collect that finds the mission already 'completed' is a no-op. Best-effort:
 * a missing mission / read failure never breaks collection.
 */
export async function closeMagiMissionIfTerminal(ctx: MeshContext, missionId: string | undefined, terminal: boolean): Promise<void> {
    if (!terminal) return;
    const id = readString(missionId);
    if (!id) return;
    try {
        // C-W9c: was in-process `getMeshMission`/`upsertMeshMission`; now the same
        // `mission_query`/`mission_upsert` IPC round trips mesh-tools-mission.ts's
        // write path already uses.
        const { missions } = await missionQuery(ctx.transport, { meshId: ctx.mesh.id, id });
        const mission = missions[0];
        // Only close a mission we can see AND that is still active. Skip when missing
        // (already pruned), or already completed/abandoned/paused (guard b).
        if (!mission || mission.status !== 'active') return;
        await missionUpsert(ctx.transport, {
            meshId: ctx.mesh.id,
            id,
            title: mission.title,
            // Preserve goal: upsert defaults goal to the existing value when omitted.
            goal: mission.goal,
            status: 'completed',
        });
    } catch { /* mission close is best-effort — never break collection */ }
}
