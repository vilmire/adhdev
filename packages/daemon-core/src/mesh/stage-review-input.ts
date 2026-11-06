/** Host-created read evidence. Never a source write grant or a replacement for ownershipScope. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { PhysicalOwnershipScope } from '@adhdev/mesh-shared';
import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';
import { attestLocalOwnership, currentPhysicalScope } from './mesh-physical-ownership.js';
import type { MeshRuntimeStore } from './mesh-runtime-store.js';

export interface StageReviewInput {
    version: 1; parentTaskId: string; childTaskId: string; round: number; headSha: string;
    submodules: string;
    /** Empty declaration: fences the checkout/build resources, grants no writable source paths. */
    checkout: PhysicalOwnershipScope;
    artifacts: Array<{ id: string; file: string; sha256: string; size: number }>;
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'core.fsmonitor=false', ...args], {
    windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

function checkoutState(workspace: string, headSha: string, scope: PhysicalOwnershipScope): string {
    if (!headSha || git(workspace, 'rev-parse', 'HEAD') !== headSha) throw new Error('review_input_head_changed');
    if (git(workspace, 'status', '--porcelain=v1', '--untracked-files=no', '--ignore-submodules=none')) throw new Error('review_input_dirty');
    const submodules: string[] = [];
    const seen = new Set<string>([workspace]);
    const visit = (cwd: string): void => {
        if (git(cwd, 'ls-files', '-v', '-z').split('\0').some(entry => /^[a-zS]/.test(entry))) throw new Error('review_input_hidden_changes');
        for (const entry of git(cwd, 'ls-files', '--stage', '-z').split('\0')) {
            const link = /^160000 ([a-f0-9]+) 0\t(.+)$/s.exec(entry);
            if (!link) continue;
            const dir = realpathSync.native(path.resolve(cwd, link[2]));
            if (seen.has(dir) || seen.size >= 128) throw new Error('review_input_submodule_limit');
            seen.add(dir);
            const relative = path.relative(workspace, dir);
            if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
                || realpathSync.native(git(dir, 'rev-parse', '--show-toplevel')) !== dir
                || git(dir, 'rev-parse', 'HEAD') !== link[1]) throw new Error('review_input_submodule_changed');
            const common = realpathSync.native(path.resolve(dir, git(dir, 'rev-parse', '--git-common-dir')));
            // Read leases fence nested checkouts/stores too, without declaring them writable.
            for (const resource of [dir, ...['refs', 'objects', 'config'].map(name => path.join(common, name))]) {
                const resolved = realpathSync.native(resource);
                const st = statSync(resolved);
                const identity = `${st.dev}:${st.ino}`;
                scope.resources.push({ path: resolved, identity, subtree: st.isDirectory() });
                submodules.push(`${resolved} ${identity}`);
            }
            submodules.push(`${dir} ${link[1]}`);
            visit(dir);
        }
    };
    visit(workspace);
    return JSON.stringify(submodules);
}

function hashMatches(a: StageReviewInput['artifacts'][number]): boolean {
    try {
        if (a.size < 0 || a.size > 4 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(a.sha256)) return false;
        if (realpathSync.native(a.file) !== a.file || !statSync(a.file).isFile() || statSync(a.file).size !== a.size) return false;
        return createHash('sha256').update(readFileSync(a.file)).digest('hex') === a.sha256;
    } catch { return false; }
}

/** Named parent evidence only; unrelated same-mission artifacts never become grants. */
export function stageReviewArtifactGrants(store: Pick<MeshRuntimeStore, 'db'>, parent: MeshWorkQueueEntry, ids: string[]): StageReviewInput['artifacts'] {
    return stageReviewArtifactGrantsWithheld(store, parent, ids).grants;
}

/**
 * Like {@link stageReviewArtifactGrants}, but an artifact in `optional` (one the implementer only cited)
 * that is gone, moved or changed since it was registered is withheld instead of failing the whole review:
 * the reviewer still gets the pipeline's own diff/self-check/verdict evidence and reads the code itself.
 * Unauthorized ids and every required artifact still fail closed.
 */
export function stageReviewArtifactGrantsWithheld(
    store: Pick<MeshRuntimeStore, 'db'>, parent: MeshWorkQueueEntry, ids: string[], optional: ReadonlySet<string> = new Set(),
): { grants: StageReviewInput['artifacts']; withheld: string[] } {
    if (!ids.length) throw new Error('review_input_artifacts_missing');
    const grants: StageReviewInput['artifacts'] = [];
    const withheld: string[] = [];
    for (const id of new Set(ids)) {
        try { grants.push(stageReviewArtifactGrant(store, parent, id)); }
        catch (e: any) {
            const msg = String(e?.message || e);
            if (!optional.has(id) || msg.startsWith('review_input_artifact_unauthorized')) throw e;
            withheld.push(id);
        }
    }
    if (!grants.length) throw new Error('review_input_artifacts_missing');
    return { grants, withheld };
}

function stageReviewArtifactGrant(store: Pick<MeshRuntimeStore, 'db'>, parent: MeshWorkQueueEntry, id: string): StageReviewInput['artifacts'][number] {
    const row = store.db.prepare('SELECT * FROM session_artifacts WHERE artifact_id = ?').get(id) as {
        mesh_id: string; task_id: string; session_id: string; producer_role: string;
        workspace_root: string; rel_path: string; sha256: string; size_bytes: number;
    } | undefined;
    if (!row || row.mesh_id !== parent.meshId || !row.session_id
        || (row.task_id !== parent.id && !parent.inputArtifactIds?.includes(id))
        || (row.task_id === parent.id && !['worker', 'pipeline'].includes(row.producer_role))) throw new Error(`review_input_artifact_unauthorized: ${id}`);
    const root = realpathSync.native(row.workspace_root);
    const file = realpathSync.native(path.resolve(root, row.rel_path));
    const relative = path.relative(root, file);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`review_input_artifact_path: ${id}`);
    const grant = { id, file, sha256: row.sha256, size: row.size_bytes };
    if (!hashMatches(grant)) throw new Error(`review_input_artifact_hash: ${id}`);
    return grant;
}

export function attestStageReviewInput(parent: MeshWorkQueueEntry, input: {
    repoIdentity: string; machineId: string; nodeId: string; workspace: string;
}, artifacts: StageReviewInput['artifacts']): StageReviewInput {
    const state = parent.stageState!;
    const headSha = state.stageHeads.at(-1)?.rootSha ?? '';
    const checkout = attestLocalOwnership({ ...input, phase: 'source', paths: { paths: [] } });
    const submodules = checkoutState(checkout.worktree, headSha, checkout);
    return { version: 1, parentTaskId: parent.id, childTaskId: '', round: state.round, headSha, submodules, checkout, artifacts };
}

/** Rechecked at actual claim using authenticated cwd/machine, not a path in the task's prose. */
export function currentStageReviewScope(parent: MeshWorkQueueEntry, child: Partial<MeshWorkQueueEntry>): PhysicalOwnershipScope | undefined {
    try {
        const proof = parent.stageReviewInput;
        const state = parent.stageState;
        if (!proof || proof.version !== 1 || !state || proof.parentTaskId !== parent.id || proof.childTaskId !== child.id
            || child.origin !== 'stage' || child.parentTaskId !== parent.id || child.stageRole !== 'review'
            || child.stageRound !== state.round || proof.round !== state.round || !state.reviewTaskIds.includes(child.id!)
            || state.stageHeads.at(-1)?.rootSha !== proof.headSha
            || JSON.stringify(child.inputArtifactIds ?? []) !== JSON.stringify(proof.artifacts.map(a => a.id))) return undefined;
        const current = currentPhysicalScope(proof.checkout, { paths: [] });
        if (!current || checkoutState(current.worktree, proof.headSha, current) !== proof.submodules || !proof.artifacts.length || !proof.artifacts.every(hashMatches)) return undefined;
        return current;
    } catch { return undefined; }
}
