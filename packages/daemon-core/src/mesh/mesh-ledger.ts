/**
 * Mesh Task Ledger — GasTown-inspired append-only JSONL task history
 *
 * Records all mesh orchestration events (task dispatch, completion, failure,
 * checkpoint, node lifecycle) as an append-only JSONL file per mesh.
 *
 * Inspired by GasTown's "Beads" pattern: every action is a versioned record
 * that persists across agent sessions, enabling recovery, auditing, and
 * continuity when individual sessions fail or context windows are exhausted.
 *
 * Storage: ~/.adhdev/mesh-ledger/<meshId>.jsonl
 * Format:  One JSON object per line, newest entries appended at end
 * Safety:  mode 0o600, atomic append via appendFileSync
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { getConfigDir } from '../config/config.js';
import { resolveLedgerRotationMaxBytes, resolveLedgerRotationMaxFiles } from './mesh-retention-config.js';
import { daemonIdsEquivalent, sessionIdsEquivalent, isMeshTaskDifficulty, type MeshTaskDifficulty } from '@adhdev/mesh-shared';
import { EventEmitter } from 'events';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import {
    coordinatorIdentityFromEmitFields,
    MESH_PROTOCOL_VERSION_V2,
    type MeshLedgerOriginatingCoordinatorV2,
} from './contracts.js';
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
    // dispatch-failure auto-fail, stranded-reclaim) while its sibling mesh_direct_dispatches
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
    // payload: { nodeId, sessionId, providerType, phase: 'blocked' | 'cleared',
    //            reason?, window?, remainingPercent?, thresholdPercent?, previouslyBlocked? }
    //            (reason/window/remainingPercent/thresholdPercent/previouslyBlocked present
    //            only on phase:'blocked'; 'cleared' carries just the identity fields.)
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
    // and appendLedgerEntry auto-derives it from payload.taskId for task-lifecycle
    // kinds so every such entry is uniformly queryable.
    taskId?: string;
    payload: Record<string, unknown>;
}

// LEDGER-TASK-TRACEABILITY (B): the kinds whose taskId base field is auto-derived
// from payload.taskId at append time (so a join by kind+taskId is uniform). Other
// kinds may still set taskId explicitly; this only backfills the common lifecycle.
const TASK_LIFECYCLE_LEDGER_KINDS: ReadonlySet<MeshLedgerKind> = new Set<MeshLedgerKind>([
    'task_dispatched',
    'task_claimed',
    'task_completed',
    'task_failed',
    'task_stalled',
    'task_reclaimed',
    'task_approval_needed',
    'task_question_pending',
    'p2p_dispatch_failed',
    'dispatch_failed',
    'dispatch_duplicate_rebound',
    'queue_hold_hard_deadline',
]);

/** Resolve the taskId for a ledger entry, preferring the base field and falling
 *  back to payload.taskId (legacy rows / entries that only carry it in payload). */
export function ledgerEntryTaskId(entry: Pick<MeshLedgerEntry, 'taskId' | 'payload'>): string | undefined {
    if (typeof entry.taskId === 'string' && entry.taskId.trim()) return entry.taskId.trim();
    const fromPayload = entry.payload && typeof entry.payload === 'object' ? (entry.payload as Record<string, unknown>).taskId : undefined;
    return typeof fromPayload === 'string' && fromPayload.trim() ? fromPayload.trim() : undefined;
}

export function isIntentionalCleanupStopEntry(entry: Pick<MeshLedgerEntry, 'kind' | 'payload'>): boolean {
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

export interface MeshTaskCompletionEvidence {
    source: 'agent_status_event';
    event: 'agent:generating_completed' | 'agent:ready';
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
        kind: 'local_jsonl';
        path: string;
        bounded: true;
        maxLimit: number;
    };
}

export interface AppendRemoteLedgerResult {
    accepted: number;
    skippedDuplicate: number;
    rejectedInvalid: number;
    entries: MeshLedgerEntry[];
}

// ─── Constants ──────────────────────────────────

const LEDGER_DIR_NAME = 'mesh-ledger';
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB — full rotation threshold
const COMPACT_THRESHOLD_BYTES = 2 * 1024 * 1024; // 2 MB — compaction threshold
const ARCHIVE_TERMINAL_OLDER_THAN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const RECENT_FAILURE_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

// Kinds that accumulate indefinitely and are safe to archive after ARCHIVE_TERMINAL_OLDER_THAN_MS.
// Non-terminal kinds (dispatched, sessions, nodes, checkpoints) are always kept in the active file.
//
// session_auto_launch is telemetry, NOT audit: it records the queue-assignment
// decision on each tick (mostly phase:'skipped' — nothing was launched). No reader
// consults it back from the ledger (unlike task_dispatched, which getSessionRecoveryContext
// scans and which therefore MUST stay non-archivable). It is the single largest
// avoidable ledger consumer after node/dispatch history, so archiving it after the
// 7-day window is the volume fix — recent entries still surface for diagnosis (and the
// per-tick dedup keeps live volume bounded), old ones move to the archive JSONL and out
// of the runtime store. This preserves observability while removing the standing bulk.
const ARCHIVABLE_KINDS: ReadonlySet<MeshLedgerKind> = new Set([
    'task_completed',
    'task_failed',
    'task_stalled',
    'recovery_attempted',
    'session_auto_launch',
] as MeshLedgerKind[]);
const DEFAULT_LEDGER_SLICE_LIMIT = 100;
export const MAX_LEDGER_SLICE_LIMIT = 500;

// ARCHIVE-PAIR-ATOMICITY (B): kinds whose archival must not break a
// dispatch↔terminal pair. `task_dispatched` is deliberately NOT in
// ARCHIVABLE_KINDS (getSessionRecoveryContext and the refine resume scanner both
// replay it), while `task_completed`/`task_failed` ARE. Without a guard the two
// halves age out asymmetrically: past ARCHIVE_TERMINAL_OLDER_THAN_MS the terminal
// row leaves the live store and its dispatch stays, so a job that finished in
// 90 seconds re-reads as permanently open. That is the 2026-08-09 → 08-16 false
// zombie: five refine jobs that all reached terminal within four minutes fired
// `resume_abandoned_stale_dispatch` a week later, because the 7-day archive window
// is far wider than the 24h zombie cutoff — making the false positive structural,
// not incidental, for any long-lived job key.
//
// The invariant: a terminal entry is archived only if its dispatch counterpart
// either goes with it or never existed in the live set. Since dispatches are never
// archivable, in practice this pins a terminal row in the live file for as long as
// its dispatch is there — the pair survives or ages out together, never half.
const PAIRED_TERMINAL_KINDS: ReadonlySet<MeshLedgerKind> = new Set([
    'task_completed',
    'task_failed',
] as MeshLedgerKind[]);

/**
 * Pairing key for the dispatch↔terminal atomicity invariant.
 *
 * Refine jobs have no taskId — their identity is `payload.refineJob.jobId` scoped
 * by nodeId, the same composite the resume scanner keys on. Ordinary queue tasks
 * use the taskId base field. Entries with neither are unpairable (returns
 * undefined) and keep the previous archive behavior.
 */
export function ledgerPairKey(entry: Pick<MeshLedgerEntry, 'kind' | 'nodeId' | 'taskId' | 'payload'>): string | undefined {
    const refineJobId = (entry.payload as any)?.refineJob?.jobId;
    if (typeof refineJobId === 'string' && refineJobId.trim() && entry.nodeId) {
        return `refine:${entry.nodeId}:${refineJobId.trim()}`;
    }
    const taskId = ledgerEntryTaskId(entry);
    return taskId ? `task:${taskId}` : undefined;
}

// ─── Operating-note growth control ──────────────
// coordinator_operating_note is append-only and, unlike task_* entries, is never
// archived by compactLedger (it is not in ARCHIVABLE_KINDS — it must survive
// restarts and there is no time-based cutoff for a "lesson"). Without dedicated
// controls the note set grows without bound and duplicate/stale notes crowd the
// bounded tail that rides into the coordinator prompt. These three constants back
// the three growth controls: dedupe-on-record, tombstone/forget, keep-latest-N.

// Kind marking an operating note as retracted. A tombstone is itself an
// append-only ledger entry (history is never destroyed); readers filter out the
// notes it targets. payload: { targetNoteId?, targetFingerprint?, reason? }
export const OPERATING_NOTE_KIND: MeshLedgerKind = 'coordinator_operating_note';
export const OPERATING_NOTE_TOMBSTONE_KIND: MeshLedgerKind = 'coordinator_operating_note_tombstone';

// Dedupe window: when recording a note, if the same trimmed text already appears
// among the most recent OPERATING_NOTE_DEDUPE_WINDOW notes, the record is a no-op
// (the existing entry is returned). Keeps the prompt tail from filling with the
// same lesson recorded 20 times.
export const OPERATING_NOTE_DEDUPE_WINDOW = 40;

// Keep-latest-N: pruneOperatingNotes retains at most this many live (non-tombstoned)
// operating notes, removing the oldest surplus and any tombstoned notes from the
// store. The prompt reads a much smaller tail (20), so this bound never trims what
// a coordinator actually sees while still capping unbounded store growth.
export const OPERATING_NOTE_KEEP_LATEST = 100;

// ─── Operating-note lifecycle: category TTL + expiry (read-side only) ──────────
// Minimal first cut of the operating-notes lifecycle. Expiry is READ/INJECTION
// side ONLY — the store prune (keep-latest-100 above) stays purely count-based
// and NEVER deletes by age, so audit history is preserved. isNoteExpired decides
// whether an UNPINNED note still rides into a coordinator prompt.
//
// Per-category retention (days). A category not listed here — including the
// uncategorized case — is durable (never expires). provider_quirk is durable
// because a runtime quirk stays true until the provider changes.
export const OPERATING_NOTE_CATEGORY_TTL_DAYS: Readonly<Record<string, number>> = {
    recovery_lesson: 14,
    pattern_to_avoid: 30,
    // provider_quirk: durable (intentionally absent → never expires)
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Shape isNoteExpired reads. Structural so mesh-ledger stays free of a
 * coordinator-prompt import (CoordinatorOperatingNote satisfies this).
 */
export interface OperatingNoteExpiryInput {
    category?: string;
    pinned?: boolean;
    createdAt?: string;
    /** Explicit expiry override; wins over the category TTL when parseable. */
    expiresAt?: string;
    /** Fallback creation time (ledger entry timestamp) when createdAt absent. */
    timestamp?: string;
}

/**
 * Pure helper: is this UNPINNED operating note expired as of `now` (epoch ms)?
 *
 * Rules:
 *  - pinned notes NEVER expire (always false).
 *  - an explicit, parseable `expiresAt` in the past → expired.
 *  - otherwise the category TTL applies; a durable category (provider_quirk,
 *    uncategorized, or any category not in the TTL map) never expires.
 *  - age is measured from createdAt, falling back to `timestamp` (ledger entry
 *    time). If neither is a valid date, the note is treated as NOT expired
 *    (never silently drop a note we cannot age).
 */
export function isNoteExpired(note: OperatingNoteExpiryInput, now: number): boolean {
    if (!note || note.pinned) return false;

    // Explicit expiresAt wins when present and parseable.
    if (typeof note.expiresAt === 'string') {
        const exp = new Date(note.expiresAt).getTime();
        if (!Number.isNaN(exp)) return exp <= now;
    }

    const ttlDays = note.category ? OPERATING_NOTE_CATEGORY_TTL_DAYS[note.category] : undefined;
    if (typeof ttlDays !== 'number' || !Number.isFinite(ttlDays)) {
        // Durable category (provider_quirk / uncategorized / unknown) → never expires.
        return false;
    }

    const created = new Date(note.createdAt ?? note.timestamp ?? '').getTime();
    if (Number.isNaN(created)) return false; // cannot age → keep

    return now - created >= ttlDays * MS_PER_DAY;
}

// ─── Path Helpers ───────────────────────────────

export function getLedgerDir(): string {
    const dir = join(getConfigDir(), LEDGER_DIR_NAME);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    return dir;
}

function getLedgerPath(meshId: string): string {
    // Sanitize meshId to prevent path traversal
    const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(getLedgerDir(), `${safe}.jsonl`);
}

function getRotatedPath(meshId: string, index: number): string {
    const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(getLedgerDir(), `${safe}.${index}.jsonl`);
}

function getArchivePath(meshId: string): string {
    const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(getLedgerDir(), `${safe}.archive.jsonl`);
}

function getRotatedArchivePath(meshId: string, index: number): string {
    const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(getLedgerDir(), `${safe}.archive.${index}.jsonl`);
}

function getArchivedTerminalKeysPath(meshId: string): string {
    const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(getLedgerDir(), `${safe}.archived-terminal-keys.json`);
}

// ARCHIVE-TERMINAL-KEY-INDEX (A): bound on the sidecar. Terminal pair keys are
// small (~60 bytes) and only ever recorded for entries that ALREADY escaped the
// pair guard (legacy asymmetric rows), so growth is slow; the cap keeps a
// long-lived mesh from accumulating an unbounded file. Oldest keys drop first —
// a key old enough to fall off has a dispatch far past every resume cutoff, so
// losing it cannot resurrect a job the scanner would act on.
const ARCHIVED_TERMINAL_KEYS_MAX = 5000;

interface ArchivedTerminalKeyIndex {
    /** Pair keys (ledgerPairKey) of terminal entries moved out of the live store, oldest→newest. */
    keys: string[];
    updatedAt: string;
}

/**
 * ARCHIVE-TERMINAL-KEY-INDEX (A): pair keys of terminal entries that were archived
 * out of the live store. The resume scanner consults this so a dispatch whose
 * completion was archived under the OLD asymmetric policy is still recognized as
 * closed, rather than re-read as an eternally-open zombie.
 *
 * Chosen over replaying `.archive.jsonl` / rotation files: those grow to tens of
 * MB and would be parsed in full on every boot scan (and on every reconcile tick,
 * once the sweep is not boot-only) purely to answer a set-membership question.
 * This index answers the same question in O(1) from a file that is orders of
 * magnitude smaller. The trade-off is that it only covers archival that happens
 * from this point on — rows stranded before this code shipped are not in it, which
 * is exactly why the D node-existence guard (the removed-node case, which covered
 * all five observed false zombies) is a separate, independent defense.
 */
export function readArchivedTerminalKeys(meshId: string): Set<string> {
    const path = getArchivedTerminalKeysPath(meshId);
    if (!existsSync(path)) return new Set();
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf-8')) as ArchivedTerminalKeyIndex;
        return new Set(Array.isArray(parsed?.keys) ? parsed.keys.filter(k => typeof k === 'string') : []);
    } catch {
        return new Set();
    }
}

/** Record the pair keys of newly archived terminal entries. Best-effort. */
function recordArchivedTerminalKeys(meshId: string, archived: MeshLedgerEntry[]): void {
    const fresh: string[] = [];
    for (const entry of archived) {
        if (!PAIRED_TERMINAL_KINDS.has(entry.kind)) continue;
        const key = ledgerPairKey(entry);
        if (key) fresh.push(key);
    }
    if (fresh.length === 0) return;
    try {
        const existing = readArchivedTerminalKeys(meshId);
        for (const key of fresh) existing.add(key);
        let keys = [...existing];
        if (keys.length > ARCHIVED_TERMINAL_KEYS_MAX) {
            keys = keys.slice(keys.length - ARCHIVED_TERMINAL_KEYS_MAX);
        }
        const index: ArchivedTerminalKeyIndex = { keys, updatedAt: new Date().toISOString() };
        writeFileSync(getArchivedTerminalKeysPath(meshId), JSON.stringify(index), { encoding: 'utf-8', mode: 0o600 });
    } catch { /* best-effort: the pair guard is the primary defense */ }
}

function getArchivedCountsPath(meshId: string): string {
    const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(getLedgerDir(), `${safe}.archived-counts.json`);
}

function rotateArchiveFile(meshId: string, archivePath: string): void {
    let index = 1;
    while (existsSync(getRotatedArchivePath(meshId, index))) {
        index++;
        if (index > 5) break;
    }
    if (index > 5) index = 5;
    try {
        renameSync(archivePath, getRotatedArchivePath(meshId, index));
    } catch (e: any) {
        process.stderr.write(`[adhdev-mesh] Archive rotation failed for mesh ${meshId}: ${e?.message || e}\n`);
    }
}

interface LedgerArchivedCounts {
    taskCompleted: number;
    taskFailed: number;
    taskStalled: number;
    recoveryAttempted: number;
    totalArchived: number;
    lastArchivedAt: string;
    /**
     * Closed rotation files whose terminal counts were already folded into this
     * rollup by the rotation-cap eviction (lifecycle retention Slice 1). Makes
     * the fold+unlink crash/restart idempotent: a file listed here is unlinked
     * without re-folding. Absent in rollups written before the cap existed.
     */
    evictedRotations?: string[];
}

function readArchivedCounts(meshId: string): LedgerArchivedCounts {
    const path = getArchivedCountsPath(meshId);
    if (!existsSync(path)) return { taskCompleted: 0, taskFailed: 0, taskStalled: 0, recoveryAttempted: 0, totalArchived: 0, lastArchivedAt: '' };
    try { return JSON.parse(readFileSync(path, 'utf-8')) as LedgerArchivedCounts; } catch { return { taskCompleted: 0, taskFailed: 0, taskStalled: 0, recoveryAttempted: 0, totalArchived: 0, lastArchivedAt: '' }; }
}

function writeArchivedCounts(meshId: string, counts: LedgerArchivedCounts): void {
    writeFileSync(getArchivedCountsPath(meshId), JSON.stringify(counts), { encoding: 'utf-8', mode: 0o600 });
}

function updateArchivedCounts(meshId: string, archived: MeshLedgerEntry[]): void {
    const counts = readArchivedCounts(meshId);
    for (const e of archived) {
        if (e.kind === 'task_completed') counts.taskCompleted++;
        else if (e.kind === 'task_failed') counts.taskFailed++;
        else if (e.kind === 'task_stalled') counts.taskStalled++;
        else if (e.kind === 'recovery_attempted') counts.recoveryAttempted++;
    }
    counts.totalArchived += archived.length;
    counts.lastArchivedAt = new Date().toISOString();
    try { writeArchivedCounts(meshId, counts); } catch { /* best-effort */ }
}

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

// ─── Ledger Compaction ──────────────────────────

/**
 * Compact the active ledger file for a mesh by moving old terminal entries
 * (task_completed, task_failed, task_stalled, recovery_attempted older than 7 days)
 * to <meshId>.archive.jsonl, keeping the active file lean.
 *
 * Non-terminal entries (dispatch, sessions, node lifecycle) are always retained.
 * Called automatically from appendLedgerEntry when the file exceeds COMPACT_THRESHOLD_BYTES.
 */
export function compactLedger(meshId: string): { archivedCount: number; retainedCount: number } {
    const filePath = getLedgerPath(meshId);
    if (!existsSync(filePath)) return { archivedCount: 0, retainedCount: 0 };

    const cutoff = Date.now() - ARCHIVE_TERMINAL_OLDER_THAN_MS;
    const entries = readLedgerEntries(meshId);

    // ARCHIVE-PAIR-ATOMICITY (B): collect the pair keys of every dispatch that will
    // REMAIN in the live file. A terminal row sharing one of those keys must stay
    // too, or the reader sees an eternally-open job (see PAIRED_TERMINAL_KINDS).
    const retainedDispatchKeys = new Set<string>();
    for (const entry of entries) {
        if (entry.kind !== 'task_dispatched') continue;
        // Dispatches are never in ARCHIVABLE_KINDS, so every one of them is retained.
        // Computed from the live set rather than assumed, so adding task_dispatched to
        // ARCHIVABLE_KINDS later degrades safely instead of silently voiding the guard.
        if (ARCHIVABLE_KINDS.has(entry.kind) && new Date(entry.timestamp).getTime() < cutoff) continue;
        const key = ledgerPairKey(entry);
        if (key) retainedDispatchKeys.add(key);
    }

    const keep: MeshLedgerEntry[] = [];
    const archive: MeshLedgerEntry[] = [];
    for (const entry of entries) {
        if (ARCHIVABLE_KINDS.has(entry.kind) && new Date(entry.timestamp).getTime() < cutoff) {
            // ARCHIVE-PAIR-ATOMICITY (B): pin a terminal row whose dispatch stays behind.
            if (PAIRED_TERMINAL_KINDS.has(entry.kind)) {
                const key = ledgerPairKey(entry);
                if (key && retainedDispatchKeys.has(key)) {
                    keep.push(entry);
                    continue;
                }
            }
            archive.push(entry);
        } else {
            keep.push(entry);
        }
    }

    if (archive.length === 0) return { archivedCount: 0, retainedCount: keep.length };

    // Append archived entries to the archive file, rotate if it exceeds 50MB
    const archivePath = getArchivePath(meshId);
    try {
        if (existsSync(archivePath) && statSync(archivePath).size > 50 * 1024 * 1024) {
            rotateArchiveFile(meshId, archivePath);
        }
        const archiveLines = archive.map(e => JSON.stringify(e)).join('\n') + '\n';
        appendFileSync(archivePath, archiveLines, { encoding: 'utf-8', mode: 0o600 });
        updateArchivedCounts(meshId, archive);
        // ARCHIVE-TERMINAL-KEY-INDEX (A): remember which job keys reached a terminal
        // state before their rows left the live store, so a reader replaying only the
        // live set does not mistake them for open.
        recordArchivedTerminalKeys(meshId, archive);
    } catch (e: any) {
        process.stderr.write(`[adhdev-mesh] Ledger archive write failed for mesh ${meshId}: ${e?.message || e}\n`);
        return { archivedCount: 0, retainedCount: entries.length };
    }

    // Rewrite active file with retained entries only
    try {
        const keepLines = keep.length ? keep.map(e => JSON.stringify(e)).join('\n') + '\n' : '';
        writeFileSync(filePath, keepLines, { encoding: 'utf-8', mode: 0o600 });
        invalidateLedgerCache(meshId);
    } catch (e: any) {
        process.stderr.write(`[adhdev-mesh] Ledger compaction rewrite failed for mesh ${meshId}: ${e?.message || e}\n`);
        return { archivedCount: archive.length, retainedCount: keep.length };
    }

    // G2: mirror the compaction in SQLite so the runtime store matches the active
    // ledger set. Archived entries live on in the JSONL archive files (export/debug).
    try {
        MeshRuntimeStore.getInstance().deleteLedgerEntries(meshId, archive.map(e => e.id));
        invalidateLedgerCache(meshId);
    } catch { /* best-effort; summary counts absorb the difference via archived counts */ }

    return { archivedCount: archive.length, retainedCount: keep.length };
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
 * Exported for the graph output envelope (mesh-event-forwarding
 * buildGraphEnvelopeWorkerResult), which needs the SAME final-summary parse the
 * ledger evidence record has always used — otherwise `envelope.worker_result`
 * is empty for every locally-completed task and documented pointers like
 * `/worker_result/validationResults` resolve to nothing.
 */
export function extractJsonObjectFromSummary(summary?: string): Record<string, unknown> | undefined {
    const text = readNonEmptyString(summary);
    if (!text) return undefined;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidates = [fenced?.[1], text].filter(Boolean) as string[];
    for (const candidate of candidates) {
        const trimmed = candidate.trim();
        if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                // Require at least one mesh worker result field to avoid false positives
                // (e.g. JSON from tool call outputs or log lines in the final summary).
                const hasWorkerShape = 'status' in parsed && (
                    'changedFiles' in parsed || 'errors' in parsed
                    || 'gitStatus' in parsed || 'nextAction' in parsed
                    || 'validationResults' in parsed
                );
                if (hasWorkerShape) return parsed;
            }
        } catch { /* try next candidate */ }
    }
    return undefined;
}

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
 * Append a new entry to the mesh ledger.
 * Handles file creation, rotation on size overflow, and atomic writes.
 */
export const meshLedgerEvents = new EventEmitter();

export function appendLedgerEntry(
    meshId: string,
    partial: Omit<MeshLedgerEntry, 'id' | 'meshId' | 'timestamp'>,
): MeshLedgerEntry {
    // Fix (1) dedupe-on-record: for a coordinator_operating_note, if the same
    // trimmed text already appears among the most recent OPERATING_NOTE_DEDUPE_WINDOW
    // notes, do NOT append a duplicate — return the existing entry so the bounded
    // prompt tail can't be crowded by the same lesson recorded repeatedly. Other
    // kinds (task_completed, …) are untouched.
    if (partial.kind === OPERATING_NOTE_KIND) {
        const text = operatingNoteText(partial.payload);
        if (text) {
            const recentNotes = readLedgerEntries(meshId, {
                kind: [OPERATING_NOTE_KIND],
                tail: OPERATING_NOTE_DEDUPE_WINDOW,
            });
            const existing = recentNotes.find(e => operatingNoteText(e.payload) === text);
            if (existing) return existing;
        }
    }

    const entry: MeshLedgerEntry = {
        id: randomUUID(),
        meshId,
        timestamp: new Date().toISOString(),
        ...partial,
    };

    // LEDGER-TASK-TRACEABILITY (B): backfill the taskId base field from payload.taskId
    // for task-lifecycle kinds so every dispatch/claim/complete/fail/stall/reclaim
    // entry is uniformly join-able by kind+taskId. An explicit partial.taskId wins.
    if (!entry.taskId && TASK_LIFECYCLE_LEDGER_KINDS.has(entry.kind)) {
        const derived = ledgerEntryTaskId(entry);
        if (derived) entry.taskId = derived;
    }

    const filePath = getLedgerPath(meshId);

    // Compact or rotate based on file size
    if (existsSync(filePath)) {
        try {
            const stat = statSync(filePath);
            if (stat.size >= MAX_FILE_SIZE_BYTES) {
                rotateLedgerFile(meshId, filePath);
            } else if (stat.size >= COMPACT_THRESHOLD_BYTES) {
                compactLedger(meshId);
            }
        } catch {
            // stat failed — proceed with append anyway
        }
    }

    // Write to SQLite (G2: primary runtime read/write path)
    try {
        MeshRuntimeStore.getInstance().appendLedgerEntry({
            id: entry.id,
            meshId: entry.meshId,
            timestamp: entry.timestamp,
            kind: entry.kind,
            nodeId: entry.nodeId ?? null,
            sessionId: entry.sessionId ?? null,
            providerType: entry.providerType ?? null,
            taskId: entry.taskId ?? null,
            payload: entry.payload,
        });
    } catch {
        // SQLite write failed but the JSONL append below still records the entry.
        // Reset the one-time import flag so the next read re-imports from JSONL
        // and the store self-heals instead of silently missing this entry.
        ledgerImportDone.delete(meshId);
    }

    // Also write to JSONL (retained as export/import/debug/legacy artifact)
    try {
        const line = JSON.stringify(entry) + '\n';
        appendFileSync(filePath, line, { encoding: 'utf-8', mode: 0o600 });
        invalidateLedgerCache(meshId);
        meshLedgerEvents.emit('append', meshId, entry);
        // Fix (3) keep-latest-N: operating notes are never archived by compactLedger,
        // so cap their store footprint here. Runs only when a note (or its tombstone)
        // is recorded, and is a no-op until the live-note count exceeds the bound.
        if (entry.kind === OPERATING_NOTE_KIND || entry.kind === OPERATING_NOTE_TOMBSTONE_KIND) {
            try { pruneOperatingNotes(meshId); } catch { /* prune is best-effort */ }
        }
        return entry;
    } catch (e: any) {
        throw new Error(`Failed to append to ledger for mesh ${meshId}: ${e.message}`);
    }
}

// ─── Operating-note growth controls ─────────────

/** Extract the trimmed note text from a coordinator_operating_note payload. */
function operatingNoteText(payload: Record<string, unknown> | undefined): string | undefined {
    const text = payload && typeof payload.text === 'string' ? payload.text.trim() : '';
    return text || undefined;
}

/**
 * Set of trimmed-text fingerprints and note ids retracted by tombstone entries in
 * the given entry set. A tombstone targets by note id and/or by text fingerprint.
 */
function collectOperatingNoteTombstones(entries: MeshLedgerEntry[]): { ids: Set<string>; fingerprints: Set<string> } {
    const ids = new Set<string>();
    const fingerprints = new Set<string>();
    for (const e of entries) {
        if (e.kind !== OPERATING_NOTE_TOMBSTONE_KIND) continue;
        const p = e.payload || {};
        const targetId = typeof p.targetNoteId === 'string' ? p.targetNoteId.trim() : '';
        const targetFp = typeof p.targetFingerprint === 'string' ? p.targetFingerprint.trim() : '';
        if (targetId) ids.add(targetId);
        if (targetFp) fingerprints.add(targetFp);
    }
    return { ids, fingerprints };
}

/** True if the operating note is retracted by any tombstone in `tombstones`. */
export function isOperatingNoteTombstoned(
    entry: Pick<MeshLedgerEntry, 'id' | 'payload'>,
    tombstones: { ids: Set<string>; fingerprints: Set<string> },
): boolean {
    if (tombstones.ids.has(entry.id)) return true;
    const text = operatingNoteText(entry.payload);
    return text ? tombstones.fingerprints.has(text) : false;
}

/**
 * Fix (2) supersede/remove: append a tombstone that retracts a coordinator
 * operating note. Targets by note id and/or by exact trimmed text (a text target
 * retracts every note with that text). History is preserved — the notes stay in
 * the ledger but readers filter them out. Returns how many currently-live notes
 * the tombstone will hide.
 */
export function tombstoneOperatingNote(
    meshId: string,
    target: { noteId?: string; text?: string; reason?: string },
): { tombstone: MeshLedgerEntry; matched: number } {
    const noteId = typeof target.noteId === 'string' ? target.noteId.trim() : '';
    const fingerprint = typeof target.text === 'string' ? target.text.trim() : '';
    if (!noteId && !fingerprint) {
        throw new Error('tombstoneOperatingNote requires a noteId or text target');
    }

    // Count currently-live matches (not already tombstoned) for the caller's report.
    const notes = readOperatingNotes(meshId);
    const matched = notes.filter(n =>
        (noteId && n.id === noteId) || (fingerprint && operatingNoteText(n.payload) === fingerprint),
    ).length;

    const tombstone = appendLedgerEntry(meshId, {
        kind: OPERATING_NOTE_TOMBSTONE_KIND,
        payload: {
            ...(noteId ? { targetNoteId: noteId } : {}),
            ...(fingerprint ? { targetFingerprint: fingerprint } : {}),
            ...(target.reason && target.reason.trim() ? { reason: target.reason.trim() } : {}),
            forgottenAt: new Date().toISOString(),
        },
    });
    return { tombstone, matched };
}

/**
 * Read live operating notes (tombstoned notes filtered out), oldest→newest.
 * `tail` bounds the number of live notes returned (the freshest N).
 */
export function readOperatingNotes(meshId: string, opts?: { tail?: number }): MeshLedgerEntry[] {
    const raw = getCachedRawEntries(meshId);
    const tombstones = collectOperatingNoteTombstones(raw);
    let notes = raw.filter(e => e.kind === OPERATING_NOTE_KIND && !isOperatingNoteTombstoned(e, tombstones));
    if (opts?.tail && opts.tail > 0 && notes.length > opts.tail) {
        notes = notes.slice(-opts.tail);
    }
    return notes;
}

/**
 * Fix (3) keep-latest-N prune for coordinator_operating_note. Removes, from the
 * store, (a) every note retracted by a tombstone, and (b) the oldest live notes
 * beyond `keepLatest`. Tombstone entries themselves are retained as an audit trail
 * of what was forgotten. Returns the number of note entries removed.
 */
export function pruneOperatingNotes(meshId: string, keepLatest: number = OPERATING_NOTE_KEEP_LATEST): number {
    const raw = getCachedRawEntries(meshId);
    const tombstones = collectOperatingNoteTombstones(raw);

    const removeIds: string[] = [];
    const liveNotes: MeshLedgerEntry[] = [];
    for (const e of raw) {
        if (e.kind !== OPERATING_NOTE_KIND) continue;
        if (isOperatingNoteTombstoned(e, tombstones)) {
            removeIds.push(e.id); // tombstoned notes are pruned first
        } else {
            liveNotes.push(e);
        }
    }

    // Drop the oldest live notes beyond keepLatest; the freshest (prompt tail) survive.
    const bound = Math.max(0, Math.floor(keepLatest));
    if (liveNotes.length > bound) {
        for (const e of liveNotes.slice(0, liveNotes.length - bound)) removeIds.push(e.id);
    }

    if (removeIds.length === 0) return 0;

    try {
        MeshRuntimeStore.getInstance().deleteLedgerEntries(meshId, removeIds);
    } catch { /* store unavailable — JSONL rewrite below still trims */ }

    // Rewrite the JSONL mirror without the pruned note entries so the export
    // artifact stays consistent with the store.
    try {
        const remaining = readLedgerFile(meshId).filter(e => !removeIds.includes(e.id));
        const filePath = getLedgerPath(meshId);
        const lines = remaining.length ? remaining.map(e => JSON.stringify(e)).join('\n') + '\n' : '';
        writeFileSync(filePath, lines, { encoding: 'utf-8', mode: 0o600 });
    } catch { /* JSONL rewrite best-effort; store is the primary read path */ }

    invalidateLedgerCache(meshId);
    return removeIds.length;
}

function clampLedgerSliceLimit(limit: unknown): number {
    if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_LEDGER_SLICE_LIMIT;
    return Math.max(1, Math.min(MAX_LEDGER_SLICE_LIMIT, Math.floor(limit)));
}

function isValidRemoteLedgerEntry(meshId: string, value: unknown): value is MeshLedgerEntry {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const entry = value as Partial<MeshLedgerEntry>;
    if (typeof entry.id !== 'string' || !entry.id.trim()) return false;
    if (entry.meshId !== meshId) return false;
    if (typeof entry.timestamp !== 'string' || Number.isNaN(new Date(entry.timestamp).getTime())) return false;
    if (typeof entry.kind !== 'string' || !entry.kind.trim()) return false;
    if (!entry.payload || typeof entry.payload !== 'object' || Array.isArray(entry.payload)) return false;
    return true;
}

/**
 * Append entries received over local-first/P2P ledger replication to the local ledger.
 * This skips deduplicated entries and rejects malformed/cross-mesh entries.
 */
export function appendRemoteLedgerEntries(meshId: string, entries: MeshLedgerEntry[]): AppendRemoteLedgerResult {
    if (entries.length === 0) return { accepted: 0, skippedDuplicate: 0, rejectedInvalid: 0, entries: [] };
    const ledgerPath = getLedgerPath(meshId);

    // Dedup against recent entries only — P2P replication is incremental (cursor-based),
    // so duplicates appear in the recent tail, not deep history.
    const existing = new Set(readLedgerEntries(meshId, { tail: 1000 }).map(e => e.id));
    const validEntries: MeshLedgerEntry[] = [];
    let rejectedInvalid = 0;
    let skippedDuplicate = 0;
    for (const entry of entries) {
        if (!isValidRemoteLedgerEntry(meshId, entry)) {
            rejectedInvalid++;
            continue;
        }
        if (existing.has(entry.id)) {
            skippedDuplicate++;
            continue;
        }
        existing.add(entry.id);
        validEntries.push(entry);
    }

    if (validEntries.length === 0) {
        return { accepted: 0, skippedDuplicate, rejectedInvalid, entries: [] };
    }

    // G2: write to SQLite (primary runtime store); INSERT OR IGNORE dedups by id.
    try {
        MeshRuntimeStore.getInstance().importLedgerEntries(validEntries.map(e => ({
            id: e.id,
            meshId: e.meshId,
            timestamp: e.timestamp,
            kind: e.kind,
            nodeId: e.nodeId ?? null,
            sessionId: e.sessionId ?? null,
            providerType: e.providerType ?? null,
            payload: e.payload ?? {},
        })));
    } catch { /* best-effort; JSONL append below still records the entries */ }

    try {
        const lines = validEntries.map(e => JSON.stringify(e)).join('\n') + '\n';
        appendFileSync(ledgerPath, lines, { encoding: 'utf-8', mode: 0o600 });
        invalidateLedgerCache(meshId);
        for (const entry of validEntries) {
            meshLedgerEvents.emit('append', meshId, entry);
        }
        return { accepted: validEntries.length, skippedDuplicate, rejectedInvalid, entries: validEntries };
    } catch (e: any) {
        throw new Error(`Failed to append remote ledger entries for mesh ${meshId}: ${e.message}`);
    }
}

// ─── Ledger Read Cache ─────────────────────────
// Absorbs repeated reads within a single event-processing burst (e.g. agent:stopped
// triggers shouldSuppressIntentionalCleanupStop, findRecentTerminalLedgerEvidence,
// hasDispatchAfterTerminal, and getSessionRecoveryContext — all reading the same store).
// TTL is 100ms: short enough to stay current, long enough to cover one event cycle.
// Cache is invalidated on every write (append, remote import, compaction).

const ledgerReadCache = new Map<string, { entries: MeshLedgerEntry[]; cachedAt: number }>();
const LEDGER_CACHE_TTL_MS = 100;

function readLedgerFile(meshId: string): MeshLedgerEntry[] {
    const filePath = getLedgerPath(meshId);
    if (!existsSync(filePath)) return [];
    let content: string;
    try { content = readFileSync(filePath, 'utf-8'); } catch { return []; }
    const entries: MeshLedgerEntry[] = [];
    for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
            const entry = JSON.parse(line) as MeshLedgerEntry;
            if (entry.id && entry.kind) {
                // LEDGER-TASK-TRACEABILITY (B): backfill the base taskId from
                // payload.taskId for legacy JSONL lines that predate the field.
                if (!entry.taskId) {
                    const derived = ledgerEntryTaskId(entry);
                    if (derived) entry.taskId = derived;
                }
                entries.push(entry);
            }
        } catch { /* skip malformed lines */ }
    }
    return entries;
}

// ─── G2: One-Time JSONL → SQLite Import ─────────
// On the first SQLite read for a mesh (per store instance), import any legacy
// JSONL entries into mesh_event_ledger. INSERT OR IGNORE makes this idempotent:
// dual-written entries are skipped, only pre-cutover legacy entries are added.
// Keyed by the store instance so MeshRuntimeStore.resetForTests() (fresh DB)
// naturally re-imports.

let ledgerImportStoreRef: MeshRuntimeStore | undefined;
const ledgerImportDone = new Set<string>();

function ensureLedgerImported(store: MeshRuntimeStore, meshId: string): void {
    if (ledgerImportStoreRef !== store) {
        ledgerImportDone.clear();
        ledgerImportStoreRef = store;
    }
    if (ledgerImportDone.has(meshId)) return;
    ledgerImportDone.add(meshId);
    const fileEntries = readLedgerFile(meshId);
    if (fileEntries.length === 0) return;
    try {
        store.importLedgerEntries(fileEntries.map(e => ({
            id: e.id,
            meshId: e.meshId,
            timestamp: e.timestamp,
            kind: e.kind,
            nodeId: e.nodeId ?? null,
            sessionId: e.sessionId ?? null,
            providerType: e.providerType ?? null,
            taskId: ledgerEntryTaskId(e) ?? null,
            payload: e.payload ?? {},
        })));
    } catch { /* import is best-effort; reads fall back to JSONL on store failure */ }
}

function readLedgerFromStore(meshId: string): MeshLedgerEntry[] {
    const store = MeshRuntimeStore.getInstance();
    ensureLedgerImported(store, meshId);
    return store.readLedgerEntriesOrdered(meshId).map(r => {
        const payload = (r.payload && typeof r.payload === 'object' ? r.payload : {}) as Record<string, unknown>;
        // LEDGER-TASK-TRACEABILITY (B): prefer the column, fall back to payload.taskId
        // for legacy rows written before the column existed (back-compat join).
        const taskId = ledgerEntryTaskId({ taskId: r.taskId ?? undefined, payload });
        return {
            id: r.id,
            meshId: r.meshId,
            timestamp: r.timestamp,
            kind: r.kind as MeshLedgerKind,
            ...(r.nodeId ? { nodeId: r.nodeId } : {}),
            ...(r.sessionId ? { sessionId: r.sessionId } : {}),
            ...(r.providerType ? { providerType: r.providerType } : {}),
            ...(taskId ? { taskId } : {}),
            payload,
        };
    });
}

function getCachedRawEntries(meshId: string): MeshLedgerEntry[] {
    const now = Date.now();
    const cached = ledgerReadCache.get(meshId);
    if (cached && now - cached.cachedAt < LEDGER_CACHE_TTL_MS) return cached.entries;
    let entries: MeshLedgerEntry[];
    try {
        // G2: SQLite mesh_event_ledger is the primary runtime read path.
        entries = readLedgerFromStore(meshId);
    } catch {
        // Store unavailable — fall back to the JSONL export artifact.
        entries = readLedgerFile(meshId);
    }
    ledgerReadCache.set(meshId, { entries, cachedAt: now });
    return entries;
}

function invalidateLedgerCache(meshId: string): void {
    ledgerReadCache.delete(meshId);
}

/**
 * Test helper: clear all runtime ledger state for a mesh — SQLite rows, read
 * cache, and the one-time import flag. JSONL files are the caller's concern.
 */
export function __clearMeshLedgerForTests(meshId: string): void {
    try {
        MeshRuntimeStore.getInstance().clearLedgerForMesh(meshId);
    } catch { /* store unavailable — nothing to clear */ }
    ledgerReadCache.delete(meshId);
    ledgerImportDone.delete(meshId);
}

/**
 * Read ledger entries with optional filtering.
 * G2: SQLite (mesh_event_ledger) is the primary read path; legacy JSONL is
 * imported once per store instance and otherwise retained as an
 * export/import/debug artifact only.
 */
export function readLedgerEntries(meshId: string, opts?: ReadLedgerOptions): MeshLedgerEntry[] {
    let entries = getCachedRawEntries(meshId);

    if (opts?.since) {
        const sinceDate = new Date(opts.since).getTime();
        if (!isNaN(sinceDate)) entries = entries.filter(e => new Date(e.timestamp).getTime() >= sinceDate);
    }
    if (opts?.kind?.length) {
        const kindSet = new Set(opts.kind);
        entries = entries.filter(e => kindSet.has(e.kind));
    }
    if (opts?.node && opts.node.trim()) {
        const node = opts.node.trim();
        entries = entries.filter(e => e.nodeId && daemonIdsEquivalent(e.nodeId, node));
    }
    if (opts?.tail && opts.tail > 0 && entries.length > opts.tail) {
        entries = entries.slice(-opts.tail);
    }
    return entries;
}

/**
 * LEDGER-KIND-TAIL-BLINDSPOT: a bare `tail: N` reads the last N entries of EVERY
 * kind, then a caller-side `.filter(e => e.kind === x)` can come up empty even
 * though a matching entry exists further back — a busy mesh produces enough
 * unrelated traffic (task_dispatched/session_auto_launch/task_claimed/... — dozens
 * of kinds feed the same ledger) to evict a still-relevant row from any fixed-size
 * window within minutes. Observed twice in production (2026-08-16, M-WORKTREE-DELETED
 * class): an in-flight Refinery job's task_dispatched row fell out of a tail:200
 * window while the job was still running, and the caller concluded no work was in
 * flight.
 *
 * Use this helper for "does an entry of kind X exist" / "find the entry of kind X"
 * reads — anything that is an existence or lookup check rather than a bounded
 * recency feed. It filters by kind FIRST (inside readLedgerEntries, before any
 * tail slicing), so an old-but-still-relevant row can never be crowded out by
 * unrelated kinds. Do NOT use this for "show recent activity" style reads (e.g.
 * dashboard feeds) — those want the last N entries regardless of kind, which is
 * what a bare `tail` is for.
 *
 * No default cap: kinds worth existence-checking (task_dispatched, task_completed,
 * task_failed, ...) are exactly the kinds mesh-ledger's compactLedger() either never
 * archives (task_dispatched) or pins via ARCHIVE-PAIR-ATOMICITY while their pair is
 * still live, so the live, kind-filtered set stays bounded by real job lifecycle
 * rather than needing an artificial ceiling — this mirrors the existing
 * router-refine-resume.ts / readOperatingNotes precedent, neither of which caps.
 * Pass `cap` only when a caller genuinely wants "the most recent N of this kind"
 * (applied AFTER the kind filter, unlike a bare `tail`) rather than the full set.
 */
export function readLedgerEntriesByKind(meshId: string, kinds: MeshLedgerKind[], cap?: number): MeshLedgerEntry[] {
    const entries = readLedgerEntries(meshId, { kind: kinds });
    if (cap && cap > 0 && entries.length > cap) {
        return entries.slice(-cap);
    }
    return entries;
}

/**
 * Build a ledger summary from pre-loaded entries. Used by both getLedgerSummary
 * and readLedgerSlice so they share a single getCachedRawEntries() call.
 */
function buildLedgerSummary(meshId: string, entries: MeshLedgerEntry[]): MeshLedgerSummary {
    const archived = readArchivedCounts(meshId);
    const now = Date.now();
    const recentFailureCutoff = now - RECENT_FAILURE_WINDOW_MS;

    const summary: MeshLedgerSummary = {
        meshId,
        totalEntries: entries.length + archived.totalArchived,
        taskDispatched: 0,
        taskCompleted: archived.taskCompleted,
        taskFailed: archived.taskFailed,
        taskStalled: archived.taskStalled,
        sessionLaunched: 0,
        checkpointCreated: 0,
        lastActivityAt: null,
        recentFailures: 0,
    };

    for (const entry of entries) {
        switch (entry.kind) {
            case 'task_dispatched': summary.taskDispatched++; break;
            case 'task_completed': summary.taskCompleted++; break;
            case 'task_failed': {
                if (isIntentionalCleanupStopEntry(entry)) break;
                summary.taskFailed++;
                if (new Date(entry.timestamp).getTime() >= recentFailureCutoff) {
                    summary.recentFailures++;
                }
                break;
            }
            case 'task_stalled': {
                if (!isIntentionalCleanupStopEntry(entry)) summary.taskStalled++;
                break;
            }
            case 'session_launched': summary.sessionLaunched++; break;
            case 'checkpoint_created': summary.checkpointCreated++; break;
        }
    }

    if (entries.length > 0) {
        summary.lastActivityAt = entries[entries.length - 1].timestamp;
    }

    return summary;
}

/**
 * Read a bounded, cursor-addressable ledger slice for local-first/P2P replication.
 * The result is intentionally small and self-describing so coordinators can query
 * remote daemons on demand without Cloud/D1 becoming a ledger data-plane.
 */
export function readLedgerSlice(meshId: string, opts?: ReadLedgerSliceOptions): MeshLedgerSlice {
    const limit = clampLedgerSliceLimit(opts?.limit);
    // Load raw entries once and share between filtering, pagination, and summary.
    const rawEntries = getCachedRawEntries(meshId);

    let entries: MeshLedgerEntry[] = rawEntries;
    if (opts?.since) {
        const sinceDate = new Date(opts.since).getTime();
        if (!isNaN(sinceDate)) entries = entries.filter(e => new Date(e.timestamp).getTime() >= sinceDate);
    }
    if (opts?.kind?.length) {
        const kindSet = new Set(opts.kind);
        entries = entries.filter(e => kindSet.has(e.kind));
    }

    const afterId = typeof opts?.afterId === 'string' && opts.afterId.trim() ? opts.afterId.trim() : null;
    if (afterId) {
        const index = entries.findIndex(entry => entry.id === afterId);
        entries = index >= 0 ? entries.slice(index + 1) : entries;
    }
    const bounded = entries.slice(0, limit);
    return {
        protocol: 'adhdev.mesh.ledger.slice.v1',
        meshId,
        entries: bounded,
        cursor: {
            afterId,
            nextAfterId: bounded.length ? bounded[bounded.length - 1].id : afterId,
            limit,
            hasMore: entries.length > bounded.length,
        },
        summary: buildLedgerSummary(meshId, rawEntries),
        sourceOfTruth: {
            kind: 'local_jsonl',
            path: getLedgerPath(meshId),
            bounded: true,
            maxLimit: MAX_LEDGER_SLICE_LIMIT,
        },
    };
}

/**
 * G4: Read a bounded ledger slice from the SQLite mesh_event_ledger table.
 * This is the preferred P2P reconcile read path; JSONL files are retained as
 * export/import/debug/legacy artifacts only.
 *
 * Returns a shape structurally compatible with MeshLedgerSlice (minus the
 * JSONL-specific `summary` and `sourceOfTruth.path` fields) so callers can
 * pass it to buildMeshLedgerReplicaEvidence without modification.
 */
export function readLedgerSliceFromStore(meshId: string, opts?: ReadLedgerSliceOptions): ReturnType<typeof MeshRuntimeStore.prototype.readLedgerSlice> {
    return MeshRuntimeStore.getInstance().readLedgerSlice(meshId, {
        afterId: opts?.afterId,
        since: opts?.since,
        // ReadLedgerSliceOptions allows kind as array; SQLite path takes a single kind string.
        // Pass first kind value if provided; callers needing multi-kind filtering should use readLedgerSlice (JSONL).
        kind: opts?.kind?.length ? opts.kind[0] : undefined,
        limit: opts?.limit,
    });
}

/**
 * Get a summary of mesh activity from the ledger.
 */
export function getLedgerSummary(meshId: string): MeshLedgerSummary {
    return buildLedgerSummary(meshId, getCachedRawEntries(meshId));
}

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

/**
 * Build recovery context for a failed session.
 * Looks up the ledger to find the original task, count failures, and advise on retry.
 */
export function getSessionRecoveryContext(
    meshId: string,
    opts: {
        sessionId?: string;
        nodeId?: string;
        maxRetries?: number;
    },
): SessionRecoveryContext {
    const maxRetries = opts.maxRetries ?? 1;
    // tail:500 is sufficient — task_dispatched is never archived (only terminal kinds are),
    // so dispatch history is always present. The 30-min failure window means we never need
    // more than a few dozen recent entries for consecutiveNodeFailures. Bounding to 500
    // avoids a full O(n) scan for meshes with many historical entries.
    const entries = readLedgerEntries(meshId, { tail: 500 });

    // Single backward pass: find last task_dispatched AND count consecutive recent failures.
    const now = Date.now();
    const recentWindow = now - RECENT_FAILURE_WINDOW_MS;
    let lastDispatch: MeshLedgerEntry | null = null;
    let consecutiveNodeFailures = 0;
    let failureCountDone = false;
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        const ts = new Date(e.timestamp).getTime();

        // Failure counting: scan until we exit the recent window or hit a chain-breaker
        if (!failureCountDone) {
            if (ts < recentWindow) {
                failureCountDone = true;
            } else if (opts.nodeId && !daemonIdsEquivalent(e.nodeId, opts.nodeId)) {
                // Entry for a different node — skip for failure counting but continue scanning for dispatch
            } else if (e.kind === 'task_failed') {
                if (!isIntentionalCleanupStopEntry(e)) consecutiveNodeFailures++;
            } else if (e.kind === 'task_completed' || e.kind === 'task_dispatched') {
                // A completion or new dispatch breaks the consecutive failure chain
                failureCountDone = true;
            }
        }

        // Dispatch search: find the last dispatch matching this session or node
        if (lastDispatch === null && e.kind === 'task_dispatched') {
            if (opts.sessionId && sessionIdsEquivalent(e.sessionId, opts.sessionId)) { lastDispatch = e; }
            else if (!opts.sessionId && opts.nodeId && daemonIdsEquivalent(e.nodeId, opts.nodeId)) { lastDispatch = e; }
        }

        // Stop once both tasks are done
        if (lastDispatch !== null && failureCountDone) break;
    }

    const lastTaskMessage = typeof lastDispatch?.payload?.message === 'string'
        ? lastDispatch.payload.message
        : null;

    // DIFFICULTY-REQUIRED (recovery inheritance): recover the difficulty the failed task
    // ran with, from the SAME task_dispatched entry the message came from — so the
    // relaunch re-enqueues with the coordinator's original classification instead of
    // guessing a new one. recordTaskDispatchedLedger (mesh-queue-assignment.ts) writes it
    // to payload.routingDecision.resolvedDifficulty. Best-effort by design: a legacy entry
    // predating the field, or one carrying a value no longer in the axis, yields null and
    // the caller falls back — never a throw, because this runs on the failure-recovery path.
    let lastTaskDifficulty: MeshTaskDifficulty | null = null;
    const routingDecision = lastDispatch?.payload?.routingDecision;
    if (routingDecision && typeof routingDecision === 'object') {
        const resolved = (routingDecision as Record<string, unknown>).resolvedDifficulty;
        if (isMeshTaskDifficulty(resolved)) lastTaskDifficulty = resolved;
    }

    // Count how many times the same task was attempted.
    // Prefer exact taskId match (payload.taskId) to avoid 200-char prefix collisions.
    let taskAttemptCount = 0;
    if (lastDispatch) {
        const taskId = typeof lastDispatch.payload?.taskId === 'string' ? lastDispatch.payload.taskId : null;
        if (taskId) {
            for (const e of entries) {
                if (e.kind === 'task_dispatched' && e.payload?.taskId === taskId) taskAttemptCount++;
            }
        } else if (lastTaskMessage) {
            const prefix = lastTaskMessage.slice(0, 200);
            for (const e of entries) {
                if (e.kind === 'task_dispatched' && typeof e.payload?.message === 'string') {
                    if (e.payload.message.startsWith(prefix)) taskAttemptCount++;
                }
            }
        }
    }

    const retryRecommended = consecutiveNodeFailures <= maxRetries;

    // Build advice string
    let advice: string;
    if (consecutiveNodeFailures === 0) {
        advice = 'No recent failures detected. This may be a normal stop.';
    } else if (retryRecommended) {
        const remaining = maxRetries - consecutiveNodeFailures + 1;
        advice = `Retry recommended (${consecutiveNodeFailures}/${maxRetries + 1} attempts used, ${remaining} remaining). `
            + (lastTaskMessage
                ? `Re-launch the session and resend the original task.`
                : `Re-launch the session. Original task message not found in ledger.`);
    } else {
        advice = `Max retries exceeded (${consecutiveNodeFailures} consecutive failures). `
            + `Consider: (1) reassigning to a different node, (2) simplifying the task, or (3) escalating to the user.`;
    }

    return {
        lastTaskMessage,
        lastTaskDifficulty,
        failedNodeId: opts.nodeId || null,
        failedSessionId: opts.sessionId || null,
        failedProviderType: null, // filled by caller if available
        consecutiveNodeFailures,
        taskAttemptCount,
        retryRecommended,
        advice,
    };
}

// ─── File Rotation ──────────────────────────────

function rotateLedgerFile(meshId: string, currentPath: string): void {
    // Find next rotation index
    let index = 1;
    while (existsSync(getRotatedPath(meshId, index))) {
        index++;
        if (index > 10) break; // Max 10 rotations
    }

    // If all slots full, overwrite the oldest
    if (index > 10) index = 10;

    try {
        renameSync(currentPath, getRotatedPath(meshId, index));
    } catch (e: any) {
        // Rotation failed — the next append will just grow the file
        process.stderr.write(`[adhdev-mesh] Ledger rotation failed for mesh ${meshId}: ${e?.message || e}. File will continue to grow.\n`);
    }
}

// ─── Closed-rotation retention cap (lifecycle retention Slice 1) ─────────────
// The rotation scheme above bounds the ACTIVE file's growth by renaming it into
// numbered slots, but the closed rotation files themselves (<mesh>.<n>.jsonl,
// plus the archive rotations <mesh>.archive.<n>.jsonl from compactLedger) had NO
// lifetime — they accumulated on disk forever. This cap evicts the OLDEST closed
// rotation files once a mesh's closed-rotation totals exceed the configured
// byte/count bounds (resolveLedgerRotationMaxBytes / ...MaxFiles, hourly via
// runDiskRetentionSweep).
//
// Hard guarantees:
//   - NEVER touches the active ledger (<mesh>.jsonl), the current archive append
//     target (<mesh>.archive.jsonl), the archived-counts rollup, the runtime DB
//     (mesh-runtime.db*), history/provider transcripts, or any file outside the
//     closed-rotation name patterns.
//   - Before unlinking an ACTIVE-family rotation, its terminal aggregate counts
//     (task_completed/failed/stalled, recovery_attempted) are folded into the
//     existing archived-counts rollup so summary totals survive the eviction.
//     Archive-family rotations are NOT re-folded — compactLedger already folded
//     their entries when archiving (re-folding would double-count).
//   - Crash/restart idempotent: the fold is recorded in the rollup
//     (evictedRotations) BEFORE the unlink, so a crash between the two is
//     completed (unlink only, no re-fold) on the next sweep.

/** Why a closed rotation file was selected for eviction. */
export type LedgerRotationEvictionReason = 'rotation_cap_count' | 'rotation_cap_bytes';

export interface LedgerRotationFileStat {
    /** Basename, e.g. `mesh.3.jsonl` or `mesh.archive.2.jsonl`. */
    name: string;
    sizeBytes: number;
    mtimeMs: number;
}

export interface LedgerRotationEvictionPlanEntry {
    name: string;
    reason: LedgerRotationEvictionReason;
    sizeBytes: number;
}

export interface LedgerRotationCapResult {
    meshId: string;
    dryRun: boolean;
    /** Files the cap would evict (dry-run) or attempted to evict (apply). */
    planned: LedgerRotationEvictionPlanEntry[];
    /** Files actually folded + unlinked (empty on dry-run). */
    applied: LedgerRotationEvictionPlanEntry[];
    evictedBytes: number;
}

export interface LedgerRotationCapSweepResult {
    /** Meshes with at least one closed rotation file that were evaluated. */
    meshes: number;
    evicted: number;
    evictedBytes: number;
    byReason: Record<LedgerRotationEvictionReason, number>;
}

/**
 * PURE. Plan which closed rotation files to evict under the per-mesh byte/count
 * caps. Evicts OLDEST first, ordered by mtime (NOT rotation index — when all
 * slots are full the rotation scheme overwrites the highest slot, so the index
 * is not a reliable age order), ties broken by name for determinism. A file
 * evicted for the count cap also counts against the byte total. `maxFiles <= 0`
 * disables the count cap, `maxBytes <= 0` disables the byte cap. No fs access,
 * no clock read.
 */
export function planLedgerRotationEvictions(
    files: LedgerRotationFileStat[],
    limits: { maxFiles: number; maxBytes: number },
): LedgerRotationEvictionPlanEntry[] {
    const sorted = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const out: LedgerRotationEvictionPlanEntry[] = [];
    let remaining = sorted.length;
    let remainingBytes = sorted.reduce((sum, f) => sum + f.sizeBytes, 0);
    let i = 0;
    const evict = (reason: LedgerRotationEvictionReason) => {
        out.push({ name: sorted[i].name, reason, sizeBytes: sorted[i].sizeBytes });
        remaining--;
        remainingBytes -= sorted[i].sizeBytes;
        i++;
    };
    if (limits.maxFiles > 0) {
        while (remaining > limits.maxFiles && i < sorted.length) evict('rotation_cap_count');
    }
    if (limits.maxBytes > 0) {
        while (remainingBytes > limits.maxBytes && i < sorted.length) evict('rotation_cap_bytes');
    }
    return out;
}

/** Classify a basename as a CLOSED rotation of `safe` mesh, or null. */
function closedRotationKind(safe: string, name: string): 'active' | 'archive' | null {
    const archivePrefix = `${safe}.archive.`;
    if (name.startsWith(archivePrefix) && /^\d+\.jsonl$/.test(name.slice(archivePrefix.length))) return 'archive';
    const activePrefix = `${safe}.`;
    if (name.startsWith(activePrefix) && /^\d+\.jsonl$/.test(name.slice(activePrefix.length))) return 'active';
    return null;
}

/** Parse the entries of a rotation file, skipping corrupt lines (evict anyway). */
function readRotationEntriesTolerant(filePath: string): Array<Pick<MeshLedgerEntry, 'kind'>> {
    let text: string;
    try {
        text = readFileSync(filePath, 'utf-8');
    } catch {
        return [];
    }
    const out: Array<Pick<MeshLedgerEntry, 'kind'>> = [];
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object' && typeof parsed.kind === 'string') {
                out.push(parsed as Pick<MeshLedgerEntry, 'kind'>);
            }
        } catch { /* corrupt line — skip; the file is still evicted */ }
    }
    return out;
}

/**
 * Fold + unlink ONE closed rotation file, crash-idempotently. The fold is
 * written to the rollup (with the file name recorded in evictedRotations)
 * BEFORE the unlink, so a crash in between leaves a recorded-but-present file
 * that the next sweep unlinks WITHOUT re-folding.
 */
function evictClosedRotationFile(safe: string, dir: string, entry: LedgerRotationEvictionPlanEntry): void {
    const filePath = join(dir, entry.name);
    const counts = readArchivedCounts(safe);
    const alreadyFolded = new Set(counts.evictedRotations ?? []);
    if (alreadyFolded.has(entry.name)) {
        // Crash window: fold already recorded, unlink was interrupted — finish it.
        if (existsSync(filePath)) unlinkSync(filePath);
        return;
    }
    if (closedRotationKind(safe, entry.name) === 'active' && existsSync(filePath)) {
        // Fold terminal aggregate counts into the rollup BEFORE the unlink so the
        // historical totals survive the eviction. Archive-family rotations were
        // already folded by compactLedger — never re-fold those.
        const entries = readRotationEntriesTolerant(filePath);
        for (const e of entries) {
            if (e.kind === 'task_completed') counts.taskCompleted++;
            else if (e.kind === 'task_failed') counts.taskFailed++;
            else if (e.kind === 'task_stalled') counts.taskStalled++;
            else if (e.kind === 'recovery_attempted') counts.recoveryAttempted++;
        }
        counts.totalArchived += entries.length;
    }
    counts.evictedRotations = [...alreadyFolded, entry.name];
    counts.lastArchivedAt = new Date().toISOString();
    writeArchivedCounts(safe, counts);
    if (existsSync(filePath)) unlinkSync(filePath);
}

/**
 * Enforce the per-mesh closed-rotation byte/count caps for ONE mesh. With
 * `dryRun: true` this is the pure planning seam: it lists + plans and returns
 * the eviction plan WITHOUT folding counts or unlinking anything. Per-file
 * failures (fold/unlink) are logged and skipped so one bad file never blocks
 * the rest — the next sweep retries it. Defaults come from the env resolvers.
 */
export function enforceLedgerRotationCap(
    meshId: string,
    opts?: { maxFiles?: number; maxBytes?: number; dryRun?: boolean },
): LedgerRotationCapResult {
    const maxFiles = opts?.maxFiles ?? resolveLedgerRotationMaxFiles();
    const maxBytes = opts?.maxBytes ?? resolveLedgerRotationMaxBytes();
    const dryRun = opts?.dryRun === true;
    const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const dir = getLedgerDir();
    const stats: LedgerRotationFileStat[] = [];
    let names: string[] = [];
    try {
        names = readdirSync(dir);
    } catch {
        names = [];
    }
    for (const name of names) {
        if (!closedRotationKind(safe, name)) continue;
        try {
            const st = statSync(join(dir, name));
            if (st.isFile()) stats.push({ name, sizeBytes: st.size, mtimeMs: st.mtimeMs });
        } catch { /* vanished between readdir and stat — skip */ }
    }
    const planned = planLedgerRotationEvictions(stats, { maxFiles, maxBytes });
    if (dryRun) {
        return { meshId, dryRun: true, planned, applied: [], evictedBytes: 0 };
    }
    const applied: LedgerRotationEvictionPlanEntry[] = [];
    let evictedBytes = 0;
    for (const entry of planned) {
        try {
            evictClosedRotationFile(safe, dir, entry);
            applied.push(entry);
            evictedBytes += entry.sizeBytes;
        } catch (e: any) {
            // Partial-failure isolation: log and continue with the remaining
            // evictions; the failed file is retried on the next sweep.
            process.stderr.write(`[adhdev-mesh] Ledger rotation eviction failed for ${entry.name}: ${e?.message || e}\n`);
        }
    }
    return { meshId, dryRun: false, planned, applied, evictedBytes };
}

/**
 * Enforce the closed-rotation caps for EVERY mesh with rotation files in the
 * ledger dir (meshes are enumerated from on-disk file names, so this needs no
 * mesh config and covers meshes this daemon no longer hosts). One mesh's
 * failure never blocks the others. Returns the content-free sweep metrics
 * (counts/bytes/reason codes only — never entry content).
 */
export function enforceAllLedgerRotationCaps(opts?: { dryRun?: boolean }): LedgerRotationCapSweepResult {
    const result: LedgerRotationCapSweepResult = {
        meshes: 0,
        evicted: 0,
        evictedBytes: 0,
        byReason: { rotation_cap_count: 0, rotation_cap_bytes: 0 },
    };
    const dir = getLedgerDir();
    let names: string[] = [];
    try {
        names = readdirSync(dir);
    } catch {
        return result;
    }
    const meshes = new Set<string>();
    for (const name of names) {
        const m = name.match(/^(.*)\.archive\.\d+\.jsonl$/) ?? name.match(/^(.*)\.\d+\.jsonl$/);
        if (m && m[1]) meshes.add(m[1]);
    }
    for (const safe of meshes) {
        let r: LedgerRotationCapResult;
        try {
            r = enforceLedgerRotationCap(safe, opts);
        } catch (e: any) {
            process.stderr.write(`[adhdev-mesh] Ledger rotation cap failed for mesh ${safe}: ${e?.message || e}\n`);
            continue;
        }
        result.meshes++;
        const counted = r.dryRun ? r.planned : r.applied;
        result.evicted += counted.length;
        result.evictedBytes += counted.reduce((sum, p) => sum + p.sizeBytes, 0);
        for (const p of counted) result.byReason[p.reason]++;
    }
    return result;
}
