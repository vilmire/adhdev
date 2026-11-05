/**
 * Physical ownership attestation. Each machine attests only its own disk; a scope from
 * another machine is that machine's answer (see isForeignPhysicalScope). Missing
 * physical proof never establishes writer isolation.
 */
import { execFileSync } from 'node:child_process';
import { getMachineId } from '../config/config.js';
import { lstatSync, realpathSync, statSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { findOwnershipConflicts, type OwnedPathsDeclaration, type PhysicalOwnershipScope, type MeshTaskPhase } from '@adhdev/mesh-shared';

function identity(p: string): string | undefined {
    try { const s = statSync(p); return `${s.dev}:${s.ino}`; } catch { return undefined; }
}
function inside(root: string, p: string): boolean {
    const relative = path.relative(root, p);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
/** Resolve a new file using its nearest existing ancestor, without following a dangling alias. */
function canonical(p: string): string {
    try { lstatSync(p); return realpathSync.native(p); } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
        // A dangling symlink is not a new file.
        try { if (lstatSync(p).isSymbolicLink()) throw new Error('ownership_symlink_escape: dangling alias'); } catch (err: any) { if (err.code !== 'ENOENT') throw err; }
        const parent = path.dirname(p);
        if (parent === p) throw e;
        return path.join(canonical(parent), path.basename(p));
    }
}
const sourceForbidden = (p: string) => p === '' || p === 'oss' || /(^|\/)(\.git|vendor|dist|node_modules)(\/|$)/.test(p);

function gitText(cwd: string, args: readonly string[]): string | undefined {
    try {
        return execFileSync('git', ['-C', cwd, ...args], { windowsHide: true, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch { return undefined; }
}

function nearestExistingDir(target: string): string {
    let cursor = target;
    for (;;) {
        try {
            const st = lstatSync(cursor);
            if (st.isSymbolicLink()) {
                const resolved = realpathSync.native(cursor);
                return statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
            }
            return st.isDirectory() ? realpathSync.native(cursor) : path.dirname(cursor);
        } catch (e: any) {
            if (e.code !== 'ENOENT') throw e;
            const parent = path.dirname(cursor);
            if (parent === cursor) return cursor;
            cursor = parent;
        }
    }
}

function pushResource(resources: PhysicalOwnershipScope['resources'], item: PhysicalOwnershipScope['resources'][number]): void {
    if (resources.some(existing => existing.path === item.path)) return;
    resources.push(item);
}

/** A declared path that enters a nested git checkout fences that checkout's common store. The root common dir stays out of `resources`. */
function recordNestedGitStores(worktree: string, declaredPath: string, resources: PhysicalOwnershipScope['resources']): void {
    const resolved = canonical(path.resolve(worktree, declaredPath));
    const dir = nearestExistingDir(resolved);
    const topRaw = gitText(dir, ['rev-parse', '--show-toplevel']);
    if (!topRaw) return;
    let top: string;
    try { top = realpathSync.native(topRaw); } catch { return; }
    if (top === worktree) return;
    const commonRaw = gitText(top, ['rev-parse', '--git-common-dir']);
    if (!commonRaw) return;
    const common = realpathSync.native(path.resolve(top, commonRaw));
    for (const [name, subtree] of [['refs', true], ['objects', true], ['config', false]] as const) {
        const resourcePath = canonical(path.join(common, name));
        pushResource(resources, { path: resourcePath, identity: identity(resourcePath), subtree });
    }
}

export function attestLocalOwnership(input: {
    repoIdentity: string; machineId: string; nodeId: string; workspace: string;
    phase: MeshTaskPhase; paths: OwnedPathsDeclaration;
}): PhysicalOwnershipScope {
    if (!input.repoIdentity || !input.machineId || !input.nodeId || !path.isAbsolute(input.workspace)) throw new Error('ownership_context_unproven');
    const worktree = realpathSync.native(input.workspace);
    const git = (...args: string[]) => execFileSync('git', ['-C', worktree, 'rev-parse', ...args], { windowsHide: true, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (realpathSync.native(git('--show-toplevel')) !== worktree) throw new Error('ownership_worktree_root_required');
    const gitDir = realpathSync.native(git('--absolute-git-dir'));
    const commonGitDir = realpathSync.native(path.resolve(worktree, git('--git-common-dir')));
    const gitResources = {
        index: canonical(path.resolve(worktree, git('--git-path', 'index'))),
        refs: canonical(path.join(commonGitDir, 'refs')),
        hooks: canonical(path.resolve(worktree, git('--git-path', 'hooks'))),
        config: canonical(path.join(commonGitDir, 'config')),
    };
    const resources: PhysicalOwnershipScope['resources'] = [];
    const seenDirectories = new Set<string>();
    const inspectSubtree = (directory: string): void => {
        let entries: import('node:fs').Dirent[];
        try { entries = readdirSync(directory, { withFileTypes: true }); } catch (e: any) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return; throw e; }
        if (seenDirectories.has(directory)) return;
        seenDirectories.add(directory);
        for (const entry of entries) {
            const child = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) {
                const resolved = canonical(child);
                if (!inside(worktree, resolved) || (input.phase === 'source' && sourceForbidden(path.relative(worktree, resolved).split(path.sep).join('/')))) throw new Error(`ownership_symlink_escape: ${child}`);
                const directoryTarget = statSync(resolved).isDirectory();
                resources.push({ path: resolved, identity: identity(resolved), subtree: directoryTarget });
                if (directoryTarget) inspectSubtree(resolved);
            } else if (entry.isDirectory()) inspectSubtree(child);
            else if (statSync(child).nlink > 1) resources.push({ path: child, identity: identity(child), subtree: false });
        }
    };
    for (const entry of input.paths.paths) {
        if (input.phase === 'source' && sourceForbidden(entry.path)) throw new Error(`source_phase_path_forbidden: ${entry.path}`);
        const resolved = canonical(path.resolve(worktree, entry.path));
        if (!inside(worktree, resolved) || (input.phase === 'source' && sourceForbidden(path.relative(worktree, resolved).split(path.sep).join('/')))) throw new Error(`ownership_symlink_escape: ${entry.path}`);
        if (entry.subtree) inspectSubtree(resolved);
        resources.push({ path: resolved, identity: identity(resolved), subtree: entry.subtree });
        recordNestedGitStores(worktree, entry.path, resources);
    }
    // Build links may leave the worktree. Record the resolved inode so admission
    // can fence a shared store. A failed attest must not leave the row unscoped.
    const buildPaths = ['node_modules', 'oss/node_modules'];
    for (const base of ['packages', 'oss/packages']) {
        try { for (const name of readdirSync(path.join(worktree, base))) {
            buildPaths.push(`${base}/${name}/dist`, `${base}/${name}/node_modules`);
            for (const modules of ['node_modules', 'oss/node_modules']) {
                const link = `${modules}/@adhdev/${name}`;
                try { lstatSync(path.join(worktree, link)); buildPaths.push(link); } catch { /* optional workspace link */ }
            }
        } } catch { /* no packages in a small repository */ }
    }
    for (const relative of buildPaths) {
        let resolved: string;
        try { resolved = canonical(path.join(worktree, relative)); } catch { continue; }
        const resolvedIdentity = identity(resolved);
        if (!resolvedIdentity) continue;
        pushResource(resources, { path: resolved, identity: resolvedIdentity, subtree: true });
    }
    return { version: 1, repoIdentity: input.repoIdentity, machineId: input.machineId, nodeId: input.nodeId,
        worktree, worktreeIdentity: identity(worktree)!, gitDir, commonGitDir, gitResources, phase: input.phase, resources, declaration: input.paths.paths };
}

/** Re-attest on admission: changing a symlink/worktree after revision never weakens H1. */
/**
 * A scope attested by another machine. This machine cannot see that disk, so it cannot
 * re-check the scope; the attesting machine answered for its own checkout and is the
 * only one that can. Unknown local identity is never "foreign" (fails closed).
 */
export function isForeignPhysicalScope(scope: Pick<PhysicalOwnershipScope, 'machineId'> | undefined, localMachineId: string | undefined = getMachineId()): boolean {
    return !!scope && !!localMachineId && typeof scope.machineId === 'string' && !!scope.machineId && scope.machineId !== localMachineId;
}

export function currentPhysicalScope(scope: PhysicalOwnershipScope | undefined, paths: OwnedPathsDeclaration): PhysicalOwnershipScope | undefined {
    if (!scope || scope.version !== 1 || JSON.stringify(paths.paths) !== JSON.stringify(scope.declaration)) return undefined;
    if (isForeignPhysicalScope(scope)) return scope;
    try {
        const current = attestLocalOwnership({ ...scope, workspace: scope.worktree, paths });
        return current.worktreeIdentity === scope.worktreeIdentity && current.gitDir === scope.gitDir && current.commonGitDir === scope.commonGitDir ? current : undefined;
    } catch { return undefined; }
}

const PLANNING_SCOPE_TTL_MS = 30_000;
const PLANNING_SCOPE_MAX_ENTRIES = 64;
const planningScopes = new Map<string, { at: number; scope: PhysicalOwnershipScope | undefined }>();

/**
 * For deciding whether a launch is worth attempting, never for admitting work: each attestation
 * spawns several git processes on the daemon's event loop, and the queue tick asks for every
 * pending task (profiled live, 2026-11-05: 47% of JS time, stalls up to 2.6 s). A stale answer
 * only delays a launch or wastes one, because the claim itself re-attests with currentPhysicalScope.
 */
export function plannedPhysicalScope(scope: PhysicalOwnershipScope | undefined, paths: OwnedPathsDeclaration, now = Date.now()): PhysicalOwnershipScope | undefined {
    const key = JSON.stringify([scope, paths.paths]);
    const known = planningScopes.get(key);
    if (known && now - known.at < PLANNING_SCOPE_TTL_MS) return known.scope;
    const current = currentPhysicalScope(scope, paths);
    planningScopes.delete(key);
    if (planningScopes.size >= PLANNING_SCOPE_MAX_ENTRIES) planningScopes.delete(planningScopes.keys().next().value!);
    planningScopes.set(key, { at: now, scope: current });
    return current;
}

export type PhysicalOverlapExplanation =
    | { kind: 'missing_scope'; side: 'a' | 'b' }
    | { kind: 'worktree'; path: string }
    | { kind: 'resource'; path: string }
    | { kind: 'integration_repo' }
    | { kind: 'none' };

function resourcesOverlap(x: PhysicalOwnershipScope['resources'][number], y: PhysicalOwnershipScope['resources'][number]): boolean {
    return x.path === y.path || (!!x.identity && x.identity === y.identity) || (x.subtree && inside(x.path, y.path)) || (y.subtree && inside(y.path, x.path));
}

/** First concrete reason comparePhysicalOwnership uses. The two must not drift. */
export function explainPhysicalOverlap(a: OwnedPathsDeclaration, aScope: PhysicalOwnershipScope | undefined, b: OwnedPathsDeclaration, bScope: PhysicalOwnershipScope | undefined): PhysicalOverlapExplanation {
    void a; void b;
    if (!aScope) return { kind: 'missing_scope', side: 'a' };
    if (!bScope) return { kind: 'missing_scope', side: 'b' };
    if (aScope.repoIdentity === bScope.repoIdentity && (aScope.phase === 'integration' || bScope.phase === 'integration')) return { kind: 'integration_repo' };
    if (aScope.machineId !== bScope.machineId) return { kind: 'none' };
    if ((aScope.phase === 'integration' || bScope.phase === 'integration')
        && (aScope.commonGitDir === bScope.commonGitDir || Object.values(aScope.gitResources).some(p => Object.values(bScope.gitResources).includes(p)))) return { kind: 'integration_repo' };
    if (aScope.worktree === bScope.worktree || aScope.worktreeIdentity === bScope.worktreeIdentity || aScope.gitDir === bScope.gitDir) return { kind: 'worktree', path: aScope.worktree };
    for (const x of aScope.resources) for (const y of bScope.resources) {
        if (resourcesOverlap(x, y)) return { kind: 'resource', path: x.path === y.path || (x.subtree && inside(x.path, y.path)) ? y.path : x.path };
    }
    return { kind: 'none' };
}

export function comparePhysicalOwnership(a: OwnedPathsDeclaration, aScope: PhysicalOwnershipScope | undefined, b: OwnedPathsDeclaration, bScope: PhysicalOwnershipScope | undefined): { physicalConflict: boolean; logicalOverlap: boolean } {
    const logicalOverlap = findOwnershipConflicts(a, [{ taskId: 'other', paths: b }]).length > 0;
    // Legacy/unknown writers may touch the same workspace, build outputs or common
    // Git resources regardless of their logical declarations. Only two current
    // attestations can prove independence; absence must never bypass a fence.
    return { physicalConflict: explainPhysicalOverlap(a, aScope, b, bScope).kind !== 'none', logicalOverlap };
}
