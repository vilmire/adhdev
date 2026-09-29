// Mesh work-queue types: the queue row (MeshWorkQueueEntry), its status unions,
// parking record, enqueue / mutation options and the queue stats shape. Split out
// of mesh-work-queue.ts (re-exported there).

import type {
    MeshTaskStatus,
    MeshTerminalTaskStatus,
    MeshTaskMode,
    MeshTaskPriority,
    OwnedPathsDeclaration,
} from '@adhdev/mesh-shared';
import type { InputEnvelope } from '../providers/io-contracts.js';
import type { RepoMeshDaemonRole } from '../repo-mesh-types.js';

export type MeshActiveTaskStatus = Extract<MeshTaskStatus, 'pending' | 'assigned'>;
export type MeshHistoricalTaskStatus = MeshTerminalTaskStatus;

/**
 * The multipart input a task is dispatched with (MESH-IMAGE-DISPATCH), as it
 * arrives from the MCP tools: `parts` is authoritative, `textFallback` is
 * derived daemon-side by `normalizeInputEnvelope` at delivery, so it is optional
 * here. Persisted on the queue row so a task queued for a BUSY session is
 * delivered with the same envelope a direct dispatch would have carried.
 */
export type MeshTaskInputEnvelope = Pick<InputEnvelope, 'parts'> & Partial<Pick<InputEnvelope, 'textFallback' | 'metadata'>>;


/**
 * PIN-PARKING: the record stamped on a task whose target pin went stale and was
 * therefore PARKED — held for an explicit coordinator decision instead of being
 * silently re-homed onto whatever session happened to be free.
 *
 * Rides in the payload JSON (no column migration); absent on every legacy row and
 * on every normally-dispatched task, so its presence IS the parked predicate (see
 * `taskIsParked` in mesh-task-parking.ts). The row stays `pending` — parking is an
 * addressing state, not a lifecycle status, and inventing a sixth MeshTaskStatus
 * would mean auditing every `status === 'pending'` reader in the scheduler.
 */
export interface MeshTaskParking {
    /** Why it parked (e.g. target_session_pin_expired_parked). */
    reason: string;
    /** ISO timestamp of the park — the anchor the retention sweep measures from. */
    parkedAt: string;
    /** The session the task was ORIGINALLY addressed to, preserved across a later re-target. */
    targetSessionId?: string;
    /** The node pin at park time, likewise preserved. */
    targetNodeId?: string;
}

export interface MeshWorkQueueEntry {
    id: string;
    meshId: string;
    message: string;
    /**
     * MESH-IMAGE-DISPATCH: the structured envelope (e.g. a screenshot) the task was
     * enqueued with. Rides in the payload JSON (no column). Delivered verbatim by
     * the claim dispatch (mesh-queue-assignment) exactly as the direct-dispatch path
     * forwards it — before this field existed an image sent to a busy worker was
     * queued as text only and the attachment silently vanished. Absent on text tasks.
     */
    input?: MeshTaskInputEnvelope;
    status: MeshTaskStatus;
    /**
     * PIN-PARKING: present ⇔ the task is parked awaiting a coordinator decision.
     * A parked row keeps its `targetSessionId` (which is what already makes it
     * unclaimable by anyone else through the tier-1 claim SELECT) and is refused
     * even to that pinned session by the claim gate's explicit parked guard.
     * Cleared by any requeue — that is the unpark.
     */
    parked?: MeshTaskParking;
    taskMode?: MeshTaskMode;
    /**
     * QUEUE-NODE-SERIALIZATION: explicit read-only axis, orthogonal to taskMode. When
     * true the task is treated as read-only by every scheduling gate (no node-busy
     * isolation, counted under the read-only cap, write commands rejected) regardless of
     * its taskMode. Decided exclusively through {@link isTaskReadonly}; `taskMode ===
     * 'live_debug_readonly'` remains an OR-fallback so legacy rows behave unchanged.
     */
    readonly?: boolean;
    /** If specified, only this node can claim the task (used by legacy mesh_send_task) */
    targetNodeId?: string;
    /** If specified, only this runtime session can claim the task */
    targetSessionId?: string;
    /** If specified, a node must expose all tags before it can claim the task. */
    requiredTags?: string[];
    /**
     * G6 (task-level scheduling priority): 'low' | 'normal' | 'high'. Orders the
     * claim candidate list so a high-priority task is pulled ahead of an older
     * normal/low task within the same claim tier (created_at is the tie-break).
     * Absent → treated as 'normal'. This is the TASK-level priority, distinct from
     * the NODE-level schedulingPriority (resolveNodeSchedulingPriority), which ranks
     * which node a task goes to, not which task a node pulls first.
     */
    priority?: MeshTaskPriority;
    /**
     * G7 (delayed execution): ISO timestamp before which the task is NOT claimable.
     * The claim gate holds the task pending while now < notBefore; once the wall
     * clock passes it the task becomes a normal claim candidate. A pure time gate —
     * cron/webhook triggers are out of scope. Absent → immediately claimable.
     */
    notBefore?: string;
    /**
     * M1: ids of tasks that must reach 'completed' before this task is claimable.
     * Forward references (ids not yet enqueued) are allowed for batch flows and
     * simply keep the task waiting until the referenced task exists and completes.
     */
    dependsOn?: string[];
    /** M1/M3: mission this task belongs to (joins mesh_missions). */
    missionId?: string;
    /**
     * MAGI: consensus group id shared by every replica of one mesh_magi_review
     * fan-out. Marks the task as part of an INTENTIONAL same-prompt quorum so the
     * completion-event dedup (mesh-events-pending) never collapses grouped
     * replicas. Absent on ordinary tasks. Rides in the payload JSON (no column).
     */
    consensusGroupId?: string;
    /**
     * MAGI-KIND-PANEL (model axis): model override for the session that executes this
     * task. When the task auto-launches a session, this is passed to launch_cli as
     * `initialModel` (ACP → setConfigOption; CLI → modelLaunchArgs template). Absent on
     * ordinary tasks. Rides in the payload JSON (no column). Best-effort — a provider
     * that cannot honor the model still runs the task (never a fatal launch error).
     */
    model?: string;
    /**
     * BRAIN-ROUTING (thinking axis): standard reasoning level ('low'|'medium'|'high')
     * for the session that executes this task. When the task auto-launches, this is
     * passed to launch_cli as `initialThinkingLevel` (CLI → thinkingLaunchArgs; ACP →
     * setConfigOption('thought_level')). Rides in payload JSON. Best-effort like model.
     */
    thinkingLevel?: string;
    /**
     * MODEL-SOURCE marker: who put the value in {@link model}. 'explicit' = the
     * caller passed it; 'preset' = the difficulty→brain preset filled it at
     * enqueue. Without this the two are indistinguishable downstream, and an
     * unconditional "task.model wins" rule lets a preset silently override the
     * difficulty-matched slot's own model (or, with the fail-closed slot guard,
     * blocks the task on nodes that never declared the preset model). Same
     * marker class as quotaShowAccountEmailSetByUser (config.ts): machine-written
     * vs user-written values must be distinguishable.
     *
     * BACKWARD COMPAT: rows enqueued before this field existed carry no marker.
     * The assignment path treats an absent marker as 'explicit' — it never lets
     * a slot override a value that MIGHT be a user's choice. That keeps legacy
     * rows on exactly their pre-fix behaviour; only newly enqueued preset rows
     * get the relaxed precedence.
     */
    modelSource?: 'explicit' | 'preset';
    /** Same source marker as {@link modelSource}, for the thinkingLevel axis. */
    thinkingLevelSource?: 'explicit' | 'preset';
    /**
     * SLOT-ROUTING (node capability slots design, 2026-07-09): the coordinator's difficulty
     * classification for this task ('easy'|'medium'|'difficult'|'freeform'),
     * PERSISTED on the entry so the scheduler can match it against node capability
     * slots at assignment time. Previously an enqueue-only option consumed to
     * resolve model/thinkingLevel and then discarded; keeping it lets task→node
     * fitness matching run. Absent on tasks enqueued without a difficulty.
     */
    difficulty?: string;
    /**
     * Independent system hold (materialization, gate, workspace, policy,
     * quarantine). C3 derived failure does NOT write `dependency_failed:*` here
     * (design :522-533); views derive `dependencyFailures` from predecessor
     * statuses instead. A C1 skip placeholder may carry `graph_skipped:*`.
     */
    blockedReason?: string;
    /** The node that actually claimed and is executing the task */
    assignedNodeId?: string;
    /** The session currently executing the task */
    assignedSessionId?: string;
    /**
     * Provider type of the session that claimed the task. Recorded so the queue
     * can enforce per-(node, provider) maxParallel caps (summed slots[].maxParallel)
     * by counting active assignments grouped by node + provider.
     */
    assignedProviderType?: string;
    /**
     * Model the claiming session actually launched with, stamped at claim time so the
     * queue can count active assignments PER SLOT — a slot being the (provider, model)
     * pair its `maxParallel` bounds. Without it, claude-cli/opus and claude-cli/sonnet
     * are indistinguishable on the row and their caps collapse into one summed provider
     * pool, letting a slot pinned to 1 run as many tasks as its siblings' headroom
     * allowed.
     *
     * Absent on rows claimed by an older daemon, and on claim paths that cannot know
     * the model (idle/event drains claim into an already-running session). Consumers
     * MUST treat an absent value as "counts against every slot of its provider" — the
     * conservative direction; ignoring it would under-count and over-subscribe a cap.
     */
    assignedModel?: string;
    /**
     * Transcript-authority class of the claiming session's provider, stamped at
     * claim time (P1 of the transcript-authority unification — root repo
     * docs/design/2026-07-25-transcript-authority-unification.md). Lets the
     * COORDINATOR side classify a remote worker (early-arm / redrive gates)
     * without resolving the provider module locally — the structural fix for
     * the "remote class unknowable → reprobe-only" blind spot. Absent on rows
     * claimed by older daemons; consumers must fall back to local resolution.
     */
    assignedTranscriptProfile?: {
        class: 'native-source' | 'pure-pty' | 'daemon-owned';
        timing: 'hold' | 'floor' | 'immediate';
        emitsPtyTurnEvents: boolean;
    };
    /** Human/operator reason for terminal cancellation. */
    cancelReason?: string;
    cancelledAt?: string;
    /** Human/operator reason for manually requeueing a task. */
    requeueReason?: string;
    requeuedAt?: string;
    requeueCount?: number;
    /** Max automatic requeue attempts. When requeueCount reaches this, task is auto-failed. */
    maxRetries?: number;
    /**
     * Bug B: number of times the reconcile assigned-stranded watchdog has reclaimed this
     * row from 'assigned' back to 'pending' because its dispatch was never confirmed
     * delivered. Separate from requeueCount (operator/execution retries) and bounded by
     * MAX_STRANDED_RECLAIMS so a permanently-undeliverable target auto-fails rather than
     * cycling reclaim→re-dispatch→strand forever.
     */
    strandedReclaimCount?: number;
    /**
     * REDRIVE-PROVIDER-FLIP (a): the provider/node/session this row was assigned to at the
     * moment the stranded-reclaim watchdog tore that assignment down, preserved because the
     * reclaim itself DELETES assignedProviderType/assignedNodeId/assignedSessionId (see
     * {@link reclaimStrandedAssignedTask}). Without it the next claim has no memory of what
     * it is replacing, so a redrive that silently lands on a DIFFERENT provider — the
     * observed 2026-08-25/26 failure mode, 7-8 occurrences, each recovered by hand — was
     * only discoverable by manually joining two `task_dispatched` ledger entries and
     * diffing their providerType.
     *
     * Read at the next dispatch by `recordTaskDispatchedLedger`, which folds a
     * `redriveProvenance` block into `task_dispatched` and, when the provider actually
     * changed, emits the explicit flip record. Diagnostic ONLY: nothing routes, gates or
     * re-ranks on this field — it exists so the flip is measurable before any behavioral
     * change to redrive routing is attempted.
     */
    lastReclaim?: {
        /** Provider the torn-down assignment was running (absent on legacy/unassigned rows). */
        providerType?: string;
        nodeId?: string;
        sessionId?: string;
        /** The reclaim reason, e.g. 'delivered_not_consumed_redrive'. */
        reason: string;
        /** strandedReclaimCount AFTER this reclaim. */
        reclaimCount: number;
        at: string;
    };
    /**
     * DISPATCH-BOOT-RACE: number of times a dispatch to this task's session FAILED
     * BEFORE the worker ever started the task (transport reject / adapter-not-found —
     * e.g. a session still booting when the coordinator dispatched to it). Separate
     * from requeueCount: requeueCount is a shared budget spent by every requeue reason
     * (worker crash, dead-target reclaim, operator retry, dispatch failure alike), so a
     * mesh policy tuned tight for genuine worker failures (maxTaskRetries:1) exhausted
     * itself on a single boot-race dispatch failure that resolves on its own within
     * seconds — the worker never even saw the task. Bounded by MAX_DISPATCH_FAILURES
     * (its own, more generous cap: these failures are cheap and fast) independently of
     * requeueCount, and paced by a backoff `notBefore` (see scheduleDispatchRetryBackoff)
     * instead of an immediate re-claim, so a re-dispatch lands after the session has had
     * time to finish booting rather than racing it again on the very next tick.
     */
    dispatchFailureCount?: number;
    /** Last automatic queue session spin-up attempt, for mesh_view_queue/debug visibility. */
    autoLaunch?: {
        status: 'skipped' | 'started' | 'failed' | 'completed';
        reason?: string;
        nodeId?: string;
        providerType?: string;
        sessionId?: string;
        updatedAt: string;
    };
    /**
     * AUTOLAUNCH-SPAWN-CAP (P3): auto-launches recorded for this task since its last
     * SUCCESSFUL claim. Deliberately a sibling of `autoLaunch` (which is overwritten
     * wholesale on every transition) and deliberately DURABLE — it rides in the payload
     * JSON so a daemon crash/restart cannot reset it, which is exactly how the in-memory
     * brakes re-ignited the 2026-09-08 launch runaway. Incremented once per launch that
     * actually PRODUCED A SESSION (recordTaskAutoLaunch's `spendSpawnBudget`), reset by
     * claim success (claimNextQueueTask) and by any explicit requeue. Absent on legacy
     * rows → 0. Full rationale + the cap that consumes it: mesh-autolaunch-spawn-cap.ts.
     */
    autoLaunchUnclaimedCount?: number;
    /**
     * SPAWN-CAP-TRANSPORT-AWARE: launches that never reached the target daemon at all —
     * the dispatch threw in this coordinator's own transport, so NO session was created.
     * Same lifecycle as the budget above (reset by claim success and by any requeue) but a
     * SEPARATE axis: it spends no budget, it only records that the failures happened, so
     * the park page can name the real failure mode instead of blaming the target node.
     * Rationale: mesh-autolaunch-spawn-budget.ts; consumer: mesh-skip-notify.ts.
     */
    autoLaunchDispatchFailedCount?: number;
    /** ISO timestamp when the task was dispatched (assigned) to a node/session. Used for precise matching on completion. */
    dispatchTimestamp?: string;
    /**
     * REDRIVE-DUP: monotonic per-task dispatch nonce. Bumped on every (re)dispatch of
     * this task (assignQueueTask) AND on every reclaim (reclaimStrandedAssignedTask), and
     * carried to the worker in meshContext.dispatchNonce. The worker echoes it back on
     * agent:generating_started (metadataEvent.dispatchNonce). When a delivered-not-consumed
     * task is reclaimed and re-dispatched to a different node, the ORIGINAL inject to the
     * first node still carries the now-stale nonce; the coordinator rejects that node's
     * generating_started ack (and stops it) so the SAME taskId is never executed twice.
     * Absent on legacy rows → the coordinator skips the stale-nonce guard (backward safe).
     */
    dispatchNonce?: number;
    /**
     * The turn-ledger attempt id (`turn_attempts.attempt_id`, C3) of the CURRENT
     * dispatch of this task — distinct from both the taskId and the monotonic
     * dispatchNonce. Stamped when the dispatch opens its attempt (queue claim:
     * `openOrResumeQueueAttempt`; direct dispatch: the caller's `dispatch_accepted`)
     * and carried to the worker in meshContext.attemptId so its evidence correlates
     * to (meshId, taskId, attemptId). Rides in the payload JSON (no column).
     */
    attemptId?: string;
    /**
     * (3) The ORIGINATING coordinator session that enqueued this task. Stamped onto the
     * worker at dispatch (meshCoordinatorSessionId) so the task's completion routes back to
     * the exact coordinator session — even when several coordinator sessions share one
     * daemon. Rides in the queue payload JSON (no column migration); absent on legacy rows
     * → daemon-level routing fallback (backward + version-skew safe).
     */
    sourceCoordinatorSessionId?: string;
    /**
     * H1 (wiring-unification Phase H, path ownership — docs/design/2026-09-23-wiring-unification.md
     * §7c): the caller-declared set of repo-relative paths/subtrees this `code_change` task
     * will touch, normalized by `normalizeOwnedPaths` (@adhdev/mesh-shared) at enqueue time.
     * Rides in the payload JSON (no column) — same pattern as `requiredTags`/`missionId`.
     * Absent/empty = opt-out: no overlap check is performed for this task (backward compat,
     * mesh-shared's own doc). Read at claim time (claimNextQueueTask) to refuse a `code_change`
     * claim that overlaps another in-flight task's declaration on the same node, and at
     * report_completion time to compare against the worker's reported `touchedFiles`.
     */
    ownedPaths?: OwnedPathsDeclaration;
    createdAt: string;
    updatedAt: string;
}

export interface MeshQueueMutationOptions {
    ownerRole?: RepoMeshDaemonRole;
}

/**
 * Options accepted by {@link enqueueTask}. Named (rather than inline) so
 * {@link enqueueTaskGraph} can reuse the exact same per-task option surface —
 * the batch path generates `id` itself and resolves batch refs in `dependsOn`
 * before delegating each entry to enqueueTask, so the two can never drift.
 */
export interface MeshEnqueueTaskOptions {
    targetNodeId?: string;
    targetSessionId?: string;
    /** MESH-IMAGE-DISPATCH: multipart envelope persisted with the task (see {@link MeshWorkQueueEntry.input}). */
    input?: MeshTaskInputEnvelope;
    taskMode?: MeshTaskMode | string;
    /** QUEUE-NODE-SERIALIZATION: explicit read-only axis (orthogonal to taskMode). */
    readonly?: boolean;
    requiredTags?: string[];
    /**
     * H1 (path ownership): repo-relative paths/subtrees this `code_change` task will
     * touch, e.g. `['src/foo.ts', 'src/mesh/**']`. Raw caller input — normalized via
     * `normalizeOwnedPaths` inside enqueueTask. Optional and opt-in (see
     * MeshWorkQueueEntry.ownedPaths).
     */
    ownedPaths?: string[];
    /** M1: tasks that must complete before this one is claimable. */
    dependsOn?: string[];
    /** G6: task-level scheduling priority ('low' | 'normal' | 'high'). Absent → 'normal'. */
    priority?: MeshTaskPriority | string;
    /** G7: hold the task pending until this time. ISO string, absolute epoch-ms, or relative-ms offset from now. */
    notBefore?: string | number;
    /** P3: max automatic requeue attempts before the task auto-fails. Absent → policy default (1). */
    maxRetries?: number;
    /** M1/M3: mission this task belongs to. */
    missionId?: string;
    /** MAGI: consensus group id shared by every replica of a mesh_magi_review fan-out. */
    consensusGroupId?: string;
    /** MAGI-KIND-PANEL: model override forwarded to the executing session's launch (initialModel). */
    model?: string;
    /** BRAIN-ROUTING: standard thinking level forwarded to launch (initialThinkingLevel). */
    thinkingLevel?: string;
    /**
     * BRAIN-ROUTING: task execution difficulty ('easy'|'medium'|'difficult'|
     * 'freeform'). REQUIRED — a missing or unrecognized value throws (see
     * assertMeshTaskDifficulty). Typed as optional only because the value arrives
     * from untyped MCP tool args; the guard is what enforces it at runtime.
     *
     * The mesh's difficulty→brain preset fills in model / thinkingLevel that were
     * not passed explicitly (an explicit model/thinkingLevel wins). Purely a
     * convenience resolver — the stored task still carries the resolved
     * model/thinkingLevel, so downstream launch is unchanged. The value itself is
     * persisted on the entry for slot matching at assignment time.
     */
    difficulty?: string;
    /** Explicit task id for batch/template flows (M5). Random UUID when omitted. */
    id?: string;
    /** (3) Originating coordinator session id (for session-anchored completion routing). */
    sourceCoordinatorSessionId?: string;
}

// ─── G5: Atomic Task-Graph Enqueue ─────────

/**
 * G5: one task in an atomic multi-task enqueue. `ref` is a batch-local label that
 * other entries' `dependsOn` may name (forward references included — order within
 * the batch does not matter); it is resolved to the generated task id before insert
 * and never persisted. A `dependsOn` value that is not a batch ref must be an
 * EXISTING queue task id. Unknown values are rejected — unlike single enqueueTask,
 * which tolerates dangling dep ids precisely because multi-call batch flows needed
 * forward references; with an atomic batch the only unknown-id case left is a typo,
 * and a typo'd dep would otherwise hang the task as unclaimable forever.
 */
export interface MeshTaskGraphEntrySpec extends Omit<MeshEnqueueTaskOptions, 'id'> {
    ref?: string;
    message: string;
}

export interface MeshWorkQueueStats {
    total: number;
    active: number;
    historical: number;
    pending: number;
    assigned: number;
    completed: number;
    failed: number;
    cancelled: number;
    /** Source-of-truth active queue counters; only pending/assigned are live work. */
    activeCounts: Record<MeshActiveTaskStatus, number>;
    /** Terminal ledger records kept for audit/history; never count as active work. */
    historicalCounts: Record<MeshHistoricalTaskStatus, number>;
    activeAssignments: Array<{
        id: string;
        nodeId?: string;
        sessionId?: string;
        message: string;
    }>;
}
