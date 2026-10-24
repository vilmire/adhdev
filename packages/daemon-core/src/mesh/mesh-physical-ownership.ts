/** Host-local attestation only. Missing physical proof never establishes writer isolation. */
import { execFileSync } from 'node:child_process';
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

export function attestLocalOwnership(input: {
    repoIdentity: string; machineId: string; nodeId: string; workspace: string;
    phase: MeshTaskPhase; paths: OwnedPathsDeclaration;
}): PhysicalOwnershipScope {
    if (!input.repoIdentity || !input.machineId || !input.nodeId || !path.isAbsolute(input.workspace)) throw new Error('ownership_context_unproven');
    const worktree = realpathSync.native(input.workspace);
    const git = (...args: string[]) => execFileSync('git', ['-C', worktree, 'rev-parse', ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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
    }
    // Scoped tests/builds share package outputs and workspace links. Refuse external
    // aliases rather than asserting that a second pathname proves isolation.
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
        const resolved = canonical(path.join(worktree, relative));
        if (!inside(worktree, resolved)) throw new Error(`ownership_build_resource_escape: ${relative}`);
        resources.push({ path: resolved, identity: identity(resolved), subtree: true });
    }
    return { version: 1, repoIdentity: input.repoIdentity, machineId: input.machineId, nodeId: input.nodeId,
        worktree, worktreeIdentity: identity(worktree)!, gitDir, commonGitDir, gitResources, phase: input.phase, resources, declaration: input.paths.paths };
}

/** Re-attest on admission: changing a symlink/worktree after revision never weakens H1. */
export function currentPhysicalScope(scope: PhysicalOwnershipScope | undefined, paths: OwnedPathsDeclaration): PhysicalOwnershipScope | undefined {
    if (!scope || scope.version !== 1 || JSON.stringify(paths.paths) !== JSON.stringify(scope.declaration)) return undefined;
    try {
        const current = attestLocalOwnership({ ...scope, workspace: scope.worktree, paths });
        return current.worktreeIdentity === scope.worktreeIdentity && current.gitDir === scope.gitDir && current.commonGitDir === scope.commonGitDir ? current : undefined;
    } catch { return undefined; }
}

export function comparePhysicalOwnership(a: OwnedPathsDeclaration, aScope: PhysicalOwnershipScope | undefined, b: OwnedPathsDeclaration, bScope: PhysicalOwnershipScope | undefined): { physicalConflict: boolean; logicalOverlap: boolean } {
    const logicalOverlap = findOwnershipConflicts(a, [{ taskId: 'other', paths: b }]).length > 0;
    // Legacy/unknown writers may touch the same workspace, build outputs or common
    // Git resources regardless of their logical declarations. Only two current
    // attestations can prove independence; absence must never bypass a fence.
    if (!aScope || !bScope) return { physicalConflict: true, logicalOverlap };
    if (aScope.repoIdentity === bScope.repoIdentity && (aScope.phase === 'integration' || bScope.phase === 'integration')) return { physicalConflict: true, logicalOverlap };
    if (aScope.machineId !== bScope.machineId) return { physicalConflict: false, logicalOverlap };
    if ((aScope.phase === 'integration' || bScope.phase === 'integration')
        && (aScope.commonGitDir === bScope.commonGitDir || Object.values(aScope.gitResources).some(p => Object.values(bScope.gitResources).includes(p)))) return { physicalConflict: true, logicalOverlap };
    if (aScope.worktree === bScope.worktree || aScope.worktreeIdentity === bScope.worktreeIdentity || aScope.gitDir === bScope.gitDir) return { physicalConflict: true, logicalOverlap };
    const physicalConflict = aScope.resources.some(x => bScope.resources.some(y =>
        x.path === y.path || (!!x.identity && x.identity === y.identity) || (x.subtree && inside(x.path, y.path)) || (y.subtree && inside(y.path, x.path))));
    return { physicalConflict, logicalOverlap };
}
