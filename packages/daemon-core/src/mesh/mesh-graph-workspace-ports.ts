/**
 * GRAPH-ORCHESTRATION Phase D — injectable ports for the workspace saga.
 *
 * Git/filesystem work lives HERE, never inside a SQLite transaction
 * (design :329-330, :993). Tests inject fakes; production uses the git-backed
 * defaults. Clone is a host-side side effect, not an agent task (design :987).
 */

import { execFile } from 'node:child_process';
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
}

export interface DefaultWorkspaceSagaPortOptions {
    /**
     * When true (default), createWorktree only creates the git worktree + owner
     * stamp. Node registration in meshes.json is the clone_mesh_node command's
     * job; D records the intended node id and binds it. Tests never flip this
     * unless they also mock mesh-config.
     */
    registerNode?: boolean;
}

export function createDefaultWorkspaceSagaPorts(opts: DefaultWorkspaceSagaPortOptions = {}): WorkspaceSagaPorts {
    void opts.registerNode;
    return {
        nowMs: () => Date.now(),
        resolveBaseRevision: req => defaultResolveBaseRevision(req),
        createWorktree: req => defaultCreateWorktree(req),
        findOwnedWorktree: req => defaultFindOwnedWorktree(req),
        inspectWorktree: req => defaultInspectWorktree(req),
        removeWorktree: req => defaultRemoveWorktree(req),
        listLiveSessionsOnNode: async () => ({ sessionIds: [], unknown: true, error: 'session_host_not_wired_to_workspace_saga' }),
        listAssignedTasksOnNode: async (meshId, nodeId) => defaultListAssignedTasks(meshId, nodeId),
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

export function derivePreparedNodeId(graphId: string, workspaceRef: string): string {
    const key = deriveWorkspaceCloneIdempotencyKey(graphId, workspaceRef);
    return `node_gws_${key.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 48)}`;
}
