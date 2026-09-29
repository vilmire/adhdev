/**
 * The router's inline mesh roster: the in-memory cache of cloud-originating meshes
 * (passed on every command as `inlineMesh`), its reconcile with meshes.json policy
 * edits, node upserts/removals with resurrection tombstones, worktree-bootstrap
 * terminal states, and the adoption of worktree nodes a member daemon reports.
 * Functions over the router instance (`host`); the class keeps thin delegators.
 */
import {
    persistRemoteWorktreeNodeToConfig,
    planMemberWorktreeAdoption,
    sanitizeMemberWorktreeNodes,
    type MemberWorktreeAdoptionResult,
    type PersistRemoteWorktreeNodeOutcome,
} from '../mesh/mesh-remote-worktree-membership.js';
import { normalizeMeshNodeId, meshNodeIdMatches } from '@adhdev/mesh-shared';
import { LOG } from '../logging/logger.js';
import { resolveMeshHostStatus } from '../mesh/mesh-host-ownership.js';
import type { RepoMeshSpawnedSessionVisibility } from '../repo-mesh-types.js';
import { mergeAndNormalizePolicy } from '../repo-mesh-types.js';
import { readMeshConfigFromDisk, statMeshConfigFile } from '../config/mesh-config-store.js';
import * as fs from 'fs';
import {
    foldMeshNodeIdentityToCanonical,
    inlineMeshCarriesTransientNodeTruth,
    normalizeInlineMeshNodeIdentity,
    readInlineMeshNodeId,
    readStringValue,
    reconcileInlineMeshCache,
    sanitizeInlineMesh,
} from '../mesh/mesh-node-identity.js';
import type { DaemonCommandRouter } from './router.js';

/** The DaemonCommandRouter members these functions read or call (compiler-checked; no cast). */
export type InlineMeshRosterHost = Pick<DaemonCommandRouter, 'deps' | 'inlineMeshCache' | 'invalidateAggregateMeshStatus' | 'meshPolicyDiskSync' | 'removedInlineMeshNodeIds'>;

/** meshes.json is stat'ed at most this often while syncing inline policies. */
const MESH_POLICY_DISK_SYNC_THROTTLE_MS = 250;

/**
 * meshes.json → inline-cache policy resync (mtime-triggered lazy reload).
 *
 * Out-of-band edits to meshes.json (an operator hand-editing a policy flag)
 * never reached the inline mesh cache: command-path updates (update_mesh)
 * rewrite BOTH disk and cache, but a direct file edit changed nothing in
 * memory, so mesh_status / refine gating kept serving the boot-time policy
 * until a daemon restart (live evidence 2026-08-25: requireApprovalForPush
 * flipped to false on disk 92 min after daemon boot; the daemon kept
 * reporting and enforcing true).
 *
 * Fix: on inline-cache reads, stat meshes.json (throttled — routing and
 * status polling are hot paths); when the file changed, re-apply ONLY each
 * cached mesh's `policy` block from disk. Policy-only, never nodes/meshHost:
 * the inline cache is the coordinator's live node truth, and the daemon's
 * own mutators read-modify-write through disk, so they already carry the
 * edit forward — overwriting the whole cached mesh here would clobber
 * in-flight node truth for zero benefit. A changed policy also busts the
 * aggregate status snapshot, whose scheduling projection is derived from it.
 *
 * Safety rules:
 *   - unparseable file (torn mid-edit write) → keep the in-memory policy,
 *     log only. Never fall back to defaults: that would silently LOOSEN
 *     security flags (requireApprovalForPush / requireApprovalForDestructiveGit).
 *   - mesh absent from disk (deleted, or inline-only cloud mesh) → keep the
 *     cache entry untouched.
 */
export function syncInlineMeshPoliciesFromDisk(host: InlineMeshRosterHost): void {
    if (host.inlineMeshCache.size === 0) return;
    const now = Date.now();
    const sync = host.meshPolicyDiskSync;
    if (now - sync.checkedAtMs < MESH_POLICY_DISK_SYNC_THROTTLE_MS) return;
    sync.checkedAtMs = now;
    const stat = statMeshConfigFile();
    if (!stat) return; // File absent/unreadable: nothing to sync; retry next window.
    if (stat.mtimeMs === sync.mtimeMs && stat.size === sync.size) return;
    const hadBaseline = sync.mtimeMs >= 0;
    sync.mtimeMs = stat.mtimeMs;
    sync.size = stat.size;
    if (!hadBaseline) return; // First sight records the baseline only (see field comment).
    const disk = readMeshConfigFromDisk();
    if (!disk) {
        console.warn('[mesh-config] meshes.json changed but is unparseable (mid-edit?) — keeping in-memory mesh policies');
        return;
    }
    const diskPolicyByMeshId = new Map<string, any>();
    for (const mesh of disk.meshes) {
        if (mesh?.id && mesh.policy && typeof mesh.policy === 'object') diskPolicyByMeshId.set(mesh.id, mesh.policy);
    }
    for (const [meshId, cached] of host.inlineMeshCache) {
        const diskPolicy = diskPolicyByMeshId.get(meshId);
        if (!diskPolicy) continue;
        const nextPolicy = mergeAndNormalizePolicy(undefined, diskPolicy);
        if (JSON.stringify(cached?.policy ?? null) === JSON.stringify(nextPolicy)) continue;
        cached.policy = nextPolicy;
        host.invalidateAggregateMeshStatus(meshId);
    }
}

export function getCachedInlineMeshNodes(host: InlineMeshRosterHost): any[] {
    syncInlineMeshPoliciesFromDisk(host);
    const nodes: any[] = [];
    for (const mesh of host.inlineMeshCache.values()) {
        if (Array.isArray(mesh?.nodes)) {
            nodes.push(...mesh.nodes);
        }
    }
    return nodes;
}

/**
 * Same flattened node list as getCachedInlineMeshNodes(), but each node is
 * paired with the `spawnedSessionVisibility` from its OWNING mesh's policy.
 * The flat node list loses the mesh→node association, yet the cloud daemon's
 * synthetic mesh-session mirror needs the mesh-level visibility policy to
 * decide whether a coordinator-spawned worker session should be hidden+muted
 * on the dashboard (the cached inline-mesh session entry carries no settings
 * of its own). Falls back to DEFAULT_MESH_POLICY.spawnedSessionVisibility when
 * the mesh policy is absent, matching the worker-launch stamp.
 */
export function getCachedInlineMeshNodesWithVisibility(host: InlineMeshRosterHost): Array<{ node: any; spawnedSessionVisibility: RepoMeshSpawnedSessionVisibility }> {
    syncInlineMeshPoliciesFromDisk(host);
    const out: Array<{ node: any; spawnedSessionVisibility: RepoMeshSpawnedSessionVisibility }> = [];
    for (const mesh of host.inlineMeshCache.values()) {
        const spawnedSessionVisibility: RepoMeshSpawnedSessionVisibility =
            mesh?.policy?.spawnedSessionVisibility === 'visible' ? 'visible' : 'hidden';
        if (Array.isArray(mesh?.nodes)) {
            for (const node of mesh.nodes) {
                out.push({ node, spawnedSessionVisibility });
            }
        }
    }
    return out;
}

export function getCachedInlineMesh(host: InlineMeshRosterHost, meshId: string, inlineMesh?: unknown): any | undefined {
    syncInlineMeshPoliciesFromDisk(host);
    if (inlineMesh && typeof inlineMesh === 'object') {
        return warmInlineMeshCache(host, meshId, inlineMesh);
    }
    return host.inlineMeshCache.get(meshId);
}

export function warmInlineMeshCache(host: InlineMeshRosterHost, meshId: string, inlineMesh?: unknown): any | undefined {
    if (!inlineMesh || typeof inlineMesh !== 'object') return undefined;
    // Save-boundary node-id normalization: reconcile each node's identity so
    // `id` and `nodeId` agree before it enters the cache, so reconcile keys
    // and the round-trip through the status serializer stay form-stable.
    const sanitizedInlineMesh = applyInlineMeshNodeTombstones(host, 
        meshId,
        sanitizeInlineMesh(normalizeInlineMeshNodeIdentity(inlineMesh as any)),
    );
    const cached = host.inlineMeshCache.get(meshId);
    if (cached) {
        const merged = reconcileInlineMeshCache(cached, sanitizedInlineMesh, host.removedInlineMeshNodeIds.get(meshId));
        host.inlineMeshCache.set(meshId, merged);
        return merged;
    }
    host.inlineMeshCache.set(meshId, sanitizedInlineMesh as any);
    return sanitizedInlineMesh as any;
}

export async function getMeshForCommand(host: InlineMeshRosterHost, meshId: string, inlineMesh?: unknown, options?: { preferInline?: boolean }): Promise<{ mesh: any; inline: boolean; source: 'inline_cache' | 'inline_bootstrap' | 'local_config' } | null> {
    // Default to inline-cache-preferred: a caller that omits the flag still sees
    // inline-cache-only (worktree clone) nodes in the resolved mesh view, closing
    // the CLAIMSTALL gap where a missed `preferInline: true` silently dropped them.
    // An explicit `preferInline: false` is still honored for any local-config-only
    // read that deliberately bypasses the inline cache.
    const preferInline = options?.preferInline !== false;
    if (preferInline) {
        const cached = getCachedInlineMesh(host, meshId);
        if (cached) {
            if (inlineMeshCarriesTransientNodeTruth(inlineMesh)) {
                const merged = reconcileInlineMeshCache(
                    cached,
                    applyInlineMeshNodeTombstones(host, meshId, inlineMesh as any),
                    host.removedInlineMeshNodeIds.get(meshId),
                );
                host.inlineMeshCache.set(meshId, sanitizeInlineMesh(normalizeInlineMeshNodeIdentity(merged)));
                return { mesh: merged, inline: true, source: 'inline_cache' };
            }
            return { mesh: cached, inline: true, source: 'inline_cache' };
        }
        if (inlineMeshCarriesTransientNodeTruth(inlineMesh)) {
            warmInlineMeshCache(host, meshId, inlineMesh);
            return { mesh: inlineMesh, inline: true, source: 'inline_bootstrap' };
        }
    }
    try {
        const { getMesh } = await import('../config/mesh-config.js');
        const mesh = getMesh(meshId);
        if (mesh) return { mesh, inline: false, source: 'local_config' };
    } catch { /* fall through to inline cache */ }
    const cached = getCachedInlineMesh(host, meshId);
    if (cached) return { mesh: cached, inline: true, source: 'inline_cache' };
    const warmedInline = warmInlineMeshCache(host, meshId, inlineMesh);
    return warmedInline ? { mesh: warmedInline, inline: true, source: 'inline_bootstrap' } : null;
}

// Public alongside removeInlineMeshNode: clone/lifecycle handlers register a
// node through the same inline-cache seam removal uses.
export function updateInlineMeshNode(host: InlineMeshRosterHost, meshId: string, mesh: any, node: any): void {
    const incomingId = normalizeMeshNodeId(node);
    if (!mesh || !Array.isArray(mesh.nodes) || !incomingId) return;
    // M-MESH-INFRA-0829 [C]: honor removal tombstones here too. Every OTHER inline-cache
    // write path (warmInlineMeshCache, getMeshForCommand's reconcile branch) already filters
    // through applyInlineMeshNodeTombstones before merging — this direct single-node writer
    // was the one gap. Its two hydrate-on-miss callers (markWorktreeBootstrapTerminalState's
    // shell upsert, seedRemoteClonedWorktreeNode's clone-reply merge) both react to late/
    // replayed/best-effort P2P events for a node id that "isn't in the cache" — which is
    // exactly true immediately after mesh_remove_node tombstones and evicts it. Without this
    // check a stray post-removal event silently resurrects the node. Same clearing rule as
    // applyInlineMeshNodeTombstones: a genuine re-registration (workspace really is back) still
    // wins.
    if (isInlineMeshNodeTombstoned(host, meshId, incomingId, node)) {
        LOG.info('Mesh', `[NodeMembershipMerge] mesh=${meshId} droppedNodeId=${incomingId} reason=tombstoned_removal source=updateInlineMeshNode`);
        return;
    }
    const idx = mesh.nodes.findIndex((entry: any) => meshNodeIdMatches(entry, incomingId));
    if (idx >= 0) mesh.nodes[idx] = node;
    else mesh.nodes.push(node);
    mesh.updatedAt = new Date().toISOString();
    // Canonicalize node identity in place (id and nodeId kept equal): clone
    // nodes are created with `id` and re-inserted here (bypassing
    // warmInlineMeshCache), so this is a second save boundary. In-place
    // folding preserves the caller's `mesh` / nodes-array references, which
    // persistWorktreeSetupState reuses across subsequent calls.
    for (const entry of mesh.nodes) foldMeshNodeIdentityToCanonical(entry);
    host.inlineMeshCache.set(meshId, mesh);
    host.invalidateAggregateMeshStatus(meshId);
}

export function removeInlineMeshNode(host: InlineMeshRosterHost, meshId: string, mesh: any, nodeId: string): boolean {
    if (!mesh || !Array.isArray(mesh.nodes)) return false;
    const idx = mesh.nodes.findIndex((entry: any) => meshNodeIdMatches(entry, nodeId));
    if (idx === -1) return false;
    const canonicalNodeId = readInlineMeshNodeId(mesh.nodes[idx]) || nodeId;
    mesh.nodes.splice(idx, 1);
    mesh.updatedAt = new Date().toISOString();
    host.inlineMeshCache.set(meshId, mesh);
    // Tombstone the removed node so the dashboard's stale inlineMesh echo does
    // not MERGE it back on the next command (see removedInlineMeshNodeIds).
    tombstoneRemovedInlineMeshNode(host, meshId, canonicalNodeId);
    if (canonicalNodeId !== nodeId) tombstoneRemovedInlineMeshNode(host, meshId, nodeId);
    host.invalidateAggregateMeshStatus(meshId);
    return true;
}

/**
 * WORKTREE-BOOTSTRAP-COORD-STATE: mark a worktree node's bootstrap as reaching a
 * terminal state (complete / failed) in THIS daemon's mesh view.
 *
 * Root cause this fixes: clone_mesh_node forwards the clone+bootstrap to the
 * source node's daemon (the worktree's machine). persistWorktreeSetupState
 * therefore flips worktreeBootstrap.status to 'complete' on the WORKER daemon's
 * mesh object — never on the coordinator's. The coordinator only ever holds the
 * 'running' state it stamped from the forwarded clone reply. The claim path's
 * bootstrap gate (mesh-event-forwarding agent:ready / mesh-queue-assignment)
 * reads the coordinator's mesh via getMeshWithCache, sees status==='running'
 * forever, and DEFERS every claim — so the worktree_bootstrap_complete re-fire
 * (triggerMeshQueue) loops against a gate that never opens: claim never lands,
 * the idle session is re-registered each tick, and auto-launch keeps spawning
 * fresh sessions (runaway worktree-session multiplication).
 *
 * Called from the worktree_bootstrap_complete/_failed event handler BEFORE the
 * queue re-fire so the gate sees the terminal state and the deferred claim can
 * finally land. Updates the inline cache (clone worktree nodes are inline-only)
 * and, when the node also exists in local config, persists there too; both paths
 * invalidate the aggregate status cache. Best-effort and idempotent.
 */
export function markWorktreeBootstrapTerminalState(host: InlineMeshRosterHost, meshId: string, nodeId: string, status: 'complete' | 'failed', opts?: { workspace?: string; daemonId?: string; machineId?: string }): void {
    if (!meshId || !nodeId) return;
    const terminalBootstrap = (prev?: Record<string, unknown>): Record<string, unknown> => ({
        ...(prev && typeof prev === 'object' ? prev : {}),
        status,
        completedAt: (prev as any)?.completedAt ?? new Date().toISOString(),
    });
    const stamp = (mesh: any): boolean => {
        if (!mesh || !Array.isArray(mesh.nodes)) return false;
        const node = mesh.nodes.find((entry: any) => meshNodeIdMatches(entry, nodeId));
        if (!node) return false;
        const prev = (node.worktreeBootstrap && typeof node.worktreeBootstrap === 'object')
            ? node.worktreeBootstrap as Record<string, unknown>
            : {};
        if (prev.status === status) return false;
        node.worktreeBootstrap = terminalBootstrap(prev);
        return true;
    };
    let changed = false;
    // Inline cache (the authoritative view for inline-only clone worktree nodes).
    try {
        const cached = getCachedInlineMesh(host, meshId);
        if (cached && stamp(cached)) {
            cached.updatedAt = new Date().toISOString();
            host.inlineMeshCache.set(meshId, cached);
            changed = true;
        } else if (!cached || !(Array.isArray(cached.nodes) && cached.nodes.some((entry: any) => meshNodeIdMatches(entry, nodeId)))) {
            // Fix (3) HYDRATE-ON-MISS: the terminal bootstrap event arrived for a node this
            // coordinator's inline view does NOT hold — the clone reply that would have seeded
            // the worktree node never reached this daemon (or the inline mesh for this id is
            // empty). With no node entry the claim gate has nothing to open, so the deferred
            // claim (mesh-event-forwarding agent:ready / mesh-queue-assignment) strands forever
            // and the coordinator relaunch/stop-loops. Instead of returning early, upsert a
            // minimal worktree node carrying the terminal bootstrap status from the event
            // payload so the gate — which reads this same inline view — sees a non-'running'
            // state and the registered idle session can finally claim. Identity is canonicalized
            // by updateInlineMeshNode (id/nodeId folded via the shared 3-form normalizer), so the
            // remote-clone node-id form resolves the same way every claim-path consumer matches.
            const shell = (cached && typeof cached === 'object')
                ? cached
                : { id: meshId, nodes: [] as any[], updatedAt: new Date().toISOString() };
            if (!Array.isArray(shell.nodes)) shell.nodes = [];
            const hydratedNode: any = {
                id: nodeId,
                nodeId,
                isLocalWorktree: true,
                ...(opts?.workspace ? { workspace: opts.workspace } : {}),
                // Origin identity from the worker's bootstrap event: without
                // these, isLocalAutoLaunchNode treats the shell as LOCAL and the
                // coordinator tries to spawn the remote worktree on itself.
                ...(opts?.daemonId ? { daemonId: opts.daemonId } : {}),
                ...(opts?.machineId ? { machineId: opts.machineId } : {}),
                worktreeBootstrap: terminalBootstrap(),
            };
            updateInlineMeshNode(host, meshId, shell, hydratedNode);
            changed = true;
        }
    } catch { /* best-effort */ }
    if (changed) host.invalidateAggregateMeshStatus(meshId);
    // Local config (a worktree node registered via addNode also lives here).
    // Done in a detached dynamic-import chain so the method stays sync; both the
    // stamp and the persist are best-effort, and the inline-cache stamp above is
    // what the coordinator's claim gate reads.
    void import('../config/mesh-config.js')
        .then(({ getMesh, updateNode }) => {
            const local = getMesh(meshId);
            if (local && stamp(local)) {
                const node = local.nodes.find((entry: any) => meshNodeIdMatches(entry, nodeId));
                if (node) updateNode(meshId, node.id, { worktreeBootstrap: node.worktreeBootstrap } as any);
                host.invalidateAggregateMeshStatus(meshId);
            }
        })
        .catch(() => { /* persistence is best-effort */ });
}

/**
 * REMOTE-CLONE-CACHE-SEED: register a worktree node produced by a clone that ran on
 * ANOTHER machine into THIS (coordinator) daemon's inline mesh cache.
 *
 * Root cause this fixes: clone_mesh_node forwards to the source node's daemon when the
 * source lives on a different machine. The local clone branch writes the new node into
 * the coordinator's own cache synchronously (updateInlineMeshNode / addNode), but the
 * remote-forward branch only returned the reply — it never seeded the local cache. The
 * scheduler is a PURELY PASSIVE cache reader (mesh-queue-assignment getMeshWithCache:
 * no network call), whereas the read tools actively refresh (refreshMeshFromDaemon) and
 * mesh_git_status fans out over P2P — which is exactly why the node was visible to every
 * tool yet permanently invisible to the queue (`target_node_id_unmatched` /
 * `no_node_satisfies_required_tags`). Cache reflection depended solely on the one-shot
 * `worktree_bootstrap_complete` P2P push, which has no retry and no periodic resync, so
 * a single dropped event stranded the node forever.
 *
 * ORDER-INDEPENDENT BY CONSTRUCTION. This races the bootstrap-complete event's
 * hydrate-on-miss upsert (markWorktreeBootstrapTerminalState) in BOTH directions, and
 * updateInlineMeshNode REPLACES the entry wholesale rather than merging, so neither
 * writer may blindly overwrite the other:
 *   - seed-then-event: the node now exists, so hydrate-on-miss does not fire; the event
 *     takes the `stamp()` path, which mutates ONLY worktreeBootstrap and preserves every
 *     scheduling field seeded here.
 *   - event-then-seed (the dangerous order): the event already hydrated a MINIMAL node
 *     carrying a TERMINAL bootstrap status. Overwriting it with this reply's 'running'
 *     state would re-close the claim gate permanently (shouldDeferDispatchForBootstrap
 *     defers on 'running'), reproducing the very stall this fixes. So an existing
 *     terminal worktreeBootstrap always wins over the reply's non-terminal one.
 * The merge is field-directional, never a wholesale pick of one side: the reply is
 * authoritative for the STATIC scheduling identity it alone carries (daemonId, machineId,
 * policy, userOverrides, capabilities, workspace, worktreeBranch) — the hydrated shell has
 * none of these — while the existing entry is authoritative for DYNAMIC runtime state that
 * has already advanced past the reply (terminal worktreeBootstrap).
 *
 * Seeding daemonId/machineId is not cosmetic: isLocalAutoLaunchNode treats a node with
 * NEITHER field as LOCAL, so the minimal hydrated shell would make the coordinator try to
 * auto-launch a remote worktree session on its own machine. Likewise required-tags matching
 * derives tags from policy/capabilities/platform, so a shell node satisfies no tag filter.
 */
export function seedRemoteClonedWorktreeNode(host: InlineMeshRosterHost, meshId: string, node: any): boolean {
    if (!meshId || !node || typeof node !== 'object') return false;
    const nodeId = normalizeMeshNodeId(node);
    if (!nodeId) return false;
    try {
        const cached = getCachedInlineMesh(host, meshId);
        const shell = (cached && typeof cached === 'object')
            ? cached
            : { id: meshId, nodes: [] as any[], updatedAt: new Date().toISOString() };
        if (!Array.isArray(shell.nodes)) shell.nodes = [];
        const existing = shell.nodes.find((entry: any) => meshNodeIdMatches(entry, nodeId));
        // Start from the reply (authoritative for static scheduling identity), then let
        // any already-advanced dynamic state on the existing entry win — see the
        // event-then-seed ordering note above.
        const merged: any = { ...(existing && typeof existing === 'object' ? existing : {}), ...node };
        const existingBootstrapStatus = readStringValue(existing?.worktreeBootstrap?.status);
        if (existingBootstrapStatus === 'complete' || existingBootstrapStatus === 'failed') {
            merged.worktreeBootstrap = existing.worktreeBootstrap;
        }
        updateInlineMeshNode(host, meshId, shell, merged);
        return true;
    } catch {
        return false; /* best-effort: a failed seed degrades to the pre-fix behavior */
    }
}

/**
 * REMOTE-CLONE-DURABLE: persist a remotely-cloned worktree node into THIS
 * coordinator's meshes.json (same shape as a local clone), so it survives a
 * coordinator restart. Idempotent by id; a node tombstoned by a removal is never
 * written (a late clone reply must not resurrect it durably either); a pure
 * inline mesh (no config twin) is a no-op, exactly like the local clone branch.
 */
export async function persistRemoteClonedWorktreeNode(host: InlineMeshRosterHost, meshId: string, node: any): Promise<PersistRemoteWorktreeNodeOutcome | 'tombstoned'> {
    const nodeId = normalizeMeshNodeId(node);
    if (!meshId || !nodeId) return 'invalid';
    if (isInlineMeshNodeTombstoned(host, meshId, nodeId, node)) return 'tombstoned';
    const outcome = await persistRemoteWorktreeNodeToConfig(meshId, node);
    if (outcome === 'persisted') host.invalidateAggregateMeshStatus(meshId);
    return outcome;
}

/**
 * MEMBER-WORKTREE-RECONCILE (coordinator side): adopt worktree nodes a member
 * reports it owns on `meshId` that this coordinator does not hold — e.g. a
 * remote clone made before clones were persisted, or lost to a restart between
 * the clone reply and the write. Owner-gated (mesh-remote-worktree-membership.ts
 * planMemberWorktreeAdoption): only this daemon's hosted meshes, only nodes owned
 * by the authenticated sender, never a tombstoned (removed) node. Also opens a
 * bootstrap gate the coordinator still holds 'running' when the member reports
 * the bootstrap terminal (the one-shot bootstrap event was lost).
 */
export async function adoptMemberWorktreeNodes(host: InlineMeshRosterHost, meshId: string, input: { reported: unknown; senderDaemonId: string; ownerDaemonId: string }): Promise<MemberWorktreeAdoptionResult> {
    const result: MemberWorktreeAdoptionResult = { adopted: [], healed: [], rejected: [] };
    const reported = sanitizeMemberWorktreeNodes(input.reported);
    if (!meshId || reported.length === 0) return result;
    const record = await getMeshForCommand(host, meshId, undefined, { preferInline: true });
    if (!record?.mesh) return result;
    const hostStatus = resolveMeshHostStatus(record.mesh);
    if (!hostStatus.canOwnCoordinator || !hostStatus.canOwnQueue) {
        result.rejected = reported.map(node => ({ nodeId: node.id, reason: 'not_mesh_host' as const }));
        return result;
    }
    // Both views of the roster: the inline cache and the config twin.
    const meshNodes: unknown[] = [];
    const cached = getCachedInlineMesh(host, meshId);
    if (Array.isArray(cached?.nodes)) meshNodes.push(...cached.nodes);
    try {
        const { getMesh } = await import('../config/mesh-config.js');
        const local = getMesh(meshId);
        if (local) meshNodes.push(...local.nodes);
    } catch { /* no config twin */ }
    if (record.mesh !== cached && Array.isArray(record.mesh.nodes)) meshNodes.push(...record.mesh.nodes);
    const plan = planMemberWorktreeAdoption({
        meshNodes,
        reported,
        senderDaemonId: input.senderDaemonId,
        ownerDaemonId: input.ownerDaemonId,
        selfDaemonId: host.deps.statusInstanceId,
        isTombstoned: (node) => isInlineMeshNodeTombstoned(host, meshId, node.id, node),
    });
    result.rejected = plan.rejected;
    for (const node of plan.adopt) {
        // Inline view only when one exists — never a shell cache that would shadow
        // the config roster for this mesh.
        const inline = getCachedInlineMesh(host, meshId);
        if (inline && Array.isArray(inline.nodes)) updateInlineMeshNode(host, meshId, inline, { ...node });
        const outcome = await persistRemoteWorktreeNodeToConfig(meshId, node);
        if (inline || outcome === 'persisted' || outcome === 'already_present') {
            result.adopted.push(node.id);
            LOG.info('Mesh', `[MemberWorktreeReconcile] mesh=${meshId} adoptedNodeId=${node.id} owner=${node.daemonId.slice(0, 24)} persist=${outcome}`);
        } else {
            result.rejected.push({ nodeId: node.id, reason: 'no_roster' });
        }
    }
    for (const heal of plan.healBootstrap) {
        markWorktreeBootstrapTerminalState(host, meshId, heal.nodeId, heal.status, {
            workspace: heal.workspace,
            daemonId: heal.daemonId,
            ...(heal.machineId ? { machineId: heal.machineId } : {}),
        });
        result.healed.push(heal.nodeId);
    }
    if (result.adopted.length > 0) host.invalidateAggregateMeshStatus(meshId);
    return result;
}

/** Public seam for remove_mesh_node's config branch (no warmed inline cache to splice). */
export function tombstoneRemovedMeshNode(host: InlineMeshRosterHost, meshId: string, nodeId: string): void {
    if (!meshId || !nodeId) return;
    tombstoneRemovedInlineMeshNode(host, meshId, nodeId);
}

export function tombstoneRemovedInlineMeshNode(host: InlineMeshRosterHost, meshId: string, nodeId: string): void {
    if (!nodeId) return;
    let set = host.removedInlineMeshNodeIds.get(meshId);
    if (!set) {
        set = new Set<string>();
        host.removedInlineMeshNodeIds.set(meshId, set);
    }
    set.add(nodeId);
}

/** Single-node counterpart of {@link applyInlineMeshNodeTombstones}, for a direct
 *  single-node writer (updateInlineMeshNode) rather than a whole-mesh merge. Same rule:
 *  a tombstoned node id is dropped unless its workspace is genuinely back on disk, in
 *  which case the tombstone clears and the write proceeds normally. */
export function isInlineMeshNodeTombstoned(host: InlineMeshRosterHost, meshId: string, nodeId: string, node: any): boolean {
    const tombstones = host.removedInlineMeshNodeIds.get(meshId);
    if (!tombstones?.size || !tombstones.has(nodeId)) return false;
    const workspace = readStringValue(node?.workspace);
    if (workspace && fs.existsSync(workspace)) {
        tombstones.delete(nodeId);
        if (tombstones.size === 0) host.removedInlineMeshNodeIds.delete(meshId);
        return false;
    }
    return true;
}

/** Filter an incoming inline mesh against this mesh's tombstones before it is
 *  reconciled into the cache. A tombstoned node is dropped only while its
 *  workspace is still absent from disk; if the workspace is back (genuine
 *  re-registration), the tombstone is cleared and the node merges normally. */
export function applyInlineMeshNodeTombstones(host: InlineMeshRosterHost, meshId: string, incoming: any): any {
    const tombstones = host.removedInlineMeshNodeIds.get(meshId);
    if (!tombstones?.size || !incoming || typeof incoming !== 'object' || !Array.isArray(incoming.nodes)) {
        return incoming;
    }
    let dropped = false;
    const nodes = incoming.nodes.filter((node: any) => {
        const nodeId = readInlineMeshNodeId(node);
        if (!nodeId || !tombstones.has(nodeId)) return true;
        const workspace = readStringValue(node?.workspace);
        // Genuine re-registration: same nodeId, workspace back on disk →
        // clear the tombstone and let the node merge normally.
        if (workspace && fs.existsSync(workspace)) {
            tombstones.delete(nodeId);
            return true;
        }
        dropped = true;
        return false;
    });
    if (tombstones.size === 0) host.removedInlineMeshNodeIds.delete(meshId);
    if (!dropped) return incoming;
    return { ...incoming, nodes };
}
