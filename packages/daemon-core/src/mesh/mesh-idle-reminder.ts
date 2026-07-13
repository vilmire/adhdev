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
 *    && generatingCount === 0 AND no async refine job is accepted/running. We intentionally
 *    do NOT probe remote node sessions here (expensive per-tick RPC): any non-terminal
 *    queue/direct work already makes totalActiveCount > 0, so the idle check is
 *    conservative — it suppresses the reminder whenever any work is outstanding, which is
 *    the safe direction. Async refine jobs (`mesh_refine_node`) are a separate class that
 *    buildMeshActiveWork does not count, so they are checked explicitly from the ledger.
 *  - NEVER transitions a mission's status. It only surfaces a hint; the coordinator
 *    decides via mesh_mission_upsert.
 *  - Debounced per mission-set. Re-fires only when the debounce window has elapsed OR
 *    the set of active mission ids changed (a mission was closed/added), so a mesh that
 *    stays idle with the same active missions is nudged at most once per window.
 *  - Opt-out via policy.idleActiveMissionReminder === false.
 */

import { LOG } from '../logging/logger.js';
import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import type { RepoMeshPolicy } from '../repo-mesh-types.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { getMeshMissions, type MeshMissionRecord } from './mesh-missions.js';
import { getQueue, getActiveDirectDispatches } from './mesh-work-queue.js';
import { readLedgerEntries } from './mesh-ledger.js';
import { buildMeshActiveWork } from './mesh-active-work.js';
import { buildMeshAsyncRefineJobs, summarizeMeshAsyncRefineJobs } from './mesh-refine-status.js';

/** Coordinator instance the reminder is injected into (the idle CLI session). */
type CoordinatorInstance = ReturnType<DaemonComponents['instanceManager']['getInstance']>;

/**
 * Debounce window: while the mesh stays idle with the SAME active-mission set, re-fire
 * the reminder at most once per this interval. A changed mission set bypasses the window.
 */
export const IDLE_REMINDER_DEBOUNCE_MS = 300_000; // 5 minutes

/** How many missions to name individually before folding the rest into "and M more". */
const MISSION_LIST_CAP = 10;

/** Stable hash of the active-mission id set (sorted, joined) for debounce comparison. */
export function missionSetHash(missions: MeshMissionRecord[]): string {
    return missions.map(m => m.id).sort().join(',');
}

/**
 * Decide whether a reminder should fire this call, given the debounce marker. Pure so it
 * is independently testable. Re-fires when there is no prior marker, the debounce window
 * has elapsed, or the active-mission set changed since the last reminder.
 */
export function shouldFireIdleReminder(
    last: { emittedAt: number; missionSetHash: string } | null,
    hash: string,
    now: number,
    debounceMs: number = IDLE_REMINDER_DEBOUNCE_MS,
): boolean {
    if (!last) return true;
    if (now - last.emittedAt > debounceMs) return true;
    return hash !== last.missionSetHash;
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
        const ledgerEntries = readLedgerEntries(meshId, { tail: 200 });
        const summary = buildMeshActiveWork({
            meshId,
            queue: getQueue(meshId),
            directDispatches: getActiveDirectDispatches(meshId),
            ledgerEntries,
            now,
        }).summary;
        if (summary.totalActiveCount !== 0 || summary.generatingCount !== 0) return false;

        // Async refine jobs are NOT modeled as queue/direct dispatches, so buildMeshActiveWork
        // never counts them — an accepted/running `mesh_refine_node` job (each pass runs
        // typecheck/test/build for minutes) would otherwise read as "no work in flight" and the
        // reminder would push the coordinator to close a mission whose verification is still
        // in progress. Derive in-flight refine jobs from the SAME ledger tail already read
        // (buildMeshAsyncRefineJobs maps `task_dispatched` refine entries with no terminal to
        // accepted/running) and suppress the reminder while any is non-terminal.
        const activeRefineJobs = summarizeMeshAsyncRefineJobs(
            buildMeshAsyncRefineJobs({ meshId, ledgerEntries }),
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
