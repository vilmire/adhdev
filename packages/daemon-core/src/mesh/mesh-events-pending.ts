import { randomUUID } from 'crypto';
import { LOG } from '../logging/logger.js';
import { loadConfig } from '../config/config.js';
import { getLedgerDir, readLedgerEntries, readLedgerEntriesByKind, appendLedgerEntry } from './mesh-ledger.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { resolveTurnAttemptRow } from './mesh-turn-presentation.js';
import { buildMeshSystemMessage, readNonEmptyString, readRecord, resolveEventSessionId, readMeshCompletionSummary, isWeakCompletionMetadata } from './mesh-events-utils.js';
import { traceMeshEventDrop } from './mesh-event-trace.js';
import { MESH_FORCE_INJECT_EVENTS } from './mesh-event-classify.js';
import { daemonIdsEquivalent, expandDaemonIdForms } from '@adhdev/mesh-shared';
import {
    assertPendingMeshCoordinatorEventV2,
    buildPendingEventEmitStamp,
    coordinatorIdentityEquals,
    coordinatorIdentityFromEmitFields,
    coordinatorIdentityKey,
    isMeshEventScope,
    isTerminalTaskEvent,
    MESH_PROTOCOL_VERSION_V2,
    shouldDeliverPendingEventToCoordinator,
    type CoordinatorIdentity,
    type MeshEventScope,
    type PendingMeshCoordinatorEventV2,
} from './contracts.js';

// ---------------------------------------------------------------------------
// MCP coordinator pending-event queue — SQLite (mesh_pending_events)
// ---------------------------------------------------------------------------
// When a mesh event fires but no CLI coordinator session is registered (e.g.
// the coordinator is Claude Code running via MCP), we persist the event to the
// SQLite inbox so it survives daemon restarts. It is drained on each
// get_pending_mesh_events call and bounded by
// prunePendingMeshCoordinatorEventsRetention (drained >7d / undrained >30d).
//
// This queue used to ALSO mirror every event into a per-mesh
// `<ledgerDir>/<meshId>.pending-events.jsonl` and drain both stores on every
// call. That mirror is gone. It bought one thing — a degraded mode where events
// kept flowing if better-sqlite3 failed to load — and cost split-brain drains:
// the two stores were emptied non-transactionally, so a SQLite drain failure
// still let the JSONL half deliver while the SQLite rows stayed undrained, and
// the next tick re-delivered them (duplicate refine:completed). With one store
// a drain failure means nothing drained: no half-drain, no duplicate delivery.
//
// The cost of losing that degraded mode is real and deliberate: if the store is
// unavailable there is no fallback, so a persist failure now means the event is
// NOT queued at all. Every store failure on the write path is therefore logged
// loudly rather than swallowed — see persistPendingMeshCoordinatorEvent.
//
// Legacy JSONL files on machines upgrading past this cut are drained into SQLite
// once at boot by mesh-events-pending-migration.ts. Nothing else reads them.
// ---------------------------------------------------------------------------

export interface PendingMeshCoordinatorEvent {
    event: string;
    meshId: string;
    nodeLabel: string;
    nodeId?: string;
    workspace?: string;
    metadataEvent: Record<string, unknown>;
    coordinatorMessage?: string;
    queuedAt: number;
    /**
     * When set, this event is intended for a specific coordinator daemon.
     * Coordinators on other daemons should ignore it during drain.
     * Absent on legacy events — treated as broadcast to any coordinator.
     */
    targetCoordinatorDaemonId?: string;
    /**
     * When set, this event is intended for a specific coordinator SESSION on the
     * target daemon (the session that originally dispatched the work). PHASE 2 inject
     * strict-matches the live coordinator by this session id so a sibling coordinator
     * session on the same daemon does not receive another coordinator's completion.
     * Absent on legacy / version-skewed events → daemon-level broadcast (no regression).
     * Rides inside the event payload, so it survives the SQLite payload round-trip and
     * the JSONL file without a dedicated column; it is NOT a drain-scoping key.
     */
    targetCoordinatorSessionId?: string;

    // ─── v2 protocol envelope (B2a) — additive, populated at emit time ────────
    // Stamped by queuePendingMeshCoordinatorEvent from the fields above plus an
    // optional emit hint. A v1 reader that ignores these is unaffected (the v2
    // shape is a strict superset). Absent → the event is a v1 event, treated as
    // broadcast during rollout.
    /** '2.0' once stamped. Absent on v1 events. */
    protocolVersion?: typeof MESH_PROTOCOL_VERSION_V2;
    /** Idempotency key (UUID). The receiver's authoritative dedup key (B3). */
    eventId?: string;
    /** Routing scope. Defaulted from the event name unless the emit hint overrides. */
    scope?: MeshEventScope;
    /** Identity of the coordinator that dispatched the work this event reports. */
    dispatchedBy?: CoordinatorIdentity;
    /** Present only for unicast scope: the coordinator this event is addressed to. */
    intendedFor?: CoordinatorIdentity;
    /**
     * True when this event was stamped as a broadcast SOLELY because no owning
     * coordinator identity was resolvable at emit time (self-fallback: dispatchedBy
     * is THIS daemon's own machineId, not a real coordinator). Such a broadcast has
     * no owner, so the MAGI-REPLICA-COMPLETION-EVENT-LEAK guard — which only exists
     * to stop a NON-owner coordinator from consuming an OWNED terminal event — must
     * not apply: an ownerless terminal broadcast is a genuine "deliver to any
     * coordinator that drains on this machine" event and identity-matching its
     * self-id dispatchedBy against the drainer would wrongly route it away.
     * Absent (undefined/false) on a normally-owned event → the leak guard applies.
     */
    dispatchedBySelfFallback?: boolean;

    // ─── Stage 6 turn-projection annotation (peek-time, additive) ────────────
    // Stamped by getPendingMeshCoordinatorEvents from the current attempt row so
    // pending-event surfaces can label the event from the authoritative causal
    // stage instead of re-deriving status. Never written to the durable queue.
    attemptId?: string;
    turnStage?: string;
    terminalOutcome?: string;
}

/**
 * Optional emit-time hint passed to queuePendingMeshCoordinatorEvent so a call
 * site can override the name-defaulted scope or supply richer coordinator
 * identity (e.g. a coordinatorRunId the base event fields don't carry). Every
 * field is optional; when omitted the stamp is derived entirely from the
 * event's own targetCoordinatorDaemonId / targetCoordinatorSessionId. Kept
 * separate from the event so existing single-arg callers are untouched.
 */
export interface PendingEventEmitHint {
    scope?: MeshEventScope;
    /** Overrides the coordinator identity derived from the event's target fields. */
    dispatchedBy?: CoordinatorIdentity;
    /** Overrides the unicast target derived from the event's target fields. */
    intendedFor?: CoordinatorIdentity;
    /** coordinatorRunId to fold into the derived identity when the event lacks one. */
    coordinatorRunId?: string;
}

const REFINE_TERMINAL_EVENTS = new Set(['refine:completed', 'refine:failed']);

/** Normalise a coordinator-daemon-id argument (single id, list, or undefined) into a
 *  de-duplicated list of non-empty strings, EXPANDED to every equivalent daemon-id
 *  form (bare `mach_X` ≡ `daemon_mach_X` ≡ `standalone_mach_X`).
 *
 *  A coordinator resolves its own id through one path (status instanceId, the config-
 *  form node daemonId, or the bare machineId) but a worker stamps a completion's
 *  `coordinator_daemon_id` through another, so the two are routinely in DIFFERENT
 *  forms of the SAME machine. The scope filter is an exact-string match, so without
 *  expansion a `daemon_mach_X`-scoped completion is silently skipped by a coordinator
 *  that only knows itself as bare `mach_X` (the base-node completion-surface bug).
 *  Expanding here fixes every drain/peek/surface caller uniformly. The first ORIGINAL
 *  id stays at [0] so the per-daemon scope filter keeps its primary; expansion stays
 *  within one machine core so a different coordinator's events are never claimed. */
function normalizeCoordinatorDaemonIds(
    coordinatorDaemonId?: string | null | ReadonlyArray<string>,
): string[] {
    return expandDaemonIdForms(coordinatorDaemonId);
}

// ─── B3a: drain-side v2 routing (accept-and-warn) ────────────────────────────
//
// Stage-1 of the v2 receive path. The drain scope is still primarily gated by the
// SQLite `coordinator_daemon_id` filter (v1 mechanism, untouched here), so
// this layer runs on top of an already daemon-scoped candidate set and adds:
//
//   1. v2 unicast routing — an event whose intendedFor addresses a DIFFERENT
//      coordinator on THIS daemon (a sibling CLI/MCP session) is skipped, so a
//      completion doesn't cross-surface. Broadcast/system-as-broadcast pass.
//   2. eventId idempotency — a v2 event whose eventId was already drained is
//      skipped (durable, via MeshRuntimeStore.hasDrainedEventId) plus a per-drain
//      batch guard against same-batch duplicates.
//   3. accept-and-warn — a v2 event that FAILS validation, or has NO version, is
//      NOT dropped: it passes through (no v1 regression) with a one-shot WARN and
//      a counter bump. Hard rejection is T6 (enforce mode), not here.
//   4. re-attribution fallback — a unicast event whose intendedFor does not match
//      the drainer by identity is NOT dropped when its intendedFor.daemonId is the
//      SAME machine as the drainer (a coordinatorRunId change from a restart
//      orphaned it): it is delivered to the current coordinator on that daemon.

/**
 * T6 (B3c) enforce switch. When ON, the drain path stops passing an unversioned
 * (v1) or a validation-failing v2 event through to the coordinator — it QUARANTINES
 * it instead (excluded from the delivered batch + WARN + counter), and unicast
 * routing is the only delivery path (there is no v1 broadcast fallback). On by
 * default; set MESH_PROTOCOL_V2_ENFORCE=0/false/off/no to disable and restore the
 * accept-and-warn rollout behaviour exactly.
 *
 * Per the rollout plan (§1 decision 4): enforce is `MESH_PROTOCOL_V2_ENFORCE` (env).
 * Now that every node emits v2 (§배포 게이트 1 / risk §4), the code default is ON —
 * a manual env injection is no longer required to get enforce behaviour. Rollback to
 * accept mode is a pure-env step: set `MESH_PROTOCOL_V2_ENFORCE=0` (or `false`/`off`/
 * `no`) — no code change, no data migration (the schema is additive). Read at call
 * time so a test / operator can toggle it without a restart.
 *
 * Quarantine (not drop) keeps the loss-free invariant. The DESTRUCTIVE drain has
 * already consumed the event from its store by the time routing runs, so "held
 * back" here means: excluded from the delivered batch AND mirrored into the mesh
 * ledger as a recoverable `event_held` entry (the same recovery channel the
 * pending-trim path uses). It is observable via the counters + the ledger, so an
 * operator can requeue it after fixing the producer. The non-destructive PEEK path
 * (countMetrics=false) merely omits the event from the returned list — it never
 * consumed it and must not ledger-record on every status poll.
 */
export function isMeshProtocolV2EnforceEnabled(): boolean {
    const raw = readNonEmptyString(process.env.MESH_PROTOCOL_V2_ENFORCE);
    if (!raw) return true;                      // unset/blank = default ON
    const v = raw.trim().toLowerCase();
    return !(v === '0' || v === 'false' || v === 'off' || v === 'no');  // only explicit off = false
}

/**
 * Record a v2-enforce-quarantined event into the mesh ledger as recoverable, so a
 * destructively-drained event held back by enforce is auditable and requeue-able
 * (loss-free invariant). Mirrors the pending-trim `event_held` shape. Best-effort:
 * a ledger write failure must not break the drain. Called ONLY on the destructive
 * drain path (the peek path never consumed the event, so nothing to recover).
 */
function ledgerRecordQuarantinedEvent(event: PendingMeshCoordinatorEvent, reason: string): void {
    try {
        const finalSummary = readMeshCompletionSummary(event.metadataEvent || {});
        appendLedgerEntry(event.meshId, {
            kind: 'event_held',
            ...(event.nodeId ? { nodeId: event.nodeId } : {}),
            payload: {
                event: event.event,
                reason,
                recoverable: true,
                nodeLabel: event.nodeLabel,
                ...(event.workspace ? { workspace: event.workspace } : {}),
                targetCoordinatorDaemonId: event.targetCoordinatorDaemonId ?? null,
                ...(readNonEmptyString(event.eventId) ? { eventId: event.eventId } : {}),
                queuedAt: event.queuedAt,
                ...(finalSummary ? { finalSummary } : {}),
                // Full original event so mesh_requeue_held_events can restore it
                // losslessly (event_held→pending). The summary/label fields above stay
                // for human-readable audit; `heldEvent` is the machine recovery copy.
                heldEvent: event,
            },
        });
    } catch (e: any) {
        LOG.warn('MeshEventsV2', `Failed to ledger-record v2-quarantined ${event.event} for mesh ${event.meshId}: ${e?.message || e}`);
    }
}

/** Observability counters for the v2 drain path. Read by tests and surfaced in
 *  mesh_status (B4/T6). Process-lifetime totals — never reset in production. */
const meshV2DrainCounters = {
    /** v2 events that passed validation and unicast/broadcast routing → delivered. */
    v2Delivered: 0,
    /** v2 unicast events skipped because intendedFor addressed another coordinator. */
    v2RoutedAway: 0,
    /** v2 events skipped because their eventId was already drained (idempotency). */
    v2DedupSkipped: 0,
    /** v2 events that failed assertPendingMeshCoordinatorEventV2 but were PASSED
     *  THROUGH (accept mode). Non-zero here is the rollout signal that a producer
     *  emits a malformed envelope. */
    v2ValidationFailedAccepted: 0,
    /** unicast events re-attributed to the drainer via daemon-core match (a
     *  coordinatorRunId change orphaned them). */
    v2ReattributedToDrainer: 0,
    /** REFINE-EVENT-SESSION-SCOPED-UNICAST: unicast events delivered while addressed only
     *  at DAEMON granularity (no sessionId in intendedFor) even though >1 coordinator
     *  session was live on that daemon — i.e. delivered by race, not by address. Non-zero
     *  here names an emit path that still fails to stamp targetCoordinatorSessionId. */
    v2AmbiguousUnicastDelivered: 0,
    /** v1 (unversioned) events passed through as broadcast (rollout baseline). */
    v1BroadcastAccepted: 0,
    /** T6 enforce: v2 events that FAILED validation and were QUARANTINED (held back
     *  from delivery, not dropped). Non-zero here means a producer is still emitting a
     *  malformed envelope after enforce was turned on. */
    v2ValidationFailedQuarantined: 0,
    /** T6 enforce: v1 (unversioned) events QUARANTINED because no v2 envelope could be
     *  derived at emit time. Non-zero here means a producer path still emits v1 after
     *  enforce — it should reach 0 once every node is on a v2-stamping build. */
    v1UnversionedQuarantined: 0,
};

/** Test/observability accessor for the v2 drain counters (snapshot copy). */
export function getMeshV2DrainCounters(): Readonly<typeof meshV2DrainCounters> {
    return { ...meshV2DrainCounters };
}

/** Test helper: zero the v2 drain counters so a test starts from a clean slate. */
export function __resetMeshV2DrainCountersForTests(): void {
    for (const k of Object.keys(meshV2DrainCounters) as Array<keyof typeof meshV2DrainCounters>) {
        meshV2DrainCounters[k] = 0;
    }
}

// One-shot WARN dedup: an accept-mode warning is logged once per (meshId, eventId)
// so a re-polled malformed event doesn't spam the log every 4s reconcile tick.
const warnedV2Violations = new Set<string>();
function warnV2Once(key: string, message: string): void {
    if (warnedV2Violations.has(key)) return;
    warnedV2Violations.add(key);
    // Bound the set so a long-lived daemon churning many distinct eventIds can't leak.
    if (warnedV2Violations.size > 2000) {
        const first = warnedV2Violations.values().next().value;
        if (first !== undefined) warnedV2Violations.delete(first);
    }
    LOG.warn('MeshEventsV2', message);
}

/** Test helper: clear the one-shot WARN dedup set. */
export function __resetMeshV2WarnDedupForTests(): void {
    warnedV2Violations.clear();
}

// Log-once guard for the SQLite pending-event drain failure. When better-sqlite3 is
// unavailable (native load failure on a clean npx install with no build tools), the
// SQLite drain throws every drain call — once per mesh, every reconcile tick (~4s) —
// and, with the JSONL mirror retired, NO events can be delivered while it is down.
// The operator only needs to be told ONCE that SQLite is down; repeating the WARN
// every cycle floods the logs (mirrors MeshRuntimeStore's
// loggedGetInstanceFailure guard). New/different drain errors still surface: the
// guard keys on nothing beyond "already warned", but the first occurrence is always
// shown at WARN and every occurrence stays at debug.
let loggedSqlitePendingDrainFailure = false;

/** Test helper: reset the one-shot SQLite-drain-failure WARN guard. */
export function __resetSqlitePendingDrainWarnForTests(): void {
    loggedSqlitePendingDrainFailure = false;
}

/**
 * Resolve the drainer's CoordinatorIdentity for v2 routing from the daemon-id
 * argument the (untouchable) reconcile-loop already passes. The daemon ids are the
 * dual/expanded self-identity forms from resolveCoordinatorDaemonIds; the FIRST is
 * the primary. coordinatorRunId is not threaded through the drain call yet, so it
 * falls back to the daemonId exactly as the emit side does
 * (coordinatorIdentityFromEmitFields) — this keeps drain-side identity CONSISTENT
 * with how v1→v2 events were stamped, and unicast equality then reduces to the
 * daemon-core match, which is the correct rollout-window granularity. A caller that
 * knows the full identity (with a real coordinatorRunId) may pass it explicitly to
 * override. Returns undefined when no daemon id is known (→ v2 routing is a no-op,
 * everything passes as-is).
 */
function resolveDrainerIdentity(
    daemonIds: ReadonlyArray<string>,
    explicit?: CoordinatorIdentity,
): CoordinatorIdentity | undefined {
    if (explicit) return explicit;
    return coordinatorIdentityFromEmitFields({ daemonId: daemonIds[0] });
}

/** A v2 event carries a '2.0' protocolVersion. Everything else is a v1 event. */
function isV2Event(event: PendingMeshCoordinatorEvent): boolean {
    return event.protocolVersion === MESH_PROTOCOL_VERSION_V2;
}

/**
 * True when an identity's coordinatorRunId is merely its own daemonId form (the
 * B2a fallback in coordinatorIdentityFromEmitFields — no real coordinatorRunId was
 * threaded through the emit/drain site yet). For such an identity the runId carries
 * NO information beyond the daemon, so two different daemon-id FORMS of the same
 * machine (mach_ vs daemon_mach_) must not be treated as different coordinators.
 */
function runIdIsDaemonFormFallback(identity: CoordinatorIdentity): boolean {
    return daemonIdsEquivalent(identity.coordinatorRunId, identity.daemonId);
}

/**
 * Delivery equality for the rollout window. When BOTH sides carry only a
 * daemon-form-fallback runId (no real coordinatorRunId wired yet), a match reduces
 * to same-machine — so a completion stamped `daemon_mach_X` is delivered to a
 * coordinator that knows itself as bare `mach_X` (the canon-identity heterogeneous-
 * form case). The session is compared ONLY when BOTH sides carry one: a session-less
 * drainer is a daemon-level drain (what the reconcile loop passes) that accepts any
 * session's events on that machine — targetCoordinatorSessionId is a PHASE-2 inject
 * key, not a drain-scoping key (see the v1 field comment). When only the drainer AND
 * the event both name a session do we require them to match, so a session-specific
 * coordinator does not receive a sibling session's unicast event.
 *
 * When EITHER side has a real (non-daemon-form) runId, fall back to strict
 * coordinatorIdentityEquals so two genuinely distinct coordinators on the same
 * daemon (different real runIds) stay separated.
 */
function identityDeliversTo(intendedFor: CoordinatorIdentity, drainer: CoordinatorIdentity): boolean {
    if (runIdIsDaemonFormFallback(intendedFor) && runIdIsDaemonFormFallback(drainer)) {
        if (!daemonIdsEquivalent(intendedFor.daemonId, drainer.daemonId)) return false;
        // Session filter applies only when the drainer itself is session-specific.
        if (intendedFor.sessionId && drainer.sessionId) {
            return intendedFor.sessionId === drainer.sessionId;
        }
        return true;
    }
    return coordinatorIdentityEquals(intendedFor, drainer);
}

/**
 * Apply v2 receive-side routing + idempotency to a merged, already daemon-scoped
 * candidate list (accept-and-warn — never drops on validation failure).
 *
 * - `drainer` undefined → routing is skipped, list returned unchanged (safety).
 * - Marks each surviving v2 event's eventId in `batchSeen` so a same-batch dup is
 *   skipped; a caller that persists drains uses `alreadyDrained` for the durable
 *   check (getPending peek passes a no-op so a peek never dedups against itself).
 */
function routeV2EventsForDrainer(
    events: PendingMeshCoordinatorEvent[],
    drainer: CoordinatorIdentity | undefined,
    ctx: {
        alreadyDrained: (eventId: string) => boolean;
        batchSeen: Set<string>;
        /** false for a non-destructive peek so the frequent status-poll path does
         *  not inflate the delivery counters (only the real drain counts). */
        countMetrics: boolean;
        /** REFINE-EVENT-SESSION-SCOPED-UNICAST ambiguity guard: how many coordinator
         *  sessions are currently live on a daemon. Optional — when absent the guard is
         *  inert (treated as 0) and routing behaviour is completely unchanged. */
        countLiveCoordinatorSessions?: (daemonId: string) => number;
    },
): PendingMeshCoordinatorEvent[] {
    if (!drainer) return events;
    // Read the enforce flag ONCE per drain so the whole batch is classified under a
    // single, consistent policy (a mid-batch env flip cannot split one drain).
    const enforce = isMeshProtocolV2EnforceEnabled();
    const bump = (k: keyof typeof meshV2DrainCounters) => { if (ctx.countMetrics) meshV2DrainCounters[k]++; };
    const kept: PendingMeshCoordinatorEvent[] = [];
    for (const event of events) {
        if (!isV2Event(event)) {
            // v1 / unversioned event. ACCEPT MODE: broadcast during rollout (existing
            // policy). ENFORCE MODE: quarantine — an unversioned event has no scope, so
            // there is no safe unicast target; hold it back (not delivered) and mirror
            // it to the ledger as recoverable, with a one-shot WARN + counter.
            if (enforce) {
                bump('v1UnversionedQuarantined');
                if (ctx.countMetrics) ledgerRecordQuarantinedEvent(event, 'v2_enforce_unversioned_quarantined');
                warnV2Once(
                    `${event.meshId}::${event.eventId ?? event.event}::v1-quarantined`,
                    `v2 ENFORCE: unversioned ${event.event} on mesh ${event.meshId} QUARANTINED (no v2 envelope — held back, not delivered; ledger-recorded recoverable). A producer path still emits v1.`,
                );
                continue;
            }
            bump('v1BroadcastAccepted');
            kept.push(event);
            continue;
        }

        // Validate the v2 envelope. ACCEPT MODE: a validation failure does NOT drop
        // the event — it passes through with a one-shot WARN + counter. ENFORCE MODE:
        // a validation failure is QUARANTINED (held back, not delivered) — the malformed
        // envelope carries no trustworthy scope/target, so delivering it risks a
        // cross-surface. It is ledger-recorded recoverable on the destructive path.
        let validated: PendingMeshCoordinatorEventV2;
        try {
            validated = assertPendingMeshCoordinatorEventV2(event);
        } catch (e: any) {
            if (enforce) {
                bump('v2ValidationFailedQuarantined');
                if (ctx.countMetrics) ledgerRecordQuarantinedEvent(event, 'v2_enforce_validation_failed_quarantined');
                warnV2Once(
                    `${event.meshId}::${event.eventId ?? event.event}::invalid-quarantined`,
                    `v2 ENFORCE: envelope validation failed for ${event.event} on mesh ${event.meshId} — QUARANTINED (held back, not delivered; ledger-recorded recoverable): ${e?.message || e}`,
                );
                continue;
            }
            bump('v2ValidationFailedAccepted');
            warnV2Once(
                `${event.meshId}::${event.eventId ?? event.event}::invalid`,
                `v2 envelope validation failed for ${event.event} on mesh ${event.meshId} — PASSED THROUGH (accept mode): ${e?.message || e}`,
            );
            kept.push(event);
            continue;
        }

        // eventId idempotency: skip if already drained (durable) or already seen in
        // this same batch (a batch can still repeat an eventId across reconcile
        // sources, so the in-batch guard stays even with a single store).
        const eventId = validated.eventId;
        if (ctx.batchSeen.has(eventId) || ctx.alreadyDrained(eventId)) {
            bump('v2DedupSkipped');
            continue;
        }

        // Broadcast → any coordinator; system → daemon handler only (never a
        // coordinator). Delegates to the contract helper for those two scopes.
        if (validated.scope !== 'unicast') {
            // Defense-in-depth (MAGI-REPLICA-COMPLETION-EVENT-LEAK): a TERMINAL task
            // event that reached the queue as broadcast is an ownership leak — a
            // completion/stop belongs to the coordinator that dispatched the task, so
            // a sibling coordinator that never dispatched it must NOT act on it. The
            // emit-side stamp now narrows unaddressed terminal events to unicast, but a
            // legacy/version-skewed/other-path broadcast can still arrive here; filter
            // it by dispatchedBy vs the drainer using the SAME daemon-form/session
            // matching semantics as unicast (identityDeliversTo), so the true owner —
            // possibly addressed under a different daemon-id form — still receives it.
            if (validated.scope === 'broadcast' && isTerminalTaskEvent(validated.event)) {
                // An ownerless self-fallback broadcast (dispatchedBy is this daemon's
                // own machineId because no coordinator identity existed at emit) has no
                // coordinator owner — but it must still stay on ITS machine: a replica
                // completion emitted on machine A must never fan out to a coordinator on
                // machine B (the MAGI-REPLICA leak). So for a self-fallback event, match
                // at the MACHINE (daemonId) level — deliver iff the drainer is on the
                // same machine as the self-dispatcher — instead of the full
                // identityDeliversTo (which also compares runId/session and would route
                // the event away from a same-machine coordinator whose id form differs,
                // the exact symptom for refine:* / agent:generating_completed reaching a
                // stdio MCP coordinator). Non-self-fallback broadcasts keep the strict
                // owner check.
                const deliverSelfFallback = event.dispatchedBySelfFallback
                    && daemonIdsEquivalent(validated.dispatchedBy.daemonId, drainer.daemonId);
                if (deliverSelfFallback || identityDeliversTo(validated.dispatchedBy, drainer)) {
                    ctx.batchSeen.add(eventId);
                    bump('v2Delivered');
                    kept.push(event);
                } else {
                    bump('v2RoutedAway');
                }
                continue;
            }
            if (shouldDeliverPendingEventToCoordinator(validated, drainer)) {
                ctx.batchSeen.add(eventId);
                bump('v2Delivered');
                kept.push(event);
            } else {
                // system scope → not for any coordinator.
                bump('v2RoutedAway');
            }
            continue;
        }

        // AMBIGUOUS-UNICAST guard (REFINE-EVENT-SESSION-SCOPED-UNICAST): a unicast event
        // whose intendedFor names NO session is addressable only at daemon granularity.
        // When more than one coordinator session is live on that daemon, whichever one
        // polls first wins — a silent race that produced exactly this defect (a refine
        // result consumed by a sibling coordinator). Delivery is UNCHANGED (holding the
        // event back would risk stranding it forever, which is strictly worse than
        // mis-attribution); the race is merely made observable so the emitting path can
        // be found and fixed. One-shot per event so a re-peeled event cannot spam.
        if (
            validated.intendedFor
            && !validated.intendedFor.sessionId
            && daemonIdsEquivalent(validated.intendedFor.daemonId, drainer.daemonId)
        ) {
            const liveSessions = ctx.countLiveCoordinatorSessions?.(validated.intendedFor.daemonId) ?? 0;
            if (liveSessions > 1) {
                warnV2Once(
                    `${event.meshId}::${eventId}::ambiguous-unicast`,
                    `v2 unicast ${event.event} on mesh ${event.meshId} carries NO coordinator session but ${liveSessions} coordinator sessions are live on ${validated.intendedFor.daemonId} — delivery is first-come-first-served and may reach the wrong coordinator. Delivered to ${coordinatorIdentityKey(drainer)}. The EMITTING path must stamp targetCoordinatorSessionId.`,
                );
                bump('v2AmbiguousUnicastDelivered');
            }
        }

        // Unicast: deliver iff intendedFor addresses THIS drainer. identityDeliversTo
        // treats a daemon-form-fallback runId (no real coordinatorRunId wired yet) as
        // form-agnostic so a `daemon_mach_X`-addressed event reaches a bare-`mach_X`
        // drainer (heterogeneous-form same coordinator), while keeping two REAL
        // distinct runIds on one daemon separated.
        if (validated.intendedFor && identityDeliversTo(validated.intendedFor, drainer)) {
            ctx.batchSeen.add(eventId);
            bump('v2Delivered');
            LOG.debug('MeshEventsV2', `unicast ${event.event} (mesh ${event.meshId}, eventId ${eventId}) delivered to ${coordinatorIdentityKey(drainer)}; intendedFor=${coordinatorIdentityKey(validated.intendedFor)}`);
            kept.push(event);
            continue;
        }

        // Not delivered by identity. Apply the re-attribution fallback (plan risk
        // §4): if intendedFor addresses the SAME MACHINE as the drainer AND the
        // mismatch is a genuine coordinatorRunId change (a restart minted a fresh
        // runId), deliver it to the current coordinator rather than orphaning it.
        //
        // Guard: when BOTH sides carry only a daemon-form-fallback runId, a mismatch
        // that survived identityDeliversTo is a SESSION mismatch (a sibling
        // coordinator on the same daemon) — that is a legitimate route-away, NOT an
        // orphaned event, so re-attribution must not fire. Re-attribution requires a
        // REAL runId difference, which means at least one side carries a real runId.
        const realRunIdMismatch = !runIdIsDaemonFormFallback(validated.intendedFor!)
            || !runIdIsDaemonFormFallback(drainer);
        if (
            validated.intendedFor
            && realRunIdMismatch
            && daemonIdsEquivalent(validated.intendedFor.daemonId, drainer.daemonId)
        ) {
            ctx.batchSeen.add(eventId);
            bump('v2ReattributedToDrainer');
            warnV2Once(
                `${event.meshId}::${eventId}::reattributed`,
                `v2 unicast ${event.event} on mesh ${event.meshId} re-attributed to current coordinator ${coordinatorIdentityKey(drainer)} (originating coordinatorRunId no longer live)`,
            );
            kept.push(event);
            continue;
        }

        // Addressed to a genuinely different coordinator (different machine, or
        // system scope) → not for this drainer. Skipped (left for its own drainer).
        LOG.debug('MeshEventsV2', `unicast ${event.event} (mesh ${event.meshId}, eventId ${eventId}) NOT delivered to ${coordinatorIdentityKey(drainer)}; intendedFor=${validated.intendedFor ? coordinatorIdentityKey(validated.intendedFor) : 'none'} — left for its own drainer`);
        bump('v2RoutedAway');
    }
    return kept;
}

export function readRefineJobId(event: { metadataEvent?: Record<string, unknown> } | Record<string, unknown>): string {
    const metadata = readRecord((event as any).metadataEvent) || event as Record<string, unknown>;
    const result = readRecord(metadata.result);
    const refineJob = readRecord(result?.refineJob);
    return readNonEmptyString(metadata.jobId) || readNonEmptyString(refineJob?.jobId);
}

function buildRefineTerminalEventFingerprint(meshId: string, eventName: string, metadataEvent: Record<string, unknown>): string {
    const jobId = readRefineJobId({ metadataEvent });
    return jobId && REFINE_TERMINAL_EVENTS.has(eventName) ? `${meshId}::${eventName}::${jobId}` : '';
}

function hasPendingRefineTerminalEventDuplicate(event: PendingMeshCoordinatorEvent): boolean {
    if (!REFINE_TERMINAL_EVENTS.has(event.event)) return false;
    const jobId = readRefineJobId(event);
    if (!jobId) return false;
    // Same suppression as before, now read from the SQLite inbox: a second
    // refine:completed/failed for a jobId already queued is a duplicate. (This
    // check used to scan the JSONL mirror, so it silently stopped working the
    // moment SQLite became the only store — keep it reading the live store.)
    try {
        return MeshRuntimeStore.getInstance().peekPendingEvents(event.meshId).some((row) =>
            row.event === event.event
            && readRefineJobId(row.payload as PendingMeshCoordinatorEvent) === jobId,
        );
    } catch {
        return false;
    }
}

// CANON-B / DUPNOTIF: terminal completion events that the coordinator surfaces as a
// notification. The native completion path (handleMeshCoordinatorEvent) and the transcript
// reconciliation fallback (reconcileDirectDispatchCompletionFromTranscript) BOTH queue one of
// these for the same finished task — with DIFFERENT timestamps — so a timestamp-bearing
// fingerprint lets both surface and the coordinator notifies twice. When the event carries a
// taskId we anchor the fingerprint on the taskId (dropping the timestamp), collapsing the two
// paths into a single surface. A weakness marker keeps a tentative false-idle completion
// distinct from the genuine completion that supersedes it, so the genuine one is never
// swallowed by the earlier weak one.
const TERMINAL_COMPLETION_EVENTS = new Set(['agent:generating_completed', 'agent:stopped']);

/**
 * ACTIONABLE-SKIP-FINGERPRINT: events whose dedup identity includes the skip
 * `reason`. These are coordinator ALERTS about why a task is not progressing —
 * two different blockers for one task are two different things to tell the
 * coordinator, so collapsing them by taskId alone silently drops the second.
 * See the note inside buildPendingEventFingerprint.
 */
const COORDINATOR_ALERT_EVENTS_WITH_REASON_FINGERPRINT: ReadonlySet<string> = new Set([
    'mesh:dispatch_blocked',
]);

export function buildPendingEventFingerprint(event: PendingMeshCoordinatorEvent): string {
    const metadata = readRecord(event.metadataEvent) || {};
    // Bootstrap events are node-scoped: dedup by meshId+event+nodeId only.
    // They carry no sessionId/taskId/timestamp — using those fields would produce
    // an empty fingerprint that defeats dedup entirely.
    if (event.event === 'worktree_bootstrap_complete' || event.event === 'worktree_bootstrap_failed') {
        return [event.meshId, event.event, event.nodeId || ''].join('::');
    }
    // DUPNOTIF: a terminal completion carrying a taskId is deduped by taskId (+ weakness),
    // NOT by timestamp — the native and transcript-reconciliation paths timestamp the same
    // completion differently, and only taskId is stable across both.
    if (TERMINAL_COMPLETION_EVENTS.has(event.event)) {
        const terminalTaskId = readNonEmptyString(metadata.taskId) || readNonEmptyString(readRecord(metadata.payload)?.taskId);
        if (terminalTaskId) {
            return [
                event.meshId,
                event.event,
                terminalTaskId,
                isWeakCompletionMetadata(metadata) ? 'weak' : 'genuine',
            ].join('::');
        }
    }
    // MAGI consensus-group exemption: a consensusGroupId marks an INTENTIONAL
    // same-prompt fan-out across N replicas — the exact opposite of the accidental
    // duplicates this dedup collapses. Anchor the fingerprint on the unique
    // (taskId, consensusGroupId) so grouped replicas can NEVER be collapsed by any
    // future prompt-content-based tightening of this builder. Mirrors the
    // bootstrap-event exemption above and serves as the explicit fan-out marker.
    // (Today this is belt-and-suspenders: each replica already gets a distinct
    // taskId, so the generic key below would not collapse them either.)
    const consensusGroupId = readNonEmptyString(metadata.consensusGroupId)
        || readNonEmptyString(readRecord(metadata.payload)?.consensusGroupId);
    if (consensusGroupId) {
        const groupTaskId = readNonEmptyString(metadata.taskId)
            || readNonEmptyString(readRecord(metadata.payload)?.taskId);
        return [event.meshId, event.event, groupTaskId || '', consensusGroupId, 'group'].join('::');
    }
    const sessionId = resolveEventSessionId(metadata);
    const providerSessionId = readNonEmptyString(metadata.providerSessionId);
    const taskId = readNonEmptyString(metadata.taskId) || readNonEmptyString(readRecord(metadata.payload)?.taskId);
    const jobId = readRefineJobId(event);
    const timestamp = metadata.timestamp !== undefined && metadata.timestamp !== null ? String(metadata.timestamp) : '';
    // ACTIONABLE-SKIP-FINGERPRINT: a coordinator ALERT is identified by (task, REASON),
    // not by task alone.
    //
    // The defect (measured live 2026-08-19). `mesh:dispatch_blocked` carries no
    // `timestamp`, so every alert about one task collapsed onto a single fingerprint.
    // A still-undrained earlier page for that task therefore SUPPRESSED every later
    // one — including the pin-expiry page, which is the notification of record for "a
    // delta addressed to a specific session lost its addressee". The reason had been
    // registered in ACTIONABLE_SKIP_REASON_PREFIXES precisely to stop that silence
    // (after a prior 74-minute incident), and the emit path built the event correctly;
    // it was discarded one layer lower, at INFO, as a duplicate of an unrelated alert.
    //
    // The in-memory de-dup in mesh-skip-notify DOES key on the reason and correctly
    // lets a reason CHANGE through — which is exactly why the gap survived review: the
    // layer everyone reads is right, and the suppression happens in a layer the reason
    // never reached. Including it here makes the two agree.
    //
    // Scoped to alert events so no other dedup behaviour shifts: repeats of the SAME
    // reason still collapse (the 4s reconcile loop cannot spam), while a genuinely
    // different blocker is no longer swallowed by an older one.
    const alertReason = COORDINATOR_ALERT_EVENTS_WITH_REASON_FINGERPRINT.has(event.event)
        ? readNonEmptyString(metadata.reason)
        : undefined;
    return [
        event.meshId,
        event.event,
        event.nodeId || '',
        sessionId || '',
        providerSessionId || '',
        taskId || '',
        jobId || '',
        timestamp || '',
        ...(alertReason ? [alertReason] : []),
    ].join('::');
}

// NOTE: the former R3 "direct-delivered" marker (markMeshCoordinatorEventDirectDelivered /
// wasDirectDeliveredToCoordinator) was removed when spontaneous PTY direct-inject was retired.
// Delivery is now queue-drain-only: an event is consumed by exactly one drainer via the atomic
// SQLite drained=1 marking, so there is no PTY-vs-poll double-delivery left to dedup against.
// The dormant mesh_direct_delivered_events table that backed it was dropped in
// MeshRuntimeStore.migrateMeshIsolationColumns (DROP TABLE IF EXISTS, migration step 5).

/**
 * DUPNOTIF-DURABLE (gap_b): TTL for the drain-independent terminal-completion dedup
 * record. Deliberately long relative to the 10-minute completion-event TTL: the
 * duplicate producers this closes are NOT near-simultaneous. The measured failure had
 * a coordinator drain in between (`reconcileDirectDispatchCompletionFromTranscript` is
 * reachable from both mesh-completion-synthesis and mesh-reconcile-stranded-dispatch,
 * seconds-to-minutes apart), and the TURN-LEDGER outbox redelivery can fire after a
 * process restart. One hour covers both while still bounding the table.
 */
const TERMINAL_COMPLETION_DEDUP_TTL_MS = 60 * 60 * 1000;

/**
 * DUPNOTIF-DURABLE (gap_b): terminal completions get a dedup record that OUTLIVES the
 * drain; every other event keeps the pre-existing drain-scoped semantics.
 *
 * Scoped to terminal completions on purpose. A progress/alert event legitimately
 * recurs — `mesh:dispatch_blocked` must be able to page the coordinator again for the
 * same task after the first page was consumed (that is the ACTIONABLE-SKIP-FINGERPRINT
 * contract, which reads the `reason` into the fingerprint precisely so a *different*
 * blocker is not swallowed). Making dedup durable for those would re-open the
 * too-few-notifications defect this must not regress. A task's terminal completion, by
 * contrast, is exactly-once by definition: it happens once, so a second arrival for the
 * same (task, weak|genuine) identity is always a duplicate producer, never news.
 */
function isDurablyDedupedEvent(event: PendingMeshCoordinatorEvent): boolean {
    if (!TERMINAL_COMPLETION_EVENTS.has(event.event)) return false;
    // Only the taskId-anchored terminal fingerprint is exactly-once. A terminal event
    // with no taskId falls through to the generic session+timestamp fingerprint, which
    // is not a stable identity for the same completion across producers — durably
    // suppressing on it could silence an unrelated later completion of that session.
    const metadata = readRecord(event.metadataEvent) || {};
    const taskId = readNonEmptyString(metadata.taskId) || readNonEmptyString(readRecord(metadata.payload)?.taskId);
    return !!taskId;
}

/**
 * DUPNOTIF-DURABLE (gap_b): record that this terminal completion fingerprint has been
 * queued, in a store that is NOT cleared by the coordinator draining the row.
 *
 * The pre-existing `hasPendingEventFingerprint` check is `WHERE drained = 0`, so once
 * the coordinator consumed the first completion the SAME fingerprint stopped reading as
 * a duplicate — a second producer (or the TURN-LEDGER outbox crash-recovery redelivery,
 * whose exactly-once guarantee rested on that one drain-gated check) queued a second
 * identical [System] completion. Measured live: session 3845d986 surfaced one final
 * summary three times.
 *
 * The UNIQUE (mesh_id, fingerprint) index is not a substitute: `deletePendingEventsById`
 * hard-deletes rows to free the fingerprint for the unresolved-delegate outbox, so the
 * index-level collision is not durable either.
 */
function recordDurableTerminalDedup(event: PendingMeshCoordinatorEvent, fingerprint: string): void {
    if (!isDurablyDedupedEvent(event)) return;
    try {
        const store = MeshRuntimeStore.getInstance();
        store.recordCompletionFingerprint(event.meshId, `pending::${fingerprint}`, TERMINAL_COMPLETION_DEDUP_TTL_MS);
        store.sweepExpiredFingerprints();
    } catch {
        // Best-effort: a store failure here costs a possible duplicate notification,
        // which is strictly better than dropping the completion entirely.
    }
}

export function hasPendingCoordinatorEventDuplicate(event: PendingMeshCoordinatorEvent): boolean {
    const fingerprint = buildPendingEventFingerprint(event);
    if (!fingerprint.trim()) return false;
    try {
        const store = MeshRuntimeStore.getInstance();
        if (store.hasPendingEventFingerprint(event.meshId, fingerprint)) return true;
        // gap_b: drain-independent check for terminal completions. Namespaced with a
        // `pending::` prefix so it can never collide with the completion-event
        // fingerprints mesh-event-forwarding writes into the same table.
        if (isDurablyDedupedEvent(event) && store.hasCompletionFingerprint(event.meshId, `pending::${fingerprint}`)) {
            return true;
        }
        return false;
    } catch {
        // Store unavailable: report "no duplicate" so the caller still attempts the
        // persist (which surfaces the real store failure) rather than silently
        // suppressing the event as an assumed duplicate.
        return false;
    }
}

function refineTerminalEventFromLedger(meshId: string, pending: readonly PendingMeshCoordinatorEvent[]): PendingMeshCoordinatorEvent[] {
    const acceptedJobIds = new Set(
        pending
            .filter(event => event.event === 'refine:accepted')
            .map(event => readRefineJobId(event))
            .filter(Boolean),
    );
    if (acceptedJobIds.size === 0) return [];
    const existingTerminalJobIds = new Set(
        pending
            .filter(event => REFINE_TERMINAL_EVENTS.has(event.event))
            .map(event => `${event.event}:${readRefineJobId(event)}`)
            .filter(value => !value.endsWith(':')),
    );
    const backfilled: PendingMeshCoordinatorEvent[] = [];
    // LEDGER-KIND-TAIL-BLINDSPOT: kind-filtered, no bare tail — this backfills a
    // MISSING terminal event for an accepted refine job. A bare tail:200 window can
    // be crowded out by unrelated mesh traffic while the refine job (minutes-long)
    // runs, causing the terminal row this function is looking for to fall out of the
    // window and leaving the coordinator never notified that its merge finished.
    const entries = readLedgerEntriesByKind(meshId, ['task_completed', 'task_failed']);
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        const payload = readRecord(entry.payload);
        if (payload?.source !== 'refine_mesh_node_async_job') continue;
        const refineJob = readRecord(payload.refineJob);
        const jobId = readNonEmptyString(refineJob?.jobId);
        if (!jobId || !acceptedJobIds.has(jobId)) continue;
        const eventName = entry.kind === 'task_completed' ? 'refine:completed' : 'refine:failed';
        if (existingTerminalJobIds.has(`${eventName}:${jobId}`)) continue;
        existingTerminalJobIds.add(`${eventName}:${jobId}`);
        const result = readRecord(payload.result);
        const metadataEvent = {
            source: 'refine_mesh_node_async_job',
            jobId,
            interactionId: readNonEmptyString(refineJob?.interactionId),
            meshId,
            nodeId: readNonEmptyString(refineJob?.nodeId) || entry.nodeId,
            targetDaemonId: readNonEmptyString(refineJob?.targetDaemonId),
            workspace: readNonEmptyString(refineJob?.workspace),
            status: eventName === 'refine:completed' ? 'completed' : 'failed',
            startedAt: readNonEmptyString(refineJob?.startedAt),
            completedAt: readNonEmptyString(refineJob?.completedAt) || entry.timestamp,
            retryOfJobId: readNonEmptyString(refineJob?.retryOfJobId) || readNonEmptyString(payload.retryOfJobId),
            ...(result ? { result } : {}),
        };
        const nodeLabel = readNonEmptyString(refineJob?.nodeId) || entry.nodeId || 'refine job';
        backfilled.push({
            event: eventName,
            meshId,
            nodeLabel,
            nodeId: readNonEmptyString(refineJob?.nodeId) || entry.nodeId,
            workspace: readNonEmptyString(refineJob?.workspace),
            metadataEvent,
            coordinatorMessage: buildMeshSystemMessage({ event: eventName, nodeLabel, metadataEvent }),
            queuedAt: Date.now(),
        });
    }
    return backfilled.reverse();
}

// ─── STALE-TASK-TERMINAL drain gate ─────────────────────────────────────────
// Generalization of isApprovalNudgeResolved (mesh-reconcile-coordinator-drain.ts):
// that function already drops an approval NUDGE whose task has since gone terminal,
// on exactly this reasoning — a nudge whose subject is resolved would tell the
// coordinator something false. The same hazard applies to every other non-terminal
// progress/dispatch alert, and it was NOT covered: measured on 2026-08-22, task
// 081317f3 committed terminal `cancelled` at 13:14:12.806 and a `mesh:dispatch_blocked`
// event for that same task was surfaced to the coordinator 767ms later. The coordinator
// had already cancelled and moved on; the alert was pure misinformation.
//
// WHY STATUS ALONE, WITH NO TIMESTAMP COMPARISON
// The obvious framing is "drop events queued AFTER the terminal", which needs a
// queuedAt-vs-terminal-time comparison and therefore inherits clock skew and ordering
// hazards. That comparison is unnecessary here, because a terminal task row is STICKY:
// updateTaskStatus (mesh-work-queue.ts:1263-1273, CANCEL-STICKY-TERMINAL) refuses every
// terminal→non-terminal transition unless an explicit `force` override is passed, and no
// caller in the tree passes it. A task that is `completed`/`failed`/`cancelled` can never
// return to active work, so a non-terminal progress alert about it is stale REGARDLESS of
// when it was queued — an event queued before the terminal is equally misleading by the
// time it would surface. Gating on the row's current status is thus both stricter and
// safer than a time window: no clock read, no skew, no reordering exposure.
//
// WHAT IS NEVER DROPPED (over-correction is the worse failure)
// Blocking a genuine result is far more damaging than surfacing a stale alert, so this
// gate is an explicit DENY-list of low-stakes alerts, never an allow-list. Everything not
// named in STALE_TASK_DROPPABLE_EVENTS passes untouched, including:
//   - every completion / stop / refine outcome (the coordinator's only copy of the
//     worker's result — dropping one loses it permanently),
//   - every approval / question nudge (a worker may be blocked on it right now; the
//     already-resolved subset is handled upstream by isApprovalNudgeResolved, which
//     applies its own terminal check with delivery-safe semantics),
//   - every event carrying no resolvable taskId, and every event whose task row cannot
//     be found or read. Unknown is treated as live: when in doubt, deliver.
const STALE_TASK_DROPPABLE_EVENTS: ReadonlySet<string> = new Set([
    // Actionable dispatch-skip page ("this task will NOT dispatch on its own"). Meaningless
    // once the task is terminal — the measured 081317f3 case.
    'mesh:dispatch_blocked',
    // Stall watchdog ("no progress observed"). A terminal task cannot make progress; the
    // alert only invites the coordinator to re-drive already-finished work.
    'monitor:no_progress',
]);

/** Terminal task statuses, mirroring mesh-work-queue's TERMINAL_TASK_STATUSES. Local copy
 *  so this module does not take a value import on the queue (import-boundary hygiene). */
const STALE_TASK_TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

/** Resolve the taskId an event is about, from either the metadata envelope or the row. */
function readPendingEventTaskId(event: PendingMeshCoordinatorEvent): string {
    const metadataEvent = readRecord(event.metadataEvent);
    return readNonEmptyString(metadataEvent?.taskId);
}

/**
 * Drop droppable non-terminal alerts whose task row has already gone terminal. Returns the
 * surviving events. Best-effort throughout: any lookup failure keeps the event (deliver).
 */
function dropStaleTerminalTaskEvents(
    meshId: string,
    events: PendingMeshCoordinatorEvent[],
): PendingMeshCoordinatorEvent[] {
    // O(1) guard: the overwhelmingly common batch contains no droppable alert at all.
    if (!events.some(event => STALE_TASK_DROPPABLE_EVENTS.has(event.event))) return events;
    let store: MeshRuntimeStore;
    try {
        store = MeshRuntimeStore.getInstance();
    } catch {
        return events; // store unavailable → cannot judge staleness; deliver everything
    }
    const terminalByTaskId = new Map<string, boolean>();
    const isTaskTerminal = (taskId: string): boolean => {
        const cached = terminalByTaskId.get(taskId);
        if (cached !== undefined) return cached;
        let terminal = false;
        try {
            const entry = store.findQueueEntryById(meshId, taskId);
            // No row (pruned / foreign mesh) → NOT provably terminal → deliver.
            terminal = !!entry && STALE_TASK_TERMINAL_STATUSES.has(entry.status);
        } catch {
            terminal = false; // read failure → deliver
        }
        terminalByTaskId.set(taskId, terminal);
        return terminal;
    };
    return events.filter(event => {
        if (!STALE_TASK_DROPPABLE_EVENTS.has(event.event)) return true;
        const taskId = readPendingEventTaskId(event);
        if (!taskId) return true; // unattributable → deliver
        if (!isTaskTerminal(taskId)) return true;
        traceMeshEventDrop('stale_task_terminal', {
            taskId,
            sessionId: resolveEventSessionId(event.metadataEvent) ?? event.targetCoordinatorSessionId,
            nodeId: event.nodeId,
            meshId,
            event: event.event,
        }, 'task row is already terminal (completed/failed/cancelled) — non-terminal alert is stale');
        return false;
    });
}

function reconcilePendingMeshCoordinatorEvents(meshId: string, events: PendingMeshCoordinatorEvent[]): PendingMeshCoordinatorEvent[] {
    const backfilled = refineTerminalEventFromLedger(meshId, events);
    // A refine:accepted event is a provisional "job accepted, result to follow" signal.
    // Once its terminal (completed/failed) counterpart for the same jobId exists — whether
    // already direct-queued into the pending store OR backfilled from the ledger here — the
    // accepted is superseded and is dropped so the coordinator isn't shown stale duplicate
    // noise alongside the terminal outcome.
    const terminalJobIds = new Set(
        [...events.filter(event => REFINE_TERMINAL_EVENTS.has(event.event)), ...backfilled]
            .map(event => readRefineJobId(event))
            .filter(Boolean),
    );
    const reconciled = terminalJobIds.size === 0
        ? events
        : events.filter(event => !(event.event === 'refine:accepted' && terminalJobIds.has(readRefineJobId(event))));
    // STALE-TASK-TERMINAL: applied to the drained events only. The ledger-backfilled
    // terminals are appended AFTER it and are deliberately never subject to it — they
    // exist precisely because a terminal outcome was missing, so they are the payload
    // this gate must protect, not filter.
    const fresh = dropStaleTerminalTaskEvents(meshId, reconciled);
    return backfilled.length === 0 ? fresh : [...fresh, ...backfilled];
}

// ─── SQLite pending-event retention ─────────────────────────────────────────
// mesh_pending_events had no lifecycle GC: drained rows are retained forever (the
// durable v2-eventId dedup baseline drainedEventIdsForMesh reads them), and an
// undrained row for a coordinator identity that never returns stays queued forever.
// Both accumulate without bound. These windows bound that growth while preserving
// the two things the rows exist for — recent-re-delivery idempotency and delivery
// to a returning coordinator. A drained event older than the drained window cannot
// be re-delivered (its producer session is long gone), so keeping it buys nothing;
// an undrained event is kept far longer so a genuinely-offline coordinator's backlog
// survives, and only unrecoverable orphans are swept.
const PENDING_EVENTS_DRAINED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;   // 7 days
const PENDING_EVENTS_UNDRAINED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * TERMINAL-NEVER-EXPIRES. Event names the undrained retention window must NEVER
 * expire, at any age. This is the force-inject (terminal) class — the events a
 * coordinator is actively blocked waiting on: a completion, a stop, an approval /
 * question nudge, a refine outcome, a worktree bootstrap result.
 *
 * Why an exemption rather than a longer window: the undrained sweep exists to bound
 * a table that a coordinator identity abandoned, and for a LIFECYCLE event
 * (`agent:ready`, `agent:generating_started`, `refine:accepted`) that is pure
 * hygiene — the information is re-derivable from level state or simply obsolete. A
 * terminal event is categorically different: its finalSummary / worker result exists
 * ONLY in this row (that is the very reason the reconcile loop holds it at the idle
 * edge instead of drain-without-inject), so expiring it destroys the single copy of
 * a worker's output. Mirroring it to `event_held` first makes it *recoverable*, but
 * recovery is a manual operator step — it is not a substitute for simply never
 * destroying it. Any window long enough to be "safe" for a terminal event is long
 * enough that the growth bound it buys is meaningless, and terminal rows are
 * naturally bounded anyway (one per dispatched task, not a per-tick stream).
 *
 * Derived from MESH_FORCE_INJECT_EVENTS rather than re-listed, so a new terminal
 * event added to that set is automatically protected here and cannot be silently
 * expired by a future contributor who did not know this list existed.
 */
export const PENDING_RETENTION_NEVER_EXPIRE_EVENTS: ReadonlySet<string> = MESH_FORCE_INJECT_EVENTS;

/** Reason stamped on an `event_held` entry produced by the retention sweep below —
 *  the SQLite-era successor to the retired JSONL trim's `pending_trim_dropped`. Kept
 *  as its own string (not reusing that literal) because the trigger is genuinely
 *  different: age-based (30-day undrained window), not a 50-entry count cap. */
export const PENDING_RETENTION_EXPIRED_HOLD_REASON = 'pending_retention_expired';

/** Observability counters for the pending-event retention sweep (this file's
 *  prunePendingMeshCoordinatorEventsRetention). Process-lifetime totals, mirroring
 *  the meshV2DrainCounters pattern above. `undrainedExpired` is the one that matters
 *  operationally: every increment is a genuine silent-drop risk (an event that never
 *  reached a coordinator) that this sweep now mirrors to `event_held` instead of
 *  deleting outright, so a non-zero count is recoverable via mesh_requeue_held_events,
 *  not a loss report. `drainedExpired` is NOT a drop (the coordinator already
 *  consumed those rows) and is tracked only for visibility into table growth. */
const pendingRetentionCounters = {
    /** Already-drained rows deleted past the 7-day dedup-useful window. Not a drop. */
    drainedExpired: 0,
    /** Never-delivered rows deleted past the 30-day undrained window. A genuine
     *  silent-drop risk — mirrored to event_held before deletion (see below). */
    undrainedExpired: 0,
    /** undrainedExpired rows that failed to mirror to the ledger (ledger write threw).
     *  Non-zero here means those specific rows are NOT recoverable via
     *  mesh_requeue_held_events — the delete still proceeds (retention must not wedge
     *  on a ledger fault), but this count is the operator's signal of true loss. */
    undrainedExpiredMirrorFailed: 0,
    /** How many times the sweep has run and found nothing to prune (0 in both
     *  windows). Purely diagnostic — confirms the sweep is actually firing. */
    sweepsNoop: 0,
    /** TERMINAL-NEVER-EXPIRES: undrained rows past the 30-day window that were KEPT
     *  because they are terminal (PENDING_RETENTION_NEVER_EXPIRE_EVENTS). Every
     *  increment is a worker output the sweep would otherwise have destroyed, so a
     *  non-zero count is the exemption doing its job — NOT a drop and NOT a backlog
     *  warning on its own. It does, however, mean a coordinator identity has an
     *  undelivered completion older than 30 days, which is worth an operator look. */
    terminalExempt: 0,
};

/** Observability accessor for the pending-event retention counters. Surfaced via
 *  mesh_status / mesh_events alongside meshV2DrainCounters (see repo-mesh-types.ts
 *  MeshProtocolV2Counters / high-family/mesh-status.ts). */
export function getPendingRetentionCounters(): Readonly<typeof pendingRetentionCounters> {
    return { ...pendingRetentionCounters };
}

/** Test helper: zero the pending-retention counters so a test starts clean. */
export function __resetPendingRetentionCountersForTests(): void {
    for (const k of Object.keys(pendingRetentionCounters) as Array<keyof typeof pendingRetentionCounters>) {
        pendingRetentionCounters[k] = 0;
    }
}

/**
 * Mirror an undrained-expired pending-event row to the mesh ledger as a recoverable
 * `event_held` entry, in the exact shape ledgerRecordQuarantinedEvent /
 * mesh-reconcile-coordinator-drain use, so mesh_requeue_held_events can restore it
 * losslessly. Best-effort: a ledger write failure must not block the retention
 * delete (an unbounded table is worse than one unmirrored row), but it is counted
 * via undrainedExpiredMirrorFailed and logged so the loss is not silent either.
 */
function ledgerRecordExpiredUndrainedEvent(row: { id: string; meshId: string; event: string; payload: unknown }): void {
    try {
        const restored = (row.payload && typeof row.payload === 'object') ? row.payload as PendingMeshCoordinatorEvent : undefined;
        const finalSummary = restored?.metadataEvent ? readMeshCompletionSummary(restored.metadataEvent) : undefined;
        appendLedgerEntry(row.meshId, {
            kind: 'event_held',
            ...(restored?.nodeId ? { nodeId: restored.nodeId } : {}),
            payload: {
                event: row.event,
                reason: PENDING_RETENTION_EXPIRED_HOLD_REASON,
                recoverable: true,
                nodeLabel: restored?.nodeLabel ?? '',
                ...(restored?.workspace ? { workspace: restored.workspace } : {}),
                targetCoordinatorDaemonId: restored?.targetCoordinatorDaemonId ?? null,
                ...(readNonEmptyString(restored?.eventId) ? { eventId: restored!.eventId } : {}),
                queuedAt: restored?.queuedAt ?? null,
                ...(finalSummary ? { finalSummary } : {}),
                // Full original event so mesh_requeue_held_events can restore it
                // losslessly (event_held→pending), same as every other event_held feeder.
                ...(restored ? { heldEvent: restored } : {}),
            },
        });
    } catch (e: any) {
        pendingRetentionCounters.undrainedExpiredMirrorFailed++;
        LOG.warn('MeshEvents', `Failed to ledger-record retention-expired pending event ${row.event} (row ${row.id}, mesh ${row.meshId}) — it is being deleted UNRECOVERABLY: ${e?.message || e}`);
    }
}

/**
 * Retention sweep for the SQLite mesh_pending_events inbox. Deletes long-drained
 * rows (past the idempotency-useful window) and long-orphaned undrained rows (a
 * coordinator identity that never returned). Best-effort and idempotent: a store
 * failure or an empty table is a cheap no-op. Called from the periodic mesh-event
 * maintenance sweep. Returns the total number of rows pruned (0 when nothing to do).
 *
 * Every undrained-expired row is a genuine silent-drop risk — it was queued for a
 * coordinator that never drained it — so before deleting them this mirrors each one
 * into the mesh ledger as `event_held` (reason: pending_retention_expired), the same
 * recovery channel the retired JSONL trim's `pending_trim_dropped` used to feed.
 * mesh_requeue_held_events can restore them afterward. The drop itself is also logged
 * at WARN with the count and the mesh ids affected, so it is visible at the moment it
 * happens rather than only discoverable by later running mesh_requeue_held_events —
 * that historical blind spot (130 drops across 4 days surfaced only in bulk, well
 * after the fact) is exactly what this sweep must not repeat. The WARN always names
 * the sweep's OWN timestamp as the drop time, never a later recovery time, so it
 * cannot be misread as "just happened" during a later requeue.
 */
export function prunePendingMeshCoordinatorEventsRetention(): number {
    try {
        const { drainedExpired, undrainedExpired, undrainedRows, terminalExempt } = MeshRuntimeStore.getInstance().prunePendingEvents({
            drainedOlderThanMs: PENDING_EVENTS_DRAINED_RETENTION_MS,
            undrainedOlderThanMs: PENDING_EVENTS_UNDRAINED_RETENTION_MS,
            // TERMINAL-NEVER-EXPIRES: a terminal event's worker output exists only in
            // this row — the sweep must never destroy it, at any age.
            neverExpireEvents: PENDING_RETENTION_NEVER_EXPIRE_EVENTS,
        });

        pendingRetentionCounters.drainedExpired += drainedExpired;
        pendingRetentionCounters.undrainedExpired += undrainedExpired;
        pendingRetentionCounters.terminalExempt += terminalExempt;

        if (terminalExempt > 0) {
            LOG.info(
                'MeshEvents',
                `Pending-event retention KEPT ${terminalExempt} terminal event(s) past the undrained window `
                + `(never expired — their worker output exists only in these rows). They remain queued and deliverable.`,
            );
        }

        if (undrainedRows.length > 0) {
            for (const row of undrainedRows) {
                ledgerRecordExpiredUndrainedEvent(row);
            }
            const meshIds = [...new Set(undrainedRows.map(r => r.meshId))];
            const droppedAt = new Date().toISOString();
            LOG.warn(
                'MeshEvents',
                `Pending-event retention DROPPED ${undrainedRows.length} never-delivered event(s) at ${droppedAt} `
                + `(queued >30d, still undrained) across mesh(es) ${meshIds.join(', ')} — mirrored to the ledger as `
                + `event_held (reason: ${PENDING_RETENTION_EXPIRED_HOLD_REASON}); recover with mesh_requeue_held_events.`,
            );
        }

        const removed = drainedExpired + undrainedExpired;
        if (removed > 0) {
            LOG.info('MeshEvents', `Pruned ${removed} stale pending-event row(s) (drained >7d / undrained >30d)`);
        } else {
            pendingRetentionCounters.sweepsNoop++;
        }
        return removed;
    } catch (e: any) {
        LOG.warn('MeshEvents', `Pending-event retention prune failed: ${e?.message || e}`);
        return 0;
    }
}

/**
 * Stamp the v2 protocol envelope onto a pending event at emit time (B2a).
 *
 * Non-breaking: returns a NEW event object with protocolVersion/eventId/scope/
 * dispatchedBy/intendedFor added when a coordinator identity can be derived,
 * otherwise returns the input unchanged (a v1 event, broadcast-treated during
 * rollout). Identity and the unicast target are derived from the event's own
 * targetCoordinatorDaemonId / targetCoordinatorSessionId (already carried by
 * every producer), so most call sites need no change; the optional `hint`
 * overrides scope/identity where a site knows better.
 *
 * The eventId is generated here (randomUUID) exactly once, so re-queues that
 * pass an already-stamped event keep their original eventId — the idempotency
 * key is stable across re-delivery. An already-stamped event is returned as-is.
 */
export function stampPendingEventV2(
    event: PendingMeshCoordinatorEvent,
    hint?: PendingEventEmitHint,
): PendingMeshCoordinatorEvent {
    // Preserve idempotency across re-queues: never re-stamp an event that already
    // carries a v2 eventId (mesh-reconcile-loop / flushPendingForMeshIdleCoordinators
    // re-queue built events verbatim).
    if (event.protocolVersion === MESH_PROTOCOL_VERSION_V2 && readNonEmptyString(event.eventId)) {
        return event;
    }

    const coordinatorIdentity = hint?.dispatchedBy ?? coordinatorIdentityFromEmitFields({
        daemonId: event.targetCoordinatorDaemonId,
        coordinatorRunId: hint?.coordinatorRunId,
        sessionId: event.targetCoordinatorSessionId,
    });

    // A/C ROOT FIX: an emit site with NO coordinator identity (direct-dispatch /
    // refine notification / any path where the worker session never carried a
    // meshCoordinatorDaemonId) used to leave the event UNVERSIONED (v1). Under v2
    // enforce (default ON) routeV2EventsForDrainer QUARANTINES every unversioned
    // event — so a summary-less completion (agent:generating_completed) and every
    // refine terminal notification (refine:accepted/completed/failed) were held
    // back and never reached the coordinator; only the backstop papered over it.
    //
    // Fall back to THIS daemon's own id as the dispatcher so a v2 envelope can
    // still be minted. There is no addressable coordinator, so we intentionally
    // leave intendedFor empty and let buildPendingEventEmitStamp downgrade the
    // (unicast-defaulting) terminal event to a BROADCAST — deliverable to whatever
    // coordinator drains on this machine, instead of an undeliverable v1 event.
    // When a real coordinator identity DOES exist the unicast path below is
    // unchanged (no regression). loadConfig().machineId is the same self-id source
    // resolveCoordinatorDaemonIds / the local queue-assignment stamp use, so the
    // broadcast dispatcher matches the drainer's own identity form.
    const selfFallback = !coordinatorIdentity;
    const dispatchedBy = coordinatorIdentity ?? coordinatorIdentityFromEmitFields({
        daemonId: readNonEmptyString(loadConfig().machineId),
    });
    // The unicast target is, by default, the same coordinator the event is already
    // routed to (its originating coordinator). A hint may override it. In the
    // self-fallback case there is no originating coordinator to address, so leave
    // it empty → broadcast (never a self-unicast that a sibling session's drainer
    // would skip).
    const intendedFor: CoordinatorIdentity | undefined = hint?.intendedFor
        ?? (selfFallback ? undefined : coordinatorIdentity);

    const stamp = buildPendingEventEmitStamp({
        eventName: event.event,
        eventId: randomUUID(),
        dispatchedBy,
        intendedFor,
        // Force broadcast for the self-fallback so a unicast-defaulting terminal
        // event isn't addressed to this daemon alone; an explicit hint still wins.
        scope: hint?.scope ?? (selfFallback ? 'broadcast' : undefined),
    });
    if (!stamp) return event; // no coordinator identity at all (no self id) → stays a v1 event

    // Mark an ownerless (self-fallback) broadcast so the drain-side leak guard can
    // tell it apart from a genuinely owned broadcast terminal event. selfFallback is
    // true only when no coordinator identity existed and we minted the stamp under
    // this daemon's own machineId; a broadcast that stays broadcast for that reason
    // has no owner to leak from and must reach whatever coordinator drains here.
    const dispatchedBySelfFallback = selfFallback && stamp.scope === 'broadcast';

    // CODA-TERMINAL-EVENT-HELD-WHILE-GENERATING (project-mesh-self-fallback-terminal-
    // broadcast-drop): an ownerless self-fallback broadcast terminal event
    // (worktree_bootstrap_complete / refine:completed / a summary-less
    // agent:generating_completed emitted while THIS machine's coordinator CLI session is
    // generating) previously carried NO targetCoordinatorDaemonId. The reconcile loop
    // holds it under `generating_no_idle_coordinator`, and its `event_held` ledger mirror
    // records targetCoordinatorDaemonId:null — so the held event is not addressable to
    // the local coordinator's per-daemon scoped file, and (live 2026-07-12) the
    // coordinator only ever learns of it by polling the ledger, violating the no-polling
    // rule.
    //
    // The event's INTENDED coordinator IS this machine's own coordinator: the
    // self-fallback minted `dispatchedBy` under this daemon's own machineId precisely
    // because the originating task was dispatched by this machine's coordinator. Stamp
    // `targetCoordinatorDaemonId` = that same self daemon id so the held event is
    // addressable to the local coordinator's scoped file / drain filter, WITHOUT
    // changing its BROADCAST scope or the `dispatchedBySelfFallback` machine-level
    // `deliverSelfFallback` guard (which already keeps a replica completion on machine A
    // from fanning out to a coordinator on machine B). The target is a MACHINE id,
    // matched by machine core, so it only ever reaches a coordinator on THIS machine.
    //
    // Gate: apply ONLY when the event carries NO targetCoordinatorSessionId. A
    // session-strict event (targetCoordinatorSessionId set, coordinator daemon id
    // unresolved) is deliberately held/expired by the reconcile loop's strict-route path
    // keyed on the SESSION, not the daemon — stamping a daemon target there would let it
    // drain to a sibling before its session returns and break the strict-route hold. An
    // event that already carries an explicit daemon target is likewise left untouched.
    //
    // WORKTREE-BOOTSTRAP-REMOTE-PULL (M-MESH-INFRA-0829 5-d): skip the self-target
    // stamp for worktree_bootstrap_*. Those are node-lifecycle broadcasts
    // (defaultScopeForEvent → broadcast; not a TERMINAL_TASK_EVENT). clone_mesh_node
    // emits them on the WORKER with no coordinator identity, so this stamp would
    // write targetCoordinatorDaemonId = the WORKER machineId. The mesh host's
    // PHASE 1 pull then drains with its OWN coordinatorDaemonId and the SQL filter
    // `(coordinator_daemon_id IS NULL OR IN (host_ids))` misses the row — the
    // event sits on the worker forever (live: Jupiter logged "queued — broadcast"
    // while the SQLite column was the worker machineId; the Mac host pulled 7000×
    // and never consumed it). Leave the SQL column NULL so a remote host pull
    // matches. Local clones still drain: PHASE 2 uses `NULL OR IN (self_ids)`.
    // Terminal TASK events (agent:generating_completed / refine:*) KEEP the
    // self-target — those must not fan out (MAGI replica leak).
    const isWorktreeBootstrapEvent = event.event === 'worktree_bootstrap_complete'
        || event.event === 'worktree_bootstrap_failed';
    const selfFallbackTarget = dispatchedBySelfFallback
        && !isWorktreeBootstrapEvent
        && !readNonEmptyString(event.targetCoordinatorDaemonId)
        && !readNonEmptyString(event.targetCoordinatorSessionId)
        ? readNonEmptyString(stamp.dispatchedBy.daemonId)
        : undefined;

    return {
        ...event,
        protocolVersion: stamp.protocolVersion,
        eventId: stamp.eventId,
        scope: stamp.scope,
        dispatchedBy: stamp.dispatchedBy,
        ...(stamp.intendedFor ? { intendedFor: stamp.intendedFor } : {}),
        ...(dispatchedBySelfFallback ? { dispatchedBySelfFallback: true } : {}),
        ...(selfFallbackTarget ? { targetCoordinatorDaemonId: selfFallbackTarget } : {}),
    };
}

// ─── v2 envelope: remote (P2P) boundary preservation (B3b/T4) ─────────────
//
// The remote pull round-trip (mesh-reconcile-loop pullRemoteNodeQueues →
// get_pending_mesh_events → buildForwardPayloadFromPending → handleMeshForwardEvent
// → queuePendingMeshCoordinatorEvent) flattens a queued PendingMeshCoordinatorEvent
// into a flat wire payload and rebuilds it on the receiving daemon. The v2 envelope
// fields (protocolVersion / eventId / scope / dispatchedBy / intendedFor) live at the
// TOP LEVEL of the event, not inside metadataEvent, so the flatten/rebuild whitelist
// dropped them: the re-queue then re-stamped a FRESH eventId, breaking cross-machine
// idempotency and downgrading the relayed completion to v1 (broadcast) routing.
//
// These two helpers are the single serialization/deserialization pair for that
// boundary. serializeV2EnvelopeToWire copies the present v2 fields onto the flat
// payload; readV2EnvelopeFromWire validates and restores them for the re-queue. The
// eventId is carried verbatim so stampPendingEventV2's already-stamped short-circuit
// preserves it (no new UUID). Kept pure + exported so the round-trip is unit-testable.

/** Read a CoordinatorIdentity off an untrusted wire object, or undefined if malformed. */
function readCoordinatorIdentityFromWire(raw: unknown): CoordinatorIdentity | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const obj = raw as Record<string, unknown>;
    const daemonId = readNonEmptyString(obj.daemonId);
    const coordinatorRunId = readNonEmptyString(obj.coordinatorRunId);
    if (!daemonId || !coordinatorRunId) return undefined;
    const sessionId = readNonEmptyString(obj.sessionId);
    return { daemonId, coordinatorRunId, ...(sessionId ? { sessionId } : {}) };
}

/**
 * Copy the v2 envelope fields that are present on `event` onto a flat wire
 * payload. Only sets a field when it is present, so a v1 event contributes
 * nothing (the payload stays v1-shaped and version-skew safe).
 */
export function serializeV2EnvelopeToWire(event: PendingMeshCoordinatorEvent): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (event.protocolVersion) out.protocolVersion = event.protocolVersion;
    if (readNonEmptyString(event.eventId)) out.eventId = event.eventId;
    if (event.scope) out.scope = event.scope;
    if (event.dispatchedBy) out.dispatchedBy = event.dispatchedBy;
    if (event.intendedFor) out.intendedFor = event.intendedFor;
    return out;
}

/**
 * Restore the v2 envelope fields from a flat wire payload for a re-queue. Only
 * returns fields that survive validation; a payload missing/malforming a field
 * yields a partial (or empty) object so the re-queue path stays v1-safe. The
 * eventId is returned verbatim — its preservation is the idempotency guarantee.
 */
export function readV2EnvelopeFromWire(payload: Record<string, unknown>): Partial<Pick<
    PendingMeshCoordinatorEvent,
    'protocolVersion' | 'eventId' | 'scope' | 'dispatchedBy' | 'intendedFor'
>> {
    const out: Partial<Pick<
        PendingMeshCoordinatorEvent,
        'protocolVersion' | 'eventId' | 'scope' | 'dispatchedBy' | 'intendedFor'
    >> = {};
    if (payload.protocolVersion === MESH_PROTOCOL_VERSION_V2) out.protocolVersion = MESH_PROTOCOL_VERSION_V2;
    const eventId = readNonEmptyString(payload.eventId);
    if (eventId) out.eventId = eventId;
    if (isMeshEventScope(payload.scope)) out.scope = payload.scope;
    const dispatchedBy = readCoordinatorIdentityFromWire(payload.dispatchedBy);
    if (dispatchedBy) out.dispatchedBy = dispatchedBy;
    const intendedFor = readCoordinatorIdentityFromWire(payload.intendedFor);
    if (intendedFor) out.intendedFor = intendedFor;
    return out;
}

export function queuePendingMeshCoordinatorEvent(
    rawEvent: PendingMeshCoordinatorEvent,
    hint?: PendingEventEmitHint,
): boolean {
    // B2a: stamp the v2 envelope before dedup/persist so the eventId/scope ride
    // into both stores and the fingerprint/dedup logic sees the final shape.
    const event = stampPendingEventV2(rawEvent, hint);
    return persistPendingMeshCoordinatorEvent(event);
}

/**
 * Persist an ALREADY-STAMPED pending event to the SQLite inbox (dedup + insert),
 * without re-running the emit stamp. queuePendingMeshCoordinatorEvent stamps then
 * calls this; the only other caller is the test helper below, which needs to inject
 * a genuinely-unversioned (v1) row to exercise the drain-side v1 handling now that
 * the emit path never produces one (self-daemon fallback stamps every local emit).
 */
function persistPendingMeshCoordinatorEvent(event: PendingMeshCoordinatorEvent): boolean {
    try {
        if (hasPendingRefineTerminalEventDuplicate(event)) {
            LOG.info('MeshEvents', `Suppressed duplicate pending ${event.event} for refine job ${readRefineJobId(event)}`);
            return true;
        }
        if (hasPendingCoordinatorEventDuplicate(event)) {
            LOG.info('MeshEvents', `Suppressed duplicate pending ${event.event} for mesh ${event.meshId}`);
            return true;
        }

        const fingerprint = buildPendingEventFingerprint(event);

        // SQLite inbox — the ONLY store. There is no second copy: a failure here
        // means the event is not queued anywhere, so it is rethrown into the outer
        // catch (which returns false) rather than swallowed. The JSONL mirror that
        // used to absorb this is gone.
        //
        // Losing that fallback is loudest on `mesh:dispatch_blocked`
        // (mesh-queue-assignment notifyCoordinatorOfActionableSkip): that event is
        // the compensating notification telling the coordinator its task was NOT
        // dispatched — e.g. a target-session pin that expired, dropping a delta
        // addressed to work already in flight. Silently failing to queue it is the
        // exact failure it exists to prevent (measured: 74 minutes of a worker
        // running on a premise a lost correction was meant to fix). So a persist
        // failure is reported at ERROR with the event named, never at debug.
        MeshRuntimeStore.getInstance().insertPendingEvent({
            id: randomUUID(),
            meshId: event.meshId,
            coordinatorDaemonId: event.targetCoordinatorDaemonId ?? null,
            event: event.event,
            payload: event,
            fingerprint: fingerprint || null,
            queuedAt: event.queuedAt,
            // v2 envelope columns (B2a) — all nullable so v1 rows coexist. The
            // authoritative copy still rides inside `payload`; these columns exist
            // for queryable idempotency (event_id) and scope-based drain filtering
            // (scope / intended_for) without JSON-parsing every row.
            protocolVersion: event.protocolVersion ?? null,
            eventId: event.eventId ?? null,
            scope: event.scope ?? null,
            dispatchedBy: event.dispatchedBy ? JSON.stringify(event.dispatchedBy) : null,
            intendedFor: event.intendedFor ? JSON.stringify(event.intendedFor) : null,
        });
        // DUPNOTIF-DURABLE (gap_b): stamp the drain-independent dedup record AFTER a
        // successful insert, so a persist that threw does not leave behind a marker
        // that would suppress the retry of an event that was never queued.
        recordDurableTerminalDedup(event, fingerprint);
        return true;
    } catch (e: any) {
        // ERROR, not warn: with the JSONL mirror retired this is total loss of the
        // event, not a degraded-but-delivered path. Name the event and mesh so the
        // dropped notification is identifiable after the fact.
        LOG.error(
            'MeshEvents',
            `PENDING-EVENT PERSIST FAILED — ${event.event} for mesh ${event.meshId} is NOT queued and will NOT be delivered `
            + `(SQLite is the only store; there is no fallback): ${e?.message || e}`,
        );
        return false;
    }
}

/**
 * STRICT-ROUTE-HOLD-DURABILITY: durably re-queue an event that was already DRAINED,
 * so a hold survives a process restart.
 *
 * This is NOT queuePendingMeshCoordinatorEvent. The normal persist path cannot
 * re-queue a drained event at all: the UNIQUE (mesh_id, fingerprint) index has no
 * `drained` qualifier, so INSERT OR IGNORE silently discards the "fresh undrained
 * copy" while hasPendingEventFingerprint (which filters `drained = 0`) reports no
 * duplicate — the caller is told the re-queue worked when nothing was written. Any
 * copy that did land would then be filtered by the v2 eventId drained-baseline.
 *
 * Instead we flip the EXISTING row back to drained=0 in place. That single move
 * clears all three suppressors at once (unique index untouched, row becomes visible
 * to the drained=0 drain query, and its eventId leaves drainedEventIdsForMesh), and
 * — unlike the old in-memory-only hold — it is durable across a restart.
 *
 * `queuedAt` is preserved, so STRICT_SESSION_MATCH_TTL_MS keeps measuring the event's
 * true age: a held event still expires on schedule and can never become immortal.
 *
 * Returns true when the event was durably returned to the queue.
 */
export function requeueDrainedPendingMeshCoordinatorEvent(event: PendingMeshCoordinatorEvent): boolean {
    const fingerprint = buildPendingEventFingerprint(event);
    if (!fingerprint.trim()) return false;

    let requeued = false;
    try {
        requeued = MeshRuntimeStore.getInstance().requeueDrainedPendingEventByFingerprint(event.meshId, fingerprint);
    } catch (e: any) {
        // No JSONL mirror to fall back on: a failure here means the hold is not
        // durable and the event will not be re-delivered after a restart.
        LOG.error(
            'MeshEvents',
            `HELD-EVENT RE-QUEUE FAILED — ${event.event} for mesh ${event.meshId} was NOT durably returned to the queue `
            + `(SQLite is the only store): ${e?.message || e}`,
        );
        return false;
    }
    return requeued;
}

/**
 * Drain and return pending coordinator events for meshId, marking the drained rows
 * consumed in the SQLite inbox.
 *
 * When `opts.onlyEvents` is supplied, ONLY events whose name is in that set are
 * drained; every other event stays queued (undrained). The reconcile loop uses this
 * to force-drain terminal/force-inject events into a *generating* coordinator while
 * leaving non-force progress events for the coordinator's next idle transition. The
 * atomic SQLite drained=1 marking keeps force-drain and a concurrent full drain from
 * double-consuming.
 */
export function drainPendingMeshCoordinatorEvents(
    meshId?: string,
    coordinatorDaemonId?: string | ReadonlyArray<string>,
    opts?: {
        onlyEvents?: ReadonlySet<string>;
        drainerIdentity?: CoordinatorIdentity;
        /** REFINE-EVENT-SESSION-SCOPED-UNICAST ambiguity guard (observability only —
         *  never changes what is delivered). Absent → guard inert. */
        countLiveCoordinatorSessions?: (daemonId: string) => number;
    },
): PendingMeshCoordinatorEvent[] {
    if (!meshId) return [];

    // A daemon may answer to more than one coordinator-id form (its canonical
    // status id like `standalone_<machineId>` AND the bare machineId). Normalise
    // to a list so the SQLite IN-filter accepts any of them.
    const daemonIds = normalizeCoordinatorDaemonIds(coordinatorDaemonId);

    // B3a: the drainer's v2 identity, for unicast routing + eventId dedup. Derived
    // from the daemon ids the (untouchable) reconcile-loop already passes, so no
    // caller change is required; a caller may still pass the full identity.
    const drainer = resolveDrainerIdentity(daemonIds, opts?.drainerIdentity);
    // Snapshot the ALREADY-drained v2 eventIds BEFORE the SQLite drain marks this
    // batch drained=1 — the re-delivery dedup baseline. Reading it after would
    // self-match the batch's own rows.
    let priorDrainedEventIds = new Set<string>();
    try {
        priorDrainedEventIds = MeshRuntimeStore.getInstance().drainedEventIdsForMesh(meshId);
    } catch { /* store unavailable — no durable baseline; batch guard still applies */ }

    const onlyEvents = opts?.onlyEvents;

    // SQLite is the sole store, and UNIQUE (mesh_id, fingerprint) already guarantees
    // one row per event, so no cross-store fingerprint merge is needed here — the
    // former pushUnique() existed only to collapse the SQLite/JSONL dual-store copy.
    const merged: PendingMeshCoordinatorEvent[] = [];

    try {
        const store = MeshRuntimeStore.getInstance();
        if (store.pendingEventCount(meshId) > 0) {
            // Record WHO drained these rows (REFINE-EVENT-SESSION-SCOPED-UNICAST
            // observability). Serialized here rather than in the store so the store stays
            // identity-agnostic. Undefined drainer → NULL, unchanged from before.
            const drainedBy = drainer ? JSON.stringify(drainer) : null;
            for (const row of store.drainPendingEvents(
                meshId,
                daemonIds.length > 0 ? daemonIds : undefined,
                { ...(onlyEvents ? { onlyEvents } : {}), drainedBy },
            )) {
                const event = row.payload as PendingMeshCoordinatorEvent;
                if (event) merged.push(event);
            }
        }
    } catch (e: any) {
        // With the JSONL mirror retired there is no second store to fall back on, so
        // a failure here means NOTHING drained this cycle — no half-drain, and no
        // duplicate re-delivery on the next tick (the old failure mode, where the
        // JSONL copy was emptied while the SQLite rows stayed undrained).
        //
        // Nothing was consumed, so events are not lost: the next tick retries them.
        // Log-once then debug — when better-sqlite3 is unavailable this throws every
        // tick × mesh count, and a flood would bury the diagnosis rather than surface
        // it. The once-warn names the real consequence: delivery is STOPPED, not
        // degraded (see loggedSqlitePendingDrainFailure).
        if (!loggedSqlitePendingDrainFailure) {
            loggedSqlitePendingDrainFailure = true;
            LOG.warn('MeshEvents', `SQLite pending-event drain failed for mesh ${meshId} — NO events can be delivered while the store is unavailable (there is no fallback store; further occurrences at debug): ${e?.message || e}`);
        } else {
            LOG.debug('MeshEvents', `SQLite pending-event drain failed for mesh ${meshId}; no events delivered this cycle: ${e?.message || e}`);
        }
    }

    if (merged.length === 0) return [];
    // (Former R3 direct-delivered dedup removed.) Spontaneous PTY direct-inject no
    // longer exists — delivery is now queue-drain-only (reconcile loop or MCP pull),
    // so an event is consumed by exactly one drainer via the atomic SQLite drained=1
    // marking. There is no PTY-vs-poll double path left to dedup against.
    //
    // B3a: v2 receive-side routing (accept-and-warn) — unicast targeting, eventId
    // idempotency, malformed-envelope pass-through-with-warn. v1 events broadcast.
    // Runs AFTER the merge/reconcile so a single eventId dedup batch covers both
    // stores. Non-destructive to v1 behaviour when no drainer identity is known.
    const routed = routeV2EventsForDrainer(merged, drainer, {
        alreadyDrained: (eventId) => priorDrainedEventIds.has(eventId),
        batchSeen: new Set<string>(),
        countMetrics: true,
        ...(opts?.countLiveCoordinatorSessions ? { countLiveCoordinatorSessions: opts.countLiveCoordinatorSessions } : {}),
    });
    return reconcilePendingMeshCoordinatorEvents(meshId, routed);
}

/**
 * FALSE-BLOCKER-CLONE-QUEUE: retract any still-UNDELIVERED `mesh:dispatch_blocked`
 * actionable-skip event for a task whose blocker has since resolved (the task was
 * claimed, or its skip transitioned to a self-resolving transient reason). Without
 * this, a `target_node_id_unmatched` blocker paged during the brief clone/bootstrap
 * propagation window would linger in the coordinator's pending queue and surface as a
 * false "actionable blocker — will NOT clear on its own" even after the task dispatched.
 *
 * Only removes events that have NOT yet been drained/delivered to the coordinator — an
 * already-delivered message cannot be unsent, but de-dup re-arm (caller side) plus this
 * retraction guarantee no NEW stale blocker accumulates. Best-effort. Returns rows removed.
 */
export function retractPendingDispatchBlockedEvent(
    meshId: string | undefined,
    taskId: string | undefined,
    coordinatorDaemonId?: string,
): number {
    if (!meshId || !taskId) return 0;
    let removed = 0;
    const matchesTask = (event: PendingMeshCoordinatorEvent | undefined): boolean => {
        if (!event || event.event !== 'mesh:dispatch_blocked') return false;
        const rowTaskId = readNonEmptyString((event.metadataEvent as Record<string, unknown> | undefined)?.taskId);
        return rowTaskId === taskId;
    };

    // SQLite inbox: peek undrained rows for the mesh, hard-delete the matching ones by id.
    try {
        const store = MeshRuntimeStore.getInstance();
        const ids: string[] = [];
        for (const row of store.peekPendingEvents(meshId)) {
            if (row.event !== 'mesh:dispatch_blocked') continue;
            if (matchesTask(row.payload as PendingMeshCoordinatorEvent)) ids.push(row.id);
        }
        if (ids.length) removed += store.deletePendingEventsById(ids);
    } catch (e: any) {
        // Best-effort: a failed retraction leaves a stale blocker visible to the
        // coordinator, which is noisy but not lossy.
        LOG.warn('MeshEvents', `Failed to retract dispatch_blocked for task ${taskId} on mesh ${meshId}: ${e?.message || e}`);
    }
    return removed;
}

/** Peek at pending coordinator events without draining (non-destructive). */
export function getPendingMeshCoordinatorEvents(
    meshId?: string,
    coordinatorDaemonId?: string | ReadonlyArray<string>,
    opts?: { drainerIdentity?: CoordinatorIdentity },
): readonly PendingMeshCoordinatorEvent[] {
    if (!meshId) return [];
    const daemonIds = normalizeCoordinatorDaemonIds(coordinatorDaemonId);
    // B3a: same v2 routing the destructive drain applies, so a peek (mesh_status
    // count, reconcile pre-check) sees the SAME set the drain would deliver — a
    // unicast event for another coordinator is not counted for this one.
    const drainer = resolveDrainerIdentity(daemonIds, opts?.drainerIdentity);
    let priorDrainedEventIds = new Set<string>();
    try {
        priorDrainedEventIds = MeshRuntimeStore.getInstance().drainedEventIdsForMesh(meshId);
    } catch { /* store unavailable — batch guard still applies */ }

    // SQLite inbox (non-destructive peek at undrained rows). UNIQUE (mesh_id,
    // fingerprint) already guarantees one row per event, so no cross-store dedup
    // is needed — that only existed to collapse the retired JSONL mirror's copy.
    const merged: PendingMeshCoordinatorEvent[] = [];
    try {
        const store = MeshRuntimeStore.getInstance();
        if (store.pendingEventCount(meshId) > 0) {
            for (const row of store.peekPendingEvents(meshId, daemonIds.length > 0 ? daemonIds : undefined)) {
                const event = row.payload as PendingMeshCoordinatorEvent;
                if (event) merged.push(event);
            }
        }
    } catch {
        // Non-destructive path (status counts, reconcile pre-checks): a store failure
        // reports "nothing pending". The destructive drain logs the same failure
        // loudly, so this stays quiet to avoid flooding the frequent poll path.
    }

    // (Former R3 direct-delivered filter removed — no PTY direct-inject path exists
    // anymore, so a peeked pending event has genuinely not yet been consumed.)
    // B3a: apply the SAME v2 routing the drain applies (non-destructive: no counter
    // inflation on the frequent status-poll path).
    const routed = routeV2EventsForDrainer(merged, drainer, {
        alreadyDrained: (eventId) => priorDrainedEventIds.has(eventId),
        batchSeen: new Set<string>(),
        countMetrics: false,
    });
    return reconcilePendingMeshCoordinatorEvents(meshId, routed)
        .map((event) => annotatePendingEventWithTurnProjection(meshId, event));
}

/**
 * TURN-PRESENTATION (Stage 6): annotate a peeked pending event with the
 * authoritative attempt identity + causal stage from the turn projection, so
 * coordinator/MCP pending-event surfaces label completion / approval / choice /
 * finalizing from the SAME authority as every other surface. Read-only: the
 * event payload and all routing/dedup semantics are unchanged; events whose
 * task has no attempt pass through untouched (legacy fallback).
 */
function annotatePendingEventWithTurnProjection(meshId: string, event: PendingMeshCoordinatorEvent): PendingMeshCoordinatorEvent {
    try {
        const taskId = typeof event?.metadataEvent?.taskId === 'string' ? event.metadataEvent.taskId.trim() : '';
        if (!taskId) return event;
        const row = resolveTurnAttemptRow({ meshId, taskId });
        if (!row) return event;
        return {
            ...event,
            attemptId: row.attemptId,
            turnStage: row.stage,
            ...(row.terminalOutcome ? { terminalOutcome: row.terminalOutcome } : {}),
        };
    } catch {
        return event;
    }
}

/**
 * Test helper: purge all pending-event state for a mesh — SQLite rows,
 * including drained fingerprint history.
 */
export function __clearMeshPendingEventsForTests(meshId: string): void {
    try {
        MeshRuntimeStore.getInstance().clearPendingEventsForMesh(meshId);
    } catch { /* store unavailable — nothing to clear */ }
    clearPendingMeshCoordinatorEvents(meshId);
}

/**
 * Test helper: persist a pending event VERBATIM, skipping the emit-time v2 stamp.
 * The local emit path (queuePendingMeshCoordinatorEvent → stampPendingEventV2) now
 * always mints a v2 envelope (self-daemon broadcast fallback when no coordinator
 * identity is present), so a genuinely-unversioned (v1) row can no longer be produced
 * through the normal queue. The drain-side v1 handling (accept-broadcast / enforce-
 * quarantine) still matters for durable v1 rows written by a pre-v2 daemon and for
 * version-skewed remote relays, so tests inject those rows directly through this.
 */
export function __persistUnstampedPendingEventForTests(event: PendingMeshCoordinatorEvent): boolean {
    return persistPendingMeshCoordinatorEvent(event);
}

// ---------------------------------------------------------------------------
// event_held → pending requeue (T6 recovery path)
// ---------------------------------------------------------------------------
// T6 quarantine (v2 enforce) and the pending-events trim both mirror a
// destructively-drained-but-undelivered event into the ledger as a recoverable
// `event_held` entry. Until now that recovery channel was audit-only: the comment
// said "an operator can requeue it" but no code path did. This restores those held
// events to the pending queue so a coordinator drains them on its next poll.
//
// No-loss + no-double-requeue invariants:
//   • The full original event rides on the held payload as `heldEvent`, so the
//     restore is byte-for-byte (metadataEvent, coordinatorMessage, v2 envelope).
//   • queuePendingMeshCoordinatorEvent runs the normal dedup (fingerprint / eventId),
//     so an event still live in the queue is not duplicated.
//   • Every held entry that has ALREADY been requeued is marked with an
//     `event_held_requeued` ledger entry keyed by the source held-entry id; a later
//     pass skips those ids, so calling the tool twice does not requeue the same held
//     event twice.

/** Narrowing filter for {@link requeueHeldMeshCoordinatorEvents}, scoped within one mesh. */
export interface MeshHeldEventRequeueFilter {
    /** Restore only held events whose worker task id matches (from the held event's metadata/taskId). */
    taskId?: string;
    /** Restore only held events originating from this node. */
    nodeId?: string;
    /** Restore only held events of this event name (e.g. 'session:completed'). */
    event?: string;
    /** Restore only held entries recorded at/after this ISO timestamp. */
    since?: string;
    /** Restore only held entries with this hold reason (e.g. 'pending_trim_dropped'). */
    reason?: string;
}

export interface MeshHeldEventRequeueResult {
    meshId: string;
    /** event_held entries considered after the filter. */
    matched: number;
    /** entries skipped because a prior requeue already recovered them. */
    alreadyRequeued: number;
    /** entries skipped because they carried no restorable original event / were not recoverable. */
    unrecoverable: number;
    /** entries handed to the pending queue (some may have been dedup-suppressed downstream). */
    requeued: number;
    /** of `requeued`, how many the pending-queue dedup collapsed onto a live event. */
    dedupSuppressed: number;
    entries: Array<{
        heldEntryId: string;
        event: string;
        nodeId?: string;
        taskId?: string;
        reason?: string;
        outcome: 'requeued' | 'already_requeued' | 'unrecoverable';
    }>;
}

/** Read the taskId a held event carried, checking the restored event then the audit payload. */
function readHeldTaskId(restored: PendingMeshCoordinatorEvent | undefined, payload: Record<string, unknown>): string {
    const fromMeta = restored?.metadataEvent && typeof restored.metadataEvent === 'object'
        ? readNonEmptyString((restored.metadataEvent as Record<string, unknown>).taskId)
        : '';
    return fromMeta || readNonEmptyString(payload.taskId) || '';
}

/**
 * Restore recoverable `event_held` ledger entries back to the pending coordinator
 * queue for `meshId`. See the block comment above for the no-loss / no-double-requeue
 * invariants. Returns per-entry outcomes for the caller to surface.
 */
export function requeueHeldMeshCoordinatorEvents(
    meshId: string,
    filter?: MeshHeldEventRequeueFilter,
): MeshHeldEventRequeueResult {
    const result: MeshHeldEventRequeueResult = {
        meshId,
        matched: 0,
        alreadyRequeued: 0,
        unrecoverable: 0,
        requeued: 0,
        dedupSuppressed: 0,
        entries: [],
    };

    const all = readLedgerEntries(meshId);
    // held-entry ids already recovered by a prior requeue pass (dedup key = source id).
    const requeuedIds = new Set<string>();
    for (const entry of all) {
        if (entry.kind !== 'event_held_requeued') continue;
        const id = readNonEmptyString(entry.payload?.heldEntryId);
        if (id) requeuedIds.add(id);
    }

    const sinceMs = filter?.since ? new Date(filter.since).getTime() : NaN;
    const wantEvent = readNonEmptyString(filter?.event);
    const wantNode = readNonEmptyString(filter?.nodeId);
    const wantTask = readNonEmptyString(filter?.taskId);
    const wantReason = readNonEmptyString(filter?.reason);

    for (const entry of all) {
        if (entry.kind !== 'event_held') continue;
        const payload = (entry.payload && typeof entry.payload === 'object') ? entry.payload : {};
        if (payload.recoverable !== true) continue;

        // Reconstruct the original event: prefer the full `heldEvent` copy; fall back to
        // the flat audit fields for entries written before the copy was embedded.
        const restored: PendingMeshCoordinatorEvent | undefined =
            (payload.heldEvent && typeof payload.heldEvent === 'object')
                ? { ...(payload.heldEvent as PendingMeshCoordinatorEvent) }
                : undefined;

        const eventName = restored?.event || readNonEmptyString(payload.event);
        const nodeId = restored?.nodeId || entry.nodeId || readNonEmptyString((payload as any).nodeId) || undefined;
        const taskId = readHeldTaskId(restored, payload as Record<string, unknown>);
        const reason = readNonEmptyString(payload.reason) || undefined;

        // Apply the caller filter within the mesh scope.
        if (wantEvent && eventName !== wantEvent) continue;
        if (wantNode && nodeId !== wantNode) continue;
        if (wantTask && taskId !== wantTask) continue;
        if (wantReason && reason !== wantReason) continue;
        if (filter?.since && !Number.isNaN(sinceMs) && new Date(entry.timestamp).getTime() < sinceMs) continue;

        result.matched++;

        if (requeuedIds.has(entry.id)) {
            result.alreadyRequeued++;
            result.entries.push({ heldEntryId: entry.id, event: eventName, ...(nodeId ? { nodeId } : {}), ...(taskId ? { taskId } : {}), ...(reason ? { reason } : {}), outcome: 'already_requeued' });
            continue;
        }

        if (!restored || !readNonEmptyString(restored.event) || !readNonEmptyString(restored.meshId)) {
            result.unrecoverable++;
            result.entries.push({ heldEntryId: entry.id, event: eventName, ...(nodeId ? { nodeId } : {}), ...(taskId ? { taskId } : {}), ...(reason ? { reason } : {}), outcome: 'unrecoverable' });
            continue;
        }

        // Restore to pending. queuePendingMeshCoordinatorEvent re-stamps/dedups; a live
        // duplicate is suppressed there (returns true) so we never double-deliver.
        const beforeDup = hasPendingCoordinatorEventDuplicate(restored);
        let ok = false;
        try {
            ok = queuePendingMeshCoordinatorEvent(restored);
        } catch (e: any) {
            LOG.warn('MeshEvents', `Requeue of held ${eventName} for mesh ${meshId} failed: ${e?.message || e}`);
        }

        // Mark the source held entry so a second pass skips it, regardless of whether the
        // queue dedup collapsed it (the recovery attempt is what we dedup on, not delivery).
        appendLedgerEntry(meshId, {
            kind: 'event_held_requeued',
            ...(nodeId ? { nodeId } : {}),
            payload: {
                heldEntryId: entry.id,
                event: eventName,
                requeued: ok,
                ...(taskId ? { taskId } : {}),
                ...(reason ? { reason } : {}),
                ...(beforeDup ? { dedupSuppressed: true } : {}),
            },
        });
        requeuedIds.add(entry.id);

        result.requeued++;
        if (beforeDup) result.dedupSuppressed++;
        result.entries.push({ heldEntryId: entry.id, event: eventName, ...(nodeId ? { nodeId } : {}), ...(taskId ? { taskId } : {}), ...(reason ? { reason } : {}), outcome: 'requeued' });
    }

    return result;
}

/** Explicitly clear all pending coordinator events for a mesh (and coordinator if scoped). */
export function clearPendingMeshCoordinatorEvents(meshId?: string, _coordinatorDaemonId?: string): void {
    if (!meshId) return;
    try { MeshRuntimeStore.getInstance().clearPendingEventsForMesh(meshId); } catch { /* store unavailable */ }
}
