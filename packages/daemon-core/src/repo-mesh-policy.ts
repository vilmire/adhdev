// Repo Mesh policy types and defaults (mesh-level policy, node policy, quota
// routing, auto fast-forward, scheduling strategy) plus the small resolvers that
// read one field. Re-exported by ./repo-mesh-types.ts.

import type { MeshSessionCleanupMode, NodeCapabilitySlot } from '@adhdev/mesh-shared';

// ─── Policy Types ───────────────────────────────

/** Session cleanup vocabulary — declared once in @adhdev/mesh-shared (MESH_SESSION_CLEANUP_MODES). */
export type RepoMeshSessionCleanupMode = MeshSessionCleanupMode;
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
 * - 'fitness': rank nodes by task→capability-slot fitness (task
 *   difficulty/requiredTags vs the node's slots), then priority/load/order.
 *   Falls back to priority/load ordering when no task is in scope (idle-session
 *   drain) — exactly the old 'least_loaded' behavior, so fitness subsumes it.
 * - 'least_loaded' / 'round_robin' (DEPRECATED aliases): absorbed into 'fitness'.
 *   normalizeMeshSchedulingStrategy maps both to 'fitness', so a meshes.json that
 *   still stores either value behaves as Smart with no file rewrite. They remain
 *   in the union only so those persisted escape-hatch values keep validating.
 * - 'priority_only' (DEPRECATED alias, escape-hatch only): rank purely by
 *   schedulingPriority (then config order), ignoring load. Not exposed in the
 *   UI, but honored verbatim for hand-edited configs.
 *
 * Distribution is explicit opt-in: a strategy other than 'first_eligible' must be
 * configured for any load-spreading to occur.
 */
export type RepoMeshSchedulingStrategy =
    | 'first_eligible'
    | 'least_loaded'
    | 'round_robin'
    | 'priority_only'
    // node capability slots design, 2026-07-09: rank nodes by task→capability-slot fitness
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
 *
 * MIGRATION: the deprecated spread aliases 'least_loaded' / 'round_robin' map to
 * 'fitness' — with no task in scope fitness degrades to the same priority/load
 * (plus rotation) ordering they had, so a meshes.json still storing either value
 * behaves identically to Smart without any file rewrite.
 */
export function normalizeMeshSchedulingStrategy(value: unknown): RepoMeshSchedulingStrategy {
    if (typeof value !== 'string') return DEFAULT_MESH_SCHEDULING_STRATEGY;
    const trimmed = value.trim();
    if (trimmed === 'least_loaded' || trimmed === 'round_robin') return 'fitness';
    return (MESH_SCHEDULING_STRATEGIES as string[]).includes(trimmed)
        ? (trimmed as RepoMeshSchedulingStrategy)
        : DEFAULT_MESH_SCHEDULING_STRATEGY;
}

// The user-facing 2-mode distribution façade (Smart ↔ 'fitness' / In order ↔
// 'first_eligible') lives in web-core (pages/repo-mesh/types.ts) — the daemon
// only ever acts on the raw strategy union above. The former daemon-side
// RepoMeshDistribution façade was removed: it had no production consumer (only
// its own test) and its 'spread' mapping predated the fitness strategy.

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
    dirtyWorkspaceBehavior: 'block' | 'warn' | 'checkpoint_then_continue';
    maxParallelTasks: number;
    allowedProviders?: string[];
    /**
     * Mesh-wide tie-break strategy for distributing untargeted queue work across
     * eligible nodes. Defaults to 'first_eligible' (today's exact behavior — no
     * load-spreading). Set to 'fitness' to opt into distribution (the UI's Smart
     * mode; the deprecated 'least_loaded'/'round_robin' aliases normalize to it).
     * Only governs the final tie-break stage; eligibility, capacity, and priority
     * are evaluated identically regardless of strategy.
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
     * Minutes a coordinator-LAUNCHED delegate session may sit idle before the daemon
     * STOPS its CLI runtime (the session-host record is preserved, so the transcript
     * stays inspectable). Default 30.
     *
     * Fills the gap left by the edge-triggered cleanups: sessionCleanupOnNodeRemove
     * fires on node removal and magiSessionCleanup on a MAGI fan-out's terminal, so a
     * one-off delegate on the BASE node (no node removal, no worktree, no MAGI marker)
     * was never reclaimed and its CLI process leaked for the daemon's lifetime.
     *
     * Never applies to the coordinator session, to a session the owner opened directly
     * (no launchedByCoordinator marker), or to a session still holding a non-terminal
     * queue/direct task — see mesh-idle-session-reaper.ts.
     *
     * `0` (or false) disables the reaper entirely. Clamped to
     * [MESH_DELEGATED_SESSION_IDLE_TTL_MIN_MINUTES, MESH_DELEGATED_SESSION_IDLE_TTL_MAX_MINUTES];
     * see resolveDelegatedSessionIdleTtlMinutes.
     */
    delegatedSessionIdleTtlMinutes?: number | false;
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
    /**
     * C3 (design :541-550): downstream behaviour when a required worker task
     * fails or is cancelled. `block` (default) keeps dependents pending and
     * recovers automatically if the predecessor is retried and later completes.
     * `cancel` terminally cancels the dependent branch. Invalid values fail
     * config validation instead of silently becoming `block`.
     */
    onDependencyFailure?: 'block' | 'cancel';
}

/**
 * Quota-aware routing thresholds (RepoMeshPolicy.quotaRouting). Every field is
 * optional; a missing field resolves to DEFAULT_QUOTA_ROUTING_POLICY.
 */
export interface RepoMeshQuotaRoutingPolicy {
    /**
     * Age past which a reported quota snapshot is judged STALE and ignored
     * (fail-open). Defaults to 60 min.
     *
     * ★Widened from 30 min on 2026-08-21 (owner decision). The number this
     * threshold really sets is how often an IDLE machine must call a third
     * party: quota/refresh.ts pins QUOTA_ROUTABLE_MAX_AGE_MS to this value and
     * backfills any snapshot that ages past it, so the threshold IS the
     * unsolicited-fetch floor. Doubling it halves that floor. What keeps the
     * looser window honest is not this constant but the window boundary:
     * resetsAt supersedes age whenever present, while this threshold remains
     * the fallback for unstamped windows. An explicit force refresh (`adhdev
     * quota --refresh`) exists for anyone who needs the current number now.
     * Generous enough to absorb reporter↔coordinator clock skew, as before.
     */
    staleAfterMs?: number;
    /**
     * Skip a (node, provider) whose SESSION window (the short ~5h rolling
     * window) has less than this percent remaining. Defaults to 10 — the short
     * window recovers quickly, so the bar is low.
     */
    sessionMinRemainingPercent?: number;
    /**
     * RESET-IMMINENT relaxation for the session gate: when the session
     * window's reset is less than this far away, a session-low block is waived
     * — the quota the task needs is about to reappear, so holding the claim
     * would just idle the mesh. Defaults to 5 min. Applies ONLY to the session
     * window: a weekly reset is days away by construction, so the weekly gate
     * never relaxes.
     */
    sessionResetImminentMs?: number;
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
    /**
     * SESSION-AXIS ACTIVATION threshold (the conditional gate in
     * rankProvidersByQuotaGate): the candidate ranking switches from weekly
     * expiry risk to SESSION (5h) expiry risk only while EVERY weekly-measured
     * candidate has more than this percent of its weekly window left. An
     * unused session remainder evaporates permanently at the 5h reset, so when
     * the weekly budget is comfortable the scheduler spends the provider whose
     * session remainder is about to be lost. At or below this threshold the
     * weekly axis governs unchanged — when the weekly budget is the binding
     * constraint, chasing session expiry would drain the weekly remainder
     * early. Defaults to 40: it must sit clearly above the weekly GATE floor
     * (weeklyMinRemainingPercent, 15) for "headroom" to mean anything — a
     * candidate only just above the gate is protected, not harvested.
     */
    sessionAxisWeeklyHeadroomPercent?: number;
    /**
     * When the quota-ranked FIRST-CHOICE provider is quota-clear but every slot
     * declaring the requested model is at its maxParallel cap, continue down the
     * SAME node's quota ranking to the next clear candidate instead of leaving
     * the task queued. Defaults to true.
     *
     * WHY THIS EXISTS: quota ranking is recomputed from scratch on every
     * reconcile tick, and nothing remembers that a provider was busy on the
     * previous tick. So the same saturated first choice was re-elected tick
     * after tick while a genuinely idle sibling slot was never tried. Observed
     * in production: three `difficult` tasks serialized onto one codex slot for
     * 20 minutes, repeatedly emitting `slot_for_model_busy`, while an idle
     * `claude-cli/opus maxParallel:2` was never attempted once.
     *
     * SCOPE — deliberately narrow, and the narrowness is what makes this safe:
     * it applies ONLY to the capacity-driven 'wait' outcome. A quota-GATED
     * provider never enters the ranking's `clear` list in the first place
     * (rankProvidersByQuotaGate), so this can never route a task onto a
     * provider that is low on quota; and the 'notify' outcome (no slot declares
     * the model — a permanent configuration fact) is untouched, so a real
     * misconfiguration still pages the coordinator instead of being silently
     * absorbed. Fallback stays WITHIN the node: it never redirects to a
     * different node.
     *
     * Set false to restore the previous behaviour exactly — a busy first choice
     * leaves the task queued for the next tick.
     */
    quotaBusyFallback?: boolean;
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
    /**
     * Live worker-session ceiling for this node (scope: liveSessionCountForNode —
     * this mesh's worker sessions only). Unset/invalid resolves to
     * DEFAULT_NODE_MAX_CONCURRENT_SESSIONS via resolveNodeMaxConcurrentSessions;
     * an explicit finite value >= 0 always wins (0 blocks all auto-launches).
     */
    maxConcurrentSessions?: number;
    /**
     * Soft scheduling priority used as the PRIORITY rank key (higher = preferred)
     * when the mesh schedulingStrategy spreads work across nodes. Defaults to 0.
     * This is NOT an eligibility gate — a node with a high priority that is at its
     * capacity (MAX-ALLOC gate) is still skipped; priority only orders nodes that
     * can actually take work. Ignored entirely under 'first_eligible'.
     */
    schedulingPriority?: number;
    /**
     * @deprecated Derived compatibility field. When slots are configured, their
     * order is authoritative and writers/readers derive providerPriority from
     * them. Kept optional for slotless legacy nodes and public CLI/MCP contracts.
     */
    providerPriority?: string[];
    /**
     * Node capability slots (node capability slots design, 2026-07-09) — the ordered "Preferred
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

/**
 * Idle TTL after which a coordinator-launched delegate session's CLI runtime is
 * stopped. Owner decision 2026-08-28: 30 minutes.
 */
export const DEFAULT_DELEGATED_SESSION_IDLE_TTL_MINUTES = 30;
/**
 * Floor. Below 5 minutes the TTL starts racing normal delegate think-time — a
 * delegate parked on a slow tool call or awaiting a human decision would be reaped
 * mid-task — so a smaller positive value is clamped up rather than honored.
 */
export const MESH_DELEGATED_SESSION_IDLE_TTL_MIN_MINUTES = 5;
/** Ceiling (7 days). Beyond this the reaper is effectively off; use 0 to say so explicitly. */
export const MESH_DELEGATED_SESSION_IDLE_TTL_MAX_MINUTES = 7 * 24 * 60;

/**
 * Default per-node live worker-session ceiling (RepoMeshNodePolicy.maxConcurrentSessions)
 * applied when a node declares no explicit cap. Before this default existed, an unset cap
 * made the auto-launch gate compare against Number(undefined) = NaN — every comparison
 * false, gate silently skipped, unlimited spawns (2026-09-08 runaway: 23 live sessions
 * piled onto one daemon until EMFILE killed it).
 *
 * Why 12: it must sit ABOVE legitimate per-node fan-out — per-provider slot caps
 * (slots[].maxParallel, typically 1-4 per provider, a few providers per node) put real
 * concurrent worker load at ~6-10 including launched-but-unclaimed sessions — and safely
 * BELOW the ~23-session EMFILE crash point, so the gate fires while the daemon is still
 * healthy. The count scope is liveSessionCountForNode: mesh WORKER sessions of one node
 * only (coordinator sessions and non-mesh user sessions are not counted).
 */
export const DEFAULT_NODE_MAX_CONCURRENT_SESSIONS = 12;

/**
 * Resolve the effective per-node concurrent-session cap from a raw node-policy value.
 * An explicit finite value >= 0 always wins (0 = block all auto-launches, preserved);
 * missing/NaN/negative falls back to DEFAULT_NODE_MAX_CONCURRENT_SESSIONS. Both the
 * auto-launch gate (mesh-queue-assignment) and the scheduling status surface
 * (mesh-scheduling-runtime) read through here so enforcement and observability can
 * never disagree on what the cap is.
 */
export function resolveNodeMaxConcurrentSessions(value: unknown): number {
    // Explicit null/undefined guard: Number(null) is 0, which would silently read an
    // unset (hand-edited JSON null) cap as "block every launch" instead of the default.
    if (value === undefined || value === null) return DEFAULT_NODE_MAX_CONCURRENT_SESSIONS;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return DEFAULT_NODE_MAX_CONCURRENT_SESSIONS;
    return Math.floor(n);
}

export const DEFAULT_MESH_POLICY: RepoMeshPolicy = {
    requirePreTaskCheckpoint: false,
    requirePostTaskCheckpoint: true,
    requireApprovalForPush: true,
    allowAutoPublishSubmoduleMainCommits: false,
    dirtyWorkspaceBehavior: 'warn',
    // Mesh-wide task cap is effectively unlimited by default: the real concurrency
    // limits live per node / per capability slot (node capability slots design, 2026-07-09), so a
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
    // Stop a coordinator-launched delegate's CLI runtime after 30 idle minutes
    // (record preserved). Owner decision 2026-08-28. 0/false disables.
    delegatedSessionIdleTtlMinutes: DEFAULT_DELEGATED_SESSION_IDLE_TTL_MINUTES,
    // Conservative default: every coordinator-dispatched worker completion still
    // notifies the owner. Opt into 'auto_silent_on_dispatch' to one-shot-silence the
    // routine idle push for a coordinator-driven task (approval/failure notifications
    // are never affected — see coordinatorIdlePushPolicy).
    coordinatorIdlePushPolicy: 'always',
    onDependencyFailure: 'block',
};

/**
 * Defaults for the quota-routing thresholds (RepoMeshPolicy.quotaRouting).
 * Rationale per field lives on RepoMeshQuotaRoutingPolicy. Kept next to
 * DEFAULT_MESH_POLICY so all policy defaults share one home.
 */
export const DEFAULT_QUOTA_ROUTING_POLICY: Required<RepoMeshQuotaRoutingPolicy> = {
    // ★Must stay equal to quota/refresh.ts QUOTA_ROUTABLE_MAX_AGE_MS —
    // quota-routing-staleness-agreement.test.ts fails on drift.
    staleAfterMs: 60 * 60 * 1000,
    sessionMinRemainingPercent: 10,
    sessionResetImminentMs: 5 * 60 * 1000,
    weeklyMinRemainingPercent: 15,
    spreadBonusMax: 30,
    sessionAxisWeeklyHeadroomPercent: 40,
    // ON by default (owner decision): the failure it prevents — an idle sibling
    // slot never being tried while tasks serialize behind a saturated first
    // choice — is silent and costs wall-clock on every tick it recurs.
    quotaBusyFallback: true,
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
    const sessionResetImminentMs = Number(value?.sessionResetImminentMs);
    const weeklyMin = Number(value?.weeklyMinRemainingPercent);
    const spreadMax = Number(value?.spreadBonusMax);
    const sessionAxisHeadroom = Number(value?.sessionAxisWeeklyHeadroomPercent);
    const clampPercentField = (n: number, fallback: number) =>
        Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : fallback;
    return {
        staleAfterMs: Number.isFinite(staleAfterMs) && staleAfterMs >= 0
            ? Math.floor(staleAfterMs)
            : DEFAULT_QUOTA_ROUTING_POLICY.staleAfterMs,
        sessionMinRemainingPercent: clampPercentField(sessionMin, DEFAULT_QUOTA_ROUTING_POLICY.sessionMinRemainingPercent),
        sessionResetImminentMs: Number.isFinite(sessionResetImminentMs) && sessionResetImminentMs >= 0
            ? Math.floor(sessionResetImminentMs)
            : DEFAULT_QUOTA_ROUTING_POLICY.sessionResetImminentMs,
        weeklyMinRemainingPercent: clampPercentField(weeklyMin, DEFAULT_QUOTA_ROUTING_POLICY.weeklyMinRemainingPercent),
        spreadBonusMax: Number.isFinite(spreadMax) && spreadMax >= 0
            ? spreadMax
            : DEFAULT_QUOTA_ROUTING_POLICY.spreadBonusMax,
        sessionAxisWeeklyHeadroomPercent: clampPercentField(sessionAxisHeadroom, DEFAULT_QUOTA_ROUTING_POLICY.sessionAxisWeeklyHeadroomPercent),
        // Boolean, not numeric: only an explicit `false` disables it. A missing
        // or non-boolean value resolves to the default (true), matching how the
        // numeric fields fall back rather than fail.
        quotaBusyFallback: typeof value?.quotaBusyFallback === 'boolean'
            ? value.quotaBusyFallback
            : DEFAULT_QUOTA_ROUTING_POLICY.quotaBusyFallback,
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
    if (record.sessionResetImminentMs !== undefined && resolved.sessionResetImminentMs !== DEFAULT_QUOTA_ROUTING_POLICY.sessionResetImminentMs) {
        out.sessionResetImminentMs = resolved.sessionResetImminentMs;
    }
    if (record.weeklyMinRemainingPercent !== undefined && resolved.weeklyMinRemainingPercent !== DEFAULT_QUOTA_ROUTING_POLICY.weeklyMinRemainingPercent) {
        out.weeklyMinRemainingPercent = resolved.weeklyMinRemainingPercent;
    }
    if (record.spreadBonusMax !== undefined && resolved.spreadBonusMax !== DEFAULT_QUOTA_ROUTING_POLICY.spreadBonusMax) {
        out.spreadBonusMax = resolved.spreadBonusMax;
    }
    if (record.sessionAxisWeeklyHeadroomPercent !== undefined && resolved.sessionAxisWeeklyHeadroomPercent !== DEFAULT_QUOTA_ROUTING_POLICY.sessionAxisWeeklyHeadroomPercent) {
        out.sessionAxisWeeklyHeadroomPercent = resolved.sessionAxisWeeklyHeadroomPercent;
    }
    if (record.quotaBusyFallback !== undefined && resolved.quotaBusyFallback !== DEFAULT_QUOTA_ROUTING_POLICY.quotaBusyFallback) {
        out.quotaBusyFallback = resolved.quotaBusyFallback;
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
