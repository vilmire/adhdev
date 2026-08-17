/**
 * Idle-active-mission reminder.
 *
 * When a coordinator session becomes fully idle — no queue/direct work in flight,
 * no pending coordinator events to drain — yet the mesh still carries `active`
 * missions, inject a one-shot "[System] Coordinator idle with N active mission(s)"
 * reminder into that coordinator session. This nudges the coordinator to decide a
 * lingering mission's real outcome (close it, or continue it) rather than leaving it
 * drifting in `active` after its work is actually done.
 *
 * Precedent: mesh-missions.ts `maybeEmitMissionCloseCandidate` — a terminal-edge,
 * once-per-edge coordinator nudge with an idempotency marker. This mirrors that
 * shape, but the "edge" is the coordinator's idle transition (fired by the fast-path
 * in mesh-event-forwarding and the slow-path idle tick in mesh-reconcile-loop) and
 * the idempotency marker is a time+mission-set debounce held in MeshRuntimeStore
 * (getIdleReminderState / setIdleReminderState). Fully best-effort: a throw here must
 * never break the drain/injection path that called it.
 *
 * Design invariants:
 *  - Only fires when the mesh has ≥1 `active` mission AND is fully idle. Fully idle =
 *    buildMeshActiveWork over queue + direct dispatches reports totalActiveCount === 0
 *    && generatingCount === 0, no LOCAL non-coordinator session is busy (see
 *    DIRECT-SESSION-IDLE-BLINDSPOT below), AND no async refine job is accepted/running.
 *    We intentionally do NOT add new remote-node RPC here (expensive per-tick probe): any
 *    non-terminal queue/direct work already makes totalActiveCount > 0, so the idle check
 *    stays conservative — it suppresses the reminder whenever any work is outstanding,
 *    which is the safe direction. Async refine jobs (`mesh_refine_node`) are a separate
 *    class that buildMeshActiveWork does not count, so they are checked explicitly from
 *    the ledger — over a KIND-FILTERED, untailed read, never the `tail: N` window (see
 *    IDLE-REFINE-TAIL-BLINDSPOT below: a tail slices all kinds, so ledger churn can evict
 *    a still-running job's dispatch row and the mesh falsely reads as idle).
 *
 *    DIRECT-SESSION-IDLE-BLINDSPOT: a session the owner starts directly (not via
 *    mesh_enqueue_task/mesh_send_task) never gets a `mesh_queue` or
 *    `mesh_direct_dispatches` row, so buildMeshActiveWork cannot see it — the mesh reads
 *    "no work in flight" while a direct session is still generating. Rather than adding a
 *    new remote RPC, this reuses `instanceManager.collectAllStates()` — the SAME
 *    synchronous, zero-RPC, in-process call the status-report path already makes every
 *    tick (status/reporter.ts, commands/low-family/status-meta.ts) — to see every
 *    LOCALLY-launched session on this daemon. It is local-only by construction (the
 *    instance manager only holds providers this process itself spawned), so it adds no
 *    network cost and no new staleness class beyond what already exists for local status
 *    reporting. Each ProviderState carries `lastUpdated`; an entry older than
 *    LOCAL_SESSION_STALE_MS is treated as unknown (not generating) rather than trusted
 *    indefinitely — see localNonCoordinatorSessionBusy() for the reasoning on why "stale
 *    → ignore" (not "stale → assume busy") is the safe default here.
 *  - MUST exclude the mesh's own coordinator session(s). `collectAllStates()` returns
 *    every local session including coordinators, and this function is only ever called at
 *    a coordinator idle edge — so without exclusion, the calling coordinator's own
 *    just-turned-idle CLI instance (or a sibling coordinator for the same mesh) would
 *    itself be read as "busy" moments earlier and permanently suppress the reminder.
 *    Exclusion mirrors findLiveCoordinators() (mesh-reconcile-coordinator-drain.ts): a
 *    session is a coordinator for THIS mesh when `settings.meshCoordinatorFor === meshId`.
 *  - NEVER transitions a mission's status. It only surfaces a hint; the coordinator
 *    decides via mesh_mission_upsert.
 *  - Debounced per mission-set. Re-fires only when the debounce window has elapsed OR
 *    a NEW mission id entered the active set since the last reminder (see
 *    MISSION-SET-GROWTH-BYPASS below), so a mesh that stays idle with the same active
 *    missions is nudged at most once per window.
 *  - Opt-out via policy.idleActiveMissionReminder === false.
 *
 *    MISSION-SET-GROWTH-BYPASS: `missionSetHash` fingerprints only the id set (sorted,
 *    joined) — it never includes title/goal/updatedAt, so a content-only edit to an
 *    existing mission (mesh_mission_upsert re-supplying the SAME mission_id with a
 *    changed goal) does not change the hash and never bypassed the debounce. The actual
 *    2026-08-17 repeat-fire trigger was a DIFFERENT, cheaper-to-hit path: any hash
 *    difference — including the set merely SHRINKING (a mission closed) — bypassed the
 *    window, and `shouldFireIdleReminder`'s hash-only signature could not distinguish
 *    "a new mission needs attention now" from "one of the missions I already got nudged
 *    about just got closed". The fix compares the actual id sets (not just their hash)
 *    and bypasses ONLY on growth — a mission id present now that was absent from the
 *    last-fired set. A same-or-shrunk set re-uses the normal 5-minute window. This keeps
 *    the original intent (new work → immediate nudge) while a coordinator's routine
 *    mission bookkeeping (status/goal updates, closing missions) no longer restarts the
 *    spam clock.
 */

import { LOG } from '../logging/logger.js';
import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import type { RepoMeshPolicy } from '../repo-mesh-types.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { getMeshMissions, type MeshMissionRecord } from './mesh-missions.js';
import { getQueue, getActiveDirectDispatches } from './mesh-work-queue.js';
import { readLedgerEntries, readLedgerEntriesByKind } from './mesh-ledger.js';
import { buildMeshActiveWork } from './mesh-active-work.js';
import { buildMeshAsyncRefineJobs, summarizeMeshAsyncRefineJobs } from './mesh-refine-status.js';
import type { ProviderState } from '../providers/provider-instance.js';

/** Coordinator instance the reminder is injected into (the idle CLI session). */
type CoordinatorInstance = ReturnType<DaemonComponents['instanceManager']['getInstance']>;

/**
 * A local session's status is trusted for at most this long past its `lastUpdated`
 * stamp. `collectAllStates()` is a synchronous in-process read, so staleness here means
 * the provider adapter itself hasn't refreshed its internal state recently (a hung/dead
 * adapter), NOT network lag — there is no RPC in this path. We deliberately do NOT treat
 * a stale entry as "still busy": an adapter that stopped updating minutes ago is far more
 * likely wedged/exited than genuinely mid-turn, and the failure mode of wrongly staying
 * "busy" is a PERMANENT reminder outage (the debounce marker only advances on an actual
 * fire), which is strictly worse than the occasional early reminder a truly-stuck-but-
 * still-generating session would cause. So a stale entry is excluded from the busy check
 * (treated as "unknown", not "generating") rather than assumed active.
 */
export const LOCAL_SESSION_STALE_MS = 120_000; // 2 minutes — well past the 30s idle heartbeat

/**
 * True when at least one LOCALLY-launched session (this daemon process), other than a
 * coordinator session for `meshId`, is in a busy status (generating or parked on a modal
 * awaiting a human). Pure/exported so it is independently testable without booting a real
 * ProviderInstanceManager.
 */
export function localNonCoordinatorSessionBusy(
    states: ProviderState[] | undefined,
    meshId: string,
    now: number,
): boolean {
    if (!Array.isArray(states)) return false;
    const busyStatuses = new Set(['generating', 'waiting_approval', 'waiting_choice']);
    for (const state of states) {
        if (!state) continue;
        const settings = state.settings && typeof state.settings === 'object' ? state.settings as Record<string, unknown> : {};
        const coordinatorFor = typeof settings.meshCoordinatorFor === 'string' ? settings.meshCoordinatorFor : undefined;
        if (coordinatorFor === meshId) continue; // exclude this mesh's own coordinator session(s)
        const lastUpdated = typeof state.lastUpdated === 'number' ? state.lastUpdated : undefined;
        if (lastUpdated !== undefined && now - lastUpdated > LOCAL_SESSION_STALE_MS) continue; // stale → unknown, not busy
        if (busyStatuses.has(state.status)) return true;
    }
    return false;
}

/**
 * Debounce window: while the mesh stays idle with the SAME-or-SHRUNK active-mission set,
 * re-fire the reminder at most once per this interval. A GROWN mission set (a new active
 * mission id appeared) bypasses the window — see MISSION-SET-GROWTH-BYPASS in the module
 * doc comment for why growth-only, not any-change.
 */
export const IDLE_REMINDER_DEBOUNCE_MS = 300_000; // 5 minutes

/** How many missions to name individually before folding the rest into "and M more". */
const MISSION_LIST_CAP = 10;

/** Stable hash of the active-mission id set (sorted, joined) for debounce comparison. */
export function missionSetHash(missions: MeshMissionRecord[]): string {
    return missions.map(m => m.id).sort().join(',');
}

/** Parse a missionSetHash back into its id set. Inverse of missionSetHash's join(','). */
function parseMissionSetHash(hash: string): Set<string> {
    return new Set(hash.split(',').filter(id => id.length > 0));
}

/**
 * True when `hash` contains at least one mission id absent from `prevHash` — i.e. the
 * active-mission set GREW. A same-or-shrunk set (missions closed, or unchanged, or
 * content-only edits that never touch the id set) is false: only growth signals "new work
 * needs attention now."
 */
function missionSetGrew(prevHash: string, hash: string): boolean {
    if (hash === prevHash) return false;
    const prevIds = parseMissionSetHash(prevHash);
    for (const id of parseMissionSetHash(hash)) {
        if (!prevIds.has(id)) return true;
    }
    return false;
}

/**
 * Decide whether a reminder should fire this call, given the debounce marker. Pure so it
 * is independently testable. Re-fires when there is no prior marker, the debounce window
 * has elapsed, or a NEW mission id entered the active set since the last reminder (a
 * same-or-shrunk set — including any content-only mission edit, since edits never change
 * the id-only hash — stays debounced; see missionSetGrew).
 */
export function shouldFireIdleReminder(
    last: { emittedAt: number; missionSetHash: string } | null,
    hash: string,
    now: number,
    debounceMs: number = IDLE_REMINDER_DEBOUNCE_MS,
): boolean {
    if (!last) return true;
    if (now - last.emittedAt > debounceMs) return true;
    return missionSetGrew(last.missionSetHash, hash);
}

/**
 * Build the coordinator-facing reminder text. Deliberately terse — one line per mission
 * (`title (id)`), NEVER the full goal (goals can be thousands of chars). When there are
 * more than MISSION_LIST_CAP missions, name the first N and fold the remainder.
 */
export function buildIdleReminderMessage(missions: MeshMissionRecord[]): string {
    const shown = missions.slice(0, MISSION_LIST_CAP);
    const lines = shown.map(m => `- ${m.title} (${m.id})`);
    const overflow = missions.length - shown.length;
    if (overflow > 0) lines.push(`- …and ${overflow} more`);
    return (
        `[System] Coordinator idle with ${missions.length} active mission(s):\n`
        + `${lines.join('\n')}\n`
        + `The mesh has no work in flight. For each mission, decide its outcome: continue it `
        + `(enqueue/dispatch the remaining work) or close it with `
        + `mesh_mission_upsert(mission_id, status: "completed" | "abandoned"). `
        + `Do not leave a finished mission in 'active'. This is a one-time reminder.`
    );
}

/**
 * Fire-and-forget idle-active-mission reminder. Call this at a coordinator idle edge
 * once the pending-event queue is empty (nothing else to inject). `coordinator` is the
 * idle CLI session to inject into; `policy` is the mesh's policy (for the opt-out flag).
 *
 * Returns true iff a reminder was injected on this call.
 */
export function maybeInjectIdleActiveMissionReminder(
    meshId: string,
    coordinator: CoordinatorInstance,
    policy: RepoMeshPolicy | undefined,
    now: number = Date.now(),
    instanceManager?: DaemonComponents['instanceManager'],
): boolean {
    try {
        if (!coordinator) return false;
        // Opt-out: default is ON; only an explicit false disables it.
        if (policy?.idleActiveMissionReminder === false) return false;

        // Active missions gate — no active mission, nothing to remind about.
        const activeMissions = getMeshMissions(meshId, ['active']);
        if (activeMissions.length === 0) return false;

        // Fully-idle gate — any non-terminal queue/direct work suppresses the reminder.
        // We pass no `nodes`: totalActiveCount already counts pending/assigned queue tasks
        // and un-acknowledged direct dispatches from the store alone, so the check stays
        // cheap (no per-node status RPC) and conservative.
        //
        // LEDGER-KIND-TAIL-BLINDSPOT: kind-filtered to exactly the kinds buildMeshActiveWork
        // reads (task_dispatched/task_completed/task_failed/task_stalled/task_approval_needed/
        // task_question_pending), no bare tail — same class as the refine gate below (:271):
        // a bare tail:200 window can be crowded out by unrelated mesh traffic while a
        // dispatch/terminal row for a still-active task falls out of the window, making this
        // gate wrongly conclude the mesh is fully idle.
        const ledgerEntries = readLedgerEntriesByKind(meshId, [
            'task_dispatched',
            'task_completed',
            'task_failed',
            'task_stalled',
            'task_approval_needed',
            'task_question_pending',
        ]);
        const summary = buildMeshActiveWork({
            meshId,
            queue: getQueue(meshId),
            directDispatches: getActiveDirectDispatches(meshId),
            ledgerEntries,
            now,
        }).summary;
        if (summary.totalActiveCount !== 0 || summary.generatingCount !== 0) return false;

        // DIRECT-SESSION-IDLE-BLINDSPOT gate — a directly-launched (non-queue) local
        // session that is generating/modal-parked has no queue/direct-dispatch row, so the
        // gate above cannot see it. instanceManager is optional (best-effort: older/other
        // call sites may not pass it) and this reuses the already-computed, zero-RPC local
        // state read — see the module doc comment for why this is safe and local-only.
        if (instanceManager) {
            try {
                const localStates = instanceManager.collectAllStates();
                if (localNonCoordinatorSessionBusy(localStates, meshId, now)) return false;
            } catch { /* best-effort — never let a local-state read failure block the reminder */ }
        }

        // IDLE-REFINE-TAIL-BLINDSPOT: the refine gate below must NOT reuse the
        // `tail: 200` window read above. `tail` slices the last N entries of EVERY kind,
        // so a refine job's `task_dispatched` row is evicted from that window by 200
        // unrelated ledger writes (session launches, task dispatches, checkpoints,
        // node_removed, …) while the job is still running — and a refine pass runs
        // typecheck/test/build for MINUTES, which is ample time for that churn on a busy
        // mesh (47 distinct appendLedgerEntry sites feed this one window).
        //
        // Losing the dispatch row makes buildMeshAsyncRefineJobs report zero in-flight
        // jobs, the mesh reads "no work in flight", and the reminder tells the
        // coordinator to close a mission whose merge is still running — observed twice
        // on 2026-08-16, both times while a Refinery job was `accepted`.
        //
        // Read the refine slice with an explicit `kind` filter and NO tail, exactly as
        // the resume scanner does (router-refine-resume.ts). Filtering by kind first
        // bounds the result to the three job-lifecycle kinds rather than all traffic, so
        // an in-flight dispatch cannot be crowded out by unrelated events.
        const refineLedgerEntries = readLedgerEntries(meshId, {
            kind: ['task_dispatched', 'task_completed', 'task_failed'],
        });

        // Async refine jobs are NOT modeled as queue/direct dispatches, so buildMeshActiveWork
        // never counts them — an accepted/running `mesh_refine_node` job (each pass runs
        // typecheck/test/build for minutes) would otherwise read as "no work in flight" and the
        // reminder would push the coordinator to close a mission whose verification is still
        // in progress. Derive in-flight refine jobs from the SAME ledger tail already read
        // (buildMeshAsyncRefineJobs maps `task_dispatched` refine entries with no terminal to
        // accepted/running) and suppress the reminder while any is non-terminal.
        const activeRefineJobs = summarizeMeshAsyncRefineJobs(
            buildMeshAsyncRefineJobs({ meshId, ledgerEntries: refineLedgerEntries }),
        ).activeJobs;
        if (activeRefineJobs.length > 0) return false;

        // Debounce — same mission set within the window is nudged at most once.
        const store = MeshRuntimeStore.getInstance();
        const hash = missionSetHash(activeMissions);
        const last = store.getIdleReminderState(meshId);
        if (!shouldFireIdleReminder(last, hash, now)) return false;

        const message = buildIdleReminderMessage(activeMissions);
        coordinator.onEvent('send_message', {
            input: { text: message, textFallback: message },
        });
        // Mark AFTER a successful inject so a mid-inject throw retries next edge rather
        // than silently swallowing the only reminder.
        store.setIdleReminderState(meshId, { emittedAt: now, missionSetHash: hash });
        LOG.info(
            'MeshIdleReminder',
            `Injected idle reminder for mesh ${meshId} (${activeMissions.length} active mission(s), fully idle)`,
        );
        return true;
    } catch (e: any) {
        LOG.warn('MeshIdleReminder', `maybeInjectIdleActiveMissionReminder failed for mesh ${meshId}: ${e?.message || e}`);
        return false;
    }
}
