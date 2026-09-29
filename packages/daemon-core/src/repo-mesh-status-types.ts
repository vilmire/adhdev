// Repo Mesh runtime status types (not persisted): the mesh_status view, per-node
// status / held runtime / git observation, queue + ledger summaries, protocol
// metrics and the async-job lifecycle. Re-exported by ./repo-mesh-types.ts.

import type {
    RepoMeshSchedulingStrategy,
    RepoMeshHostStatus,
    RepoMeshDaemonRole,
    RepoMeshNodeHealth,
    LocalMeshNodeEntry,
} from './repo-mesh-types.js';
import type { MeshMissionSummary, MeshMissionSlimSummary } from './mesh/mesh-missions.js';
import type { MeshMagiActivitySummary } from './mesh/mesh-magi-status.js';
import type { GitRepoStatus } from './git/git-types.js';
import type {
    RepoMeshSessionStatus,
    NodeCapabilitySlot,
    MeshTaskStatus,
    MeshTaskPriority,
} from '@adhdev/mesh-shared';

// ─── Mesh Status (runtime, not persisted) ───────

/**
 * Per-(node, provider) cap + consumption, as surfaced on a node's scheduling
 * status. Wire-shape mirror of MeshNodeProviderSchedulingRuntime.
 */
export interface RepoMeshNodeProviderSchedulingStatus {
    providerType: string;
    maxParallel?: number;
    activeAssigned: number;
    capReached: boolean;
}

/**
 * Per-node scheduling runtime exposed on RepoMeshNodeStatus.scheduling. Carried in
 * full by verbose mesh_status; compact mesh_status sends only {load, capReached}.
 */
export interface RepoMeshNodeSchedulingStatus {
    load: number;
    schedulingPriority?: number;
    maxConcurrentSessions?: number;
    /**
     * Per-(node, provider) caps + consumption. Field name kept for dashboard
     * back-compat; the cap source is now slots[].maxParallel (the removed
     * policy.providerRoles no longer exists).
     */
    providerRoles?: RepoMeshNodeProviderSchedulingStatus[];
    capReached: boolean;
    capReasons?: string[];
}

/**
 * Mesh-level scheduling rollup exposed on RepoMeshStatus.scheduling. Current
 * daemons emit `{ strategy }` ONLY — the global cap numbers are deliberately
 * dropped from the wire (mesh-status.ts): real concurrency is governed
 * per-node/per-slot, and a global number misreads as capacity. The cap fields
 * are optional so consumers must handle their absence; only pre-drop daemons
 * still send them.
 */
export interface RepoMeshSchedulingStatus {
    strategy: RepoMeshSchedulingStrategy;
    maxParallelTasks?: number;
    maxReadonlyParallelTasks?: number;
    activeWriteAssigned?: number;
    activeReadonlyAssigned?: number;
    globalWriteCapReached?: boolean;
    globalReadonlyCapReached?: boolean;
}

export interface RepoMeshStatus {
    meshId: string;
    meshName: string;
    repoIdentity: string;
    defaultBranch?: string;
    refreshedAt: string;
    meshHost?: RepoMeshHostStatus;
    nodes: RepoMeshNodeStatus[];
    queue?: RepoMeshQueueStatus;
    ledger?: RepoMeshLedgerStatus;
    /**
     * Mesh-level scheduling rollup (strategy + global cap consumption). Omitted by
     * daemons predating the scheduling-runtime exposure — treat as optional.
     */
    scheduling?: RepoMeshSchedulingStatus;
    /**
     * Mission summaries for the dashboard overview. Active/paused missions plus a
     * capped, newest-first slice of completed/abandoned history. Omitted by older
     * daemons — the dashboard must treat this as optional and render an empty
     * state when absent. Split on each entry's `status` for live vs. history.
     *
     * Compact (the default) status calls send the slim shape — `goalPreview` +
     * `goalTruncated` instead of the full `goal` — while verbose sends the full
     * `goal`. Consumers must read `goal ?? goalPreview`. Each entry may also carry
     * an optional `stats` operational rollup (durations / retries).
     */
    missions?: (MeshMissionSummary | MeshMissionSlimSummary)[];
    /**
     * Preview-deploy freshness rollup (deploy-lag visibility): stamped by the
     * dashboard mesh_status when the repo has a preview pipeline. Shape is
     * daemon-defined (mesh/preview-freshness.ts) — `currentMainCommit` is the
     * global deploy-lag anchor the dashboard compares nodeFacts.daemonBuild
     * against. Omitted for repos without the pipeline and by older daemons.
     */
    previewFreshness?: Record<string, unknown>;
    /**
     * MAGI cross-verification activity, reconstructed from the mesh ledger
     * (magi_dispatched / magi_synthesis entries) and folded in so the dashboard's
     * MAGI surface can read synthesis output — needs_verification counts, the
     * independence banner, git skew, and a bounded needs_verification preview —
     * without re-running collection. Running groups are always included; synthesized
     * groups are bounded to recent ones (see summarizeMeshMagiActivity). Omitted by
     * daemons predating the exposure and when no MAGI run is present; treat as
     * optional. Mirrors the MCP `mesh_status` tool's `magiActivity` field.
     */
    magiActivity?: MeshMagiActivitySummary[];
    /**
     * T7 (visibility 7-2b): provider CLI/ACP version skew across nodes. Each entry
     * names a provider running ≥2 distinct versions across the nodes that reported
     * it, with the node ids per version. Observational only — never a dispatch
     * blocker. Omitted when every reported provider is uniform (or none reported).
     * Mirrors the MCP `mesh_status` tool's `providerVersionSkew` field.
     */
    providerVersionSkew?: MeshProviderVersionSkew[];
    /** Human-readable companion warning to providerVersionSkew. Omitted when no skew. */
    providerVersionSkewWarning?: string;
    /**
     * T7 (B4): mesh-protocol-v2 adoption metrics for the batch of pending events
     * surfaced in the drain backing this status. Snapshot, not a durable counter.
     * Omitted when nothing was drained. Mirrors the MCP tool's meshProtocolMetrics.
     */
    meshProtocolMetrics?: MeshProtocolMetrics;
    /**
     * T6 (B3c): live process-lifetime mesh-protocol-v2 enforce counters from THIS
     * daemon — the enforce flag state, drain-routing tallies (deliver / route-away /
     * dedup / quarantine), and the last-resort backstop fire counts (PHASE-4 synth,
     * acked-hold fast-track / death-deadline). Diagnostic-only and never cached (a
     * live snapshot). Under enforce, non-zero quarantine or backstop counts are the
     * rollout-health signal (target 0). Omitted when unavailable.
     */
    meshProtocolV2Counters?: MeshProtocolV2Counters;
    /**
     * C7-5 freshness gate (wiring-unification C-W3): present while another
     * writer's `mesh.<id>.events` entries have not replicated to this daemon
     * (Beacon `staleness().behind`). Fleet-wide reads in this status are
     * advisory until it clears. Computed per call, never cached.
     */
    replication?: 'pending';
    /**
     * Live process-lifetime counters for the legacy pending-event inbox retention sweep
     * (age-based: drained rows >7d, undrained rows >30d). `undrainedExpired` is the
     * operational signal — every increment is a pending event that was queued for a
     * coordinator but NEVER delivered before its 30-day window expired; the sweep
     * mirrors each one to the ledger as `event_held` (reason: pending_retention_expired)
     * before deleting it, so it stays recoverable via mesh_requeue_held_events instead
     * of vanishing. `undrainedExpiredMirrorFailed` non-zero means some of those rows
     * are genuinely unrecoverable (the ledger write itself failed). `drainedExpired`
     * is NOT a drop (the coordinator already consumed those rows) — tracked only for
     * table-growth visibility. Diagnostic-only and never cached (a live snapshot).
     * Omitted when unavailable.
     */
    pendingRetentionCounters?: MeshPendingRetentionCounters;
}

/** Live pending-event retention sweep counters (see RepoMeshStatus.pendingRetentionCounters). */
export interface MeshPendingRetentionCounters {
    drainedExpired: number;
    undrainedExpired: number;
    undrainedExpiredMirrorFailed: number;
    sweepsNoop: number;
    /** TERMINAL-NEVER-EXPIRES: undrained rows past the window KEPT because they are
     *  terminal (a completion/stop/approval/refine-outcome). Not a drop — the
     *  exemption preventing one. */
    terminalExempt: number;
}

/** T6 (B3c) live v2 enforce/observability counters (see RepoMeshStatus.meshProtocolV2Counters). */
export interface MeshProtocolV2Counters {
    /** True when MESH_PROTOCOL_V2_ENFORCE is active on this daemon. */
    enforce: boolean;
    /** Drain-path routing tallies (accept + enforce). Process-lifetime totals. */
    drain: {
        v2Delivered: number;
        v2RoutedAway: number;
        v2DedupSkipped: number;
        v2ValidationFailedAccepted: number;
        v2ReattributedToDrainer: number;
        v1BroadcastAccepted: number;
        v2ValidationFailedQuarantined: number;
        v1UnversionedQuarantined: number;
    };
    /** Last-resort backstop fire counts. Target 0 under a healthy v2 contract. */
    backstop: {
        phase4SynthesisFired: number;
        ackedHoldFastTrackFired: number;
        ackedHoldDeathDeadlineFired: number;
    };
}

/** One provider's version skew across mesh nodes (see RepoMeshStatus.providerVersionSkew). */
export interface MeshProviderVersionSkew {
    /** Provider id (e.g. 'claude-cli'). */
    provider: string;
    /** Each distinct detected version and the node ids running it. */
    versions: Array<{ version: string; nodeIds: string[] }>;
}

/** Mesh-protocol-v2 adoption snapshot over one drain (see RepoMeshStatus.meshProtocolMetrics). */
export interface MeshProtocolMetrics {
    /** Total pending events surfaced in the drain. */
    total: number;
    /** Count carrying a v2 envelope (protocolVersion '2.0'). */
    v2: number;
    /** Count still on v1 (unstamped). */
    v1: number;
    /** v2/total, rounded to 2 decimals (0 when total is 0). */
    v2Ratio: number;
    /** Scope breakdown of the v2 events (unicast/broadcast/system/unspecified → count). */
    scopes: Record<string, number>;
}

export type RepoMeshPeerConnectionState = 'self' | 'connected' | 'connecting' | 'disconnected' | 'failed' | 'closed' | 'unknown';
export type RepoMeshPeerConnectionTransport = 'local' | 'direct' | 'relay' | 'unknown';

export interface RepoMeshPeerConnectionStatus {
    perspective: 'selected_coordinator';
    source: 'mesh_peer_status' | 'not_reported';
    state: RepoMeshPeerConnectionState;
    transport: RepoMeshPeerConnectionTransport;
    reported: boolean;
    reason?: string;
    /**
     * Round-trip time in ms for the selected candidate pair, as sampled by the
     * coordinator daemon when connected. Optional — older daemons and not_reported
     * fallbacks omit it; the dashboard must treat it as best-effort telemetry.
     */
    rttMs?: number;
    lastStateChangeAt?: string;
    lastConnectedAt?: string;
    lastCommandAt?: string;
}

export interface RepoMeshNodeStatus {
    nodeId: string;
    /** MACHINE-axis label (owner axiom 2026-08-24: machine ⊃ nodes) —
     *  identical for every checkout one machine hosts. Never carries branch
     *  or workspace identity; that is `nodeLabel`/`worktreeBranch`. */
    machineLabel: string;
    /** NODE/CHECKOUT-axis label: `⎇ branch` for worktrees, the workspace
     *  basename for base checkouts (buildMeshNodeCheckoutLabel). Optional —
     *  absent from statuses rendered by pre-2026-08-24 daemons. */
    nodeLabel?: string;
    /** How machineLabel was resolved: 'explicit_metadata' (stored
     *  label/nickname/alias) or 'machine_identity' (machine-name/hostname/id
     *  evidence). Diagnostic only. */
    labelSource?: string;
    workspace: string;
    repoRoot?: string;
    daemonId?: string;
    machineId?: string;
    role?: RepoMeshDaemonRole;
    machineStatus?: string;
    /**
     * Machine identity projection (buildMeshNodeMachineIdentity): locality vs
     * the coordinator plus the evidence used to decide it. UIs use it to name
     * the MACHINE (hostname) independently of the derived node label.
     */
    machine?: {
        sameMachine?: boolean;
        locality?: string;
        localityReason?: string;
        coordinatorHostname?: string;
        identityEvidence?: Array<{ label?: string; value?: string }>;
    };
    isLocalWorktree?: boolean;
    worktreeBranch?: string;
    /** Mirrored from LocalMeshNodeEntry.systemPrompt for coordinator-prompt rendering. */
    systemPrompt?: string;
    health: RepoMeshNodeHealth;
    git?: GitRepoStatus;
    /**
     * True when the selected coordinator has evidence that a peer git probe is still
     * in flight or just timed out during initial mesh handshake, so callers should
     * treat missing git data as pending instead of authoritative absence.
     */
    gitProbePending?: boolean;
    providers: string[];
    /**
     * Detected provider CLI/ACP versions on this node, keyed by provider id. Mirrors
     * RepoMeshNodeCapabilities.providerVersions onto the status snapshot so the mesh
     * UI / coordinator prompt can render per-provider versions and flag a version
     * skew across nodes. Optional — omitted by daemons predating the exposure or when
     * detection has not run. Additive; existing consumers ignore it. */
    providerVersions?: Record<string, string>;
    /** Human-readable daemon build version (getDaemonBuildInfo().version) of the
     *  daemon that owns this node. Complements the per-daemon commit stamp
     *  (daemonBuilds) for node-card display. Omitted when unknown. */
    daemonBuildVersion?: string;
    activeSessions: string[];
    activeSessionDetails?: RepoMeshSessionStatus[];
    providerPriority?: string[];
    /** Explicitly-configured node capability slots (node capability slots design, 2026-07-09). */
    slots?: NodeCapabilitySlot[];
    launchReady?: boolean;
    /** True when the node is clean, ahead=0, behind>0, and safe for fast-forward consideration. */
    autoFastForwardEligible?: boolean;
    /** Coordinator-facing suggestion for obvious clean catch-up work. */
    suggestedAction?: 'auto_fast_forward';
    worktreeBootstrap?: LocalMeshNodeEntry['worktreeBootstrap'];
    launchBlockedReason?: string;
    launchBlockedMessage?: string;
    recoveryHint?: string;
    lastSeenAt?: string;
    updatedAt?: string;
    connection?: RepoMeshPeerConnectionStatus;
    /**
     * Per-node scheduling runtime (load / priority / provider caps / claim-block
     * reasons). Verbose mesh_status carries the full shape; compact carries only
     * {load, capReached}. Omitted by daemons predating the exposure.
     */
    scheduling?: RepoMeshNodeSchedulingStatus;
    /**
     * Stale-daemon-build marker: the live daemon's build commit is a strict ancestor
     * of this node's workspace HEAD (merged code not yet live). Best-effort, set by
     * mesh_status when the git probe reports daemonBuildBehind; shape is daemon-defined
     * (scope/isDaemonAffecting flags). Omitted when the build is current.
     */
    staleDaemonBuild?: Record<string, unknown>;
    /**
     * Versioned per-machine runtime facts bundle (MeshNodeFacts). Opaque
     * pass-through from the node record — see the node-level field doc.
     * Carries the daemon build COMMIT (not just the version string), which is
     * the deploy-lag anchor the dashboard renders.
     */
    nodeFacts?: import('@adhdev/mesh-shared').MeshNodeFacts;
    /**
     * Where this node's git state came from and how old it is, as held by the
     * coordinator (mesh-node-git-state.ts). Stamped at serve time, so a cached
     * aggregate snapshot still reports the current refresh/unreachable state.
     * Absent from daemons predating the coordinator-held node state.
     */
    gitObservation?: RepoMeshNodeGitObservation;
    /**
     * Coordinator-held content-free runtime summary of a REMOTE node's daemon
     * (sessions / build / upgrade marker — mesh/mesh-node-runtime-summary.ts),
     * pushed by the member or refreshed in the background. Absent for self/local
     * nodes (read directly) and from daemons predating the held runtime.
     */
    heldRuntime?: RepoMeshNodeHeldRuntime;
    error?: string;
}

/** Held runtime of one remote mesh node, stamped per call like gitObservation. */
export interface RepoMeshNodeHeldRuntime {
    /** 'none' = the coordinator holds no runtime for this node yet (sessions unknown, not zero). */
    source: 'member_push' | 'coordinator_probe' | 'none';
    observedAt: number | null;
    /** A background runtime refresh for this node's daemon is in flight. */
    refreshing: boolean;
    sessions: import('./mesh/mesh-node-runtime-summary.js').MeshNodeRuntimeSession[];
    daemonId?: string;
    daemonBuild?: import('./mesh/mesh-node-runtime-summary.js').MeshNodeRuntimeDaemonBuild;
    upgradeFailure?: import('./mesh/mesh-node-runtime-summary.js').MeshNodeRuntimeUpgradeFailure;
    sessionsTruncated?: boolean;
    /** The node's provider catalog (installed / enabled / versions / autoApproveModes); absent from older members. */
    providers?: import('./mesh/mesh-node-runtime-summary.js').MeshNodeRuntimeProvider[];
}

/** Coordinator-held git observation metadata for one mesh node. */
export interface RepoMeshNodeGitObservation {
    /**
     * 'self' / 'local' = read on the coordinator's own machine this render;
     * 'member_push' / 'coordinator_probe' = last-known remote state held by the
     * coordinator; 'none' = the coordinator has never observed this node's git.
     */
    source: 'self' | 'local' | 'member_push' | 'coordinator_probe' | 'none';
    /** Epoch ms of the observation (null when never observed). */
    observedAt: number | null;
    /** A background refresh for this node is in flight on the coordinator. */
    refreshing: boolean;
    /** Epoch ms since which refreshes have failed (null when reachable / unknown). */
    unreachableSince: number | null;
    /** Short reason of the last failed refresh, when unreachable. */
    lastRefreshError?: string | null;
}

/** Queue task status on the status wire — the ONE vocabulary from @adhdev/mesh-shared (MESH_TASK_STATUSES). */
export type RepoMeshQueueTaskStatus = MeshTaskStatus;

export interface RepoMeshQueueTask {
    id: string;
    meshId: string;
    message: string;
    status: RepoMeshQueueTaskStatus;
    /**
     * SLOT-ROUTING difficulty classification ('easy'|'medium'|'difficult'|'freeform')
     * carried on {@link MeshWorkQueueEntry} — already on the wire, just untyped here
     * until the show-task-difficulty UI needed it. Absent on tasks enqueued without
     * a difficulty (pre-existing rows, or freeform-classified work).
     */
    difficulty?: string;
    /**
     * M1 dependency edges carried on {@link MeshWorkQueueEntry} — like `difficulty`,
     * already on the wire (mesh_status serializes raw queue rows) and typed here the
     * moment a UI needed it: the task-DAG view renders these as graph edges. Absent
     * on tasks enqueued without dependencies.
     */
    dependsOn?: string[];
    /** M1/M3 mission this task belongs to (same wire-already provenance as dependsOn). */
    missionId?: string;
    /**
     * Provider type of the session that claimed this task, carried on
     * {@link MeshWorkQueueEntry} — same wire-already provenance as `difficulty`
     * and `dependsOn`, typed here for the task-detail completion-info UI.
     * Absent on rows claimed by an older daemon, and on claim paths that drain
     * into an already-running session (`mesh-work-queue.ts:295-299`); treat
     * absence as "unknown", not "no provider".
     */
    assignedProviderType?: string;
    /**
     * Model the claiming session actually launched with — same absence caveats
     * as {@link assignedProviderType}. This is the *executed* model; `model`/
     * `modelSource` below are the *requested* model at enqueue time.
     */
    assignedModel?: string;
    /** G6 task-level scheduling priority (MESH_TASK_PRIORITIES); absent = normal. */
    priority?: MeshTaskPriority;
    /**
     * Independent system hold. C3 derived failure does not write
     * `dependency_failed:*` here; views expose `dependencyFailures` instead.
     */
    blockedReason?: string;
    /**
     * C3 public projection (design :524-527): failed/cancelled predecessor ids
     * derived from current statuses. Skipped placeholders are excluded.
     */
    dependencyFailures?: Array<{ taskId: string; status: 'failed' | 'cancelled'; reason?: string }>;
    /** Task-mode contract (code_change | validation | live_debug_readonly | launch_app | convergence). */
    taskMode?: string;
    /** QUEUE-NODE-SERIALIZATION read-only axis (orthogonal to taskMode). */
    readonly?: boolean;
    /** G7 delayed-execution hold (ISO timestamp) — the task stays pending until this time. */
    notBefore?: string;
    targetNodeId?: string;
    targetSessionId?: string;
    assignedNodeId?: string;
    assignedSessionId?: string;
    cancelReason?: string;
    cancelledAt?: string;
    requeueReason?: string;
    requeuedAt?: string;
    requeueCount?: number;
    autoLaunch?: {
        status: 'skipped' | 'started' | 'failed' | 'completed';
        reason?: string;
        nodeId?: string;
        providerType?: string;
        sessionId?: string;
        updatedAt: string;
    };
    dispatchTimestamp?: string;
    createdAt: string;
    updatedAt: string;
}

export interface RepoMeshQueueSummary {
    total: number;
    active: number;
    historical: number;
    pending: number;
    assigned: number;
    completed: number;
    failed: number;
    cancelled: number;
    activeCounts: {
        pending: number;
        assigned: number;
    };
    historicalCounts: {
        completed: number;
        failed: number;
        cancelled: number;
    };
    activeAssignments: Array<{
        id: string;
        nodeId?: string;
        sessionId?: string;
        message: string;
    }>;
}

export interface RepoMeshQueueStatus {
    tasks: RepoMeshQueueTask[];
    summary: RepoMeshQueueSummary;
}

export interface RepoMeshLedgerEntryStatus {
    id: string;
    meshId: string;
    timestamp: string;
    kind: string;
    nodeId?: string;
    sessionId?: string;
    providerType?: string;
    payload: Record<string, unknown>;
}

export interface RepoMeshLedgerSummaryStatus {
    meshId: string;
    totalEntries: number;
    taskDispatched: number;
    taskCompleted: number;
    taskFailed: number;
    taskStalled: number;
    sessionLaunched: number;
    checkpointCreated: number;
    lastActivityAt: string | null;
    recentFailures: number;
}

export interface RepoMeshLedgerStatus {
    entries: RepoMeshLedgerEntryStatus[];
    summary: RepoMeshLedgerSummaryStatus;
}

// ─── Async Job Lifecycle ─────────────────────────
// Shared base for all mesh async job types (refine jobs, bootstrap runs, etc.)
// Each concrete type adds its own status enum and domain-specific fields.

export interface MeshAsyncJobLifecycle {
    startedAt?: string;
    completedAt?: string;
    error?: string;
}
