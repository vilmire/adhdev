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
     * Whether sessions spawned by mesh/coordinator policy should auto-open as visible
     * dashboard tabs or start hidden. Defaults to 'visible' to preserve existing
     * watch-the-agents behavior; hidden sessions remain discoverable and manually openable.
     */
    spawnedSessionVisibility?: RepoMeshSpawnedSessionVisibility;
    /**
     * What to do with delegated session-host records for a node when it is removed.
     * Defaults to 'preserve' so completed work can be reviewed later and live
     * runtimes are never stopped/deleted unless the mesh owner opts in.
     */
    sessionCleanupOnNodeRemove?: RepoMeshSessionCleanupMode;
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

export interface RepoMeshNodePolicy {
    readOnly?: boolean;
    canPush?: boolean;
    maxConcurrentSessions?: number;
    /** Ordered provider preference used when mesh_launch_session omits an explicit type. */
    providerPriority?: string[];
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
    sessionCleanupOnNodeRemove: 'preserve',
    maxTaskRetries: 1,
};

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
}

export interface RepoMeshSessionStatus {
    sessionId: string;
    providerType?: string;
    state?: string;
    lifecycle?: 'starting' | 'running' | 'stopping' | 'stopped' | 'failed' | 'interrupted';
    surfaceKind?: 'live_runtime' | 'recovery_snapshot' | 'inactive_record';
    recoveryState?: string | null;
    workspace?: string | null;
    title?: string | null;
    lastActivityAt?: string | null;
    isCached?: boolean;
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
    worktreeBootstrap?: LocalMeshNodeEntry['worktreeBootstrap'];
    launchBlockedReason?: string;
    launchBlockedMessage?: string;
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
