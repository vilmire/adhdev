/**
 * Read-only Git-aware Repo Mesh onboarding discovery and planning.
 *
 * This is the single implementation used by daemon commands, MCP, CLI and the
 * dashboard. It deliberately performs only filesystem reads and local Git
 * queries: no fetch, config write, mesh mutation, branch creation or worktree
 * creation occurs here.
 */
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import { gitChildEnv } from '../git/git-locale.js';
import type { CLIInfo } from '../detection/cli-detector.js';
import type { LocalMeshEntry, LocalMeshNodeEntry } from '../repo-mesh-types.js';
import { mergeAndNormalizePolicy } from '../repo-mesh-types.js';
import {
    listMeshesReadOnly,
    normalizeRepoIdentity,
} from '../config/mesh-config.js';
import { runMeshInit, type RunMeshInitResult } from './mesh-init.js';
import { listWorktrees, type WorktreeEntry } from '../git/git-worktree.js';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 15_000;

export type MeshOnboardingOperation = 'auto' | 'add_existing' | 'clone_worktree' | 'create_mesh';
export type MeshOnboardingErrorCode =
    | 'not_git_repository'
    | 'remote_not_found'
    | 'remote_not_selected'
    | 'no_commits_for_local_identity'
    | 'ambiguous_remotes'
    | 'detached_head'
    | 'unsafe_branch'
    | 'nested_worktree'
    | 'conflicted_workspace'
    | 'dirty_workspace'
    | 'mesh_not_found'
    | 'ambiguous_mesh'
    | 'unrelated_repo_identity'
    | 'duplicate_workspace'
    | 'duplicate_node';

export interface MeshOnboardingRemote {
    name: string;
    urls: string[];
    identities: string[];
}

export interface MeshOnboardingDiscovery {
    inputPath: string;
    workspace: string;
    repoRoot: string;
    gitDir: string;
    commonDir: string;
    mainWorktreeRoot: string;
    isMainCheckout: boolean;
    isLinkedWorktree: boolean;
    isNestedWorktree: boolean;
    worktrees: WorktreeEntry[];
    currentBranch: string;
    defaultBranch: string;
    headCommit: string;
    remotes: MeshOnboardingRemote[];
    origin?: MeshOnboardingRemote;
    upstream?: MeshOnboardingRemote;
    selectedRemote: string;
    repoIdentity: string;
    dirty: boolean;
    changedFileCount: number;
    hasConflicts: boolean;
    conflictFiles: string[];
}

export interface MeshMembershipMatch {
    meshId: string;
    meshName: string;
    repoIdentity: string;
    compatible: boolean;
    nodeId?: string;
    nodeWorkspace?: string;
    exactWorkspace?: boolean;
}

export interface MeshOnboardingPlanStep {
    command: 'create_mesh' | 'add_mesh_node' | 'clone_mesh_node' | 'mesh_init';
    description: string;
    writes: boolean;
    approvalRequired: boolean;
    args: Record<string, unknown>;
}

export interface MeshOnboardingPlanSuccess {
    success: true;
    dryRun: true;
    discovery: MeshOnboardingDiscovery;
    membership: MeshMembershipMatch[];
    compatibleMesh?: {
        id: string;
        name: string;
        repoIdentity: string;
        defaultBranch?: string;
        nodeCount: number;
    };
    plan: {
        kind: 'create_mesh_and_onboard' | 'add_existing_workspace' | 'clone_new_worktree';
        summary: string;
        requiresClean: boolean;
        approvalRequired: true;
        steps: MeshOnboardingPlanStep[];
        alternatives: Array<{
            kind: 'add_existing_workspace' | 'clone_new_worktree';
            summary: string;
            requiresClean: boolean;
        }>;
    };
    suggestedConfig: RunMeshInitResult;
    note: string;
    /**
     * Non-blocking advisories the operator should see before approving. Present only
     * when something is worth saying — e.g. a clone planned from a workspace with
     * uncommitted changes, which is allowed but does NOT carry those changes into the
     * new worktree. Callers should surface these; they are not failures.
     */
    warnings?: string[];
}

export interface MeshOnboardingPlanFailure {
    success: false;
    dryRun: true;
    code: MeshOnboardingErrorCode;
    error: string;
    action: string;
    discovery?: Partial<MeshOnboardingDiscovery>;
    membership?: MeshMembershipMatch[];
}

export type MeshOnboardingPlanResult = MeshOnboardingPlanSuccess | MeshOnboardingPlanFailure;

export interface PlanMeshOnboardingOptions {
    workspace: string;
    meshId?: string;
    operation?: MeshOnboardingOperation;
    branch?: string;
    detectedProviders?: CLIInfo[];
    /** Test/integration injection. Production uses the read-only local snapshot. */
    meshes?: LocalMeshEntry[];
}

async function git(cwd: string, args: string[], allowFailure = false): Promise<string> {
    try {
        const { stdout } = await execFileAsync('git', args, {
            cwd,
            encoding: 'utf8',
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: 4 * 1024 * 1024,
            windowsHide: true,
            env: gitChildEnv(),
        });
        return (stdout || '').trim();
    } catch (error: any) {
        if (allowFailure) return '';
        const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
        throw new Error(stderr || error?.message || `git ${args[0]} failed`);
    }
}

async function canonicalPath(path: string): Promise<string> {
    const absolute = resolve(path);
    try {
        return await realpath(absolute);
    } catch {
        return absolute;
    }
}

function pathInside(child: string, parent: string): boolean {
    const rel = relative(parent, child);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel);
}

function failure(
    code: MeshOnboardingErrorCode,
    error: string,
    action: string,
    extra: Pick<MeshOnboardingPlanFailure, 'discovery' | 'membership'> = {},
): MeshOnboardingPlanFailure {
    return { success: false, dryRun: true, code, error, action, ...extra };
}

function isPlanFailure(
    value: MeshOnboardingDiscovery | MeshOnboardingPlanFailure,
): value is MeshOnboardingPlanFailure {
    return (value as MeshOnboardingPlanFailure).success === false;
}

function parseStatus(raw: string): {
    dirty: boolean;
    changedFileCount: number;
    hasConflicts: boolean;
    conflictFiles: string[];
} {
    const lines = raw.split(/\r?\n/).filter(line => line && !line.startsWith('# '));
    const conflictFiles: string[] = [];
    for (const line of lines) {
        if (line.startsWith('u ')) {
            const fields = line.split(' ');
            conflictFiles.push(fields.slice(10).join(' ') || fields.at(-1) || '(unknown)');
            continue;
        }
        if (line.startsWith('1 ') || line.startsWith('2 ')) {
            const xy = line.slice(2, 4);
            if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(xy)) {
                conflictFiles.push(line.split(' ').at(-1) || '(unknown)');
            }
        }
    }
    return {
        dirty: lines.length > 0,
        changedFileCount: lines.length,
        hasConflicts: conflictFiles.length > 0,
        conflictFiles,
    };
}

async function discoverRemotes(repoRoot: string, currentBranch: string): Promise<{
    remotes: MeshOnboardingRemote[];
    origin?: MeshOnboardingRemote;
    upstream?: MeshOnboardingRemote;
    selectedRemote?: MeshOnboardingRemote;
    ambiguous: boolean;
}> {
    const names = (await git(repoRoot, ['remote'], true)).split(/\r?\n/).map(v => v.trim()).filter(Boolean);
    const remotes: MeshOnboardingRemote[] = [];
    for (const name of names) {
        const urls = (await git(repoRoot, ['remote', 'get-url', '--all', name], true))
            .split(/\r?\n/)
            .map(v => v.trim())
            .filter(Boolean);
        const identities = [...new Set(urls.map(normalizeRepoIdentity).filter(Boolean))];
        remotes.push({ name, urls, identities });
    }
    const origin = remotes.find(remote => remote.name === 'origin');
    const trackingRemoteName = await git(repoRoot, ['config', '--get', `branch.${currentBranch}.remote`], true);
    const upstream = remotes.find(remote => remote.name === trackingRemoteName)
        || remotes.find(remote => remote.name === 'upstream');
    const identities = [...new Set(remotes.flatMap(remote => remote.identities))];
    const selectedRemote = origin || upstream || (remotes.length === 1 ? remotes[0] : undefined);
    return {
        remotes,
        origin,
        upstream,
        selectedRemote,
        ambiguous: identities.length > 1 || !!remotes.find(remote => remote.identities.length > 1),
    };
}

/**
 * Derive a stable identity for a repository that has no usable remote.
 *
 * A remote URL is only a convenience for inferring identity; a repository whose
 * history exists locally is already uniquely identified by its root commit. The
 * `local/` prefix keeps the value inside the `host/path` shape that
 * `normalizeRepoIdentity` round-trips unchanged, and cannot collide with a real
 * hostname.
 *
 * Repositories built by merging unrelated histories have several root commits,
 * and `git rev-list` does not order them stably across branches or checkout
 * order, so the roots are sorted and the lexicographically first one is taken.
 *
 * Returns '' when the repository has no commits: there is nothing stable to
 * derive from yet, and silently falling back to a path or UUID would change the
 * identity once the first commit lands, orphaning the mesh.
 */
async function deriveLocalRepoIdentity(repoRoot: string): Promise<string> {
    const raw = await git(repoRoot, ['rev-list', '--max-parents=0', 'HEAD'], true);
    const roots = raw
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => /^[0-9a-f]{40}$/i.test(line))
        .sort();
    const root = roots[0];
    return root ? `local/${root.toLowerCase()}` : '';
}

async function resolveDefaultBranch(repoRoot: string, remoteName: string, currentBranch: string): Promise<string> {
    const symbolic = await git(repoRoot, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remoteName}/HEAD`], true);
    if (symbolic.startsWith(`${remoteName}/`)) return symbolic.slice(remoteName.length + 1);
    for (const candidate of ['main', 'master']) {
        const exists = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remoteName}/${candidate}`], true)
            || await git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`], true);
        if (exists) return candidate;
    }
    return currentBranch;
}

async function discoverGit(workspaceInput: string): Promise<MeshOnboardingDiscovery | MeshOnboardingPlanFailure> {
    const workspace = await canonicalPath(workspaceInput || process.cwd());
    const repoRootRaw = await git(workspace, ['rev-parse', '--show-toplevel'], true);
    if (!repoRootRaw) {
        return failure(
            'not_git_repository',
            `Not a Git repository: ${workspace}`,
            'Choose a directory inside a Git checkout, or initialize/clone the repository before planning Repo Mesh onboarding.',
        );
    }
    const repoRoot = await canonicalPath(repoRootRaw);
    const gitDirRaw = await git(repoRoot, ['rev-parse', '--git-dir']);
    const commonDirRaw = await git(repoRoot, ['rev-parse', '--git-common-dir']);
    const gitDir = await canonicalPath(isAbsolute(gitDirRaw) ? gitDirRaw : resolve(repoRoot, gitDirRaw));
    const commonDir = await canonicalPath(isAbsolute(commonDirRaw) ? commonDirRaw : resolve(repoRoot, commonDirRaw));
    const currentBranch = await git(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true);
    const headCommit = await git(repoRoot, ['rev-parse', 'HEAD'], true);
    const worktrees = await listWorktrees(repoRoot);
    const canonicalWorktrees = await Promise.all(worktrees.map(async entry => ({
        ...entry,
        path: await canonicalPath(entry.path),
    })));
    const mainWorktreeRoot = canonicalWorktrees[0]?.path || repoRoot;
    const isMainCheckout = repoRoot === mainWorktreeRoot;
    const isLinkedWorktree = gitDir !== commonDir;

    // A checkout rooted below another Git checkout/worktree is easy to mistake
    // for the outer project. Refuse it until the operator chooses the intended root.
    const parentRepoRootRaw = await git(dirname(repoRoot), ['rev-parse', '--show-toplevel'], true);
    const parentRepoRoot = parentRepoRootRaw ? await canonicalPath(parentRepoRootRaw) : '';
    const isNestedWorktree = !!parentRepoRoot && parentRepoRoot !== repoRoot && pathInside(repoRoot, parentRepoRoot);

    const status = parseStatus(await git(repoRoot, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal']));
    const partial: Partial<MeshOnboardingDiscovery> = {
        inputPath: workspaceInput,
        workspace,
        repoRoot,
        gitDir,
        commonDir,
        mainWorktreeRoot,
        isMainCheckout,
        isLinkedWorktree,
        isNestedWorktree,
        worktrees: canonicalWorktrees,
        currentBranch,
        headCommit,
        ...status,
    };
    if (!currentBranch) {
        return failure(
            'detached_head',
            `Detached HEAD at ${headCommit.slice(0, 12) || '(unknown commit)'}.`,
            'Check out a named, safe branch before adding or cloning a Repo Mesh node.',
            { discovery: partial },
        );
    }
    const branchValid = await git(repoRoot, ['check-ref-format', '--branch', currentBranch], true);
    if (!branchValid) {
        return failure(
            'unsafe_branch',
            `Current branch is not a safe Git branch name: ${currentBranch}`,
            'Check out or create a valid named branch, then re-run the onboarding plan.',
            { discovery: partial },
        );
    }
    if (isNestedWorktree) {
        return failure(
            'nested_worktree',
            `Repository ${repoRoot} is nested inside Git checkout ${parentRepoRoot}.`,
            'Choose the intended outer checkout or move the nested checkout outside it before Repo Mesh onboarding.',
            { discovery: partial },
        );
    }
    if (status.hasConflicts) {
        return failure(
            'conflicted_workspace',
            `Workspace has unresolved conflicts (${status.conflictFiles.join(', ')}).`,
            'Resolve or abort the in-progress Git operation before adding this workspace to Repo Mesh.',
            { discovery: partial },
        );
    }

    const remoteDiscovery = await discoverRemotes(repoRoot, currentBranch);

    // A repository with no remote at all is still a complete mesh participant:
    // identity falls back to the local root commit. Remotes that exist but do
    // not yield a canonical choice are a different, operator-resolvable problem
    // and must not be reported as "no remote is configured".
    if (!remoteDiscovery.remotes.length) {
        const localIdentity = await deriveLocalRepoIdentity(repoRoot);
        if (!localIdentity) {
            return failure(
                'no_commits_for_local_identity',
                'This repository has no remote and no commits, so a stable repository identity cannot be derived.',
                'Create at least one commit (the root commit becomes the local identity), or pass an explicit repo identity when creating the mesh.',
                { discovery: partial },
            );
        }
        const localDefaultBranch = await resolveDefaultBranch(repoRoot, '', currentBranch);
        return {
            ...partial,
            remotes: [],
            origin: undefined,
            upstream: undefined,
            selectedRemote: '',
            repoIdentity: localIdentity,
            defaultBranch: localDefaultBranch,
        } as MeshOnboardingDiscovery;
    }
    if (!remoteDiscovery.selectedRemote) {
        const detail = remoteDiscovery.remotes.map(remote => remote.name).join(', ');
        return failure(
            'remote_not_selected',
            `No canonical remote could be selected among multiple remotes (${detail}).`,
            'Name one of them origin or upstream, set the current branch to track one of them, or pass an explicit repo identity when creating the mesh.',
            { discovery: { ...partial, remotes: remoteDiscovery.remotes, origin: remoteDiscovery.origin, upstream: remoteDiscovery.upstream } },
        );
    }
    if (remoteDiscovery.ambiguous) {
        const detail = remoteDiscovery.remotes
            .map(remote => `${remote.name}=${remote.identities.join('|') || '(no URL)'}`)
            .join(', ');
        return failure(
            'ambiguous_remotes',
            `Multiple unrelated remote identities were found: ${detail}`,
            'Remove the ambiguity or explicitly choose/reconcile the canonical remote before onboarding.',
            { discovery: { ...partial, remotes: remoteDiscovery.remotes, origin: remoteDiscovery.origin, upstream: remoteDiscovery.upstream } },
        );
    }
    const repoIdentity = remoteDiscovery.selectedRemote.identities[0];
    if (!repoIdentity) {
        return failure(
            'remote_not_found',
            `Remote '${remoteDiscovery.selectedRemote.name}' has no usable URL.`,
            'Configure a valid fetch URL for the selected remote before onboarding.',
            { discovery: partial },
        );
    }
    const defaultBranch = await resolveDefaultBranch(repoRoot, remoteDiscovery.selectedRemote.name, currentBranch);
    return {
        ...partial,
        remotes: remoteDiscovery.remotes,
        origin: remoteDiscovery.origin,
        upstream: remoteDiscovery.upstream,
        selectedRemote: remoteDiscovery.selectedRemote.name,
        repoIdentity,
        defaultBranch,
    } as MeshOnboardingDiscovery;
}

async function membershipsFor(
    discovery: MeshOnboardingDiscovery,
    meshes: LocalMeshEntry[],
): Promise<MeshMembershipMatch[]> {
    const matches: MeshMembershipMatch[] = [];
    for (const mesh of meshes) {
        const compatible = normalizeRepoIdentity(mesh.repoIdentity) === discovery.repoIdentity;
        let emittedMesh = false;
        for (const node of mesh.nodes || []) {
            const rawWorkspace = resolve(node.workspace || '');
            const canonicalWorkspace = await canonicalPath(rawWorkspace);
            const canonicalRepoRoot = node.repoRoot ? await canonicalPath(node.repoRoot) : canonicalWorkspace;
            const exactWorkspace = canonicalWorkspace === discovery.workspace;
            if (exactWorkspace || canonicalRepoRoot === discovery.repoRoot) {
                matches.push({
                    meshId: mesh.id,
                    meshName: mesh.name,
                    repoIdentity: normalizeRepoIdentity(mesh.repoIdentity),
                    compatible,
                    nodeId: node.id,
                    nodeWorkspace: node.workspace,
                    exactWorkspace,
                });
                emittedMesh = true;
            }
        }
        if (compatible && !emittedMesh) {
            matches.push({
                meshId: mesh.id,
                meshName: mesh.name,
                repoIdentity: normalizeRepoIdentity(mesh.repoIdentity),
                compatible: true,
            });
        }
    }
    return matches;
}

function meshSummary(mesh: LocalMeshEntry) {
    return {
        id: mesh.id,
        name: mesh.name,
        repoIdentity: normalizeRepoIdentity(mesh.repoIdentity),
        defaultBranch: mesh.defaultBranch,
        nodeCount: mesh.nodes?.length || 0,
    };
}

function addStep(mesh: LocalMeshEntry, discovery: MeshOnboardingDiscovery): MeshOnboardingPlanStep {
    return {
        command: 'add_mesh_node',
        description: 'Explicitly register this existing checkout as a mesh node.',
        writes: true,
        approvalRequired: true,
        args: {
            meshId: mesh.id,
            workspace: discovery.repoRoot,
            repoRoot: discovery.repoRoot,
            isLocalWorktree: discovery.isLinkedWorktree,
        },
    };
}

function initStep(discovery: MeshOnboardingDiscovery): MeshOnboardingPlanStep {
    return {
        command: 'mesh_init',
        description: 'Preview suggested .adhdev configuration; persist only in a separate approved write call.',
        writes: false,
        approvalRequired: false,
        args: { workspace: discovery.repoRoot, write: false, overwrite: false },
    };
}

export async function planMeshOnboarding(options: PlanMeshOnboardingOptions): Promise<MeshOnboardingPlanResult> {
    const discoveryResult = await discoverGit(options.workspace);
    if (isPlanFailure(discoveryResult)) return discoveryResult;
    const discovery = discoveryResult;
    const operation = options.operation || 'auto';
    const meshes = options.meshes || listMeshesReadOnly();
    const membership = await membershipsFor(discovery, meshes);

    const requestedMesh = options.meshId ? meshes.find(mesh => mesh.id === options.meshId) : undefined;
    if (options.meshId && !requestedMesh) {
        return failure('mesh_not_found', `Mesh not found: ${options.meshId}`, 'List meshes and choose an existing mesh id.', { discovery, membership });
    }
    if (requestedMesh && normalizeRepoIdentity(requestedMesh.repoIdentity) !== discovery.repoIdentity) {
        return failure(
            'unrelated_repo_identity',
            `Workspace identity '${discovery.repoIdentity}' does not match mesh '${requestedMesh.name}' identity '${normalizeRepoIdentity(requestedMesh.repoIdentity)}'.`,
            'Choose a mesh for the same repository, or create a separate mesh for this repository.',
            { discovery, membership },
        );
    }

    const compatibleMeshes = requestedMesh
        ? [requestedMesh]
        : meshes.filter(mesh => normalizeRepoIdentity(mesh.repoIdentity) === discovery.repoIdentity);
    if (compatibleMeshes.length > 1) {
        return failure(
            'ambiguous_mesh',
            `More than one compatible mesh exists for '${discovery.repoIdentity}': ${compatibleMeshes.map(mesh => `${mesh.name} (${mesh.id})`).join(', ')}`,
            'Pass an explicit mesh id to select the intended mesh.',
            { discovery, membership },
        );
    }
    const compatibleMesh = compatibleMeshes[0];
    const duplicate = membership.find(match => match.compatible && match.nodeId && (!compatibleMesh || match.meshId === compatibleMesh.id));

    if (operation !== 'clone_worktree' && duplicate) {
        return failure(
            duplicate.exactWorkspace ? 'duplicate_workspace' : 'duplicate_node',
            `Workspace is already registered as node '${duplicate.nodeId}' in mesh '${duplicate.meshName}'.`,
            'Use the existing node, or choose clone_worktree with a new branch for isolated work.',
            { discovery, membership },
        );
    }

    if (operation === 'add_existing' && !compatibleMesh) {
        return failure(
            'mesh_not_found',
            `No compatible mesh exists for '${discovery.repoIdentity}'.`,
            'Run the auto/create onboarding plan first, explicitly create the mesh, then add this workspace.',
            { discovery, membership },
        );
    }

    if (operation === 'clone_worktree') {
        // Advisories accumulated while planning; surfaced on the successful plan so the
        // operator approves with full knowledge rather than being blocked outright.
        const planWarnings: string[] = [];
        if (!compatibleMesh) {
            return failure(
                'mesh_not_found',
                `No compatible mesh exists for '${discovery.repoIdentity}'.`,
                'Create and add the base workspace first, then plan a cloned worktree node.',
                { discovery, membership },
            );
        }
        // DIRTY SOURCE: advisory by default, blocking only when the mesh says so.
        //
        // `git worktree add` creates the new tree from HEAD, so uncommitted changes in
        // the source workspace are simply absent from the clone — that is the defined
        // behavior of a worktree, not a fault. Hard-failing here made worktrees
        // unusable in the normal case, because a coordinator's own checkout is dirty
        // most of the time it is working; the whole parallel-worktree workflow (clone
        // N branches → work → converge) died on this preflight rather than on anything
        // being wrong.
        //
        // The mesh already has `dirtyWorkspaceBehavior` (default 'warn') expressing the
        // operator's intent, and this path simply never read it. Honor it: 'block'
        // still refuses; 'warn' / 'checkpoint_then_continue' proceed with an advisory.
        //
        // Genuinely dangerous states are NOT relaxed here and are handled elsewhere:
        // unresolved conflicts hard-fail earlier in discoverWorkspace
        // ('conflicted_workspace'), before this point is ever reached.
        // Normalize against the shipped defaults so an unset/invalid value resolves to
        // the documented default ('warn') rather than being read as a block.
        const dirtyBehavior = mergeAndNormalizePolicy(compatibleMesh.policy, undefined).dirtyWorkspaceBehavior;
        if (discovery.dirty && dirtyBehavior === 'block') {
            return failure(
                'dirty_workspace',
                `Workspace has ${discovery.changedFileCount} uncommitted change(s); a cloned worktree would not include them.`,
                'Commit or stash the changes, then re-run the clone plan. '
                    + "(This mesh's dirtyWorkspaceBehavior is 'block'; set it to 'warn' to allow cloning from a dirty workspace.)",
                { discovery, membership },
            );
        }
        if (discovery.dirty) {
            planWarnings.push(
                `Source workspace has ${discovery.changedFileCount} uncommitted change(s). `
                + 'The new worktree is created from HEAD, so uncommitted changes are NOT included in it — '
                + 'commit them first if the cloned branch needs them.',
            );
        }
        const branch = (options.branch || '').trim();
        if (!branch || !(await git(discovery.repoRoot, ['check-ref-format', '--branch', branch], true))) {
            return failure(
                'unsafe_branch',
                branch ? `Requested worktree branch is unsafe: ${branch}` : 'A named branch is required to clone a new worktree node.',
                'Provide a new valid branch name such as feat/my-task.',
                { discovery, membership },
            );
        }
        const sourceNode = duplicate?.nodeId
            ? compatibleMesh.nodes.find(node => node.id === duplicate.nodeId)
            : compatibleMesh.nodes.find((node: LocalMeshNodeEntry) => !!node.workspace);
        if (!sourceNode) {
            return failure(
                'mesh_not_found',
                `Mesh '${compatibleMesh.name}' has no source node to clone.`,
                'Explicitly add this existing workspace as the first node, then clone a worktree.',
                { discovery, membership },
            );
        }
        const suggestedConfig = runMeshInit(compatibleMesh, discovery.repoRoot, options.detectedProviders || []);
        return {
            success: true,
            dryRun: true,
            discovery,
            membership,
            compatibleMesh: meshSummary(compatibleMesh),
            plan: {
                kind: 'clone_new_worktree',
                summary: `Create an isolated worktree node from '${sourceNode.id}' on branch '${branch}'.`,
                // Only a 'block' mesh actually requires a clean source; under the
                // default 'warn' a dirty workspace is advisory, so reporting true here
                // would misdescribe the plan the caller is approving.
                requiresClean: dirtyBehavior === 'block',
                approvalRequired: true,
                steps: [{
                    command: 'clone_mesh_node',
                    description: 'Explicitly create the branch/worktree and register the resulting node.',
                    writes: true,
                    approvalRequired: true,
                    args: {
                        meshId: compatibleMesh.id,
                        sourceNodeId: sourceNode.id,
                        branch,
                        baseBranch: compatibleMesh.defaultBranch || discovery.defaultBranch,
                    },
                }, initStep(discovery)],
                alternatives: [{ kind: 'add_existing_workspace', summary: 'Register the supplied checkout without creating a worktree.', requiresClean: false }],
            },
            suggestedConfig,
            note: 'Read-only plan only. No mesh, config, branch, remote or worktree state was changed.',
            ...(planWarnings.length ? { warnings: planWarnings } : {}),
        };
    }

    const suggestedConfig = runMeshInit(compatibleMesh || {}, discovery.repoRoot, options.detectedProviders || []);
    if (compatibleMesh && operation !== 'create_mesh') {
        return {
            success: true,
            dryRun: true,
            discovery,
            membership,
            compatibleMesh: meshSummary(compatibleMesh),
            plan: {
                kind: 'add_existing_workspace',
                summary: discovery.isLinkedWorktree
                    ? `Register the existing linked worktree on '${discovery.currentBranch}' in '${compatibleMesh.name}'.`
                    : `Register the main checkout as a base node in '${compatibleMesh.name}'.`,
                requiresClean: false,
                approvalRequired: true,
                steps: [addStep(compatibleMesh, discovery), initStep(discovery)],
                alternatives: [{
                    kind: 'clone_new_worktree',
                    summary: `After a base node exists, create a clean isolated worktree from '${compatibleMesh.defaultBranch || discovery.defaultBranch}'.`,
                    requiresClean: true,
                }],
            },
            suggestedConfig,
            note: 'Read-only plan only. Adding the node and writing suggested configs require separate explicit approved calls.',
        };
    }

    const identityRepoName = discovery.repoIdentity.split('/').filter(Boolean).at(-1);
    const suggestedName = `${identityRepoName || basename(discovery.mainWorktreeRoot || discovery.repoRoot)}-mesh`;
    const createArgs = {
        name: suggestedName,
        repoIdentity: discovery.repoIdentity,
        repoRemoteUrl: discovery.origin?.urls[0] || discovery.upstream?.urls[0] || discovery.remotes[0]?.urls[0],
        defaultBranch: discovery.defaultBranch,
    };
    return {
        success: true,
        dryRun: true,
        discovery,
        membership,
        plan: {
            kind: 'create_mesh_and_onboard',
            summary: `Create '${suggestedName}', add this ${discovery.isLinkedWorktree ? 'linked worktree' : 'checkout'} as its first node, then review suggested .adhdev configs.`,
            requiresClean: false,
            approvalRequired: true,
            steps: [
                {
                    command: 'create_mesh',
                    description: 'Explicitly create a machine-local mesh record.',
                    writes: true,
                    approvalRequired: true,
                    args: createArgs,
                },
                {
                    command: 'add_mesh_node',
                    description: 'After creation, explicitly register this existing workspace as the first node.',
                    writes: true,
                    approvalRequired: true,
                    args: {
                        meshId: '<created mesh id>',
                        workspace: discovery.repoRoot,
                        repoRoot: discovery.repoRoot,
                        isLocalWorktree: discovery.isLinkedWorktree,
                    },
                },
                initStep(discovery),
            ],
            alternatives: [],
        },
        suggestedConfig,
        note: 'Read-only plan only. No mesh/config/worktree writes occurred; execute each write step separately after approval.',
    };
}
