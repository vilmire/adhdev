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
    projectContext: ProjectContextSnapshot;
    nodes: RepoMeshNode[];
    status: 'active' | 'archived' | 'deleted';
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
    /** Additional system prompt context for coordinator */
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
    /** For single-machine mesh: same daemon, different worktree */
    isLocalWorktree?: boolean;
    /** Branch this worktree tracks (set when created via clone_mesh_node) */
    worktreeBranch?: string;
    /** Node ID this worktree was cloned from */
    clonedFromNodeId?: string;
    /** Optional associated/external repos configured as node metadata. */
    relatedRepos?: RepoMeshRelatedRepo[];
}

// ─── Mesh Status (runtime, not persisted) ───────

export interface RepoMeshStatus {
    meshId: string;
    meshName: string;
    repoIdentity: string;
    refreshedAt: string;
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
    machineStatus?: string;
    isLocalWorktree?: boolean;
    worktreeBranch?: string;
    health: RepoMeshNodeHealth;
    git?: GitRepoStatus;
    providers: string[];
    activeSessions: string[];
    activeSessionDetails?: RepoMeshSessionStatus[];
    providerPriority?: string[];
    launchReady?: boolean;
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
