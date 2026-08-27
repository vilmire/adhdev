/**
 * GRAPH-ORCHESTRATION Phase D — injectable ports for the workspace saga.
 *
 * Git/filesystem work lives HERE, never inside a SQLite transaction
 * (design :329-330, :993). Tests inject fakes; production uses the git-backed
 * defaults. Clone is a host-side side effect, not an agent task (design :987).
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { gitChildEnv } from '../git/git-locale.js';
import { createWorktree, removeWorktree } from '../git/git-worktree.js';
import { getMesh } from '../config/mesh-config.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import {
    WORKSPACE_OWNER_GIT_CONFIG_KEY,
    deriveWorkspaceCloneIdempotencyKey,
} from './mesh-graph-workspace-identity.js';
import type { WorkspaceInspectReport } from './mesh-graph-workspace-safety.js';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;

export interface WorkspaceCloneRequest {
    meshId: string;
    graphId: string;
    workspaceRef: string;
    sourceNodeId?: string;
    baseRevision?: string;
    branchIdentity: string;
    ownerTag: string;
    desiredPath?: string;
    idempotencyKey: string;
}

export interface WorkspaceCloneResult {
    nodeId: string;
    worktreePath: string;
    ownerTag: string;
    alreadyExisted?: boolean;
    baseSha?: string;
}

export interface WorkspaceInspectRequest {
    meshId: string;
    graphId: string;
    workspaceRef: string;
    worktreePath?: string;
    createdNodeId?: string;
    ownerTag?: string;
    baseRevision?: string;
    sourceNodeId?: string;
}

export interface WorkspaceRemoveRequest {
    meshId: string;
    worktreePath: string;
    createdNodeId?: string;
    sourceNodeId?: string;
}

export interface WorkspaceRemoveResult {
    removed: boolean;
    alreadyGone?: boolean;
    error?: string;
}

export class WorkspaceSagaPermanentError extends Error {
    readonly code: 'source_missing' | 'identity_conflict' | 'graph_gone';
    constructor(code: WorkspaceSagaPermanentError['code'], message: string) {
        super(message);
        this.name = 'WorkspaceSagaPermanentError';
        this.code = code;
    }
}

export interface WorkspaceBaseRevisionRequest {
    meshId: string;
    graphId: string;
    workspaceRef: string;
    sourceNodeId?: string;
}

export interface WorkspaceNodeRegistrationRequest {
    meshId: string;
    nodeId: string;
    worktreePath: string;
    branchIdentity: string;
    sourceNodeId?: string;
    /** Bootstrap status to stamp on the registered node. See registerWorkspaceNode. */
    bootstrapStatus: 'running' | 'complete';
}

export interface WorkspaceNodeUnregistrationRequest {
    meshId: string;
    nodeId: string;
}

export interface WorkspaceSagaPorts {
    nowMs(): number;
    /**
     * Derive the base revision from the declared source node when the declaration
     * omitted `base_revision`. Returns undefined when it cannot be resolved — the
     * saga then stays `declared` rather than cloning from an unknown base.
     */
    resolveBaseRevision(req: WorkspaceBaseRevisionRequest): Promise<string | undefined>;
    createWorktree(req: WorkspaceCloneRequest): Promise<WorkspaceCloneResult>;
    findOwnedWorktree(req: WorkspaceInspectRequest): Promise<WorkspaceCloneResult | null>;
    inspectWorktree(req: WorkspaceInspectRequest): Promise<WorkspaceInspectReport>;
    removeWorktree(req: WorkspaceRemoveRequest): Promise<WorkspaceRemoveResult>;
    listLiveSessionsOnNode(nodeId: string): Promise<{ sessionIds: string[]; unknown?: boolean; error?: string }>;
    listAssignedTasksOnNode(meshId: string, nodeId: string): Promise<string[]>;
    /**
     * Publish the prepared worktree into live mesh membership so it is a normal
     * dispatch target (mesh_list_nodes / target_node_id). Idempotent: re-running
     * a saga step re-stamps rather than duplicating. See registerWorkspaceNode.
     */
    registerNode(req: WorkspaceNodeRegistrationRequest): Promise<boolean>;
    /** Compensation mirror of registerNode — drops the membership entry so a
     *  removed worktree leaves no ghost node behind. */
    unregisterNode(req: WorkspaceNodeUnregistrationRequest): Promise<boolean>;
}

/**
 * Mutation seam onto live mesh membership. Production wires the router (which
 * owns the inline cache); `meshes.json` is written directly. Both halves are
 * needed: `get_mesh` (preferInline, the default) returns the INLINE CACHE ALONE
 * when one is warm, so a durable-only write is invisible to mesh_list_nodes;
 * while a cache-only write has no durable twin and is lost on daemon restart.
 * This mirrors clone_mesh_node, which writes both for exactly these reasons.
 */
export interface WorkspaceNodeRegistryDeps {
    getCachedInlineMesh?(meshId: string): any | undefined;
    updateInlineMeshNode?(meshId: string, mesh: any, node: any): void;
    removeInlineMeshNode?(meshId: string, mesh: any, nodeId: string): boolean;
    invalidateAggregateMeshStatus?(meshId: string): void;
}

export interface DefaultWorkspaceSagaPortOptions {
    /**
     * Default true: a prepared worktree is registered as a real mesh node, so a
     * graph-owned worktree is an ordinary dispatch target. It used to be false —
     * and, worse, unimplemented: the value was read and discarded, and the
     * "clone_mesh_node registers it" handoff named in this comment was never
     * built. The saga therefore produced worktrees that no read tool listed and
     * no task could target. Isolation was never a design requirement (the design
     * doc's workspace-saga section never mentions membership at all), and
     * concurrency is already handled by per-node locks + branch isolation.
     *
     * Set false only for a test that wants the pre-fix create-without-publish
     * behaviour.
     */
    registerNode?: boolean;
    /** Live membership mutation seam; omitted in tests → durable-only. */
    registry?: WorkspaceNodeRegistryDeps;
}

export function createDefaultWorkspaceSagaPorts(opts: DefaultWorkspaceSagaPortOptions = {}): WorkspaceSagaPorts {
    const registrationEnabled = opts.registerNode !== false;
    const registry = opts.registry;
    return {
        nowMs: () => Date.now(),
        resolveBaseRevision: req => defaultResolveBaseRevision(req),
        createWorktree: req => defaultCreateWorktree(req),
        findOwnedWorktree: req => defaultFindOwnedWorktree(req),
        inspectWorktree: req => defaultInspectWorktree(req),
        removeWorktree: req => defaultRemoveWorktree(req),
        listLiveSessionsOnNode: async () => ({ sessionIds: [], unknown: true, error: 'session_host_not_wired_to_workspace_saga' }),
        listAssignedTasksOnNode: async (meshId, nodeId) => defaultListAssignedTasks(meshId, nodeId),
        registerNode: async req => (registrationEnabled ? registerWorkspaceNode(req, registry) : false),
        unregisterNode: async req => (registrationEnabled ? unregisterWorkspaceNode(req, registry) : false),
    };
}

function resolveSourceRepo(meshId: string, sourceNodeId?: string): { repoRoot: string; meshName: string; sourceNodeId?: string } {
    const mesh = getMesh(meshId);
    if (!mesh) throw new WorkspaceSagaPermanentError('source_missing', `mesh '${meshId}' is not available on this daemon`);
    const nodes = Array.isArray(mesh.nodes) ? mesh.nodes : [];
    const source = sourceNodeId
        ? nodes.find(n => n.id === sourceNodeId)
        : nodes.find(n => n.isLocalWorktree !== true);
    const repoRoot = (typeof source?.repoRoot === 'string' && source.repoRoot.trim()
        ? source.repoRoot.trim()
        : typeof source?.workspace === 'string' && source.workspace.trim()
            ? source.workspace.trim()
            : '');
    if (!repoRoot || !existsSync(repoRoot)) {
        throw new WorkspaceSagaPermanentError('source_missing', `source repo for workspace clone is missing (node ${sourceNodeId ?? 'base'})`);
    }
    return { repoRoot, meshName: String(mesh.name || mesh.id || 'mesh'), sourceNodeId: source?.id };
}

async function gitConfigGet(cwd: string, key: string): Promise<string | undefined> {
    try {
        const { stdout } = await execFileAsync('git', ['config', '--get', key], {
            cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true, env: gitChildEnv(),
        });
        const value = stdout.trim();
        return value || undefined;
    } catch {
        return undefined;
    }
}

async function gitConfigSet(cwd: string, key: string, value: string): Promise<void> {
    await execFileAsync('git', ['config', key, value], {
        cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true, env: gitChildEnv(),
    });
}

/**
 * Derive the base revision from the declared source node, mirroring what
 * `clone_mesh_node` already does for an operator-driven worktree clone
 * (commands/med-family/mesh-crud.ts `clone_mesh_node`): resolve the source
 * node's repo, then branch from the branch that repo currently has checked out.
 *
 * `clone_mesh_node` reaches the same place implicitly — it forwards an absent
 * `baseBranch` to createWorktree, which omits the `git worktree add` start ref
 * so git branches from the source repo's HEAD. The saga cannot rely on that
 * implicit path because it PERSISTS the resolved base revision: the recorded
 * value is later re-read by the ahead-probe in defaultInspectWorktree, which
 * compensation safety depends on. So we resolve the same revision explicitly
 * and store it, instead of leaving the intent's baseRevision null forever.
 *
 * Returns undefined (never throws) whenever the mesh, node, repo, or git call
 * is unavailable — an unresolvable base leaves the saga `declared`, which is
 * the pre-existing safe behaviour.
 */
async function defaultResolveBaseRevision(req: WorkspaceBaseRevisionRequest): Promise<string | undefined> {
    let repoRoot: string;
    try {
        ({ repoRoot } = resolveSourceRepo(req.meshId, req.sourceNodeId));
    } catch {
        return undefined;
    }
    // Symbolic branch name first: it is what an operator would have typed as
    // base_revision, and it keeps the remote-freshness resolution in
    // createWorktree (resolveWorktreeBaseStartPoint) meaningful — a raw SHA
    // would silently disable it.
    try {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
            cwd: repoRoot, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true, env: gitChildEnv(),
        });
        const branch = stdout.trim();
        if (branch && branch !== 'HEAD') return branch;
    } catch { /* fall through to the detached-HEAD sha probe */ }
    // Detached HEAD: a sha is still a usable, deterministic base.
    try {
        const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
            cwd: repoRoot, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true, env: gitChildEnv(),
        });
        return stdout.trim() || undefined;
    } catch {
        return undefined;
    }
}

async function defaultCreateWorktree(req: WorkspaceCloneRequest): Promise<WorkspaceCloneResult> {
    const existing = await defaultFindOwnedWorktree({
        meshId: req.meshId,
        graphId: req.graphId,
        workspaceRef: req.workspaceRef,
        worktreePath: req.desiredPath,
        ownerTag: req.ownerTag,
        sourceNodeId: req.sourceNodeId,
    });
    if (existing) return { ...existing, alreadyExisted: true };

    const { repoRoot, meshName } = resolveSourceRepo(req.meshId, req.sourceNodeId);
    if (req.desiredPath && existsSync(req.desiredPath)) {
        const observed = await gitConfigGet(req.desiredPath, WORKSPACE_OWNER_GIT_CONFIG_KEY);
        if (observed && observed !== req.ownerTag) {
            throw new WorkspaceSagaPermanentError(
                'identity_conflict',
                `worktree '${req.desiredPath}' exists with a different owner tag`,
            );
        }
        if (observed === req.ownerTag) {
            return {
                nodeId: derivePreparedNodeId(req.graphId, req.workspaceRef),
                worktreePath: req.desiredPath,
                ownerTag: req.ownerTag,
                alreadyExisted: true,
            };
        }
        throw new WorkspaceSagaPermanentError('identity_conflict', `worktree path '${req.desiredPath}' already exists and is unowned`);
    }

    const created = await createWorktree({
        repoRoot,
        branch: req.branchIdentity,
        baseBranch: req.baseRevision,
        meshName,
        targetDir: req.desiredPath,
        syncBaseFromRemote: false,
    });
    await gitConfigSet(created.worktreePath, WORKSPACE_OWNER_GIT_CONFIG_KEY, req.ownerTag);
    return {
        nodeId: derivePreparedNodeId(req.graphId, req.workspaceRef),
        worktreePath: created.worktreePath,
        ownerTag: req.ownerTag,
        alreadyExisted: false,
    };
}

async function defaultFindOwnedWorktree(req: WorkspaceInspectRequest): Promise<WorkspaceCloneResult | null> {
    const candidates = [req.worktreePath].filter((p): p is string => typeof p === 'string' && p.length > 0);
    for (const path of candidates) {
        if (!existsSync(path)) continue;
        const observed = await gitConfigGet(path, WORKSPACE_OWNER_GIT_CONFIG_KEY);
        if (req.ownerTag && observed === req.ownerTag) {
            return {
                nodeId: req.createdNodeId || derivePreparedNodeId(req.graphId, req.workspaceRef),
                worktreePath: path,
                ownerTag: observed,
                alreadyExisted: true,
            };
        }
    }
    return null;
}

async function defaultInspectWorktree(req: WorkspaceInspectRequest): Promise<WorkspaceInspectReport> {
    const path = req.worktreePath;
    if (!path || !existsSync(path)) {
        return { pathExists: false, dirty: false, ahead: false, stashed: false, sessionBound: false };
    }
    try {
        const observedOwnerTag = await gitConfigGet(path, WORKSPACE_OWNER_GIT_CONFIG_KEY);
        const { stdout: porcelain } = await execFileAsync('git', ['status', '--porcelain'], {
            cwd: path, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true, env: gitChildEnv(),
        });
        let stashCount = 0;
        try {
            const { stdout: stash } = await execFileAsync('git', ['stash', 'list'], {
                cwd: path, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true, env: gitChildEnv(),
            });
            stashCount = stash.split('\n').filter(l => l.trim()).length;
        } catch { /* stash list failure is treated as unknown → ambiguous by caller if they want; we report 0 and no inspectFailed for stash-only */ }

        let ahead = false;
        let aheadCount = 0;
        if (req.baseRevision) {
            try {
                const { stdout: rev } = await execFileAsync('git', ['rev-list', '--count', `${req.baseRevision}..HEAD`], {
                    cwd: path, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true, env: gitChildEnv(),
                });
                aheadCount = Number(rev.trim()) || 0;
                ahead = aheadCount > 0;
            } catch {
                return {
                    pathExists: true,
                    observedOwnerTag,
                    dirty: porcelain.trim().length > 0,
                    ahead: false,
                    stashed: stashCount > 0,
                    stashCount,
                    sessionBound: false,
                    inspectFailed: true,
                    inspectError: 'ahead_probe_failed',
                    ambiguous: true,
                    ambiguityReason: 'could_not_compare_base_revision',
                };
            }
        }

        return {
            pathExists: true,
            observedOwnerTag,
            dirty: porcelain.trim().length > 0,
            ahead,
            aheadCount,
            stashed: stashCount > 0,
            stashCount,
            sessionBound: false,
        };
    } catch (e: any) {
        return {
            pathExists: true,
            dirty: false,
            ahead: false,
            stashed: false,
            sessionBound: false,
            inspectFailed: true,
            inspectError: e?.message || String(e),
            ambiguous: true,
            ambiguityReason: 'inspect_failed',
        };
    }
}

async function defaultRemoveWorktree(req: WorkspaceRemoveRequest): Promise<WorkspaceRemoveResult> {
    if (!req.worktreePath || !existsSync(req.worktreePath)) {
        return { removed: true, alreadyGone: true };
    }
    try {
        const { repoRoot } = resolveSourceRepo(req.meshId, req.sourceNodeId);
        await removeWorktree(repoRoot, req.worktreePath, { requireClean: true });
        return { removed: true };
    } catch (e: any) {
        return { removed: false, error: e?.message || String(e) };
    }
}

/**
 * Publish a saga-prepared worktree into live mesh membership.
 *
 * Node shape mirrors clone_mesh_node's worktree clone exactly, because every
 * downstream consumer already keys off those fields:
 *   - `isLocalWorktree: true` + `worktreeBranch` are what
 *     resolveNodeCapabilityTags reads to SYNTHESIZE the `worktree=<branch>` and
 *     `converge=refine` tags (mesh-work-queue.ts). They are derived, never
 *     stored, so writing tags by hand here would duplicate/diverge.
 *   - `clonedFromNodeId` keeps the provenance link the dashboard renders.
 *   - daemonId / machineId / userOverrides / policy are inherited from the
 *     source node: the worktree lives on the source node's machine, so its
 *     scheduling identity must be the source's, exactly as for an operator clone.
 *
 * `bootstrapStatus` is the dispatch gate. Registration happens at CREATE time so
 * the node is visible immediately, but a saga that has not finalized is stamped
 * 'running', which the pre-existing worktree-bootstrap gate
 * (shouldDeferDispatchForBootstrap / launchBlockedReason='worktree_bootstrap_running')
 * already treats as "do not dispatch into a half-built worktree". Finalize
 * re-stamps 'complete'. This reuses the established guard rather than inventing
 * a second half-ready predicate.
 *
 * Best-effort by contract: a daemon with no router has no inline cache and a
 * mesh with no config twin makes addNode a no-op. The saga must not fail because
 * membership publication failed — the worktree itself is already correct — so
 * every failure is swallowed and reported false (the saga LOGS a false return;
 * it is never silent). A pure-inline mesh with a cold cache is NOT left
 * unpublished: the inline half hydrates a shell mesh and upserts into it (see
 * the COLD/COLD HYDRATE-ON-MISS branch below).
 */
async function registerWorkspaceNode(
    req: WorkspaceNodeRegistrationRequest,
    registry?: WorkspaceNodeRegistryDeps,
): Promise<boolean> {
    const mesh = getMesh(req.meshId);
    const cachedInline = (() => {
        try { return registry?.getCachedInlineMesh?.(req.meshId); } catch { return undefined; }
    })();
    const membershipSource = mesh ?? cachedInline;
    const sourceNode = (() => {
        const nodes = Array.isArray(membershipSource?.nodes) ? membershipSource.nodes : [];
        if (req.sourceNodeId) {
            const explicit = nodes.find((n: any) => n?.id === req.sourceNodeId);
            if (explicit) return explicit;
        }
        return nodes.find((n: any) => n?.isLocalWorktree !== true);
    })();

    const worktreeBootstrap = {
        status: req.bootstrapStatus,
        // The saga never runs the repo's worktree_bootstrap script (clone_mesh_node
        // owns that path), so nothing is REQUIRED to finish here. required:false
        // keeps a 'running' stamp from hard-blocking launch readiness while it
        // still defers queue claims, which is precisely the intended window.
        required: false,
        ...(req.bootstrapStatus === 'running'
            ? { startedAt: new Date().toISOString() }
            : { completedAt: new Date().toISOString() }),
    };

    const node: Record<string, unknown> = {
        id: req.nodeId,
        workspace: req.worktreePath,
        repoRoot: req.worktreePath,
        daemonId: sourceNode?.daemonId,
        machineId: sourceNode?.machineId ?? sourceNode?.machine_id,
        userOverrides: { ...(sourceNode?.userOverrides || {}) },
        policy: { ...(sourceNode?.policy || {}) },
        isLocalWorktree: true,
        worktreeBranch: req.branchIdentity,
        clonedFromNodeId: sourceNode?.id,
        worktreeBootstrap,
    };
    // Defensive parity with clone_mesh_node: a source policy still carrying the
    // removed legacy providerRoles has its cap folded into slots so the clone
    // never re-seeds providerRoles.
    try {
        const { migrateProviderRolesToSlots } = await import('../config/mesh-config.js');
        migrateProviderRolesToSlots(node.policy as Record<string, unknown>);
    } catch { /* migration helper unavailable (mocked mesh-config in tests) */ }

    let published = false;

    // Durable half (meshes.json). addNode refuses a duplicate workspace, which is
    // exactly what a re-registration looks like, so an existing entry is patched
    // through updateNode instead of being added twice.
    try {
        const { addNode, updateNode } = await import('../config/mesh-config.js');
        const already = Array.isArray(mesh?.nodes)
            ? mesh.nodes.find((n: any) => n?.id === req.nodeId || n?.workspace === req.worktreePath)
            : undefined;
        if (already) {
            updateNode(req.meshId, already.id, { worktreeBootstrap: worktreeBootstrap as any });
            published = true;
        } else if (mesh) {
            const added = addNode(req.meshId, {
                id: req.nodeId,
                workspace: req.worktreePath,
                repoRoot: req.worktreePath,
                daemonId: sourceNode?.daemonId,
                machineId: sourceNode?.machineId ?? sourceNode?.machine_id,
                userOverrides: { ...(sourceNode?.userOverrides || {}) },
                policy: node.policy as any,
                isLocalWorktree: true,
                worktreeBranch: req.branchIdentity,
                clonedFromNodeId: sourceNode?.id,
                worktreeBootstrap: worktreeBootstrap as any,
            });
            if (added) published = true;
        }
    } catch { /* no config twin / mocked mesh-config — inline half still applies */ }

    // Inline-cache half. get_mesh (preferInline) reads ONLY this when it is warm,
    // so without it the node stays invisible to mesh_list_nodes on a coordinator
    // that has a warmed cache — the exact failure this fix exists to close.
    try {
        if (cachedInline && registry?.updateInlineMeshNode) {
            registry.updateInlineMeshNode(req.meshId, cachedInline, node);
            published = true;
        } else if (!cachedInline && !mesh && registry?.updateInlineMeshNode) {
            // COLD/COLD HYDRATE-ON-MISS: pure-inline (cloud) mesh — no config twin
            // — whose inline cache was never warmed. Gating the inline write on
            // cache warmth made the publish decision depend on state the saga does
            // not control (whether some earlier read happened to warm the cache),
            // and the reconcile loop cannot close that window either: its
            // file→cache merge (mesh-reconcile-loop.ts PHASE 0.5) is itself gated
            // on a warm cache. So BOTH halves skipped and published:false was
            // swallowed, stranding a real on-disk worktree with no membership.
            // Hydrate a minimal shell and upsert through the same seam the
            // router's own hydrate-on-miss paths use
            // (markWorktreeBootstrapTerminalState / seedRemoteClonedWorktreeNode).
            // Deliberately NOT done when a config twin exists: warming a cold
            // cache for a file-backed mesh would flip its reads from always-fresh
            // 'local_config' to a snapshot (the exact regression PHASE 0.5's
            // warm-gate avoids), and the durable half above already published.
            const shell = { id: req.meshId, nodes: [] as any[], updatedAt: new Date().toISOString() };
            registry.updateInlineMeshNode(req.meshId, shell, node);
            published = true;
        }
    } catch { /* best-effort mirror */ }

    try { registry?.invalidateAggregateMeshStatus?.(req.meshId); } catch { /* best-effort */ }
    return published;
}

/**
 * Compensation mirror: drop the membership entry for a removed worktree.
 * Runs only after the safety classifier already allowed the delete, so there is
 * no session/assigned-task/dirty work to strand. Both halves are cleared for the
 * same reason both are written — a surviving inline-cache entry would resurrect
 * the node on the next read, and a surviving config entry would restore it on
 * daemon restart.
 */
async function unregisterWorkspaceNode(
    req: WorkspaceNodeUnregistrationRequest,
    registry?: WorkspaceNodeRegistryDeps,
): Promise<boolean> {
    let removed = false;
    try {
        const { removeNode } = await import('../config/mesh-config.js');
        if (removeNode(req.meshId, req.nodeId) === true) removed = true;
    } catch { /* no config twin / mocked mesh-config */ }
    try {
        const cached = registry?.getCachedInlineMesh?.(req.meshId);
        if (cached && registry?.removeInlineMeshNode) {
            if (registry.removeInlineMeshNode(req.meshId, cached, req.nodeId)) removed = true;
        }
    } catch { /* best-effort mirror */ }
    try { registry?.invalidateAggregateMeshStatus?.(req.meshId); } catch { /* best-effort */ }
    return removed;
}

function defaultListAssignedTasks(meshId: string, nodeId: string): string[] {
    try {
        const entries = MeshRuntimeStore.getInstance().getQueueEntries(meshId);
        return entries
            .filter(e => e.status === 'assigned' && (e.assignedNodeId === nodeId || e.targetNodeId === nodeId))
            .map(e => e.id);
    } catch {
        return [];
    }
}

/**
 * Deterministic node id for a prepared graph workspace.
 *
 * MUST stay collision-free across workspaces of the SAME graph: a batch that
 * declares N workspaces prepares N worktrees on N distinct branches
 * (deriveWorkspaceBranchIdentity), and each must register as its own node.
 *
 * The previous form sliced the whole idempotency key to 48 chars:
 *   `node_gws_` + `graph-ws-clone:<graphId>:<workspaceRef>`.slice(0, 48)
 * `graph_ws_clone_` (15) plus a UUID graphId (36) plus a separator already
 * spans 52 chars, so the cut landed mid-UUID and the workspaceRef never
 * reached the id at all. Every workspace of a graph collapsed onto one id,
 * addNode() deduped the rest as re-registrations, and the tasks pinned to the
 * dropped nodes stranded as `no_node_satisfies_required_tags`.
 *
 * The fix budgets the two components independently instead of truncating
 * their concatenation, so the workspace part can never be squeezed out. The
 * graph stem matches deriveWorkspaceBranchIdentity's 8-char stem, which keeps
 * the id readable next to the branch it belongs to.
 *
 * Back-compat: this changes the derived id for existing single-workspace
 * worktrees too, but not their identity in practice — a resumed intent
 * short-circuits on the persisted `createdNodeId` (mesh-graph-workspace-saga.ts
 * :347) and compensation unregisters that same stored id, so already-prepared
 * worktrees keep the id they registered under and are never re-derived. Only
 * newly prepared workspaces take the new form.
 */
export function derivePreparedNodeId(graphId: string, workspaceRef: string): string {
    const graphStem = sanitizeNodeIdPart(graphId).slice(0, 8);
    const refStem = sanitizeNodeIdPart(workspaceRef).slice(0, 32);
    // Full-key digest: keeps ids distinct when two long workspace refs share a
    // 32-char prefix, which the stems alone would collapse.
    const digest = createHash('sha256')
        .update(deriveWorkspaceCloneIdempotencyKey(graphId, workspaceRef))
        .digest('hex')
        .slice(0, 8);
    return `node_gws_${graphStem}_${refStem}_${digest}`;
}

function sanitizeNodeIdPart(value: string): string {
    return value.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'ws';
}
