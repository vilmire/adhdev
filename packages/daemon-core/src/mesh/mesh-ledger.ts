/**
 * Mesh record vocabulary + worker-result helpers.
 *
 * Until C-W9a this module was the append-only mesh event ledger (SQLite
 * event-ledger table + a per-mesh JSONL mirror, read cache, rotation,
 * compaction, archive sidecars and a P2P import path). All of that is gone:
 *
 *   · WRITE — `meshRecord(meshId, kind, scalars, { local })` (mesh-record.ts):
 *     the content-free projection on `mesh.<id>.events` + the full payload as a
 *     local `mesh_local_records` row.
 *   · READ — mesh-local-records.ts (this machine's records + the turn ledger's
 *     task outcomes) and mesh-topic-index.ts (the fleet view).
 *
 * What stays here is the shared vocabulary those two speak — `MeshLedgerKind`
 * / `MeshLedgerEntry` (the reader shape of a record, kept under its old name so
 * the ~40 consumers and the mcp-server's type imports are unchanged) — plus the
 * worker-result parsing helpers and the recovery-context builder.
 */

import type { MeshTaskDifficulty } from '@adhdev/mesh-shared';
import { extractJsonObjectFromSummary } from '../shared/worker-result-parse.js';
import {
    coordinatorIdentityFromEmitFields,
    MESH_PROTOCOL_VERSION_V2,
    type MeshLedgerOriginatingCoordinatorV2,
} from './contracts.js';
import type { LocalRecordProjection } from './mesh-local-record-store.js';

// ─── Types ──────────────────────────────────────

export type MeshLedgerKind =
    | 'task_dispatched'
    // LEDGER-TASK-TRACEABILITY (C): a queue task transitioned pending→assigned (a
    // node/session claimed it). Distinct from task_dispatched (the message was handed
    // to the transport): claim precedes dispatch and marks the lifecycle handoff.
    // payload: { taskId, nodeId, sessionId, providerType?, claimedAt }
    | 'task_claimed'
    | 'task_completed'
    | 'task_failed'
    | 'task_stalled'
    | 'task_approval_needed'
    // Retraction for the task_approval_needed LEVEL assertion. Emitted only after
    // an approval/rejection button was actually dispatched successfully.
    // payload: { taskId?, event: 'agent:approval_resolved', resolution, source? }
    | 'task_approval_resolved'
    // A worker is parked on an AskUserQuestion multi-choice prompt (waiting_choice) —
    // distinct from task_approval_needed (a yes/no tool-consent modal). The coordinator
    // answers a question with mesh_answer_question, never mesh_approve (mission f1d25e11).
    // payload carries the full InteractivePrompt (promptId + questions + options).
    | 'task_question_pending'
    // A6-SILENT-REFUSAL: an atomic claim declined to hand a task to an idle session, and
    // WHICH of the nine store-level gates refused. Previously every one of them collapsed
    // into a bare `return null` → `if (!task) return false`, so a permanently-unclaimable
    // task looked identical to an empty queue. Transition-deduped (see recordClaimRefusal),
    // so a steady-state refusal records once rather than every ~4s reconcile tick.
    // payload: { reason: MeshClaimRefusalReason, detail? }
    | 'claim_refused'
    | 'p2p_dispatch_failed'
    // DISPATCH-FAILED-UNQUERYABLE: a queue dispatch failed (transport reject or hang
    // timeout) and the task was returned to pending — the record of WHY a task bounced.
    // Appended by deliverTaskToSession's failure path, which wrote it as
    // `'dispatch_failed' as any` for its whole life: not in this union, so not in
    // TASK_LIFECYCLE_LEDGER_KINDS, so persisted to the indexed SQLite task_id column as
    // NULL and invisible to every kind+taskId join. Distinct from 'p2p_dispatch_failed',
    // which is the mcp-server P2P-transport-specific row.
    // payload: { taskId, deliveryId, error, retryable, transport }
    | 'dispatch_failed'
    // DUP-CLAIM-REBIND: a dispatch was refused because the node is ALREADY working this
    // exact task on another live session, so the turn attempt was re-pointed at that
    // holder instead of being cancelled (which used to discard the holder's real
    // completion as session_mismatch). Not a failure — the work is in flight.
    // payload: { taskId, deliveryId, transport, attemptedSessionId, holderSessionId, attemptId?, rebound }
    | 'dispatch_duplicate_rebound'
    | 'session_launched'
    | 'session_auto_launch'
    | 'session_stopped'
    | 'checkpoint_created'
    | 'node_cloned'
    | 'node_joined'
    | 'node_removed'
    // WORKTREE-DELETED-WHILE-RUNNING: a managed worktree DIRECTORY was deleted.
    // Distinct from 'node_removed', which records the node leaving mesh
    // membership and is appended only when that succeeds. The directory is
    // deleted first, so a membership removal that then fails or no-ops used to
    // destroy a worktree while leaving no ledger trace at all — the node still
    // listed, its workspace gone, and nothing to attribute it to. `membershipRemoved`
    // marks that orphaned shape.
    // payload: { workspace?, worktreeBranch?, membershipRemoved, forced?, fallback?,
    //            reason?, residue?, requestedForce?, removedByRemoteDaemon? }
    | 'worktree_directory_removed'
    | 'coordinator_started'
    | 'recovery_attempted'
    | 'ledger_replicated'
    | 'ledger_reconciled'
    | 'direct_fast_forward'
    | 'delivery_unroutable'
    | 'direct_dispatch_pruned'
    | 'event_held'
    // Audit marker written by mesh_requeue_held_events when a recoverable `event_held`
    // entry is restored to the pending queue (event_held→pending). Keyed by the source
    // held-ledger-entry id so a second requeue pass skips already-recovered entries
    // (no double-requeue). payload: { heldEntryId, event, requeued: boolean, reason?, dedupSuppressed?: boolean }
    | 'event_held_requeued'
    | 'task_reclaimed'
    // REDRIVE-PROVIDER-FLIP (a): a task that had been force-reclaimed (canonically
    // `delivered_not_consumed_redrive`) was re-dispatched onto a DIFFERENT provider than the
    // one it was originally routed to. The reclaim path re-claims whatever idle session is
    // available WITHOUT recomputing routing, so this flip happens silently; live 2026-08-25/26
    // it occurred 7-8 times and each was found only by hand.
    //
    // Its own kind, not a field on task_dispatched, for the same reason queue_hold_hard_deadline
    // is its own kind: the flip is a diagnostic about WHICH provider changed and needs to be
    // greppable/queryable on its own, while every dispatch (flip or not) still writes exactly one
    // task_dispatched. A same-provider redrive writes NOTHING here — this stays a signal.
    // Emitted alongside (never instead of) the task_dispatched entry, whose payload carries the
    // same block as `redriveProvenance`.
    // payload: { taskId, deliveryId, transport, reason, reclaimCount, previousProviderType?,
    //            previousNodeId?, previousSessionId?, reclaimedAt, providerType, providerChanged }
    | 'redrive_provider_changed'
    // Gap2-A: a coordinator-recorded operating note — a runtime-accumulated
    // lesson (provider quirk, pattern to avoid, recovery lesson) persisted in
    // the ledger so it survives coordinator restarts and is provider-neutral.
    // payload: { text, category?, createdAt?, sourceCoordinator? }
    | 'coordinator_operating_note'
    // Retraction of a coordinator_operating_note. Append-only (history preserved);
    // readers filter out the targeted note so it leaves the prompt/list. Targets by
    // note id (exact) and/or by trimmed-text fingerprint (matches all notes with that
    // text). payload: { targetNoteId?, targetFingerprint?, reason?, forgottenAt? }
    | 'coordinator_operating_note_tombstone'
    // Mission audit trail: mission record mutations (mesh_mission_upsert) so the
    // ledger captures mission lifecycle, not just task events. Without these a
    // mission create / goal rewrite / status transition left no ledger trace,
    // breaking audit continuity and post-restart recovery.
    // mission_created       payload: { missionId, title, goalSummary, goalLength, goalTruncated, status }
    // mission_status_changed payload: { missionId, title, fromStatus, toStatus }
    // mission_goal_updated  payload: { missionId, title, prevGoalSummary, nextGoalSummary, prevGoalLength, nextGoalLength, goalTruncated }
    | 'mission_created'
    | 'mission_status_changed'
    | 'mission_goal_updated'
    // MAGI (Multi-Agent Ground-truth Insight) cross-verification activity. Persisted
    // so a wait=false fan-out and its later synthesis survive coordinator restarts and
    // are foldable into mesh_status (keyed by consensusGroupId).
    // magi_dispatched payload: { source:'magi', consensusGroupId, missionId?, panel?, question?, replicaCount }
    // magi_synthesis  payload: { source:'magi', consensusGroupId, missionId?, panel?, question?, synthesis }
    | 'magi_dispatched'
    | 'magi_synthesis'
    // MESH-SEND-KEYS (feature 3): audit trail for coordinator PTY key injections
    // via mesh_send_keys. Records the key ENUMS, destructive flag and result —
    // NEVER the literal text body (may carry tokens / user data).
    // payload: { keys: string[], hasDestructive: boolean, result: 'injected'|'refused'|'error',
    //            refused?: string, submits?: boolean, confirmDestructive?: boolean }
    | 'key_injection'
    // Disk/worktree retention (mission 86def38d): DETECTION-ONLY signal that a git
    // worktree present on disk has no matching live mesh node — an orphan cleanup
    // candidate. The reconcile loop emits this so the coordinator can decide whether
    // to remove it; retention NEVER auto-deletes a worktree (manual/coordinator-driven).
    // Keyed by worktreePath so a re-emit for the same orphan is idempotent (a prior
    // unresolved entry within the dedupe window suppresses the repeat).
    // payload: { worktreePath, branch?, head?, reason: 'no_matching_live_node', state: 'cleanup_candidate' }
    | 'worktree_cleanup_candidate'
    // QUEUE-HOLD-HARD-DEADLINE: an unbounded reconcile hold gate (live
    // awaiting_approval/awaiting_choice, an unresolved held waiting_* suspension, or the
    // RC.20 active-attempt-stage gate) kept a row 'assigned' past the absolute ceiling and
    // was forced to yield to the ordinary bounded reclaim. Deliberately its OWN kind rather
    // than a task_reclaimed: the breach is a diagnostic about WHICH gate went stale, and
    // folding it into task_reclaimed would inflate reclaim counts with non-reclaims. Emitted
    // at most once per (task, gate) per process — see queueHoldHardDeadlineExceeded.
    // payload: { taskId, reason: 'queue_hold_hard_deadline', gate, heldMs, ceilingMs, detail? }
    | 'queue_hold_hard_deadline'
    // ACKED-HOLD-TERMINALIZED: an acked DIRECT-DISPATCH row's indefinite synth hold was
    // force-terminalized (row → 'stale', hold row deleted) because the worker session is
    // provably unreachable — either a consecutive-read-failure death streak after a
    // live-confirmed ack, or the absolute acked-hold time ceiling. Sibling of
    // queue_hold_hard_deadline on the DIRECT-dispatch axis (that one bounds a queue row
    // held 'assigned'; this one bounds a dispatch row held 'acked'), and its own kind for
    // the same reason: the breach is a diagnostic about WHICH bound fired, and folding it
    // into task_failed would inflate failure counts with non-failures — no completion is
    // being asserted here, only that the hold is over.
    // payload: { taskId, reason: 'acked_read_failure_death' | 'acked_hold_time_ceiling',
    //            consecutiveReadFailures?, heldMs?, ceilingMs? }
    | 'acked_hold_terminalized'
    // SIBLING-DISPATCH-ORPHAN: a task's QUEUE row was abandoned (operator cancel, requeue,
    // dispatch-failure auto-fail, stranded-reclaim) while its sibling legacy direct-dispatch row
    // row was still non-terminal, so that row was force-flipped to 'stale' in the same
    // mutation. Without this the dispatch row outlived its task forever: markStaleDirectDispatches
    // only sweeps status='dispatched', so an 'acked' row had NO timeout sweeper at all, and
    // buildMeshActiveWork maps a surviving 'acked' row to `generating` — rendering a CANCELLED
    // task as live work (measured: one row orphaned 12 days).
    //
    // Its own kind, and STALE rather than completed/failed, for the same reason
    // acked_hold_terminalized is: no outcome is being asserted — the worker's fate is
    // unknown and a cancel is not completion evidence (mesh-terminal-admission.ts). Folding
    // it into task_failed would inflate failure counts with non-failures. It exists at all
    // because flipping the row silently would erase the only trace that the orphan ever
    // existed — which is precisely why the original leak needed a live-DB forensic to find.
    // payload: { taskId, reason: 'queue_task_cancelled' | 'queue_task_requeued'
    //            | 'queue_task_dispatch_failed' | 'queue_task_stranded_reclaimed',
    //            dispatchStatus, sessionId?, nodeId? }
    | 'sibling_dispatch_terminalized'
    // COMPLETION-SIDE-EFFECT-EVIDENCE: async, best-effort follow-up to a `code_change`
    // task's `task_completed` entry, checking whether the completing node's workspace
    // actually has a git diff. A local-only git status read (no P2P — see cost guard on
    // the appending call site) run AFTER the completion already landed, so it is its OWN
    // kind rather than mutating task_completed (the ledger is append-only) or folding into
    // task_completed's counters (a clean-tree completion is not necessarily a failure —
    // "nothing to change" can be the correct outcome of an investigation task). Purely
    // informational: never flips task status, never blocks/delays completion delivery.
    // payload: { taskId, sessionId, nodeId, workspace, gitDirty: false, changedFiles: 0,
    //            reason: 'no_side_effects' }
    | 'task_completion_no_side_effects'
    // GRAPH-ORCHESTRATION Phase E — enqueue/graph provenance (design :733-757).
    //
    // ★ CONTENT BOUNDARY: these payloads carry IDENTIFIERS, COUNTS, ENUMS and
    // DIGESTS only. Design :737-738 is explicit — "Message contents and bound
    // output values are excluded; only sizes and digests are emitted." A task
    // message, a bound upstream value, or a gate's free-text instructions must
    // never be written into a graph ledger payload; a digest or a byte count is
    // the correct way to make one auditable.
    //
    // graph_enqueue_committed payload:
    //   { graphId, batchId, enqueueSurface, schemaVersion, planDigest, missionId?,
    //     coordinatorSessionId?, taskCount, gateCount, workspaceCount,
    //     dependencyEdgeCount, onDependencyFailure, orchestrationDecision?, replayed? }
    // graph_enqueue_validation_failed payload: { code, batchId?, taskCount?, gateCount? }
    // graph_enqueue_rolled_back payload: { batchId?, code, taskCount? }
    //   ★ design :752-753 — a rollback record MUST be written in a FRESH
    //   transaction after the failed graph transaction, otherwise the audit row
    //   rolls back together with the data it exists to describe. The ledger is a
    //   separate JSONL append, so this holds by construction here.
    | 'graph_enqueue_committed'
    | 'graph_enqueue_validation_failed'
    | 'graph_enqueue_rolled_back'
    // design :697-731 — the enqueue-decision record for the SINGLE-task surface.
    //
    // ★ Its own kind rather than a graph_enqueue_committed with empty graph fields:
    // a single enqueue commits no graph, so it has no graphId, batchId or planDigest,
    // and synthesizing them would corrupt every graph count that joins on those. The
    // design's two adoption metrics are computed from the two kinds together —
    // "declared eligible singles" is exactly the subset of THIS kind whose
    // orchestrationDecision.known_graph_steps >= 2.
    //
    // Same content boundary as the graph kinds: identifiers, counts, enums. The task
    // MESSAGE is never written here; taskId is the join key to the task rows.
    // payload: { taskId, enqueueSurface: 'single', missionId?, coordinatorSessionId?,
    //            orchestrationDecision, declaredEligibleSingle?, decisionMissing?,
    //            batchCapabilityAvailable? }
    | 'single_enqueue_decision'
    // GRAPH-MEASUREMENT-DIRECT — the decision record for the DIRECT dispatch surface
    // (`mesh_send_task`), the third and largest of the three dispatch surfaces.
    //
    // ★ WHY THIS KIND EXISTS. The graph-adoption investigation found 0 graphs across
    // 206 dispatches and could not say whether that was a failure, because ~67% of
    // those dispatches went out through `mesh_send_task` — a surface whose schema
    // carried no decision field at all. `single_enqueue_decision` therefore measured
    // only the enqueue minority, and its `decision_missing` count was silent about
    // the direct majority rather than evidence concerning it.
    //
    // ★ Its own kind rather than a `single_enqueue_decision` with a different
    // `enqueueSurface`, for the same reason that kind is separate from
    // graph_enqueue_committed: a direct dispatch commits no graph AND enters no
    // queue, so "declared eligible singles" (a metric over QUEUED singles) must not
    // silently absorb direct rows. Readers that want the whole picture join the three
    // kinds explicitly; readers that want one surface are not forced to filter.
    //
    // The `direct_reason` axis is distinct from `single_reason` on purpose. The
    // question a single enqueue answers is "why one step and not a graph"; the
    // question a direct dispatch answers is "why this session and not the queue" —
    // and the coordinator prompt sanctions specific answers to the second
    // (same-subject continuation, investigation→fix handoff, idle-session reuse,
    // deliberate queue bypass). `new_subject` is a legal value that self-classifies
    // as NOT sanctioned, which is what makes justified and lazy direct dispatches
    // separable after the fact.
    //
    // Same content boundary as every kind above: identifiers, counts, enums. The task
    // MESSAGE is never written here; taskId is the join key to the task rows.
    // payload: { taskId, enqueueSurface: 'direct', via, nodeId?, sessionId?, missionId?,
    //            coordinatorSessionId?, orchestrationDecision, decisionMissing?,
    //            unsanctionedDirect?, batchCapabilityAvailable? }
    | 'direct_dispatch_decision'
    // Coordinator gate lifecycle (design :740-750). payload:
    //   { graphId, gateId, ref?, action, outcome?, generation, ownerSessionId?,
    //     releaseDigest?, materializedNodeIds?, policy?, ambiguousExternalOutcome? }
    | 'graph_gate_claimed'
    | 'graph_gate_released'
    | 'graph_gate_expired'
    // A coordinator gave up on a gate (design :399, the `-> cancelled` edge).
    // Distinct from `graph_gate_released` ON PURPOSE: an abandon granted no
    // passage and produced no outcome or evidence, so folding the two together
    // would make "gave up" read as "approved" in the audit trail. payload:
    //   { graphId, gateId, ref?, action, priorState, reason, coordinatorSessionId?,
    //     force?, cancelledNodeIds?, graphStatus? }
    | 'graph_gate_abandoned'
    // A coordinator rewrote a still-pending node's spec and re-settled it
    // (mesh_graph_node_patch) — the recovery path for a node blocked on a
    // `materialization_error:*`. The base spec is otherwise the immutable plan,
    // so this is the ONE way the instruction a worker finally receives can
    // differ from the one the batch was accepted with, and it is audited as
    // such. Only patched KEY NAMES are recorded, never the patch values.
    // payload:
    //   { graphId, nodeId, ref?, queueTaskId?, patchedKeys, priorBlockedReason?,
    //     outcome, state, blockedReason?, materializationVersion, coordinatorSessionId? }
    | 'graph_node_patched'
    // QUOTA-CLAIM-GATE-LEDGER: the quota claim gate in tryAssignQueueTask (evaluateProviderQuotaGate)
    // previously only LOGGED a block (logQuotaClaimBlockTransition, LOG.info only) — no ledger
    // trace at all. That is a silent-forever risk specifically for MAGI: a kind-panel slot is
    // pinned to a single (node, provider) via requiredTags, so when that provider is
    // quota-exhausted there is no fallback candidate to escape to (unlike the ordinary
    // multi-provider claim path, which can fall through to another provider on the same node —
    // see logQuotaClaimFallbackSuccess). The replica just parks pending indefinitely with
    // nothing in the ledger to diagnose why.
    //
    // Same transition-dedup discipline as claim_refused / worktree_bootstrap_stale_bypass above,
    // NOT one entry per ~4s reconcile tick: 'blocked' fires once when a (mesh, node, session,
    // provider) gate verdict changes (first entry into the block, or the block reason/window/
    // remaining% changes), and 'cleared' fires once when that same key's block resolves
    // (evaluateProviderQuotaGate stops returning a block for it) — mirroring
    // logQuotaClaimBlockTransition / clearQuotaClaimBlockState's existing log fingerprinting so
    // the ledger records exactly the same state transitions the log line already dedupes on,
    // never a steady-state repeat.
// payload: { nodeId, sessionId, providerType, phase: 'blocked' | 'cleared' | 'overridden_by_pin',
//            reason?, window?, remainingPercent?, thresholdPercent?, previouslyBlocked?,
//            trigger?, candidateTaskId?, pinOverride? }
//            (reason/window/remainingPercent/thresholdPercent/previouslyBlocked present
//            on phase:'blocked' and 'overridden_by_pin'; 'cleared' carries just the identity
//            fields. trigger/candidateTaskId/pinOverride are added by the claim path to
//            disambiguate idle-session scans from pin-override dispatches.)
    | 'quota_claim_gate'
    ;

export interface MeshLedgerEntry {
    id: string;
    meshId: string;
    timestamp: string;
    kind: MeshLedgerKind;
    nodeId?: string;
    sessionId?: string;
    providerType?: string;
    // LEDGER-TASK-TRACEABILITY (B): the task this entry pertains to, promoted from
    // payload.taskId to a top-level base field so a task's lifecycle
    // (task_dispatched → task_claimed → task_completed/failed/stalled/reclaimed) can
    // be joined by kind+taskId without an O(n) per-entry payload scan. Optional and
    // back-compat: legacy rows never carried it — readers fall back to payload.taskId,
    // and meshRecord auto-derives it from payload.taskId for task-lifecycle
    // kinds so every such entry is uniformly queryable.
    taskId?: string;
    payload: Record<string, unknown>;
}

/** Resolve the taskId of a record: the base field, else payload.taskId (legacy rows). */
export function ledgerEntryTaskId(entry: Pick<MeshLedgerEntry, 'taskId' | 'payload'>): string | undefined {
    if (typeof entry.taskId === 'string' && entry.taskId.trim()) return entry.taskId.trim();
    const fromPayload = entry.payload && typeof entry.payload === 'object' ? (entry.payload as Record<string, unknown>).taskId : undefined;
    return typeof fromPayload === 'string' && fromPayload.trim() ? fromPayload.trim() : undefined;
}

/**
 * Whether this entry records an operator-initiated cleanup rather than a genuine
 * failure.
 *
 * ★ Accepts a `kind: string` rather than `MeshLedgerKind` so the Stage 4B roster
 * (mesh-read-model-consumers.ts) can pass a `ProjectedLedgerView` read from the
 * seqscribe replica, whose `kind` is a plain string. This widening loses nothing:
 * the first line already narrows to the three kinds it accepts and returns false
 * for everything else, so an unrecognized string was always a `false` — the union
 * was never what made this function correct.
 *
 * The four payload keys read below are all allow-listed in the Stage 4B
 * projection, which is what makes the replica path lossless for this predicate.
 */
export function isIntentionalCleanupStopEntry(
    entry: { kind: string; payload?: Record<string, unknown> | undefined },
): boolean {
    if (entry.kind !== 'session_stopped' && entry.kind !== 'task_failed' && entry.kind !== 'task_stalled') return false;
    const payload = entry.payload && typeof entry.payload === 'object' && !Array.isArray(entry.payload)
        ? entry.payload as Record<string, unknown>
        : {};
    return payload.intentional === true
        && (payload.reason === 'operator_cleanup'
            || payload.intentionalStopReason === 'operator_cleanup'
            || payload.source === 'mesh_cleanup_sessions'
            || payload.source === 'mesh_remove_node');
}

export type MeshWorkerResultStatus = 'completed' | 'failed' | 'blocked' | 'partial' | 'unknown';
export type MeshProcessArtifactKind = 'process' | 'log' | 'port' | 'window' | 'session' | 'file' | 'url' | 'other';

export interface MeshValidationResultArtifact {
    command?: string;
    status: 'passed' | 'failed' | 'skipped' | 'unknown';
    durationMs?: number;
    outputPath?: string;
    summary?: string;
}

export interface MeshProcessArtifact {
    kind: MeshProcessArtifactKind;
    id?: string;
    label?: string;
    locator?: string;
    pid?: number;
    port?: number;
    url?: string;
    path?: string;
    sessionId?: string;
    keepRunning?: boolean;
    metadata?: Record<string, unknown>;
}

export interface MeshWorkerResultArtifact {
    status: MeshWorkerResultStatus;
    classification?: string;
    changedFiles: string[];
    validationResults: MeshValidationResultArtifact[];
    gitStatus?: Record<string, unknown>;
    processArtifacts: MeshProcessArtifact[];
    errors: string[];
    nextAction?: string;
    requiresUserAction: boolean;
    // NOTIF Defect-2b: `parseable_answer` = the final summary held a parseable JSON
    // ANSWER (e.g. a MAGI claim_audit / rca envelope) that is NOT worker-result-shaped
    // (no status + changedFiles/errors/…). It is still concrete evidence that the worker
    // produced a real, parseable answer — so it must NOT be labelled evidenceLevel
    // 'insufficient' — but it is NOT a self-attributing worker result, so it is deliberately
    // distinct from 'final_summary_json' and stays subject to the direct-dispatch grace gate
    // in mesh-events-stale.ts (which keys on `!== 'final_summary_json'`).
    source: 'explicit_metadata' | 'final_summary_json' | 'parseable_answer' | 'default';
}

/** The status event a completion-evidence record was built from (a type, not an emission). */
export type MeshTaskCompletionEvidenceEvent = 'agent:generating_completed' | 'agent:ready';

export interface MeshTaskCompletionEvidence {
    source: 'agent_status_event';
    event: MeshTaskCompletionEvidenceEvent;
    nodeId: string;
    sessionId: string;
    providerType?: string;
    completedAt: string;
    transcriptHandle: {
        kind: 'provider_session' | 'runtime_session';
        sessionId: string;
        providerSessionId?: string;
        finalSummaryAvailable: boolean;
    };
    workerResult: MeshWorkerResultArtifact;
    git: {
        status: 'deferred';
        reason: string;
    };
    validation: {
        status: 'deferred';
        commandsRun: string[];
        reason: string;
    };
    checkpoint: {
        attempted: false;
        reason: 'not_attempted_for_ordinary_completion';
    };
}

export interface BuildTaskCompletionEvidenceOptions {
    event: MeshTaskCompletionEvidence['event'];
    nodeId: string;
    sessionId: string;
    providerType?: string;
    providerSessionId?: string;
    finalSummary?: string;
    workerResult?: Record<string, unknown>;
    completedAt?: string;
}

export interface MeshLedgerSummary {
    meshId: string;
    totalEntries: number;
    taskDispatched: number;
    taskCompleted: number;
    taskFailed: number;
    taskStalled: number;
    sessionLaunched: number;
    checkpointCreated: number;
    lastActivityAt: string | null;
    recentFailures: number; // failures in last 30 minutes
}

export interface ReadLedgerOptions {
    tail?: number;
    since?: string;
    kind?: MeshLedgerKind[];
    /**
     * Filter to entries whose nodeId is equivalent to this daemon id. Matched via
     * daemonIdsEquivalent (not raw ===) so caller-supplied identifiers in any form
     * (mach_X vs daemon_mach_X) resolve correctly — see the canon-identity defect class.
     */
    node?: string;
}

export interface ReadLedgerSliceOptions {
    /** Return entries strictly after this entry id. If not found, starts from the beginning of the filtered set. */
    afterId?: string;
    /** Return entries at or after this timestamp. */
    since?: string;
    /** Optional event kind filter. */
    kind?: MeshLedgerKind[];
    /** Maximum entries to return. Clamped to a bounded protocol maximum. */
    limit?: number;
}

export interface MeshLedgerCursor {
    afterId: string | null;
    nextAfterId: string | null;
    limit: number;
    hasMore: boolean;
}

export interface MeshLedgerSlice {
    protocol: 'adhdev.mesh.ledger.slice.v1';
    meshId: string;
    entries: MeshLedgerEntry[];
    cursor: MeshLedgerCursor;
    summary: MeshLedgerSummary;
    sourceOfTruth: {
        kind: 'local_sqlite';
        table: 'mesh_local_records';
        bounded: true;
        maxLimit: number;
    };
}

/** Protocol maximum of a `get_mesh_ledger_slice` page (mesh-local-records.ts enforces it). */
export const MAX_LEDGER_SLICE_LIMIT = 500;

// ─── Worker Result Footer ───────────────────────

/**
 * Footer to append to worker task messages so workers output structured results
 * that the daemon parses via extractJsonObjectFromSummary / normalizeMeshWorkerResult.
 *
 * Usage: append buildWorkerTaskFooter() to the task message in mesh_send_task /
 * mesh_enqueue_task. The coordinator prompt rules instruct coordinators to do this.
 */
export function buildWorkerTaskFooter(): string {
    return `

---
When your task is done, end your final response with a JSON code block in this exact format (omit fields that don't apply):
\`\`\`json
{
  "status": "completed",
  "changedFiles": ["src/foo.ts", "tests/foo.test.ts"],
  "gitStatus": { "branch": "feat/your-branch", "committed": true, "pushed": false },
  "validationResults": [{ "command": "npm test", "status": "passed" }],
  "errors": [],
  "nextAction": "optional guidance for the coordinator"
}
\`\`\`
Valid status values: \`completed\` | \`failed\` | \`blocked\` | \`partial\`.`;
}

// ─── Core API ───────────────────────────────────

function readNonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.map(item => readNonEmptyString(item)).filter(Boolean) as string[];
}

/**
 * Re-exported from `shared/worker-result-parse.ts` (moved there in
 * wiring-unification C-W5c so `providers/completion/completion-flush.ts` —
 * which must never import `mesh/**` — can compute the graph output
 * envelope's `workerResult` for a LOCAL completion the same way this ledger
 * evidence record always has, without a boundary violation). Kept as a
 * re-export here so this file's own existing callers are unaffected.
 */
export { extractJsonObjectFromSummary } from '../shared/worker-result-parse.js';

function normalizeValidationResults(value: unknown): MeshValidationResultArtifact[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter(item => item && typeof item === 'object' && !Array.isArray(item))
        .map((item: any) => {
            const status = ['passed', 'failed', 'skipped', 'unknown'].includes(item.status) ? item.status : 'unknown';
            return {
                ...(readNonEmptyString(item.command) ? { command: readNonEmptyString(item.command) } : {}),
                status,
                ...(Number.isFinite(Number(item.durationMs)) ? { durationMs: Number(item.durationMs) } : {}),
                ...(readNonEmptyString(item.outputPath) ? { outputPath: readNonEmptyString(item.outputPath) } : {}),
                ...(readNonEmptyString(item.summary) ? { summary: readNonEmptyString(item.summary) } : {}),
            };
        });
}

function normalizeProcessArtifacts(value: unknown): MeshProcessArtifact[] {
    if (!Array.isArray(value)) return [];
    const kinds = new Set(['process', 'log', 'port', 'window', 'session', 'file', 'url', 'other']);
    return value
        .filter(item => item && typeof item === 'object' && !Array.isArray(item))
        .map((item: any) => ({
            kind: kinds.has(item.kind) ? item.kind : 'other',
            ...(readNonEmptyString(item.id) ? { id: readNonEmptyString(item.id) } : {}),
            ...(readNonEmptyString(item.label) ? { label: readNonEmptyString(item.label) } : {}),
            ...(readNonEmptyString(item.locator) ? { locator: readNonEmptyString(item.locator) } : {}),
            ...(Number.isFinite(Number(item.pid)) ? { pid: Number(item.pid) } : {}),
            ...(Number.isFinite(Number(item.port)) ? { port: Number(item.port) } : {}),
            ...(readNonEmptyString(item.url) ? { url: readNonEmptyString(item.url) } : {}),
            ...(readNonEmptyString(item.path) ? { path: readNonEmptyString(item.path) } : {}),
            ...(readNonEmptyString(item.sessionId) ? { sessionId: readNonEmptyString(item.sessionId) } : {}),
            ...(typeof item.keepRunning === 'boolean' ? { keepRunning: item.keepRunning } : {}),
            ...(item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata) ? { metadata: item.metadata as Record<string, unknown> } : {}),
        }));
}

export function normalizeMeshWorkerResult(input?: Record<string, unknown>, source: MeshWorkerResultArtifact['source'] = 'explicit_metadata'): MeshWorkerResultArtifact {
    const raw = input && typeof input === 'object' ? input : {};
    const status = ['completed', 'failed', 'blocked', 'partial', 'unknown'].includes(String(raw.status))
        ? raw.status as MeshWorkerResultStatus
        : 'unknown';
    const gitStatus = raw.gitStatus && typeof raw.gitStatus === 'object' && !Array.isArray(raw.gitStatus)
        ? raw.gitStatus as Record<string, unknown>
        : undefined;
    return {
        status,
        ...(readNonEmptyString(raw.classification) ? { classification: readNonEmptyString(raw.classification) } : {}),
        changedFiles: readStringArray(raw.changedFiles),
        validationResults: normalizeValidationResults(raw.validationResults),
        ...(gitStatus ? { gitStatus } : {}),
        processArtifacts: normalizeProcessArtifacts(raw.processArtifacts),
        errors: readStringArray(raw.errors),
        ...(readNonEmptyString(raw.nextAction) ? { nextAction: readNonEmptyString(raw.nextAction) } : {}),
        requiresUserAction: raw.requiresUserAction === true,
        source,
    };
}

/**
 * NOTIF Defect-2b: does the summary contain ANY parseable JSON object answer (not just a
 * worker-result-shaped one)? Some providers (and every MAGI replica) emit a complete, valid
 * answer as a JSON envelope that has no `status`/`changedFiles` worker-result fields, so
 * extractJsonObjectFromSummary returns undefined and the completion is mislabelled
 * source='default' → evidenceLevel='insufficient' even though a real answer was produced.
 * This is a conservative existence check: it only returns true when a JSON object actually
 * parses out of the summary (raw or fenced), so an empty / prose-only / unparseable summary
 * still resolves to 'default'.
 */
function summaryHasParseableJsonAnswer(summary?: string): boolean {
    const text = readNonEmptyString(summary);
    if (!text) return false;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidates = [fenced?.[1], text].filter(Boolean) as string[];
    for (const candidate of candidates) {
        const trimmed = candidate.trim();
        if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                && Object.keys(parsed).length > 0) {
                return true;
            }
        } catch { /* try next candidate */ }
    }
    return false;
}

function resolveWorkerResult(opts: BuildTaskCompletionEvidenceOptions): MeshWorkerResultArtifact {
    if (opts.workerResult && typeof opts.workerResult === 'object') {
        return normalizeMeshWorkerResult(opts.workerResult, 'explicit_metadata');
    }
    const parsed = extractJsonObjectFromSummary(opts.finalSummary);
    if (parsed) {
        return normalizeMeshWorkerResult(parsed, 'final_summary_json');
    }
    // NOTIF Defect-2b: no worker-result-shaped JSON, but a parseable JSON answer IS present
    // (the common MAGI / answer-only case). Treat it as concrete evidence so the completion is
    // not labelled 'insufficient', while keeping the worker-result fields empty (status stays
    // 'unknown') — we only know an answer parsed, not its task outcome.
    if (summaryHasParseableJsonAnswer(opts.finalSummary)) {
        return normalizeMeshWorkerResult(undefined, 'parseable_answer');
    }
    return normalizeMeshWorkerResult(undefined, 'default');
}

export function buildTaskCompletionEvidence(opts: BuildTaskCompletionEvidenceOptions): MeshTaskCompletionEvidence {
    const providerSessionId = opts.providerSessionId?.trim() || undefined;
    const providerType = opts.providerType?.trim() || undefined;
    return {
        source: 'agent_status_event',
        event: opts.event,
        nodeId: opts.nodeId,
        sessionId: opts.sessionId,
        providerType,
        completedAt: opts.completedAt || new Date().toISOString(),
        transcriptHandle: {
            kind: providerSessionId ? 'provider_session' : 'runtime_session',
            sessionId: opts.sessionId,
            providerSessionId,
            finalSummaryAvailable: typeof opts.finalSummary === 'string' && opts.finalSummary.trim().length > 0,
        },
        workerResult: resolveWorkerResult(opts),
        git: {
            status: 'deferred',
            reason: 'ordinary_completion_git_status_not_checked',
        },
        validation: {
            status: 'deferred',
            commandsRun: [],
            reason: 'ordinary_completion_validation_not_run',
        },
        checkpoint: {
            attempted: false,
            reason: 'not_attempted_for_ordinary_completion',
        },
    };
}

/**
 * Build the v2 originating-coordinator stamp for a task_dispatched ledger entry
 * (B2a / design decision §2). This is the source of truth from which a worker's
 * completion emit later restores `dispatchedBy` — it records which coordinator
 * dispatched the task, so the terminal event can be routed (unicast) back to it.
 *
 * Nested under `payload.originatingCoordinator`; additive, so existing readers
 * of the task_dispatched payload are unaffected. Returns undefined when no
 * coordinator daemon id is known (the pre-v2 path) so the caller omits the stamp
 * entirely rather than writing a malformed identity — those entries stay v1 and
 * are broadcast-treated during rollout.
 */
export function buildLedgerOriginatingCoordinatorStamp(fields: {
    coordinatorDaemonId?: string | null;
    coordinatorRunId?: string | null;
    coordinatorSessionId?: string | null;
}): MeshLedgerOriginatingCoordinatorV2 | undefined {
    const originatingCoordinator = coordinatorIdentityFromEmitFields({
        daemonId: fields.coordinatorDaemonId,
        coordinatorRunId: fields.coordinatorRunId,
        sessionId: fields.coordinatorSessionId,
    });
    if (!originatingCoordinator) return undefined;
    return { originatingCoordinator, protocolVersion: MESH_PROTOCOL_VERSION_V2 };
}

/**
 * Payload fields buildMeshActiveWork (mesh-active-work.ts) reads from ledger entries:
 * buildMeshActiveWorkLedgerSnapshot / hasTerminalLedgerAuthorityForTask /
 * directDispatchTaskId (taskId), isDirectDispatch (source, via),
 * buildLedgerDirectDispatchRecord (dispatchedToIdleSession, message, summary,
 * providerType, taskTitle, taskSummary, taskMode) and isWeakCompletionEvidence
 * (evidenceLevel, reviewRecommended, completionDiagnostic.*). Adding a payload read
 * there means adding its path here — the projection test pins the two against real
 * builder output.
 */
export const ACTIVE_WORK_LEDGER_PROJECTION: LocalRecordProjection = {
    name: 'active_work',
    paths: [
        '$.taskId',
        '$.source',
        '$.via',
        '$.dispatchedToIdleSession',
        '$.message',
        '$.summary',
        '$.providerType',
        '$.taskTitle',
        '$.taskSummary',
        '$.taskMode',
        '$.evidenceLevel',
        '$.reviewRecommended',
        '$.completionDiagnostic.finalAssistantPresent',
        '$.completionDiagnostic.transcriptFinalAssistantPresent',
        '$.completionDiagnostic.blockReason',
    ],
};

/** Payload fields buildMeshAsyncRefineJobs (mesh-refine-status.ts) reads from ledger entries. */
export const REFINE_JOB_LEDGER_PROJECTION: LocalRecordProjection = {
    name: 'refine_jobs',
    paths: [
        '$.taskId',
        '$.source',
        '$.refineJob',
        '$.retryOfJobId',
        '$.result.branch',
        '$.result.into',
        '$.result.finalBranchConvergenceState.branch',
        '$.result.finalBranchConvergenceState.baseBranch',
        '$.finalBranchConvergenceState.branch',
        '$.finalBranchConvergenceState.baseBranch',
    ],
};

/** The refine-job lifecycle kinds buildMeshAsyncRefineJobs folds. */
export const REFINE_JOB_LEDGER_KINDS: MeshLedgerKind[] = ['task_dispatched', 'task_completed', 'task_failed'];

// ─── Recovery Context ───────────────────────────

export interface SessionRecoveryContext {
    /** The original task message that was dispatched to this session/node */
    lastTaskMessage: string | null;
    /**
     * DIFFICULTY-REQUIRED (recovery inheritance): the difficulty the failed task ran
     * with, recovered from the same task_dispatched entry lastTaskMessage comes from
     * (payload.routingDecision.resolvedDifficulty, written by recordTaskDispatchedLedger).
     *
     * The recovery relaunch re-enqueues the failed task, and enqueueTask now REQUIRES a
     * difficulty — without this the relaunch could not name one, and re-classifying a task
     * the coordinator already classified would be a guess. null when the dispatch entry
     * predates resolvedDifficulty or carries an unrecognized value; the relaunch path
     * decides the fallback (it must never fail to relaunch over a missing difficulty).
     */
    lastTaskDifficulty: MeshTaskDifficulty | null;
    /** The node that was running the failed task */
    failedNodeId: string | null;
    /** Session ID of the failed session */
    failedSessionId: string | null;
    /** Provider used for the failed session */
    failedProviderType: string | null;
    /** Number of consecutive failures for this node (within recent window) */
    consecutiveNodeFailures: number;
    /** Number of times this specific task was attempted (matched by truncated message prefix) */
    taskAttemptCount: number;
    /** Whether a retry is recommended based on maxRetries policy */
    retryRecommended: boolean;
    /** Human-readable recovery advice for the coordinator */
    advice: string;
}
