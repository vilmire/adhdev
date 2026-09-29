// The claim path's mesh view: the local coordinator daemon id, the per-node repo
// mesh config (with de-duplicated unreadable-config WARNs), the delegated-worker
// auto-approve settings, and getMeshWithCache — local config merged with the
// router's inline-mesh cache. Split out of mesh-queue-assignment.ts (re-exported
// there).

import { canonicalDaemonId, meshNodeIdMatches } from '@adhdev/mesh-shared';
import { readNonEmptyString } from './mesh-events-utils.js';
import { getMachineId } from '../config/config.js';
import { type RepoMeshDeclarativeConfig, loadRepoMeshJsonConfig } from '../config/mesh-json-config.js';
import { LOG } from '../logging/logger.js';
import { delegatedWorkerAutoApproveSettings } from '../repo-mesh-types.js';
import type { DaemonComponents } from '../boot/daemon-components.js';
import { getMesh } from '../config/mesh-config.js';
import { normalizeMeshNodeId } from '@adhdev/mesh-shared';

/**
 * CANON: the single canonical coordinator-daemon id this daemon stamps onto every
 * worker dispatch (meshContext.coordinatorDaemonId / sourceCoordinatorDaemonId / the
 * co-located meshCoordinatorDaemonId anchor). getMachineId() is the bare
 * `mach_X` form; canonicalizing to `daemon_mach_X` unifies it with the MCP-side
 * resolveCoordinatorDaemonId producer so the two dispatch paths can never stamp a
 * worker's coordinator anchor in two different forms — the CANON-IDENTITY
 * double-dispatch root cause. Consumers of the anchor already compare under
 * daemonIdsEquivalent / expandDaemonIdForms, so the exact form is form-agnostic on
 * the read side; this only removes the producer-side skew.
 */
export function localCoordinatorDaemonId(): string | undefined {
    return canonicalDaemonId(readNonEmptyString(getMachineId()));
}


/**
 * Why `loadRepoConfigForNode` returned null — distinguishes the ordinary "no repo
 * config declared here" case from a genuine read/parse failure, so the caller can
 * decide whether this is worth a WARN at all:
 *   - 'absent'          — no `.adhdev/mesh.json` at this workspace (or none found via
 *                          the cwd fallback either). The per-repo file is optional;
 *                          this is the common, expected state and is never a WARN.
 *   - 'workspace_mismatch' — a file WAS found (locally or via the cwd fallback) but it
 *                          does not live under the node's own workspace (remote node,
 *                          or the coordinator's own cwd leaking into a remote node's
 *                          resolution — see REMOTE-NODE-AUTO-APPROVE-MODE-DELIVERY
 *                          below). Also expected/benign, not a WARN.
 *   - 'invalid'         — a file exists under the node's workspace but failed to
 *                          parse/validate (or the read threw). This is the only case
 *                          that indicates something is actually broken.
 *   - 'no_workspace'    — the node carries no workspace path at all (defensive; should
 *                          not happen for a launchable node).
 */
export type RepoConfigUnavailableReason = 'absent' | 'workspace_mismatch' | 'invalid' | 'no_workspace';

export interface LoadRepoConfigForNodeResult {
    config: RepoMeshDeclarativeConfig | null;
    /** Present only when `config` is null — see RepoConfigUnavailableReason. */
    reason?: RepoConfigUnavailableReason;
}

/**
 * Load the repo-shared `.adhdev/mesh.json` for a node's workspace, tolerating a
 * missing/invalid file (returns config:null → resolver falls back to provider-spec
 * defaults, i.e. exactly the pre-providerDefaults behavior). Only the
 * `providerDefaults` zone influences the delegated-worker MODE selection; it never
 * touches the ENABLE decision. When a node carries no workspace path (should not
 * happen for a launchable node, but be defensive), we skip the read entirely.
 *
 * The `reason` field on a null result lets callers tell an ordinary "nothing declared
 * here" outcome from a genuine read/parse failure — see RepoConfigUnavailableReason.
 */
export function loadRepoConfigForNode(node: any): RepoMeshDeclarativeConfig | null {
    return loadRepoConfigForNodeDetailed(node).config;
}

export function loadRepoConfigForNodeDetailed(node: any): LoadRepoConfigForNodeResult {
    const workspace = typeof node?.workspace === 'string' && node.workspace.trim() ? node.workspace.trim() : '';
    if (!workspace) return { config: null, reason: 'no_workspace' };
    try {
        const result = loadRepoMeshJsonConfig(workspace);
        if (result.sourceType === 'unavailable') return { config: null, reason: 'absent' };
        if (result.sourceType === 'invalid' || !result.config) return { config: null, reason: 'invalid' };
        // REMOTE-NODE-AUTO-APPROVE-MODE-DELIVERY: loadRepoMeshJsonConfig falls back to
        // process.cwd() when the requested workspace carries no config. On a coordinator
        // running inside its own checkout, that fallback would return the COORDINATOR's
        // mesh.json for a REMOTE node whose workspace lives on another machine —
        // attributing one machine's declared modes to another. Only accept a file that
        // actually lives under the node's own workspace; the worker re-resolves its real
        // config at launch time (delegated-worker-mode-delivery.ts).
        if (!isConfigPathInsideWorkspace(result.path, workspace)) return { config: null, reason: 'workspace_mismatch' };
        return { config: result.config };
    } catch {
        return { config: null, reason: 'invalid' };
    }
}

/** True when the matched config file actually lives under `workspace`. */
function isConfigPathInsideWorkspace(configPath: string | undefined, workspace: string): boolean {
    if (typeof configPath !== 'string' || !configPath) return false;
    const toPosix = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
    const ws = toPosix(workspace);
    const target = toPosix(configPath);
    return !!ws && (target === ws || target.startsWith(`${ws}/`));
}

// ─── Per-node WARN streak dedup for an unreadable repo mesh.json ────────────
// 2026-09-25 wiring-unification live pass: warnUnreadableRepoConfigForNode used to
// fire on EVERY loadRepoConfigForNode() miss, including the ordinary "this repo
// declares no .adhdev/mesh.json" case — a legitimate, common, per-repo-optional
// state. On a queue claim for a node whose repo has no mesh.json, that meant a WARN
// on every claim cycle (twice per cycle in the observed log), forever, for a file
// that was never supposed to exist. Only a file that IS present but unreadable/
// invalid is worth a WARN, and even that should not repeat on every tick — a
// streak of the SAME invalid file surfacing once per claim would just trade one
// noise source for another.
//
// This mirrors the existing dedup discipline in mesh-queue-observability.ts
// (record-on-transition, clear-on-recovery) rather than mesh-event-trace.ts's
// timed-flush streak collapsing: unlike that module's high-frequency completion-
// event drops, a claim cycle fires at most a couple of times a minute per node, so
// "one WARN per node per invalid streak" (no periodic re-surface) is enough to stay
// visible without a time-based re-flush.
const warnedInvalidRepoConfigNodes = new Set<string>();

function repoConfigStreakKey(nodeId: string, workspace: string): string {
    return `${nodeId}\u0000${workspace}`;
}

/** Test hook: clears in-memory WARN-streak state so tests don't leak into each other. */
export function __resetRepoConfigWarnStreaksForTests(): void {
    warnedInvalidRepoConfigNodes.clear();
}

/**
 * Coordinator-side observability for a repo `.adhdev/mesh.json` that IS present
 * under the node's workspace but could not be read/parsed — a genuine misconfig,
 * as opposed to the ordinary "no repo config declared" case (see
 * RepoConfigUnavailableReason). The worker re-resolves at launch, but the
 * coordinator log is what makes the gap visible from the side that made the
 * decision. Rate-limited to one WARN per node per invalid streak: a later
 * successful (or absent) read clears the streak so a real recovery/fresh failure
 * is observable again.
 */
function warnUnreadableRepoConfigForNode(node: any, providerType: string | undefined): void {
    const workspace = typeof node?.workspace === 'string' && node.workspace.trim() ? node.workspace.trim() : '';
    if (!workspace) return;
    const nodeId = readNonEmptyString(node?.id) || readNonEmptyString(node?.nodeId) || 'unknown-node';
    const key = repoConfigStreakKey(nodeId, workspace);
    if (warnedInvalidRepoConfigNodes.has(key)) return;
    warnedInvalidRepoConfigNodes.add(key);
    LOG.warn(
        'MeshQueue',
        `repo mesh.json unreadable from this daemon for node=${nodeId} workspace=${workspace} `
        + `provider=${providerType || 'unknown'} — delegated auto-approve MODE falls back to the provider `
        + `default here; the worker daemon re-resolves it from its own checkout at launch`,
    );
}

/** Clears the WARN-streak fingerprint once a node's repo config is readable again
 *  (present+valid, or genuinely absent) so a later re-break is observable again. */
function clearUnreadableRepoConfigStreak(node: any): void {
    const workspace = typeof node?.workspace === 'string' && node.workspace.trim() ? node.workspace.trim() : '';
    if (!workspace) return;
    const nodeId = readNonEmptyString(node?.id) || readNonEmptyString(node?.nodeId) || 'unknown-node';
    warnedInvalidRepoConfigNodes.delete(repoConfigStreakKey(nodeId, workspace));
}

/**
 * Resolve the delegated-worker auto-approve envelope for a node, warning when the
 * repo config that should decide the MODE is present but not readable from this
 * process. A repo that simply declares no `.adhdev/mesh.json` (or whose config
 * lives outside this node's workspace — the remote-node case) is NOT warned about;
 * only a present-but-invalid file is.
 */
export function delegatedWorkerAutoApproveSettingsForNode(
    mesh: any,
    node: any,
    provider: any,
    providerType: string | undefined,
): ReturnType<typeof delegatedWorkerAutoApproveSettings> {
    const { config: repoConfig, reason } = loadRepoConfigForNodeDetailed(node);
    if (reason === 'invalid') {
        warnUnreadableRepoConfigForNode(node, providerType);
    } else {
        clearUnreadableRepoConfigStreak(node);
    }
    return delegatedWorkerAutoApproveSettings(mesh?.policy, node?.policy, provider, repoConfig, providerType);
}

let warnedMissingRouterView = false;

export function getMeshWithCache(components: DaemonComponents, meshId: string): any | undefined {
    const localMesh = getMesh(meshId);
    // Real components always carry the router. A look-alike without one silently
    // drops the inline-cache-only (cloned worktree) nodes from the claim view — the
    // CLAIMSTALL class — so say so once instead of degrading quietly.
    // (A router that exists but lacks the method still throws below, as before.)
    if (!components.router && !warnedMissingRouterView) {
        warnedMissingRouterView = true;
        LOG.warn('MeshQueue', `mesh ${meshId}: components passed to the mesh view have no router (look-alike components?) — inline-only worktree nodes are invisible to this read`);
    }
    const cachedMesh = components.router?.getCachedInlineMesh(meshId);
    if (!localMesh) return cachedMesh;
    if (!cachedMesh) return localMesh;
    return mergeInlineCacheOnlyNodes(localMesh, cachedMesh);
}

/**
 * Claim-time membership view unification (CLAIMSTALL fix).
 *
 * The coordinator's claim path — triggerMeshQueue → autoLaunch candidate filter
 * and the local/remote idle-session drain — reads mesh membership through
 * getMeshWithCache, which historically returned the local-config mesh verbatim
 * whenever one existed. A freshly cloned worktree node is registered ONLY into the
 * router's inline mesh cache: clone_mesh_node's `meshRecord.inline` branch calls
 * updateInlineMeshNode, NOT addNode, so the worktree node never reaches local
 * config (meshes.json). The config-first view therefore omits the worktree node,
 * while send_task — which resolves membership through getMeshForCommand(preferInline)
 * over the same inline cache — sees it. That view asymmetry is the stall: a queue
 * task pinned to the worktree node reports `target_node_id_unmatched` (autoLaunch
 * candidate filter / targetPinUnmatched check) and the node's idle session is
 * dropped from the drain pool (mesh.nodes.find miss), so claim never fires and the
 * task is stranded pending — even though nodeId matching itself is correct.
 *
 * Fix: union the local-config nodes with any inline-cache-ONLY nodes, so the claim
 * view matches the command (send_task) view. Base (non-worktree) nodes present in
 * local config stay config-authoritative — their STATIC fields are taken verbatim
 * from localMesh, so base node claim/matching is byte-for-byte unchanged. Only nodes
 * that exist solely in the inline cache (the cloned worktree nodes) are appended.
 * Identity comparison uses the shared 3-form normalizer (id / nodeId / node_id),
 * identical to every other claim-path consumer — the matching logic is untouched,
 * only which nodes are visible.
 *
 * BOOTSTRAP-DEFER VIEW-CONSISTENCY (this fix): for a worktree node that IS registered
 * in local config, the union previously took the config node verbatim and discarded the
 * inline-cache entry entirely. But the inline cache holds the FRESHER runtime bootstrap
 * state — markWorktreeBootstrapTerminalState stamps worktreeBootstrap.status='complete'
 * synchronously into the inline cache, while local config lags behind the detached async
 * persist chain (and on the coordinator may never receive it at all). A config-registered
 * worktree node therefore read a permanently stale 'running' here, so
 * shouldDeferDispatchForBootstrap deferred its claim forever. We now MERGE the inline
 * cache's dynamic runtime bootstrap state onto the config node (config keeps its static
 * fields; worktreeBootstrap is preferred from the inline cache) so EVERY consumer of the
 * merged view — not just tryAssignQueueTask's gate — observes the terminal stamp.
 *
 * RESIDUAL-getMeshWithCache-bootstrap-overlay (precedence guard): the overlay is DIRECTIONAL —
 * it prefers the inline entry ONLY when the inline runtime state is actually fresher, never
 * merely because the inline entry carries a status. inlineBootstrapIsFresher() (below) permits
 * the overlay in exactly two cases, mirroring the mission's "terminal OR strictly newer" rule:
 *   (1) the inline state is TERMINAL ('complete'/'failed') while the config state is NOT — the
 *       markWorktreeBootstrapTerminalState synchronous stamp the async config persist has not
 *       yet caught up to; this is the whole point of the overlay (opens the gate).
 *   (2) both states are non-terminal but the inline startedAt is STRICTLY newer — a re-driven
 *       bootstrap whose fresher 'running' epoch the config has not observed.
 * It REFUSES the overlay when the config state is already terminal and the inline state is a
 * stale/non-terminal 'running' — otherwise a stale inline 'running' would MASK a genuinely
 * complete config node and re-defer its claim forever (the exact anti-case this guard closes).
 * And when both are 'running' with no newer epoch, the config value is kept and the gate still
 * defers — the half-built-worktree → empty-session defense is preserved: only a terminal-confirmed
 * inline state, never an ambiguous read, ever opens the gate.
 */
const BOOTSTRAP_TERMINAL_STATUSES = new Set(['complete', 'failed']);

function bootstrapEpochMs(bootstrap: any): number {
    const raw = readNonEmptyString(bootstrap?.startedAt) || readNonEmptyString(bootstrap?.completedAt);
    if (!raw) return 0;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Directional freshness test for the bootstrap overlay: may the inline runtime state
 * REPLACE the config runtime state? True only when the inline state is terminal and the
 * config state is not (the synchronous terminal stamp the async persist lags), or when
 * both are non-terminal but the inline epoch is strictly newer. A terminal config state is
 * never overwritten by a non-terminal inline read (the stale-'running'-masks-complete
 * anti-case), and equal states never trigger a rewrite.
 */
function inlineBootstrapIsFresher(inlineBootstrap: any, configBootstrap: any): boolean {
    const inlineStatus = readNonEmptyString(inlineBootstrap?.status);
    if (!inlineStatus) return false;
    const configStatus = readNonEmptyString(configBootstrap?.status);
    const inlineTerminal = BOOTSTRAP_TERMINAL_STATUSES.has(inlineStatus);
    const configTerminal = !!configStatus && BOOTSTRAP_TERMINAL_STATUSES.has(configStatus);
    // Config already terminal: only a DIFFERENT terminal inline state (e.g. config 'complete'
    // vs a later 'failed' re-drive) may supersede it; a non-terminal inline read must never
    // mask a terminal config state.
    if (configTerminal) {
        return inlineTerminal && inlineStatus !== configStatus
            && bootstrapEpochMs(inlineBootstrap) > bootstrapEpochMs(configBootstrap);
    }
    // Config not terminal: an inline terminal state is always fresher (opens the gate).
    if (inlineTerminal) return true;
    // Both non-terminal: prefer inline only when its epoch is strictly newer (a re-driven
    // bootstrap the config has not observed). Equal/older ⇒ keep config, gate still defers.
    return bootstrapEpochMs(inlineBootstrap) > bootstrapEpochMs(configBootstrap);
}

function mergeInlineCacheOnlyNodes(localMesh: any, cachedMesh: any): any {
    const localNodes = Array.isArray(localMesh?.nodes) ? localMesh.nodes : [];
    const cachedNodes = Array.isArray(cachedMesh?.nodes) ? cachedMesh.nodes : [];
    if (!cachedNodes.length) return localMesh;
    // Index inline-cache nodes by identity so we can (a) append cache-only nodes and
    // (b) prefer the inline runtime bootstrap state on config-registered nodes.
    const cacheOnly = cachedNodes.filter((cachedNode: any) => {
        const cachedId = readMeshNodeId(cachedNode);
        // Unidentifiable cache entries can never be a claim/route target — skip them
        // rather than appending junk that no consumer can address.
        if (!cachedId) return false;
        return !localNodes.some((localNode: any) => meshNodeIdMatches(localNode, cachedId));
    });
    // Overlay the inline cache's fresher worktreeBootstrap state onto any config node that
    // also exists in the inline cache. inlineBootstrapIsFresher() gates the overlay to the
    // "terminal OR strictly newer" cases, so a stale inline 'running' can never mask a
    // terminal config state and the gate's deferral is preserved for a genuine 'running'.
    let overlaidLocalNodes: any[] = localNodes;
    let overlaid = false;
    for (let i = 0; i < localNodes.length; i++) {
        const localNode = localNodes[i];
        const localId = readMeshNodeId(localNode);
        if (!localId) continue;
        const inlineMatch = cachedNodes.find((cachedNode: any) => meshNodeIdMatches(cachedNode, localId));
        if (!inlineMatch) continue;
        const bootstrapFresher = inlineBootstrapIsFresher(inlineMatch.worktreeBootstrap, localNode.worktreeBootstrap);
        // Dual-source (5-c / 5-b C): mesh_status stamps lastGit on the INLINE node; the claim
        // view used to take the config node verbatim whenever bootstrap wasn't fresher, so
        // shouldDeferDispatchForBootstrap never saw the P2P git evidence and the stale-running
        // backstop could not open. Overlay lastGit independently of bootstrap freshness.
        const inlineGit = inlineMatch.lastGit ?? inlineMatch.last_git;
        if (!bootstrapFresher && !inlineGit) continue;
        if (!overlaid) {
            overlaidLocalNodes = [...localNodes];
            overlaid = true;
        }
        // Keep the config node's static fields; overlay only dynamic runtime substate
        // (fresher terminal stamp / epoch, and live lastGit). Config identity is unchanged.
        overlaidLocalNodes[i] = {
            ...localNode,
            ...(bootstrapFresher ? { worktreeBootstrap: inlineMatch.worktreeBootstrap } : {}),
            ...(inlineGit ? { lastGit: inlineGit, last_git: inlineGit } : {}),
        };
    }
    if (!cacheOnly.length && !overlaid) return localMesh;
    return { ...localMesh, nodes: [...overlaidLocalNodes, ...cacheOnly] };
}


// Canonical mesh node-id normalization. A node may arrive from the local config
// form (`id`) or the inline-cache form (`nodeId`/`node_id`) — see
// readInlineMeshNodeId in commands/router.ts. Comparing only `node.id` against a
// task.targetNodeId silently drops inline-cached worktree nodes, leaving a
// target-routed task permanently pending with a misleading
// `no_node_satisfies_required_tags` skip.
export function readMeshNodeId(node: any): string {
    // Delegate to the shared 3-way (id / nodeId / node_id) normalizer so this
    // and every other mesh node-id read agree on identity. Coalesce to '' to
    // preserve the existing string return contract for callers that do
    // `=== task.targetNodeId` / `if (!nodeId)`.
    return normalizeMeshNodeId(node) ?? '';
}
