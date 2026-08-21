// ---------------------------------------------------------------------------
// mesh-reconcile-acked-hold — in-flight acked-hold state (persistence + tuning)
// ---------------------------------------------------------------------------
// Pure move out of mesh-reconcile-loop.ts (no behavior change). This is the
// read-through/write-through cache over the mesh_inflight_hold table plus the
// env-tunable timers (death deadline, transcript fast-track grace) that govern
// when an acked dispatch's indefinite synth hold is released. See the R4f and
// ACKED-HOLD-IDLE-OVERTRUST design commentary inline.
// ---------------------------------------------------------------------------

import { LOG } from '../logging/logger.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { readNonEmptyString } from './mesh-events-utils.js';

// R4f backstop (a): how many CONSECUTIVE read_chat failures (transport error / success:false /
// no payload) for an acked task are treated as a death signal that releases the indefinite hold.
// A single failed read is a transient probe blip; a session that genuinely died reads-fail every
// tick, so a small streak distinguishes the two without racing a live-but-slow worker.
export const ACKED_DEATH_CONSECUTIVE_READ_FAILURES = 3;

// R4f backstop (b): the absolute death-deadline. An acked task is held indefinitely until this much
// time has elapsed since its generating_started ack (dispatch.updatedAt); past it, a persistently
// idle session is synthesized as a notification-loss net. This is set FAR above any observed emit
// latency (R4e's worst case was ~16s) so it does NOT race a normal slow turn — it only catches a
// genuinely wedged worker or a permanently-lost emit. Read at call time so tests can tune it.
export function resolveTunedReconcileMs(envName: string, def: number, min: number, max: number): number {
    const raw = readNonEmptyString(process.env[envName]);
    if (raw) {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed >= min && parsed <= max) return parsed;
    }
    return def;
}
export function resolveAckedDeathDeadlineMs(): number {
    // Default 8 min — FAR above the variable emit latency the finite R4..R4e timers raced (R4e's
    // worst case was ~16s); by the time this fires a live worker would long since have emitted its
    // real terminal. The env-override floor is 0 so tests can force the deadline (production never
    // sets it that low); the ceiling is 60min so a mis-set env cannot disable the loss-net forever.
    return resolveTunedReconcileMs('MESH_INFLIGHT_ACKED_DEATH_DEADLINE_MS', 8 * 60_000, 0, 60 * 60_000);
}

// ACKED-HOLD-IDLE-OVERTRUST (transcript-completion fast-track). The indefinite acked-hold above is
// safe but SLOW: when the worker's real generating_completed emit is dropped/lost, the only thing
// that promotes the missing completion is the 8-min death backstop — even though the answer has been
// FULLY rendered in the transcript for minutes (read_chat reports idle WITH a final visible assistant
// message every ~4s). Observed live: completions surfaced 144s / 492s late, both incompatible with the
// provider's own emit ceiling (COMPLETED_FINALIZATION_MAX_WAIT_MS 30s + NATIVE_HISTORY_MESH_IDLE_SETTLE
// 4s ≈ 34s). That gap = a worker that finished, whose PTY generating→idle edge / real emit was lost,
// held hostage to the 8-min net.
//
// Fast-track: when an acked task reads idle AND a final visible assistant message is present (the same
// transcript-completion evidence PHASE 4 already requires to synth), and that idle-with-final-assistant
// state has PERSISTED for a short continuous grace, promote the synth EARLY — ahead of the 8-min
// backstop. The grace is the correctness gate: a SINGLE idle read could be a mid-turn blip (PTY
// inter-tool-call settle, or final text rendered while the next tool call is about to start), so we
// require the idle-with-final-assistant signal to hold continuously for the grace window before
// trusting it as a genuine turn-end. Any non-idle read (generating / waiting_approval), a read
// failure, or the disappearance of the final assistant message RESETS the streak — so an actively
// streaming worker that momentarily reads idle never crosses the grace.
//
// Safety: this only changes WHEN an acked synth fires (earlier), never WHETHER it is correct —
// reconcileDirectDispatchCompletionFromTranscript's hasTerminalLedgerAfterDispatch makes a real
// emit that lands later an idempotent no-op, exactly as the death-backstop synth relies on. The
// death backstop (8 min) is PRESERVED unchanged as the final net; the fast-track is a faster path in
// front of it. The grace is set ABOVE the provider's own emit ceiling (~34s) so a worker still inside
// its normal finalization window is never pre-empted — we only fast-track once enough continuous idle
// has elapsed that a live emit would already have arrived.
export function resolveAckedTranscriptFastTrackGraceMs(): number {
    // Default 40s — above the provider emit ceiling (30s COMPLETED_FINALIZATION_MAX_WAIT_MS + 4s
    // NATIVE_HISTORY_MESH_IDLE_SETTLE ≈ 34s): a genuinely-live worker would have emitted its real
    // terminal within that window, so 40s of CONTINUOUS idle-with-final-assistant means the emit was
    // lost, not late. Far below the 8-min death backstop, so the fast-track is the dominant path for a
    // lost emit while the backstop remains the last-resort net. Floor 0 lets tests force an immediate
    // fast-track; ceiling 5min keeps a mis-set env from collapsing it into the death backstop.
    return resolveTunedReconcileMs('MESH_INFLIGHT_ACKED_TRANSCRIPT_FASTTRACK_GRACE_MS', 40_000, 0, 5 * 60_000);
}

// ACKED-HOLD-TIME-CEILING (2026-08-21). The absolute wall-clock ceiling on how long an
// acked dispatch's synth hold may persist, measured from when the hold row was FIRST
// created (mesh_inflight_hold.held_at, preserved across every upsert and across daemon
// restarts).
//
// Why this exists even though the read-failure death signal now terminalizes the row:
// ACKED_DEATH_CONSECUTIVE_READ_FAILURES is a LOWER bound (>= 3), not an upper one, and it
// only fires on the read-FAILURE path — a hold that never accrues failures (or that never
// satisfies liveConfirmedSinceAck, or that wedges in any other gate that `continue`s while
// re-arming the hold) has no elapsed-time bound at all. The live incident measured
// read_failure_count = 20810 on a single hold row: 20,810 probes with no ceiling, because
// the counter only resets on a SUCCESSFUL read and a vanished session can never succeed.
// Fix 1 closes that one path; this closes the CLASS — every acked hold is finite.
//
// The value deliberately mirrors the queue-side sibling
// (QUEUE_HOLD_HARD_DEADLINE_MS = 90min, mesh-reconcile-stranded-dispatch.ts), but is a
// SEPARATE constant rather than a shared import, because the two bound different things:
// the queue ceiling bounds a row held 'assigned' (which also blocks the node from claiming
// anything else — a liveness problem for the whole node), while this bounds a synth hold on
// an already-dispatched row (which only delays that one task's terminal). Coupling them
// would mean a future tuning of one silently re-tunes the other across that boundary. 90min
// is the right STARTING value for the same reason it is there: comfortably above the
// longest realistic single worker turn and any genuine human approval wait, so it can never
// pre-empt a legitimately slow-but-alive worker — it only guarantees finiteness.
export function resolveAckedHoldHardCeilingMs(): number {
    // Floor 0 so tests can force the ceiling; ceiling 24h so a mis-set env cannot disable
    // the finiteness guarantee outright.
    return resolveTunedReconcileMs('MESH_INFLIGHT_ACKED_HOLD_HARD_CEILING_MS', 90 * 60_000, 0, 24 * 60 * 60_000);
}

// Per-task in-flight hold state for an acked dispatch:
//   - liveConfirmedSinceAck: we have seen at least one conclusive read (idle OR generating) since
//     the ack — proves the session is reachable, so a later read FAILURE is a genuine liveness loss
//     rather than a node that was never reachable.
//   - consecutiveReadFailures: streak of inconclusive read_chat results (death backstop (a)).
//   - transcriptIdleSinceMs: the timestamp of the FIRST tick in the current continuous run of
//     idle-with-final-assistant reads (ACKED-HOLD-IDLE-OVERTRUST fast-track). Cleared to undefined
//     whenever the signal breaks (non-idle read, read failure, or no final assistant message), so a
//     mid-turn idle blip never accumulates grace. When `now - transcriptIdleSinceMs` exceeds the
//     fast-track grace the synth is promoted ahead of the death backstop.
//   - heldSinceMs: wall-clock ms when this hold row was FIRST created (store `held_at`,
//     preserved across every upsert and across daemon restarts). The anchor for the
//     ACKED-HOLD-TIME-CEILING above. Never written by callers — setHoldState carries the
//     known value through so the store's insert-once semantics stay authoritative, and a
//     hold whose row predates this field simply reads undefined (no ceiling until the next
//     tick re-reads it, never a false ceiling breach).
export interface AckedHoldState {
    liveConfirmedSinceAck: boolean;
    consecutiveReadFailures: number;
    transcriptIdleSinceMs?: number;
    heldSinceMs?: number;
}

// T2 (B2b): acked-hold state persistence. The Map below is a process-local CACHE;
// the SSOT is the mesh_inflight_hold table in MeshRuntimeStore. Every read goes
// read-through (Map miss → load from store, then cache), every mutation goes
// write-through (Map set → store upsert; Map delete → store delete). On daemon
// boot the reconcile loop rehydrates the Map from the store per-mesh the first
// time it touches that mesh (rehydrateAckedHoldsForMesh), so a hold established
// before a restart survives it — closing the duplicate-emit / drop window the
// PHASE-4 transcript synth backstop otherwise had to correct after the fact.
//
// Store row ↔ AckedHoldState mapping:
//   hold_reason 'live'|'unconfirmed'  ↔ liveConfirmedSinceAck (boolean)
//   read_failure_count                ↔ consecutiveReadFailures
//   first_idle_since_ack              ↔ transcriptIdleSinceMs (undefined ⇒ NULL)
//   mesh_id                            = the owning mesh (for listByMesh / prune)
//   held_at                            = ms the hold was first created (store-managed)
export const inFlightAckedHoldState = new Map<string, AckedHoldState>();
// Meshes whose store rows have already been rehydrated into the Map this process.
// A restart resets this set, so the first touch of each mesh reloads from disk.
const rehydratedHoldMeshes = new Set<string>();

export function inFlightSynthKey(meshId: string, taskId: string): string {
    return `${meshId}::${taskId}`;
}

// Extract the taskId back out of a `${meshId}::${taskId}` synth key. The meshId
// prefix can itself contain '::' only if the caller passed one (mesh ids are
// config-derived and never do), so split on the FIRST '::' and treat the remainder
// as the taskId.
function taskIdFromSynthKey(meshId: string, synthKey: string): string {
    const prefix = `${meshId}::`;
    return synthKey.startsWith(prefix) ? synthKey.slice(prefix.length) : synthKey;
}

function holdStore(): MeshRuntimeStore | undefined {
    try { return MeshRuntimeStore.getInstance(); } catch { return undefined; }
}

// Read-through: Map hit returns the cached state; a miss consults the store and,
// when a row exists, hydrates the Map from it before returning. A store failure
// degrades to Map-only (returns undefined on a miss) — identical to the pre-T2
// in-memory behavior, never worse.
export function getHoldState(synthKey: string, meshId: string): AckedHoldState | undefined {
    const cached = inFlightAckedHoldState.get(synthKey);
    if (cached) return cached;
    const store = holdStore();
    if (!store) return undefined;
    let row;
    try { row = store.getInflightHold(taskIdFromSynthKey(meshId, synthKey)); } catch { return undefined; }
    if (!row) return undefined;
    const state: AckedHoldState = {
        liveConfirmedSinceAck: row.holdReason === 'live',
        consecutiveReadFailures: row.readFailureCount ?? 0,
        ...(row.firstIdleSinceAck !== null && row.firstIdleSinceAck !== undefined
            ? { transcriptIdleSinceMs: row.firstIdleSinceAck }
            : {}),
        ...(row.heldAt !== null && row.heldAt !== undefined ? { heldSinceMs: row.heldAt } : {}),
    };
    inFlightAckedHoldState.set(synthKey, state);
    return state;
}

// Write-through: update the Map cache AND the store row. A store failure leaves the
// Map authoritative for this process (degrade, never crash the tick).
export function setHoldState(synthKey: string, meshId: string, state: AckedHoldState): void {
    // ACKED-HOLD-TIME-CEILING: heldSinceMs is insert-once, not caller-owned. Callers build
    // the state from the fields they manage and do NOT carry it, so re-derive it here —
    // from the incoming state, else the cached entry, else (first write of this process for
    // a row that already exists on disk) `now`, matching the store's own default. Without
    // this the Map entry would drop the anchor on every tick and the ceiling could never
    // accrue: the hold would look freshly created forever — the exact unbounded shape this
    // whole change exists to remove.
    const store = holdStore();
    let priorHeldSinceMs = state.heldSinceMs ?? inFlightAckedHoldState.get(synthKey)?.heldSinceMs;
    if (priorHeldSinceMs === undefined && store) {
        // Map is cold but a row may already exist on disk (first write of this process, or
        // post-restart before rehydration). Take the persisted anchor so the ceiling keeps
        // accruing across restarts instead of resetting to `now` on every boot — a hold that
        // resets its own clock is unbounded again by another name.
        try { priorHeldSinceMs = store.getInflightHold(taskIdFromSynthKey(meshId, synthKey))?.heldAt ?? undefined; } catch { /* degrade */ }
    }
    const heldSinceMs = priorHeldSinceMs ?? Date.now();
    inFlightAckedHoldState.set(synthKey, { ...state, heldSinceMs });
    if (!store) return;
    try {
        store.upsertInflightHold({
            taskId: taskIdFromSynthKey(meshId, synthKey),
            meshId,
            holdReason: state.liveConfirmedSinceAck ? 'live' : 'unconfirmed',
            // Only meaningful when the row is NEW — upsertInflightHold deliberately
            // preserves held_at on conflict, so an existing row keeps its original anchor.
            heldAt: heldSinceMs,
            firstIdleSinceAck: state.transcriptIdleSinceMs ?? null,
            readFailureCount: state.consecutiveReadFailures,
        });
    } catch { /* degrade to Map-only */ }
}

// Write-through delete: drop the Map entry AND the store row.
export function deleteHoldState(synthKey: string, meshId: string): void {
    inFlightAckedHoldState.delete(synthKey);
    const store = holdStore();
    if (!store) return;
    try { store.deleteInflightHold(taskIdFromSynthKey(meshId, synthKey)); } catch { /* degrade */ }
}

// Restart rehydration: on the first touch of a mesh this process, pull its persisted
// acked-hold rows from the store into the Map cache so a hold that outlived a daemon
// restart is honored again. Idempotent per process via rehydratedHoldMeshes. A store
// failure just skips rehydration (Map starts empty for the mesh — pre-T2 behavior).
export function rehydrateAckedHoldsForMesh(meshId: string): void {
    if (rehydratedHoldMeshes.has(meshId)) return;
    rehydratedHoldMeshes.add(meshId);
    const store = holdStore();
    if (!store) return;
    let rows;
    try { rows = store.listInflightHoldsByMesh(meshId); } catch { return; }
    for (const row of rows) {
        const synthKey = inFlightSynthKey(meshId, row.taskId);
        if (inFlightAckedHoldState.has(synthKey)) continue; // a live tick already set fresher state
        inFlightAckedHoldState.set(synthKey, {
            liveConfirmedSinceAck: row.holdReason === 'live',
            consecutiveReadFailures: row.readFailureCount ?? 0,
            ...(row.firstIdleSinceAck !== null && row.firstIdleSinceAck !== undefined
                ? { transcriptIdleSinceMs: row.firstIdleSinceAck }
                : {}),
            ...(row.heldAt !== null && row.heldAt !== undefined ? { heldSinceMs: row.heldAt } : {}),
        });
    }
    if (rows.length > 0) {
        LOG.info('MeshReconcile', `Rehydrated ${rows.length} persisted acked-hold row(s) for mesh ${meshId} after (re)start`);
    }
}

// Collect the union of held synth keys for a mesh — the Map cache entries plus every
// persisted store row — so the PHASE-4 prune can drop a hold that exists ONLY on disk
// (not yet cached). A store failure degrades to the Map-only key set (never throws).
export function collectHeldSynthKeysForMesh(meshId: string): Set<string> {
    const heldKeys = new Set<string>();
    for (const key of inFlightAckedHoldState.keys()) {
        if (key.startsWith(`${meshId}::`)) heldKeys.add(key);
    }
    const store = holdStore();
    if (store) {
        try {
            for (const row of store.listInflightHoldsByMesh(meshId)) {
                heldKeys.add(inFlightSynthKey(meshId, row.taskId));
            }
        } catch { /* degrade — prune only what's in the Map */ }
    }
    return heldKeys;
}

// Test hook: clear the in-flight acked-hold state between cases (both the Map cache
// and the per-mesh rehydrate guard, so each case starts from a clean read-through).
export function __resetReconcileInFlightSynthDebounceForTests(): void {
    inFlightAckedHoldState.clear();
    rehydratedHoldMeshes.clear();
}
