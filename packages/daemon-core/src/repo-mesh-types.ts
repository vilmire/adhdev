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
    | 'priority_only';

export const MESH_SCHEDULING_STRATEGIES: RepoMeshSchedulingStrategy[] = [
    'first_eligible',
    'least_loaded',
    'round_robin',
    'priority_only',
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
     * dashboard tabs or start hidden. Defaults to 'visible' to preserve existing
     * watch-the-agents behavior; hidden sessions remain discoverable and manually openable.
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
    /**
     * What to do with delegated session-host records for a node when it is removed.
     * Defaults to 'preserve' so completed work can be reviewed later and live
     * runtimes are never stopped/deleted unless the mesh owner opts in.
     */
    sessionCleanupOnNodeRemove?: RepoMeshSessionCleanupMode;
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
}

export interface RepoMeshRelatedRepo {
    /** Stable display label for an explicitly configured associated checkout. */
    label: string;
    /** Absolute checkout/workspace path for git freshness probes. */
    workspace: string;
}

/**
 * Per-(node, provider) role + parallelism declaration.
 *
 * `role` is a free-form resource-pool label (recommended values:
 * 'investigation' | 'coding' | 'orchestration') describing what this
 * (node, provider) combination is *for*. As of the load-balancing scheduler it
 * is ALSO routable: each declared role is advertised as a synthetic `role=<x>`
 * capability tag (see buildMeshNodeCapabilityTags), so a task enqueued with
 * requiredTags: ["role=validation"] is hard-filtered to nodes/providers that
 * declare that role — through the same nodeSatisfiesRequiredTags path as any
 * other tag. There is intentionally no separate "advertisedRoles" field: the
 * label and the routing tag are one mechanism. A task that does not require a
 * `role=` tag ignores roles entirely (opt-in, fully backward compatible).
 *
 * role is intentionally orthogonal to taskMode: taskMode classifies the *work*
 * (code_change vs live_debug_readonly), role classifies the *resource pool*.
 *
 * `maxParallel` is the only enforced field: the queue will not assign a task
 * to this (node, provider) once it already has `maxParallel` active
 * (status='assigned') tasks. When the global parallel cap and this per-(node,
 * provider) cap disagree, the stricter (lower effective) limit wins — a claim
 * must satisfy both. Omitting `maxParallel` means this provider is bounded only
 * by the global/taskMode caps (full backward compatibility).
 */
export interface RepoMeshProviderRole {
    /** Provider type this entry governs (e.g. 'claude-cli', 'codex-cli'). */
    providerType: string;
    /** Free-form role label; recommended: 'investigation' | 'coding' | 'orchestration'. */
    role?: string;
    /** Max concurrent active tasks for this (node, provider). Omit = no per-provider cap. */
    maxParallel?: number;
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
     * Per-(node, provider) role + parallelism declarations. Each entry binds a
     * providerType on THIS node to an optional free-form role label and an
     * optional maxParallel cap. maxParallel is enforced (as an additional,
     * stricter-wins constraint on top of the global maxParallelTasks/taskMode
     * caps); role is advertised as a routable `role=<x>` capability tag so tasks
     * can hard-filter by required role. Missing/empty: the node behaves exactly
     * as before (global caps only, no role tags).
     */
    providerRoles?: RepoMeshProviderRole[];
    /**
     * Per-node override for RepoMeshPolicy.delegatedWorkerAutoApprove. When set, takes
     * precedence over the mesh-level policy for worker sessions launched onto this node.
     */
    delegatedWorkerAutoApprove?: boolean;
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
    maxParallelTasks: 2,
    spawnedSessionVisibility: 'visible',
    delegatedWorkerAutoApprove: true,
    sessionCleanupOnNodeRemove: 'preserve',
    autoFastForward: { enabled: true },
    maxTaskRetries: 1,
};

/**
 * Resolve whether a delegated worker session launched onto `nodePolicy` (within a mesh
 * governed by `meshPolicy`) should auto-approve. Precedence: node override → mesh policy
 * → default true. The result is stamped into the worker launch settings envelope as
 * `autoApprove`; it wins over the global per-provider-type autoApprove config because the
 * launch path merges the envelope as a settingsOverride on top of the provider defaults.
 */
export function resolveDelegatedWorkerAutoApprove(
    meshPolicy?: Pick<RepoMeshPolicy, 'delegatedWorkerAutoApprove'> | null,
    nodePolicy?: Pick<RepoMeshNodePolicy, 'delegatedWorkerAutoApprove'> | null,
): boolean {
    if (typeof nodePolicy?.delegatedWorkerAutoApprove === 'boolean') {
        return nodePolicy.delegatedWorkerAutoApprove;
    }
    if (typeof meshPolicy?.delegatedWorkerAutoApprove === 'boolean') {
        return meshPolicy.delegatedWorkerAutoApprove;
    }
    return true;
}

/**
 * Resolve the per-(node, provider) role declaration from a node policy.
 * Case-insensitive, trimmed match on providerType. Returns undefined when the
 * node has no providerRoles entry for this provider (caller then applies only
 * the global caps). Defensive against malformed config — non-object entries and
 * blank providerTypes are skipped rather than throwing.
 */
export function resolveProviderRole(
    nodePolicy: Pick<RepoMeshNodePolicy, 'providerRoles'> | null | undefined,
    providerType: string | null | undefined,
): RepoMeshProviderRole | undefined {
    const wanted = typeof providerType === 'string' ? providerType.trim().toLowerCase() : '';
    if (!wanted) return undefined;
    const roles = nodePolicy?.providerRoles;
    if (!Array.isArray(roles)) return undefined;
    for (const entry of roles) {
        if (!entry || typeof entry !== 'object') continue;
        const type = typeof entry.providerType === 'string' ? entry.providerType.trim().toLowerCase() : '';
        if (type && type === wanted) return entry;
    }
    return undefined;
}

/**
 * Resolve the enforced per-(node, provider) maxParallel cap, or undefined when
 * no finite, non-negative cap is declared for this provider. Used by the queue
 * claim path as a stricter-wins constraint layered on top of the global caps.
 */
export function resolveProviderMaxParallel(
    nodePolicy: Pick<RepoMeshNodePolicy, 'providerRoles'> | null | undefined,
    providerType: string | null | undefined,
): number | undefined {
    const role = resolveProviderRole(nodePolicy, providerType);
    const raw = Number(role?.maxParallel);
    if (!Number.isFinite(raw) || raw < 0) return undefined;
    return Math.floor(raw);
}

// ─── Capabilities ───────────────────────────────

export interface RepoMeshNodeCapabilities {
    platform?: string;
    packageManagers?: string[];
    detectedCommands?: DetectedCommand[];
    canRunLongJobs?: boolean;
    canRunDocker?: boolean;
    canRunBrowserE2E?: boolean;
    canAccessSecrets?: boolean;
    canPush?: boolean;
    readOnly?: boolean;
    userLabels?: string[];
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
        status: 'ready' | 'running' | 'failed' | 'not_configured' | 'disabled' | 'stale';
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
    activeSessions: string[];
    activeSessionDetails?: RepoMeshSessionStatus[];
    providerPriority?: string[];
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
