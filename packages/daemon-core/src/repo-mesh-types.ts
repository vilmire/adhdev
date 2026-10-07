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
 * The core types in this module are runtime-free; the runtime policy defaults and
 * normalizers live in ./repo-mesh-policy.ts and ./repo-mesh-policy-resolve.ts.
 */

import type { GitCompactSummary } from './git/git-types.js';
import type { DifficultyBrainMap } from '@adhdev/mesh-shared';
import type { RepoMeshRelatedRepo, MeshReportedMemberState, RepoMeshNodePolicy } from './repo-mesh-policy.js';
import type { RepoMeshPolicyOverrides } from './repo-mesh-policy-resolve.js';

// Policy types/defaults, their normalization and the runtime status types live in
// sibling modules; this module re-exports them so `repo-mesh-types` stays the one
// import path for mesh types.
export * from './repo-mesh-policy.js';
export * from './repo-mesh-policy-resolve.js';
export * from './repo-mesh-status-types.js';

// ─── Core Mesh Types ────────────────────────────

export interface RepoMesh {
    id: string;
    name: string;
    repoIdentity: string;
    repoRemoteUrl?: string;
    defaultBranch?: string;
    /**
     * Stored policy OVERRIDES — only the keys the owner set (sparse). Read the
     * effective value through resolveMeshPolicy(mesh.policy); `key in mesh.policy`
     * means "explicitly set". Docs: docs/design/2026-10-07-mesh-workspace-policy.md §A.
     */
    policy: RepoMeshPolicyOverrides;
    /** Policy storage format marker; 2 = sparse overrides (set by the load-time migration). */
    policyStorage?: number;
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
    /** MACHINE-axis label only — checkout identity lives in
     *  worktreeBranch/nodeLabel (axis separation, 2026-08-24). */
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
     * Detected provider CLI versions on this node, keyed by provider id
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
    /**
     * Stored policy OVERRIDES — only the keys the owner set (sparse). Read the
     * effective value through resolveMeshPolicy(mesh.policy); `key in mesh.policy`
     * means "explicitly set". Docs: docs/design/2026-10-07-mesh-workspace-policy.md §A.
     */
    policy: RepoMeshPolicyOverrides;
    /** Policy storage format marker; 2 = sparse overrides (set by the load-time migration). */
    policyStorage?: number;
    coordinator: RepoMeshCoordinatorConfig;
    meshHost?: RepoMeshHostMetadata;
    nodes: LocalMeshNodeEntry[];
    /**
     * BRAIN-ROUTING: per-task-difficulty brain presets for THIS mesh, stored
     * machine-locally. Keyed by difficulty (easy / medium /
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
     * Live, self-healed provider CLI versions reported by the daemon that owns
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
     * buildMeshNodeMachineLabel (machine-axis-only since 2026-08-24) so the
     * mesh UI renders the friendly nickname instead of a raw daemonId/nodeId.
     * Absent until set/first-reported.
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

// RepoMeshSessionStatus shape now lives in @adhdev/mesh-shared (shared with
// web-core's session normalizer). Re-exported so local RepoMeshNodeStatus/
// RepoMeshStatus and external `@adhdev/daemon-core/repo-mesh-types` consumers
// keep resolving it unchanged.
export type { RepoMeshSessionStatus } from '@adhdev/mesh-shared';
