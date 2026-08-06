/**
 * Repo Mesh Types — Cross-package type definitions for repo-scoped orchestration
 *
 * A Repo Mesh is a repo-scoped execution environment that groups
 * machines/workspaces around one Git repository identity. A coordinator
 * agent delegates work to mesh nodes via natural conversation.
 *
 * These types are OSS-level and usable without cloud infrastructure.
 * Import via: import type { ... } from '@adhdev/daemon-core/repo-mesh-types'
 *
 * IMPORTANT: This file must remain runtime-free (types only).
 */

import type { GitRepoStatus, GitCompactSummary } from './git/git-types.js';
import type { MeshMissionSummary, MeshMissionSlimSummary } from './mesh/mesh-missions.js';
import type { MeshMagiActivitySummary } from './mesh/mesh-magi-status.js';
import type { MagiKindPanelMap, DifficultyBrainMap, NodeCapabilitySlot } from '@adhdev/mesh-shared';
import type { ProviderModule } from './providers/contracts.js';
import { deriveAutoApproveModeRisk } from './providers/auto-approve-modes.js';
// Type-only import (no runtime cycle) — mesh-json-config imports types from this
// module, and this direction is `import type` so tsc erases it at emit.
import type { RepoMeshDeclarativeConfig } from './config/mesh-json-config.js';

// ─── Core Mesh Types ────────────────────────────

export interface RepoMesh {
    id: string;
    name: string;
    repoIdentity: string;
    repoRemoteUrl?: string;
    defaultBranch?: string;
    policy: RepoMeshPolicy;
    coordinator: RepoMeshCoordinatorConfig;
    meshHost?: RepoMeshHostMetadata;
    projectContext: ProjectContextSnapshot;
    nodes: RepoMeshNode[];
    status: 'active' | 'archived' | 'deleted';
}

export type RepoMeshDaemonRole = 'host' | 'member';

export interface RepoMeshHostPairingMetadata {
    status: 'not_configured' | 'pairing' | 'paired' | 'rejected' | 'revoked';
    tokenId?: string;
    joinedAt?: string;
    lastPairedAt?: string;
    lastRejectedAt?: string;
    expiresAt?: string;
}

export interface RepoMeshHostMetadata {
    /** Local daemon role for this mesh. Missing metadata defaults to host for standalone compatibility. */
    role: RepoMeshDaemonRole;
    /** Daemon that owns mesh truth/status/git/queue/session/ledger/coordinator ownership. */
    hostDaemonId?: string;
    /** Mesh node that represents the host daemon, when known. */
    hostNodeId?: string;
    /** Future standalone manual pairing endpoint entered by member daemons. */
    hostAddress?: string;
    /** Redacted pairing state only; raw join tokens must not be persisted here. */
    pairing?: RepoMeshHostPairingMetadata;
}

export interface RepoMeshHostStatus extends RepoMeshHostMetadata {
    canOwnCoordinator: boolean;
    canOwnQueue: boolean;
    defaulted: boolean;
    /**
     * HOST-SELF-SYNTHESIS-GUARD: true when `hostDaemonId` was NOT read from persisted
     * config but inferred from the evaluating daemon's own identity (a role:'host' mesh
     * whose pin was never written, with no other daemon attached). It is a best-effort
     * default, not an established pin — consumers that would show a confident host badge
     * or target a coordinator launch must treat it as "host not established yet" and
     * require an explicit operator choice. Absent/false = the pin is authoritative
     * (persisted hostDaemonId/hostNodeId, or a node declared role:'host').
     */
    hostSynthesized?: boolean;
}

export interface RepoMeshNode {
    id: string;
    daemonId: string;
    machineId?: string;
    machineLabel: string;
    workspace: string;
    repoRoot?: string;
    git?: GitCompactSummary;
    providers: string[];
    detectedCapabilities: RepoMeshNodeCapabilities;
    userOverrides: Partial<RepoMeshNodeCapabilities>;
    effectiveCapabilities: RepoMeshNodeCapabilities;
    policy: RepoMeshNodePolicy;
    health: RepoMeshNodeHealth;
    role?: RepoMeshDaemonRole;
    status: 'enabled' | 'disabled' | 'removed';
}

export type RepoMeshNodeHealth =
    | 'online'
    | 'offline'
    | 'degraded'
    | 'dirty'
    | 'wrong_branch'
    | 'unknown';

// ─── Policy Types ───────────────────────────────

export type RepoMeshSessionCleanupMode = 'preserve' | 'stop' | 'delete_stopped' | 'stop_and_delete';
export type RepoMeshSpawnedSessionVisibility = 'visible' | 'hidden';

/**
 * What to do with the worker sessions a MAGI fan-out auto-launched, once the
 * review's responses have been collected (terminal). MAGI dispatches each replica
 * to an independent (node × provider); for a pinned target with no idle session
 * the queue AUTO-LAUNCHES a fresh worker session. Those auto-launched sessions
 * stay idle-LIVE after their turn (the CLI process is still running — `completed`
 * means the task finished, not that the runtime exited), so repeated reviews leave
 * a trail of idle live worker sessions cluttering the session list.
 *
 * 'stop_and_delete' (the default) force-stops AND deletes ONLY the sessions this
 * fan-out auto-launched (verified by the per-session autoLaunchedForQueueTaskId
 * marker — see cleanupMeshSessions). It is the only mode that covers the idle-LIVE
 * case: delete_stopped skips live runtimes by contract, so it would no-op on the
 * exact sessions we want gone. Reused idle sessions (no marker), the coordinator
 * session, and any other node's sessions are NEVER touched.
 *
 * 'preserve' disables auto-cleanup entirely (leave every auto-launched worker
 * session as-is for later inspection).
 */
export type RepoMeshMagiSessionCleanupMode = 'preserve' | 'stop_and_delete';

/**
 * Mesh-wide tie-break strategy for distributing untargeted queue work across
 * eligible nodes. This ONLY governs the final tie-break stage of the scheduler
 * pipeline (TAG hard-filter → MAX-ALLOC capacity gate → PRIORITY soft score →
 * TIE-BREAK); eligibility/capacity/priority are evaluated identically for every
 * strategy.
 *
 * - 'first_eligible' (DEFAULT): preserve today's behavior exactly. Nodes are
 *   visited in config/array order and the first that can launch wins. No
 *   load-spreading. This is the strict no-change default — a mesh that never
 *   sets schedulingStrategy behaves identically to before this feature.
 * - 'least_loaded': prefer the eligible node with the fewest active assignments,
 *   so untargeted work spreads instead of piling onto whichever node asks first.
 * - 'round_robin': among nodes tied at the least load, rotate the winner using a
 *   per-mesh cursor so distribution stays fair across passes.
 * - 'priority_only': rank purely by schedulingPriority (then config order),
 *   ignoring load — always send to the highest-priority eligible node.
 *
 * Distribution is explicit opt-in: a strategy other than 'first_eligible' must be
 * configured for any load-spreading to occur.
 */
export type RepoMeshSchedulingStrategy =
    | 'first_eligible'
    | 'least_loaded'
    | 'round_robin'
    | 'priority_only'
    // ORCHESTRATION_NODE_SLOTS.md: rank nodes by task→capability-slot fitness
    // (task difficulty/requiredTags vs the node's slots), then priority/load/order.
    // Falls back to load ordering when no task is in scope (idle-session drain).
    | 'fitness';

export const MESH_SCHEDULING_STRATEGIES: RepoMeshSchedulingStrategy[] = [
    'first_eligible',
    'least_loaded',
    'round_robin',
    'priority_only',
    'fitness',
];

export const DEFAULT_MESH_SCHEDULING_STRATEGY: RepoMeshSchedulingStrategy = 'first_eligible';

/**
 * Normalize an unknown scheduling-strategy value to a valid strategy, defaulting
 * to 'first_eligible' (strict no-change) for anything missing/blank/unrecognized.
 */
export function normalizeMeshSchedulingStrategy(value: unknown): RepoMeshSchedulingStrategy {
    if (typeof value !== 'string') return DEFAULT_MESH_SCHEDULING_STRATEGY;
    const trimmed = value.trim() as RepoMeshSchedulingStrategy;
    return (MESH_SCHEDULING_STRATEGIES as string[]).includes(trimmed)
        ? trimmed
        : DEFAULT_MESH_SCHEDULING_STRATEGY;
}

// ─── User-facing distribution mode (2-mode façade over the 4-union) ──────────
//
// The raw RepoMeshSchedulingStrategy 4-union stays the persisted, escape-hatch
// truth (a hand-edited meshes.json / .adhdev/mesh.json may write any of the four
// and it is honored verbatim). The PRODUCT surface is just two modes:
//
//   - 'spread'   → distribute work evenly. Maps to 'least_loaded', which now also
//                  absorbs the round_robin rotation as its internal tie-break (see
//                  orderEligibleNodes), so a single mode covers both former
//                  load-spreading strategies. schedulingPriority still acts as the
//                  primary rank key automatically when set — no separate mode.
//   - 'in_order' → assign in the order nodes were added. Maps to 'first_eligible'
//                  (the strict no-change default).
//
// distributionToStrategy / strategyToDistribution are the canonical bridge the UI
// and the .adhdev/mesh.json loader share so the 2-mode↔4-union mapping is defined
// exactly once.
export type RepoMeshDistribution = 'spread' | 'in_order';

export const MESH_DISTRIBUTIONS: RepoMeshDistribution[] = ['spread', 'in_order'];

/**
 * Product default for the user-facing toggle. Note this is the *recommended* mode
 * shown first, NOT the persisted default: a mesh that never sets schedulingStrategy
 * stays 'first_eligible' (→ displays as 'in_order'), preserving strict no-change.
 */
export const DEFAULT_MESH_DISTRIBUTION: RepoMeshDistribution = 'spread';

/** Normalize an unknown value to a valid distribution mode (defaults to 'spread'). */
export function normalizeMeshDistribution(value: unknown): RepoMeshDistribution {
    if (typeof value !== 'string') return DEFAULT_MESH_DISTRIBUTION;
    const trimmed = value.trim();
    return (MESH_DISTRIBUTIONS as string[]).includes(trimmed)
        ? (trimmed as RepoMeshDistribution)
        : DEFAULT_MESH_DISTRIBUTION;
}

/**
 * Map a user-facing distribution mode to the raw scheduling strategy the scheduler
 * acts on. 'spread' → 'least_loaded' (which absorbs round_robin rotation as its
 * tie-break); 'in_order' → 'first_eligible'.
 */
export function distributionToStrategy(distribution: RepoMeshDistribution): RepoMeshSchedulingStrategy {
    return distribution === 'spread' ? 'least_loaded' : 'first_eligible';
}

/**
 * Map a raw scheduling strategy back to the 2-mode façade for display/migration.
 *   - 'first_eligible'           → 'in_order'
 *   - 'least_loaded'/'round_robin' → 'spread'
 *   - 'priority_only'            → 'spread' when a node priority is actually
 *     configured (priority ordering IS a spread behavior), else 'in_order'
 *     (priority_only with no priorities is behaviorally identical to
 *     first_eligible, so it must not flip a mesh into load-spreading on migration).
 */
export function strategyToDistribution(
    strategy: unknown,
    opts?: { priorityConfigured?: boolean },
): RepoMeshDistribution {
    const normalized = normalizeMeshSchedulingStrategy(strategy);
    if (normalized === 'first_eligible') return 'in_order';
    if (normalized === 'priority_only') return opts?.priorityConfigured ? 'spread' : 'in_order';
    return 'spread';
}

/**
 * Resolve a node's soft scheduling priority — a single scalar used as the PRIORITY
 * stage rank key (higher = preferred). It is NOT an eligibility gate (the MAX-ALLOC
 * capacity gate alone decides whether a node can take work). Missing/blank/NaN
 * resolves to 0 so unconfigured nodes all share the same neutral priority.
 */
export function resolveNodeSchedulingPriority(
    nodePolicy: Pick<RepoMeshNodePolicy, 'schedulingPriority'> | null | undefined,
): number {
    const raw = Number(nodePolicy?.schedulingPriority);
    return Number.isFinite(raw) ? raw : 0;
}

/**
 * Synthetic capability tag advertised by every mesh node describing how it can land
 * its work onto the base branch:
 *   - converge=refine: a local worktree node (on any machine — refine_mesh_node
 *     forwards to the owning daemon) can run the Refinery merge → push → cleanup.
 *   - converge=fast_forward: a non-worktree node (the machine itself) can only
 *     fast-forward/push an already-converged branch.
 * Emitted by buildMeshNodeCapabilityTags and matched through the ordinary
 * required-tags filter.
 */
export const MESH_CONVERGE_REFINE_TAG = 'converge=refine';
export const MESH_CONVERGE_FAST_FORWARD_TAG = 'converge=fast_forward';

/**
 * Resolve whether the load-balancing scheduler should auto-inject a
 * `converge=refine` required tag onto code_change tasks so they hard-filter onto
 * refine-capable (worktree) nodes only. Strict opt-in: defaults to false, so a mesh
 * that does not set it behaves exactly as before (code_change routes to any eligible
 * node, including a non-worktree machine node when no worktree exists).
 */
export function resolveAutoConvergeCodeChange(
    policy: Pick<RepoMeshPolicy, 'autoConvergeCodeChange'> | null | undefined,
): boolean {
    return policy?.autoConvergeCodeChange === true;
}

export interface RepoMeshAutoFastForwardPolicy {
    /** Defaults to true. Set false to disable daemon-initiated idle fast-forwards. */
    enabled: boolean;
    /** Maximum behind count eligible for automatic fast-forward. Missing means no limit. */
    maxBehind?: number;
    /** Defaults to true. Require submodule status to be clean before automatic fast-forward. */
    requireCleanSubmodules?: boolean;
    /**
     * Opt-in: extend auto fast-forward to REMOTE owning-daemon nodes (not just the
     * coordinator's local workspace). Defaults to **false** so the historical
     * self-only behavior is preserved byte-for-byte. When true, the coordinator
     * delegates the ff to the node's owning daemon via dispatchMeshCommand
     * (fast_forward_mesh_node), which runs the same git safety gates on the machine
     * that actually holds the workspace.
     */
    remoteNodes?: boolean;
    /**
     * When to run remote auto fast-forward detection. Defaults to **"idle"** — the
     * historical behavior where the ff is only attempted on a node's idle edge
     * (agent:ready / genuine generating_completed). "continuous" adds a periodic
     * scan inside the reconcile tick so an online/clean/behind remote node is caught
     * up even when it emits no fresh idle edge (e.g. a base node that has been idle
     * for a while while upstream advanced). Only governs remote-node detection;
     * local idle-edge ff is unchanged either way.
     */
    mode?: 'idle' | 'continuous';
}

export interface RepoMeshPolicy {
    requirePreTaskCheckpoint: boolean;
    requirePostTaskCheckpoint: boolean;
    requireApprovalForPush: boolean;
    /**
     * Narrow Refinery opt-in: when validation and patch-equivalence have passed,
     * allow Refinery to publish submodule gitlink commits to each submodule's
     * configured remote main branch with a non-force push, then verify reachability.
     * Defaults to false; root branch pushes/merges are not affected.
     */
    allowAutoPublishSubmoduleMainCommits?: boolean;
    requireApprovalForDestructiveGit: boolean;
    dirtyWorkspaceBehavior: 'block' | 'warn' | 'checkpoint_then_continue';
    maxParallelTasks: number;
    allowedProviders?: string[];
    /**
     * Mesh-wide tie-break strategy for distributing untargeted queue work across
     * eligible nodes. Defaults to 'first_eligible' (today's exact behavior — no
     * load-spreading). Set to 'least_loaded' / 'round_robin' / 'priority_only' to
     * opt into distribution. Only governs the final tie-break stage; eligibility,
     * capacity, and priority are evaluated identically regardless of strategy.
     */
    schedulingStrategy?: RepoMeshSchedulingStrategy;
    /**
     * Convergence routing opt-in: when true, the scheduler auto-injects a
     * `converge=refine` required tag onto every code_change task at enqueue time, so
     * code_change work hard-filters onto refine-capable worktree nodes (on any
     * machine — refine_mesh_node forwards to the owning daemon) and never lands on a
     * non-worktree machine node. Explicit target_node_id routing and any
     * caller-supplied required_tags are preserved (the tag is merged, not replaced).
     * Defaults to false: code_change routing is unchanged unless opted in.
     */
    autoConvergeCodeChange?: boolean;
    /**
     * Whether sessions spawned by mesh/coordinator policy should auto-open as visible
     * dashboard tabs or start hidden. Defaults to 'hidden' so the dashboard is not
     * flooded with mesh noise tabs; users can still surface or unmute any specific
     * session manually from the dashboard (that override is preserved per-device).
     */
    spawnedSessionVisibility?: RepoMeshSpawnedSessionVisibility;
    /**
     * Whether worker sessions the coordinator dispatches should auto-approve agent
     * approval modals (tool/command prompts) without firing a user-facing approval
     * notification. Delegated workers are coordinator-driven, so a human should not
     * have to approve each one; defaults to true. Set to false to make delegated
     * worker sessions stop at approval modals like an interactive session.
     * Stamped into the worker launch settings envelope as `autoApprove`, which wins
     * over the global per-provider-type autoApprove config via the settings merge.
     * A node policy may override this per-node (RepoMeshNodePolicy.delegatedWorkerAutoApprove).
     */
    delegatedWorkerAutoApprove?: boolean;
    /** Explicit opt-in required before delegated workers may use a dangerous provider mode. */
    delegatedWorkerDangerousModeAllow?: boolean;
    /**
     * MESH-SEND-KEYS (feature 3): opt-in to allow the coordinator to inject
     * DESTRUCTIVE keys (CTRL_C / ESC) into a worker PTY via mesh_send_keys. These
     * can kill or derail the worker process, and delegatedWorkerAutoApprove is a
     * TOOL-CONSENT policy, not a PTY-input authorization — so a destructive key
     * injection additionally requires this explicit mesh-owner opt-in AND a
     * per-call confirm_destructive=true. Defaults to false (destructive keys
     * refused). Non-destructive keys (text/ENTER/arrows/TAB/BACKSPACE) are
     * unaffected. A node policy may override per-node.
     */
    allowSendKeysDestructive?: boolean;
    /**
     * What to do with delegated session-host records for a node when it is removed.
     * Defaults to 'preserve' so completed work can be reviewed later and live
     * runtimes are never stopped/deleted unless the mesh owner opts in.
     */
    sessionCleanupOnNodeRemove?: RepoMeshSessionCleanupMode;
    /**
     * What to do with the worker sessions a MAGI fan-out auto-launched, once the
     * review responses are collected (terminal). Defaults to 'stop_and_delete' so
     * repeated mesh_magi_review calls don't accumulate idle-LIVE worker sessions.
     * Only sessions THIS fan-out auto-launched are affected (marker-verified);
     * reused/coordinator/other-node sessions are never touched. Set 'preserve' to
     * leave auto-launched worker sessions for later inspection. A per-call
     * auto_cleanup override on mesh_magi_review / mesh_magi_collect beats this.
     * Accepts a boolean for convenience (true → stop_and_delete, false → preserve).
     */
    magiSessionCleanup?: RepoMeshMagiSessionCleanupMode | boolean;
    /**
     * Daemon-initiated fast-forward for idle clean nodes that are only behind
     * their tracked upstream. Defaults to enabled.
     */
    autoFastForward?: RepoMeshAutoFastForwardPolicy;
    /**
     * Maximum number of automatic retry recommendations for a failed task on the
     * same node before the daemon advises the coordinator to escalate or reassign.
     * Defaults to 1 (allow one retry). Set to 0 to disable auto-recovery advice.
     */
    maxTaskRetries?: number;
    /**
     * When true (default), the daemon injects a one-shot "[System] Coordinator idle
     * with N active mission(s)" reminder into an idle coordinator session whenever the
     * mesh is fully idle (no queue/direct work in flight, no pending coordinator events)
     * yet still has `active` missions. This nudges the coordinator to close or continue
     * missions that would otherwise drift in `active` while their real outcome is decided.
     * Idempotent/debounced per mission-set (see maybeInjectIdleActiveMissionReminder).
     * Set to false to suppress the reminder entirely.
     */
    idleActiveMissionReminder?: boolean;
    /**
     * Whether a coordinator-dispatched worker's routine idle/completion push
     * notification is delivered to the owner every time ('always', the default —
     * historical behavior, byte-for-byte unchanged), or auto-silenced for the single
     * completion that follows a coordinator dispatch ('auto_silent_on_dispatch').
     *
     * When 'auto_silent_on_dispatch', dispatching a task to a worker arms a ONE-SHOT
     * transient mute (settings.silentNextIdlePush) on that worker session. The next
     * agent:generating_completed rides a muted status snapshot, so the server push
     * gate (which already honors session.muted) suppresses ONLY that routine
     * completion push; the flag auto-clears afterward so subsequent turns notify
     * normally, and it is status-gated to `idle` so an approval-needed / long-running
     * / failure notification in the SAME turn is NEVER suppressed. A stale one-shot
     * self-expires (SILENT_IDLE_PUSH_TTL_MS) so a worker that never completes cannot
     * strand its session permanently muted.
     *
     * Coordinator-spawned HIDDEN workers already default muted (they emit no owner
     * push), so this only changes behavior for VISIBLE / manually-unmuted delegated
     * workers. Defaults to 'always' — zero behavior change unless the mesh opts in.
     */
    coordinatorIdlePushPolicy?: 'always' | 'auto_silent_on_dispatch';
    /**
     * Base directory under which mesh_clone_node physically creates managed
     * worktrees, laid out as `<worktreeBaseDir>/<meshName>/<branch>`. When unset
     * (the default), worktrees are placed under `<home>/.adhdev/worktrees`
     * (getDefaultWorktreeBaseDir). The cleanup guard resolves the same base from
     * this policy, so an override applied at clone time must remain set on the mesh
     * for the node's lifetime.
     */
    worktreeBaseDir?: string;
    /**
     * Quota-aware routing thresholds (QUOTA ROUTING GATE / SPREAD). The daemon
     * consumes the per-provider quota snapshots riding each node's nodeFacts
     * bundle in two places: a launch GATE that skips a (node, provider) whose
     * remaining session/weekly window is below the threshold, and a bounded
     * SPREAD bonus in task→slot fitness that prefers providers with more
     * headroom. Both fail OPEN on missing or stale data — an old reading must
     * never exclude a node. All fields default when unset (see
     * DEFAULT_QUOTA_ROUTING_POLICY); persist only explicit overrides.
     *
     * This is a ROUTING policy (coordinator-side), distinct from the
     * machine-local quota PROBE on/off (machineProviders) — the probe decides
     * whether a node measures its quota at all, this decides how the
     * coordinator routes on whatever was reported.
     */
    quotaRouting?: RepoMeshQuotaRoutingPolicy;
}

/**
 * Quota-aware routing thresholds (RepoMeshPolicy.quotaRouting). Every field is
 * optional; a missing field resolves to DEFAULT_QUOTA_ROUTING_POLICY.
 */
export interface RepoMeshQuotaRoutingPolicy {
    /**
     * Age past which a reported quota snapshot is judged STALE and ignored
     * (fail-open). Defaults to 30 min — two quota refresh cycles
     * (QUOTA_REFRESH_INTERVAL_MS = 15 min), generous enough to absorb reporter↔
     * coordinator clock skew.
     */
    staleAfterMs?: number;
    /**
     * Skip a (node, provider) whose SESSION window (the short ~5h rolling
     * window) has less than this percent remaining. Defaults to 10 — the short
     * window recovers quickly, so the bar is low.
     */
    sessionMinRemainingPercent?: number;
    /**
     * Skip a (node, provider) whose WEEKLY window (the ~7d rolling window) has
     * less than this percent remaining. Defaults to 15 — an exhausted weekly
     * window strands the node for days, so the bar is more conservative.
     */
    weeklyMinRemainingPercent?: number;
    /**
     * Upper bound of the quota-headroom bonus added to a slot's task-fitness
     * score, proportional to remaining quota. Defaults to 30 — deliberately
     * below the exact-difficulty-match bonus (+100) and level with the
     * requiredTags coverage bonus (+30), so quota can express a PREFERENCE
     * among equally-fit slots but can never overturn a difficulty match.
     */
    spreadBonusMax?: number;
}

export interface RepoMeshRelatedRepo {
    /** Stable display label for an explicitly configured associated checkout. */
    label: string;
    /** Absolute checkout/workspace path for git freshness probes. */
    workspace: string;
}

/**
 * Per-(node, provider) parallelism declaration.
 *
 * `maxParallel` is the only enforced field: the queue will not assign a task
 * to this (node, provider) once it already has `maxParallel` active
 * (status='assigned') tasks. When the global parallel cap and this per-(node,
 * provider) cap disagree, the stricter (lower effective) limit wins — a claim
 * must satisfy both. Omitting `maxParallel` means this provider is bounded only
 * by the global/taskMode caps (full backward compatibility).
 *
 * Routing is governed exclusively by required_tags (see nodeSatisfiesRequiredTags).
 * To route work to a specific node, advertise an ordinary capability tag on the
 * node and require it on the task.
 *
 * NOTE: the per-(node, provider) parallelism cap now lives on `slots[].maxParallel`
 * (see NodeCapabilitySlot). The former `providerRoles` field has been removed; a
 * persisted meshes.json that still carries it is migrated to `slots` on load
 * (see migrateLoadedMeshConfig).
 */

/**
 * Unified mirrored member state — the per-machine RUNTIME facts a remote member
 * self-reports (REMOTE-NODE-SLOTS-COORDINATOR-LOCAL fix).
 *
 * A single self-reported observability envelope stamped by the daemon that OWNS a
 * node's workspace and carried wholesale on the git_status envelope
 * (reporterMemberState), consolidating the previously per-field self-heal of
 * providerVersions and daemonBuildVersion. The coordinator ingests this whole object
 * onto the mirrored remote node in one place
 * (mesh-node-identity.recordInlineMeshDirectGitTruth).
 *
 * Source-of-truth model: provider VERSIONS + daemon BUILD are per-machine runtime
 * facts (e.g. a member has claude-cli@2.1.168 while the coordinator has @2.1.170), so
 * they are reported here. SLOTS are NOT reported — they are coordinator-owned config
 * (node.policy.slots for every node, self and remote alike; see
 * resolveNodeCapabilitySlots), a single source of truth on the coordinator with no
 * reporter round-trip.
 */
export interface MeshReportedMemberState {
    /** Reporter node's detected provider CLI/ACP versions (keyed by provider id). */
    providerVersions?: Record<string, string>;
    /** Reporter daemon's build version (getDaemonBuildInfo().version). */
    daemonBuildVersion?: string;
    /** Epoch ms the report was stamped; used for mirror staleness reasoning. */
    lastReportedAt?: number;
}

export interface RepoMeshNodePolicy {
    readOnly?: boolean;
    canPush?: boolean;
    maxConcurrentSessions?: number;
    /**
     * Soft scheduling priority used as the PRIORITY rank key (higher = preferred)
     * when the mesh schedulingStrategy spreads work across nodes. Defaults to 0.
     * This is NOT an eligibility gate — a node with a high priority that is at its
     * capacity (MAX-ALLOC gate) is still skipped; priority only orders nodes that
     * can actually take work. Ignored entirely under 'first_eligible'.
     */
    schedulingPriority?: number;
    /** Ordered provider preference used when mesh_launch_session omits an explicit type. */
    providerPriority?: string[];
    /**
     * Node capability slots (ORCHESTRATION_NODE_SLOTS.md) — the ordered "Preferred
     * AI tools" profile that is the single source of truth for task routing, MAGI
     * fan-out, and orchestrator-proposed edits. Each slot bundles provider + model
     * + thinkingLevel + difficulty range + capability tags + per-slot maxParallel.
     * Order = preference. When absent, the scheduler derives slots from the legacy
     * providerPriority/difficultyBrains (deriveSlotsFromLegacy) so existing nodes
     * keep working without reconfiguration.
     */
    slots?: NodeCapabilitySlot[];
    /**
     * Per-node override for RepoMeshPolicy.delegatedWorkerAutoApprove. When set, takes
     * precedence over the mesh-level policy for worker sessions launched onto this node.
     */
    delegatedWorkerAutoApprove?: boolean;
    /** Per-node override for dangerous delegated worker mode authorization. */
    delegatedWorkerDangerousModeAllow?: boolean;
    /**
     * MESH-SEND-KEYS (feature 3): per-node override for
     * RepoMeshPolicy.allowSendKeysDestructive.
     */
    allowSendKeysDestructive?: boolean;
    /**
     * Optional associated/external repos that must be checked alongside this node.
     * These are explicit policy/config entries only; Repo Mesh does not auto-discover
     * sibling paths so freshness checks stay fail-closed and non-surprising.
     */
    relatedRepos?: RepoMeshRelatedRepo[];
    /**
     * When true (default), mesh_git_status automatically discovers git submodules
     * and includes their status. Set to false to disable auto-discovery.
     */
    autoDiscoverSubmodules?: boolean;
    /**
     * Submodule paths to ignore when autoDiscoverSubmodules is true.
     * Useful for vendored dependencies that change frequently but are not deploy-critical.
     */
    submoduleIgnorePaths?: string[];
    /**
     * When true (default), mesh_clone_node runs `git submodule update --init --recursive`
     * after creating a worktree. Set to false to skip submodule initialization.
     */
    initSubmodulesOnClone?: boolean;
}

export const DEFAULT_MESH_POLICY: RepoMeshPolicy = {
    requirePreTaskCheckpoint: false,
    requirePostTaskCheckpoint: true,
    requireApprovalForPush: true,
    allowAutoPublishSubmoduleMainCommits: false,
    requireApprovalForDestructiveGit: true,
    dirtyWorkspaceBehavior: 'warn',
    // Mesh-wide task cap is effectively unlimited by default: the real concurrency
    // limits live per node / per capability slot (ORCHESTRATION_NODE_SLOTS.md), so a
    // global ceiling is rarely meaningful. The UI hides this control; set it via the
    // API only to impose a deliberate mesh-wide cap.
    maxParallelTasks: 200,
    // Coordinator-spawned worker sessions default to hidden so the dashboard is not
    // flooded with mesh noise tabs/notifications. Users can still surface or unmute
    // any specific session manually; that override is preserved per-device.
    spawnedSessionVisibility: 'hidden',
    delegatedWorkerAutoApprove: true,
    delegatedWorkerDangerousModeAllow: false,
    sessionCleanupOnNodeRemove: 'preserve',
    // MAGI auto-launches a worker session per pinned replica target with no idle
    // session; those stay idle-LIVE after their turn. Default ON (stop_and_delete)
    // so repeated reviews don't pile up idle worker sessions. Only marker-verified
    // auto-launched sessions are cleaned — see RepoMeshMagiSessionCleanupMode.
    magiSessionCleanup: 'stop_and_delete',
    autoFastForward: { enabled: true },
    maxTaskRetries: 1,
    // Nudge the coordinator when the mesh is fully idle but active missions linger,
    // so a mission is never left drifting in `active` after its work is really done.
    idleActiveMissionReminder: true,
    // Conservative default: every coordinator-dispatched worker completion still
    // notifies the owner. Opt into 'auto_silent_on_dispatch' to one-shot-silence the
    // routine idle push for a coordinator-driven task (approval/failure notifications
    // are never affected — see coordinatorIdlePushPolicy).
    coordinatorIdlePushPolicy: 'always',
};

/**
 * Defaults for the quota-routing thresholds (RepoMeshPolicy.quotaRouting).
 * Rationale per field lives on RepoMeshQuotaRoutingPolicy. Kept next to
 * DEFAULT_MESH_POLICY so all policy defaults share one home.
 */
export const DEFAULT_QUOTA_ROUTING_POLICY: Required<RepoMeshQuotaRoutingPolicy> = {
    staleAfterMs: 30 * 60 * 1000,
    sessionMinRemainingPercent: 10,
    weeklyMinRemainingPercent: 15,
    spreadBonusMax: 30,
};

/**
 * Resolve the effective quota-routing thresholds from a mesh policy, filling
 * every unset/invalid field from DEFAULT_QUOTA_ROUTING_POLICY. The launch gate
 * and the fitness spread bonus both read through here so they can never
 * disagree on what the thresholds are.
 */
export function resolveQuotaRoutingPolicy(
    value?: RepoMeshQuotaRoutingPolicy | null,
): Required<RepoMeshQuotaRoutingPolicy> {
    const staleAfterMs = Number(value?.staleAfterMs);
    const sessionMin = Number(value?.sessionMinRemainingPercent);
    const weeklyMin = Number(value?.weeklyMinRemainingPercent);
    const spreadMax = Number(value?.spreadBonusMax);
    const clampPercentField = (n: number, fallback: number) =>
        Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : fallback;
    return {
        staleAfterMs: Number.isFinite(staleAfterMs) && staleAfterMs >= 0
            ? Math.floor(staleAfterMs)
            : DEFAULT_QUOTA_ROUTING_POLICY.staleAfterMs,
        sessionMinRemainingPercent: clampPercentField(sessionMin, DEFAULT_QUOTA_ROUTING_POLICY.sessionMinRemainingPercent),
        weeklyMinRemainingPercent: clampPercentField(weeklyMin, DEFAULT_QUOTA_ROUTING_POLICY.weeklyMinRemainingPercent),
        spreadBonusMax: Number.isFinite(spreadMax) && spreadMax >= 0
            ? spreadMax
            : DEFAULT_QUOTA_ROUTING_POLICY.spreadBonusMax,
    };
}

/**
 * Normalize a quotaRouting sub-policy for persistence. Returns undefined when
 * the value is absent or every field resolves to its default, so an untouched
 * meshes.json stays byte-for-byte the same (same persistence-economy rule as
 * schedulingStrategy); otherwise returns only the explicitly non-default,
 * valid fields.
 */
export function normalizeQuotaRoutingPolicy(value: unknown): RepoMeshQuotaRoutingPolicy | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const resolved = resolveQuotaRoutingPolicy(record as RepoMeshQuotaRoutingPolicy);
    const out: RepoMeshQuotaRoutingPolicy = {};
    if (record.staleAfterMs !== undefined && resolved.staleAfterMs !== DEFAULT_QUOTA_ROUTING_POLICY.staleAfterMs) {
        out.staleAfterMs = resolved.staleAfterMs;
    }
    if (record.sessionMinRemainingPercent !== undefined && resolved.sessionMinRemainingPercent !== DEFAULT_QUOTA_ROUTING_POLICY.sessionMinRemainingPercent) {
        out.sessionMinRemainingPercent = resolved.sessionMinRemainingPercent;
    }
    if (record.weeklyMinRemainingPercent !== undefined && resolved.weeklyMinRemainingPercent !== DEFAULT_QUOTA_ROUTING_POLICY.weeklyMinRemainingPercent) {
        out.weeklyMinRemainingPercent = resolved.weeklyMinRemainingPercent;
    }
    if (record.spreadBonusMax !== undefined && resolved.spreadBonusMax !== DEFAULT_QUOTA_ROUTING_POLICY.spreadBonusMax) {
        out.spreadBonusMax = resolved.spreadBonusMax;
    }
    return Object.keys(out).length ? out : undefined;
}

/**
 * TTL for the one-shot silent-idle-push arm (settings.silentNextIdlePushArmedAt).
 * A dispatched worker whose completion never arrives (crash, offline, dropped event)
 * must not leave its session muted forever — after this window the arm is treated as
 * expired and stops muting, so the session self-heals to normal notification behavior.
 * Ten minutes comfortably covers a long delegated turn while still bounding the leak.
 */
export const SILENT_IDLE_PUSH_TTL_MS = 10 * 60 * 1000;

/**
 * Resolve the effective coordinator idle-push policy from a mesh policy, defaulting
 * to 'always' (notify) for a missing/invalid value so a typo can never silently
 * disable owner completion notifications. Mirrors the other policy resolvers so the
 * arm site and any future consumer read one source of truth.
 */
export function resolveCoordinatorIdlePushPolicy(
    meshPolicy?: Pick<RepoMeshPolicy, 'coordinatorIdlePushPolicy'> | null,
): 'always' | 'auto_silent_on_dispatch' {
    return meshPolicy?.coordinatorIdlePushPolicy === 'auto_silent_on_dispatch'
        ? 'auto_silent_on_dispatch'
        : 'always';
}

// ─── Policy normalization (single source of truth) ──────────────────────────
//
// Every mesh policy passes through mergeAndNormalizePolicy exactly once on write
// (createMesh/updateMesh) and again whenever a policy is materialized for display
// or scheduling. Co-locating the default constant, the per-field normalizers, and
// the merge here keeps the three former layers (DEFAULT_MESH_POLICY, the merge in
// mesh-config, and the scattered field clamps) from drifting apart. The function
// is idempotent: feeding it an already-normalized policy yields the same object.

const SESSION_CLEANUP_MODES = new Set<RepoMeshSessionCleanupMode>([
    'preserve', 'stop', 'delete_stopped', 'stop_and_delete',
]);

/**
 * Resolve a magiSessionCleanup policy value (string mode, boolean shorthand,
 * or unset) to a canonical mode. Unset → the default ('stop_and_delete', ON).
 * boolean true → 'stop_and_delete', false → 'preserve'. Any unrecognized string
 * falls back to the default so a typo can't silently disable auto-cleanup.
 */
export function resolveMagiSessionCleanupMode(
    value: RepoMeshMagiSessionCleanupMode | boolean | undefined | null,
): RepoMeshMagiSessionCleanupMode {
    if (value === undefined || value === null) return DEFAULT_MESH_POLICY.magiSessionCleanup as RepoMeshMagiSessionCleanupMode;
    if (typeof value === 'boolean') return value ? 'stop_and_delete' : 'preserve';
    return value === 'preserve' || value === 'stop_and_delete'
        ? value
        : (DEFAULT_MESH_POLICY.magiSessionCleanup as RepoMeshMagiSessionCleanupMode);
}

export type MagiCleanupGateReason =
    | 'auto_launch_marker_match'
    | 'auto_launch_marker_skip_coordinator_session'
    | 'auto_launch_marker_absent_session_not_auto_launched'
    | 'auto_launch_marker_mismatch';

/**
 * Pure decision for the MAGI auto-cleanup marker gate. A session is eligible for
 * MAGI auto-cleanup ONLY when its session-host record was auto-launched FOR the
 * exact replica task the caller expects. This is the safety core: MAGI passes
 * explicit session_ids (which bypass the self-coordinator / shared-daemon guards),
 * so this marker check is the sole thing preventing a reused-idle, coordinator, or
 * re-assigned session from being stopped/deleted.
 *
 *  - coordinator session (meta.meshCoordinatorFor === meshId)          → skip
 *  - no expected task id supplied for this session id                  → skip
 *  - record carries no autoLaunchedForQueueTaskId marker (reused idle) → skip
 *  - marker present but points at a DIFFERENT task (re-assignment)     → skip
 *  - marker present and equals the expected task id                    → ALLOW
 */
export function magiAutoLaunchedSessionCleanupDecision(args: {
    recordMarker: string | undefined | null;
    expectedTaskId: string | undefined | null;
    isCoordinatorSession: boolean;
}): { allow: boolean; reason: MagiCleanupGateReason } {
    const marker = typeof args.recordMarker === 'string' ? args.recordMarker.trim() : '';
    const expected = typeof args.expectedTaskId === 'string' ? args.expectedTaskId.trim() : '';
    if (args.isCoordinatorSession) return { allow: false, reason: 'auto_launch_marker_skip_coordinator_session' };
    if (!expected) return { allow: false, reason: 'auto_launch_marker_mismatch' };
    if (!marker) return { allow: false, reason: 'auto_launch_marker_absent_session_not_auto_launched' };
    if (marker !== expected) return { allow: false, reason: 'auto_launch_marker_mismatch' };
    return { allow: true, reason: 'auto_launch_marker_match' };
}
const SPAWNED_SESSION_VISIBILITY_MODES = new Set<RepoMeshSpawnedSessionVisibility>([
    'visible', 'hidden',
]);
const DIRTY_WORKSPACE_BEHAVIORS = new Set<RepoMeshPolicy['dirtyWorkspaceBehavior']>([
    'block', 'warn', 'checkpoint_then_continue',
]);

/** Min/max bounds for the global write-task parallel cap. */
export const MESH_MAX_PARALLEL_TASKS_MIN = 1;
export const MESH_MAX_PARALLEL_TASKS_MAX = 64;

/**
 * Default multiplier applied to the write cap to derive the read-only diagnosis
 * cap. Read-only (live_debug_readonly) tasks carry no isolation/merge cost so they
 * run under a separate, looser cap; a missing/invalid readonlyMultiplier resolves
 * to this value, preserving the historical `max(2, write × 2)` behavior.
 */
export const DEFAULT_MESH_READONLY_MULTIPLIER = 2;

/**
 * SINGLE source of truth for the read-only diagnosis cap derivation. Both the live
 * claim path (maybeAutoLaunchOneQueueSession) and the observability projection
 * (buildMeshSchedulingRuntime) read it through here so the exposed cap and the
 * enforced cap can never drift. Floors at 2 so a write cap of 1 still allows two
 * concurrent read-only diagnoses. An out-of-range multiplier falls back to the
 * default (2) — identical to the previous inline `Math.max(2, maxParallel * 2)`.
 */
export function resolveMaxReadonlyParallelTasks(maxParallelTasks: number, multiplier?: unknown): number {
    const raw = Number(multiplier);
    const mult = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_MESH_READONLY_MULTIPLIER;
    return Math.max(2, Math.floor(maxParallelTasks) * mult);
}

/**
 * Resolve the effective global write-task parallel cap from a raw policy value,
 * clamped to [MESH_MAX_PARALLEL_TASKS_MIN, MESH_MAX_PARALLEL_TASKS_MAX] and
 * defaulting to DEFAULT_MESH_POLICY.maxParallelTasks for a missing/NaN value.
 * Both the config write path and the runtime scheduler read the cap through this
 * helper so they can never disagree on what "max parallel" means.
 */
export function resolveMaxParallelTasks(value: unknown): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return DEFAULT_MESH_POLICY.maxParallelTasks;
    return Math.max(MESH_MAX_PARALLEL_TASKS_MIN, Math.min(MESH_MAX_PARALLEL_TASKS_MAX, Math.floor(n)));
}

/**
 * Normalize an autoFastForward sub-policy, filling defaults and dropping an
 * invalid maxBehind. Mirrors the (previously mesh-config-local) shape so the merge
 * always emits a fully-populated, valid autoFastForward object.
 */
export function normalizeAutoFastForwardPolicy(value: unknown): NonNullable<RepoMeshPolicy['autoFastForward']> {
    const record = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
    const maxBehind = Number(record.maxBehind);
    // Persistence economy: remoteNodes is emitted only when explicitly true and mode
    // only when explicitly 'continuous', so an untouched autoFastForward stays
    // byte-for-byte { enabled, requireCleanSubmodules, [maxBehind] } — the historical
    // self-only / idle-edge default shape.
    return {
        enabled: record.enabled !== false,
        ...(Number.isFinite(maxBehind) && maxBehind >= 0 ? { maxBehind: Math.floor(maxBehind) } : {}),
        requireCleanSubmodules: record.requireCleanSubmodules !== false,
        ...(record.remoteNodes === true ? { remoteNodes: true } : {}),
        ...(record.mode === 'continuous' ? { mode: 'continuous' as const } : {}),
    };
}

/**
 * Canonical merge+normalize for a RepoMeshPolicy. Layers (lowest→highest):
 * DEFAULT_MESH_POLICY → base (existing persisted policy) → patch (incoming change),
 * then applies every per-field normalizer so the result is always valid regardless
 * of what a hand-edited meshes.json or a partial patch contained.
 *
 * Persistence economy is preserved: schedulingStrategy is dropped when it
 * normalizes to the 'first_eligible' default, and autoConvergeCodeChange is dropped
 * unless explicitly true — so an untouched meshes.json stays byte-for-byte the same.
 */
export function mergeAndNormalizePolicy(
    base: RepoMeshPolicy | undefined,
    patch: Partial<RepoMeshPolicy> | undefined,
): RepoMeshPolicy {
    const autoFastForward = normalizeAutoFastForwardPolicy({
        ...DEFAULT_MESH_POLICY.autoFastForward,
        ...((base?.autoFastForward && typeof base.autoFastForward === 'object') ? base.autoFastForward : {}),
        ...((patch?.autoFastForward && typeof patch.autoFastForward === 'object') ? patch.autoFastForward : {}),
    });
    const policy: RepoMeshPolicy = {
        ...DEFAULT_MESH_POLICY,
        ...(base || {}),
        ...(patch || {}),
        autoFastForward,
    };
    if (!DIRTY_WORKSPACE_BEHAVIORS.has(policy.dirtyWorkspaceBehavior)) {
        policy.dirtyWorkspaceBehavior = 'warn';
    }
    policy.maxParallelTasks = resolveMaxParallelTasks(policy.maxParallelTasks);
    policy.allowAutoPublishSubmoduleMainCommits = policy.allowAutoPublishSubmoduleMainCommits === true;
    if (!SESSION_CLEANUP_MODES.has(policy.sessionCleanupOnNodeRemove as RepoMeshSessionCleanupMode)) {
        policy.sessionCleanupOnNodeRemove = 'preserve';
    }
    // Canonicalize magiSessionCleanup (accepts boolean shorthand / unset → default ON).
    policy.magiSessionCleanup = resolveMagiSessionCleanupMode(policy.magiSessionCleanup);
    if (!SPAWNED_SESSION_VISIBILITY_MODES.has(policy.spawnedSessionVisibility as RepoMeshSpawnedSessionVisibility)) {
        policy.spawnedSessionVisibility = DEFAULT_MESH_POLICY.spawnedSessionVisibility;
    }
    // Load-balancing: normalize the scheduling strategy so an invalid/blank value
    // falls back to 'first_eligible' (strict no-change). Only persist the field when
    // it is explicitly a non-default value to keep existing meshes.json untouched.
    const normalizedStrategy = normalizeMeshSchedulingStrategy(policy.schedulingStrategy);
    if (normalizedStrategy === 'first_eligible') {
        delete policy.schedulingStrategy;
    } else {
        policy.schedulingStrategy = normalizedStrategy;
    }
    // Convergence routing: strict opt-in (default false). Only persist when explicitly
    // enabled so existing meshes.json stays byte-for-byte untouched.
    if (policy.autoConvergeCodeChange === true) {
        policy.autoConvergeCodeChange = true;
    } else {
        delete policy.autoConvergeCodeChange;
    }
    // Dangerous delegated-worker provider modes are fail-closed and only persist
    // when the mesh owner has explicitly opted in.
    if (policy.delegatedWorkerDangerousModeAllow === true) {
        policy.delegatedWorkerDangerousModeAllow = true;
    } else {
        delete policy.delegatedWorkerDangerousModeAllow;
    }
    // Coordinator idle-push policy: strict opt-in. Only persist the explicit
    // 'auto_silent_on_dispatch' value; any other/invalid value normalizes to the
    // 'always' default and is dropped so existing meshes.json stays byte-for-byte
    // untouched (a typo cannot silently disable owner completion notifications).
    if (policy.coordinatorIdlePushPolicy === 'auto_silent_on_dispatch') {
        policy.coordinatorIdlePushPolicy = 'auto_silent_on_dispatch';
    } else {
        delete policy.coordinatorIdlePushPolicy;
    }
    // Quota routing: normalize + persistence economy — persist only explicit
    // non-default overrides so an untouched meshes.json stays byte-for-byte the
    // same. Readers resolve the effective thresholds via resolveQuotaRoutingPolicy.
    const quotaRouting = normalizeQuotaRoutingPolicy(policy.quotaRouting);
    if (quotaRouting) {
        policy.quotaRouting = quotaRouting;
    } else {
        delete policy.quotaRouting;
    }
    return policy;
}

/**
 * Resolve delegated worker auto-approve. Legacy providers return a boolean. Providers
 * with modes return a mode id, except a dangerous mode is downgraded to a
 * non-dangerous PTY mode unless mesh/node policy explicitly opts in.
 *
 * THREE EXPLICIT STAGES — do not collapse them; the ordering is a hard MAGI
 * invariant:
 *
 *   ① ENABLE gate (machine-local policy only): node boolean > mesh boolean.
 *      `enabled=false` returns `false` IMMEDIATELY, BEFORE any mode selection.
 *      The repo `mesh.json` providerDefaults has ZERO influence here — a
 *      node/mesh opt-out is never overridden by a repo-declared requested mode.
 *
 *   ② MODE selection (only when enabled === true):
 *        task override [FUTURE — param reserved below, not yet wired] >
 *        repo mesh.json providerDefaults.autoApproveModes[providerType] >
 *        provider spec autoApproveModes.default.
 *      A repo-requested mode ID is adopted ONLY when it exists in the provider's
 *      own `autoApproveModes.modes`; an unknown/stale/typo'd ID is IGNORED and we
 *      fall back to the provider default (fail-closed: never coerce into a
 *      dangerous mode via a bad ID).
 *
 *   ③ DANGEROUS gate: whichever mode stage ② picked, if it is dangerous and the
 *      machine-local delegatedWorkerDangerousModeAllow is not set, downgrade to a
 *      non-dangerous PTY-parse mode (or `false` if none exists).
 */
export function resolveDelegatedWorkerAutoApprove(
    meshPolicy?: Pick<RepoMeshPolicy, 'delegatedWorkerAutoApprove' | 'delegatedWorkerDangerousModeAllow'> | null,
    nodePolicy?: Pick<RepoMeshNodePolicy, 'delegatedWorkerAutoApprove' | 'delegatedWorkerDangerousModeAllow'> | null,
    provider?: Pick<ProviderModule, 'autoApproveModes'> | null,
    repoConfig?: RepoMeshDeclarativeConfig | null,
    // providerType is needed to look up the repo-declared requested mode; it is
    // separate from `provider` because the caller resolves the spec independently.
    providerType?: string | null,
    // Per-launch mode override (e.g. a mode explicitly chosen at coordinator-launch
    // time). Wins over repoConfig.providerDefaults when set to a mode ID the spec knows.
    overrideModeId?: string | null,
    // Per-launch boolean override for legacy providers with no declared modes
    // (AutoApproveModesConfig absent) — mirrors the workspace dialog's
    // LegacyAutoApproveToggle. Ignored when the provider declares modes.
    overrideLegacyAutoApprove?: boolean | null,
): boolean | string {
    // ── ① ENABLE gate — machine-local only. false short-circuits before mode. ──
    let enabled = true;
    if (typeof nodePolicy?.delegatedWorkerAutoApprove === 'boolean') {
        enabled = nodePolicy.delegatedWorkerAutoApprove;
    } else if (typeof meshPolicy?.delegatedWorkerAutoApprove === 'boolean') {
        enabled = meshPolicy.delegatedWorkerAutoApprove;
    }
    if (!enabled) return false;

    const modes = provider?.autoApproveModes;
    if (!modes) return typeof overrideLegacyAutoApprove === 'boolean' ? overrideLegacyAutoApprove : true;

    // ── ② MODE selection (enabled only). A per-launch override (e.g. a mode picked
    //     in the new-coordinator dialog) takes precedence over the repo-declared
    //     providerDefaults, which in turn may override the provider spec default —
    //     but only with a mode ID the spec knows. ──
    const overrideModeIdTrimmed = typeof overrideModeId === 'string' ? overrideModeId.trim() : '';
    const requestedModeRaw = overrideModeIdTrimmed
        ? overrideModeIdTrimmed
        : typeof providerType === 'string'
            ? repoConfig?.providerDefaults?.autoApproveModes?.[providerType.trim()]
            : undefined;
    const requestedModeId = typeof requestedModeRaw === 'string' && requestedModeRaw.trim()
        ? requestedModeRaw.trim()
        : '';
    const requestedMode = requestedModeId
        ? modes.modes.find((mode) => mode.id === requestedModeId)
        : undefined;
    const selectedMode = requestedMode
        ?? modes.modes.find((mode) => mode.id === modes.default);
    if (!selectedMode || selectedMode.strategy === 'post-boot-command') return false;

    // ── ③ DANGEROUS gate — downgrade a dangerous selection without machine opt-in. ──
    const dangerousAllowed = resolveDelegatedWorkerDangerousModeAllow(meshPolicy, nodePolicy);
    if (deriveAutoApproveModeRisk(selectedMode) === 'dangerous' && !dangerousAllowed) {
        const ptyFallback = modes.modes.find((mode) =>
            mode.strategy === 'pty-parse-default' && deriveAutoApproveModeRisk(mode) !== 'dangerous');
        return ptyFallback?.id || false;
    }
    return selectedMode.id;
}

export function resolveDelegatedWorkerDangerousModeAllow(
    meshPolicy?: Pick<RepoMeshPolicy, 'delegatedWorkerDangerousModeAllow'> | null,
    nodePolicy?: Pick<RepoMeshNodePolicy, 'delegatedWorkerDangerousModeAllow'> | null,
): boolean {
    if (typeof nodePolicy?.delegatedWorkerDangerousModeAllow === 'boolean') {
        return nodePolicy.delegatedWorkerDangerousModeAllow;
    }
    return meshPolicy?.delegatedWorkerDangerousModeAllow === true;
}

/** Shape a boolean-or-mode resolution for the settings precedence contract. */
export function delegatedWorkerAutoApproveSettings(
    meshPolicy?: Pick<RepoMeshPolicy, 'delegatedWorkerAutoApprove' | 'delegatedWorkerDangerousModeAllow'> | null,
    nodePolicy?: Pick<RepoMeshNodePolicy, 'delegatedWorkerAutoApprove' | 'delegatedWorkerDangerousModeAllow'> | null,
    provider?: Pick<ProviderModule, 'autoApproveModes'> | null,
    repoConfig?: RepoMeshDeclarativeConfig | null,
    providerType?: string | null,
    // Per-launch mode override — see resolveDelegatedWorkerAutoApprove.
    overrideModeId?: string | null,
    // Per-launch legacy boolean override — see resolveDelegatedWorkerAutoApprove.
    overrideLegacyAutoApprove?: boolean | null,
): {
    autoApprove: boolean | undefined;
    autoApproveMode: string | undefined;
    delegatedWorkerDangerousModeAllow: boolean;
} {
    const resolved = resolveDelegatedWorkerAutoApprove(meshPolicy, nodePolicy, provider, repoConfig, providerType, overrideModeId, overrideLegacyAutoApprove);
    const delegatedWorkerDangerousModeAllow = resolveDelegatedWorkerDangerousModeAllow(meshPolicy, nodePolicy);
    return typeof resolved === 'string'
        ? { autoApprove: undefined, autoApproveMode: resolved, delegatedWorkerDangerousModeAllow }
        : { autoApprove: resolved, autoApproveMode: undefined, delegatedWorkerDangerousModeAllow };
}

/**
 * MESH-SEND-KEYS (feature 3): resolve whether DESTRUCTIVE key injection
 * (CTRL_C/ESC via mesh_send_keys) is permitted for a node. Node policy overrides
 * mesh policy; DEFAULTS TO FALSE (fail-closed) — a destructive key still requires
 * a per-call confirm_destructive=true on top of this opt-in.
 */
export function resolveAllowSendKeysDestructive(
    meshPolicy?: Pick<RepoMeshPolicy, 'allowSendKeysDestructive'> | null,
    nodePolicy?: Pick<RepoMeshNodePolicy, 'allowSendKeysDestructive'> | null,
): boolean {
    if (typeof nodePolicy?.allowSendKeysDestructive === 'boolean') {
        return nodePolicy.allowSendKeysDestructive;
    }
    if (typeof meshPolicy?.allowSendKeysDestructive === 'boolean') {
        return meshPolicy.allowSendKeysDestructive;
    }
    return false;
}

/**
 * Resolve the enforced per-(node, provider) maxParallel cap from a node's resolved
 * capability slots, or undefined when no matching slot declares a finite cap. Used
 * by the queue claim path as a stricter-wins constraint layered on top of the global
 * caps. Case-insensitive, trimmed match on the slot's provider.
 *
 * When a node declares multiple slots for the same provider (e.g. distinct
 * difficulty ranges), their caps SUM into a single per-(node, provider) pool — the
 * provider can run up to the total across all its slots. Legacy-derived slots (via
 * deriveSlotsFromLegacy) produce one slot per provider, so the sum equals that
 * single slot's cap and behavior is preserved exactly.
 *
 * Callers pass the already-resolved slots (explicit policy.slots, else legacy-
 * derived) — this keeps the resolver free of the difficultyBrains dependency and
 * usable from any layer.
 */
export function resolveProviderMaxParallel(
    slots: NodeCapabilitySlot[] | null | undefined,
    providerType: string | null | undefined,
): number | undefined {
    const wanted = typeof providerType === 'string' ? providerType.trim().toLowerCase() : '';
    if (!wanted) return undefined;
    if (!Array.isArray(slots)) return undefined;
    let total: number | undefined;
    for (const slot of slots) {
        if (!slot || typeof slot !== 'object') continue;
        const type = typeof slot.provider === 'string' ? slot.provider.trim().toLowerCase() : '';
        if (!type || type !== wanted) continue;
        const raw = Number(slot.maxParallel);
        if (!Number.isFinite(raw) || raw < 0) continue;
        total = (total ?? 0) + Math.floor(raw);
    }
    return total;
}

// ─── Capabilities ───────────────────────────────

export interface RepoMeshNodeCapabilities {
    /** Node's OS, raw NodeJS.Platform value ("darwin"/"win32"/"linux"). For
     *  remote member nodes this is stamped by the member daemon at join time
     *  (its own process.platform) and drives os= capability-tag routing. */
    platform?: string;
    /** Node's CPU architecture, raw process.arch value ("arm64"/"x64"). Stamped
     *  by the member daemon at join time; drives arch= capability-tag routing. */
    arch?: string;
    packageManagers?: string[];
    detectedCommands?: DetectedCommand[];
    canRunLongJobs?: boolean;
    canRunDocker?: boolean;
    canRunBrowserE2E?: boolean;
    canAccessSecrets?: boolean;
    canPush?: boolean;
    readOnly?: boolean;
    userLabels?: string[];
    /**
     * Detected provider CLI/ACP versions on this node, keyed by provider id
     * (e.g. `{ 'claude-cli': '1.2.3', 'codex-cli': '0.9.0' }`). Populated from the
     * same CLI detection pass that feeds providerPriority (see buildProviderVersions
     * over detectCLIs' CLIInfo[]). Absent/undefined when detection has not run or a
     * daemon predates the exposure — never a hard signal, purely observability so a
     * coordinator can spot a provider-version skew across nodes before dispatch.
     * Additive: existing status consumers ignore it.
     */
    providerVersions?: Record<string, string>;
    /**
     * The daemon build version (package.json version baked into the running bundle,
     * see getDaemonBuildInfo().version) that detected the above providerVersions.
     * Complements the commit-level daemonBuild stamp with a human-readable version
     * for node-card rendering. Absent when the build define was not injected.
     */
    daemonBuildVersion?: string;
}

export interface DetectedCommand {
    command: string;
    sourcePath: string;
    confidence: 'high' | 'medium' | 'low';
    requiresApproval?: boolean;
}

// ─── Project Context ────────────────────────────

export interface ProjectContextSnapshot {
    version: number;
    generatedAt: string;
    sources: ProjectContextSource[];
    repo: {
        identity: string;
        remoteUrl?: string;
        defaultBranch?: string;
        currentBranches: string[];
    };
    layout: {
        packageManager?: string;
        workspaceFiles: string[];
        packageRoots: string[];
        likelyEntryPoints: string[];
    };
    commands: {
        build?: DetectedCommand[];
        test?: DetectedCommand[];
        typecheck?: DetectedCommand[];
        lint?: DetectedCommand[];
        e2e?: DetectedCommand[];
    };
    instructions: {
        files: string[];
        summary: string;
    };
    conventions: {
        pathHints: string[];
        validationNotes: string[];
        riskyAreas: string[];
    };
}

export interface ProjectContextSource {
    kind: 'daemon_status' | 'git' | 'project_file' | 'instruction_file' | 'user_override' | 'probe_error';
    nodeId?: string;
    path?: string;
    observedAt: string;
    confidence: 'high' | 'medium' | 'low';
}

// ─── Coordinator Config ─────────────────────────

export interface RepoMeshCoordinatorConfig {
    /** Provider to use for coordinator session (e.g. 'claude-cli', 'cursor') */
    providerType?: string;
    /** Preferred node to run coordinator on (null = auto) */
    preferredNodeId?: string;
    /**
     * Full mesh-level override for the coordinator system prompt. When set,
     * replaces the daemon's rendered default and any user-file override
     * (~/.adhdev/coordinator-prompts/<cli>.md). The per-launch
     * extraSystemPrompt still composes on top — it always lands last as
     * Additional Context. Supports the same {{placeholders}} the daemon's
     * default template uses ({{meshName}}, {{repo}}, {{nodes}}, …).
     */
    systemPromptOverride?: string;
    /**
     * Mesh-level append. Composes after whichever base prompt won
     * (override → user-file override → daemon default). Use this when you
     * want extra rules for THIS mesh but otherwise the standard prompt is
     * fine. Stacks with the user-file append (`<cli>.append.md`) — both
     * apply if both are set.
     */
    systemPromptAppend?: string;
    /**
     * @deprecated Use systemPromptAppend. Kept as a fallback alias so
     * existing meshes.json files keep working without a migration step;
     * the daemon prefers systemPromptAppend when both are present.
     */
    systemPromptSuffix?: string;
}

// ─── Local Mesh Config (OSS standalone) ─────────

/**
 * Local mesh configuration stored in ~/.adhdev/meshes.json
 * Used by OSS standalone mode without cloud infrastructure.
 */
export interface LocalMeshConfig {
    meshes: LocalMeshEntry[];
}

export interface LocalMeshEntry {
    id: string;
    name: string;
    repoIdentity: string;
    repoRemoteUrl?: string;
    defaultBranch?: string;
    policy: RepoMeshPolicy;
    coordinator: RepoMeshCoordinatorConfig;
    meshHost?: RepoMeshHostMetadata;
    nodes: LocalMeshNodeEntry[];
    /**
     * MAGI-KIND-PANEL: per-task_kind panel bindings for THIS mesh, the SOLE MAGI
     * panel-resolution surface (the former named-panel `magiPanels` map was removed).
     * Keyed by task_kind (rca / design / claim_audit / freeform); each maps to ≥1
     * `(node × provider × model?)` slot, whose optional `nodeId` must name a node of
     * this mesh. A `mesh_magi_review` resolves its panel from here — an unconfigured
     * kind is a hard error, never a synthesized fallback.
     *
     * Scope: PER MESH, stored machine-locally (~/.adhdev/meshes.json), NOT in the
     * repo-committed .adhdev/mesh.json — node identity and provider availability are
     * machine facts. It previously lived at config root keyed by task_kind alone,
     * which let a write in one mesh overwrite another's binding for the same kind;
     * a legacy root map is folded in on load (see foldLegacyTopLevelMagiKindPanels).
     * Optional; absent when this mesh has bound no kinds.
     */
    magiKindPanels?: MagiKindPanelMap;
    /**
     * BRAIN-ROUTING: per-task-difficulty brain presets for THIS mesh, stored
     * machine-locally alongside magiKindPanels. Keyed by difficulty (easy / medium /
     * difficult / freeform); each maps to a BrainSlot (provider? / model? /
     * thinkingLevel?). The coordinator classifies a task's difficulty at enqueue; the
     * matching preset fills in the task's model / thinking level (an explicit task
     * value wins).
     *
     * Scope: PER MESH. It formerly sat at the config root keyed by difficulty alone,
     * so one mesh's write overwrote every other's — and since this map picks the
     * MODEL a task runs on, the shipped DEFAULT_DIFFICULTY_BRAINS (difficult → opus)
     * silently applied to every mesh on the machine. A legacy root map is folded in
     * on load (see foldLegacyTopLevelMeshSetting). Optional; a mesh with none set
     * uses DEFAULT_DIFFICULTY_BRAINS on read.
     */
    difficultyBrains?: DifficultyBrainMap;
    createdAt: string;
    updatedAt: string;
}

export interface LocalMeshNodeEntry {
    id: string;
    workspace: string;
    repoRoot?: string;
    daemonId?: string;
    /** Machine registry ID that owns this workspace, when known. */
    machineId?: string;
    /** Operator-defined capability tags used by mesh queue matching. */
    capabilities?: string[];
    userOverrides: Partial<RepoMeshNodeCapabilities>;
    /**
     * Live, self-healed platform/arch reported by the daemon that owns this
     * node's workspace (its own process.platform/process.arch), carried on the
     * git_status envelope and persisted by the coordinator on each direct git
     * probe. This is auto-detected truth, kept DISTINCT from `userOverrides`
     * (operator intent) so capability-tag derivation can prefer an explicit
     * operator override while still self-correcting auto-detected nodes — and so
     * a stale value is overwritten by the next report rather than sticking.
     * Absent until the first direct probe succeeds.
     */
    reportedPlatform?: string;
    reportedArch?: string;
    /**
     * Live, self-healed provider CLI/ACP versions reported by the daemon that owns
     * this node's workspace, carried on the git_status envelope (reporterProviderVersions)
     * and persisted by the coordinator on each direct git probe — mirrors the
     * reportedPlatform/reportedArch self-heal pattern. Auto-detected truth, overwritten
     * by the next report so a stale value never sticks. Absent until the first probe
     * carrying versions succeeds. Surfaced as RepoMeshNodeStatus.providerVersions.
     */
    reportedProviderVersions?: Record<string, string>;
    /** Live, self-healed daemon build version (getDaemonBuildInfo().version) of the
     *  owning daemon, carried on the git_status envelope (reporterDaemonBuildVersion)
     *  alongside the provider versions. Absent until first reported. */
    reportedDaemonBuildVersion?: string;
    /**
     * Unified mirrored "member state" self-reported by the daemon that owns this
     * node's workspace, carried wholesale on the git_status envelope
     * (reporterMemberState) and ingested by the coordinator in one place. It carries
     * the per-machine RUNTIME facts (reportedProviderVersions, reportedDaemonBuildVersion)
     * consolidated into one envelope — NOT slots, which are coordinator-owned config
     * resolved from node.policy.slots for every node, not reported
     * (REMOTE-NODE-SLOTS-COORDINATOR-LOCAL fix). The legacy flat fields above stay
     * populated in parallel during rollout for back-compat (see mesh-node-identity
     * ingest). `lastReportedAt` is the epoch ms the report was stamped, so a
     * partitioned node's mirror does not linger as fresh forever. Absent until the
     * first envelope carrying it is ingested.
     */
    reportedMemberState?: MeshReportedMemberState;
    /**
     * Versioned per-machine runtime facts bundle (MeshNodeFacts — deploy-lag
     * visibility design §a). Remote nodes: ingested wholesale from the
     * git_status envelope's reporterNodeFacts. Self/worktree nodes: built by
     * the SAME producer (buildLocalNodeFacts). Relayed opaquely — surfaces
     * must pass the object through, never rebuild it field-by-field.
     */
    nodeFacts?: import('@adhdev/mesh-shared').MeshNodeFacts;
    /**
     * The operator-set machine nickname (config.machineNickname) of the daemon
     * that owns this node's workspace. The local coordinator stamps its own
     * config value onto its self/base node; a remote member self-reports its
     * value on the git_status envelope (reporterMachineNickname), which the
     * coordinator persists here on each direct git probe. Feeds
     * buildMeshNodeDisplayLabel so the mesh UI renders the friendly nickname
     * instead of a raw daemonId/nodeId. Absent until set/first-reported.
     */
    machineNickname?: string;
    policy: RepoMeshNodePolicy;
    /**
     * Per-node instruction surfaced in the coordinator prompt so the LLM
     * knows what each node is for (e.g. "this is the staging mirror — run
     * only smoke tests here", or "use opus on this node, sonnet elsewhere").
     * Empty/missing: omitted silently from the rendered prompt, no rule
     * line about it gets added. The coordinator forwards/honors it when
     * delegating; we don't enforce it at the daemon level.
     */
    systemPrompt?: string;
    /** For single-machine mesh: same daemon, different worktree */
    isLocalWorktree?: boolean;
    /** Branch this worktree tracks (set when created via clone_mesh_node) */
    worktreeBranch?: string;
    /** Node ID this worktree was cloned from */
    clonedFromNodeId?: string;
    /** Repo-local preparation result for ADHDev-created worktree nodes. */
    worktreeBootstrap?: {
        // 'complete' is the terminal stamp written by markWorktreeBootstrapTerminalState
        // (router.ts) on worktree_bootstrap_complete — kept in sync with WorktreeBootstrapStatus.
        status: 'ready' | 'complete' | 'running' | 'failed' | 'not_configured' | 'disabled' | 'stale';
        required?: boolean;
        configSource?: string;
        configSourceType?: string;
        startedAt?: string;
        completedAt?: string;
        lastCommand?: string;
        exitCode?: number | null;
        error?: string;
        commandsRun?: Array<Record<string, unknown>>;
        staleInputs?: string[];
    };
    /** Optional associated/external repos configured as node metadata. */
    relatedRepos?: RepoMeshRelatedRepo[];
    role?: RepoMeshDaemonRole;
}

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
 * Mesh-level scheduling rollup exposed on RepoMeshStatus.scheduling: which tie-break
 * strategy is live and how much of the global parallel caps is consumed.
 */
export interface RepoMeshSchedulingStatus {
    strategy: RepoMeshSchedulingStrategy;
    maxParallelTasks: number;
    maxReadonlyParallelTasks: number;
    activeWriteAssigned: number;
    activeReadonlyAssigned: number;
    globalWriteCapReached: boolean;
    globalReadonlyCapReached: boolean;
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

// RepoMeshSessionStatus shape now lives in @adhdev/mesh-shared (shared with
// web-core's session normalizer). Re-exported so local RepoMeshNodeStatus/
// RepoMeshStatus and external `@adhdev/daemon-core/repo-mesh-types` consumers
// keep resolving it unchanged.
export type { RepoMeshSessionStatus } from '@adhdev/mesh-shared';
import type { RepoMeshSessionStatus } from '@adhdev/mesh-shared';

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
    machineLabel: string;
    workspace: string;
    repoRoot?: string;
    daemonId?: string;
    machineId?: string;
    role?: RepoMeshDaemonRole;
    machineStatus?: string;
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
    /** Explicitly-configured node capability slots (ORCHESTRATION_NODE_SLOTS.md). */
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
    error?: string;
}

export type RepoMeshQueueTaskStatus = 'pending' | 'assigned' | 'completed' | 'failed' | 'cancelled';

export interface RepoMeshQueueTask {
    id: string;
    meshId: string;
    message: string;
    status: RepoMeshQueueTaskStatus;
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
