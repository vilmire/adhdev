/** Host-created read evidence. Never a source write grant or a replacement for ownershipScope. */
import { execFileSync } from 'node:child_process';
import { gitChildEnv } from '../git/git-locale.js';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { PhysicalOwnershipScope } from '@adhdev/mesh-shared';
import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';
import { attestLocalOwnership, currentPhysicalScope } from './mesh-physical-ownership.js';
import type { MeshRuntimeStore } from './mesh-runtime-store.js';
import { decodeStageDiffManifest, validateStageDiffManifest } from './stage-diff-manifest.js';
import { decodeStageSourceGenerated, readStageSourceGenerated } from './stage-source-generated-provider.js';
import { stageDiffSources } from './stage-diff-stream.js';

export interface StageReviewInput {
    version: 1; parentTaskId: string; childTaskId: string; round: number; headSha: string;
    submodules: string;
    /** Empty declaration: fences the checkout/build resources, grants no writable source paths. */
    checkout: PhysicalOwnershipScope;
    artifacts: Array<{ id: string; file: string; sha256: string; size: number }>;
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['--no-replace-objects', '-C', cwd, '-c', 'core.fsmonitor=false', ...args], {
    windowsHide: true, env: gitChildEnv(), encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
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

/** Descriptor-bounded retained-byte check. No symlink (including ancestors), hardlink, or growth accepted. */
export function readStageReviewArtifact(a: StageReviewInput['artifacts'][number]): Buffer {
    if (!Number.isSafeInteger(a.size) || a.size < 0 || a.size > 4 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(a.sha256)) throw new Error('review_input_artifact_size');
    const resolved = path.resolve(a.file);
    if (resolved !== a.file || realpathSync.native(resolved) !== resolved) throw new Error('review_input_artifact_path');
    let cursor = path.parse(resolved).root;
    for (const segment of resolved.slice(cursor.length).split(path.sep)) {
        cursor = path.join(cursor, segment);
        if (lstatSync(cursor).isSymbolicLink()) throw new Error('review_input_artifact_symlink');
    }
    const before = lstatSync(resolved);
    const fd = openSync(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const st = fstatSync(fd);
        if (!st.isFile() || st.nlink !== 1 || st.dev !== before.dev || st.ino !== before.ino || st.size !== a.size) throw new Error('review_input_artifact_changed');
        const b = Buffer.alloc(a.size + 1);
        let bytes = 0;
        while (bytes < b.length) {
            const n = readSync(fd, b, bytes, b.length - bytes, null);
            if (!n) break;
            bytes += n;
        }
        const after = lstatSync(resolved), end = fstatSync(fd);
        if (bytes !== a.size || end.size !== a.size || after.dev !== st.dev || after.ino !== st.ino
            || end.mtimeMs !== st.mtimeMs || end.ctimeMs !== st.ctimeMs || realpathSync.native(resolved) !== resolved
            || createHash('sha256').update(b.subarray(0, bytes)).digest('hex') !== a.sha256) throw new Error('review_input_artifact_hash');
        return b.subarray(0, bytes);
    } finally { closeSync(fd); }
}

function hashMatches(a: StageReviewInput['artifacts'][number]): boolean {
    try { readStageReviewArtifact(a); return true; } catch { return false; }
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
        try {
            const grant = stageReviewArtifactGrant(store, parent, id);
            const raw = readStageReviewArtifact(grant);
            const sourceGenerated = decodeStageSourceGenerated(raw);
            const bundle = sourceGenerated ?? decodeStageDiffManifest(raw);
            const expanded = [grant];
            if (bundle) {
                const row = artifactRow(store, id);
                if (bundle.scope.meshId !== parent.meshId || bundle.scope.taskId !== parent.id || bundle.scope.parentTaskId !== parent.id
                    || bundle.scope.missionId !== parent.missionId || (row?.mission_id ?? undefined) !== bundle.scope.missionId
                    || row?.producer_role !== 'pipeline' || row.session_id !== `stage:${parent.id}`
                    // eslint-disable-next-line no-restricted-syntax -- canon-ok: match the exact origin stamp in the hashed manifest to its stored registration.
                    || row.origin_daemon_id !== bundle.scope.originDaemonId || row.task_id !== parent.id) throw new Error('review_input_artifact_unauthorized_manifest'); // canon-ok: exact manifest origin stamp.
                const resolve = (c: import('./stage-diff-manifest.js').StageDiffChunk) => {
                    if (c.id === id) throw new Error('review_diff_recursive_manifest');
                    const chunkRow = artifactRow(store, c.id);
                    if (!chunkRow || chunkRow.mesh_id !== parent.meshId || chunkRow.task_id !== parent.id
                        || chunkRow.session_id !== row.session_id || chunkRow.producer_role !== 'pipeline'
                        || chunkRow.mission_id !== row.mission_id
                        || chunkRow.origin_daemon_id !== row.origin_daemon_id || chunkRow.workspace_root !== row.workspace_root) throw new Error('review_input_artifact_unauthorized_chunk');
                    const chunk = stageReviewArtifactGrant(store, parent, c.id);
                    if (chunk.size !== c.bytes || chunk.sha256 !== c.sha256) throw new Error('review_diff_chunk_metadata');
                    expanded.push(chunk);
                    return readStageReviewArtifact(chunk);
                };
                if ('sourceChunks' in bundle) readStageSourceGenerated(bundle, resolve);
                else validateStageDiffManifest(bundle, bundle.scope, resolve);
            }
            for (const item of expanded) if (!grants.some(g => g.id === item.id)) grants.push(item);
        }
        catch (e: any) {
            const msg = String(e?.message || e);
            if (!optional.has(id) || artifactRow(store, id)?.producer_role === 'pipeline' || msg.startsWith('review_input_artifact_unauthorized')) throw e;
            withheld.push(id);
        }
    }
    if (!grants.length) throw new Error('review_input_artifacts_missing');
    return { grants, withheld };
}

function artifactRow(store: Pick<MeshRuntimeStore, 'db'>, id: string) {
    return store.db.prepare('SELECT * FROM session_artifacts WHERE artifact_id = ?').get(id) as {
        mesh_id: string; task_id: string; session_id: string; producer_role: string;
        workspace_root: string; rel_path: string; sha256: string; size_bytes: number; origin_daemon_id: string; mission_id?: string | null;
    } | undefined;
}

function stageReviewArtifactGrant(store: Pick<MeshRuntimeStore, 'db'>, parent: MeshWorkQueueEntry, id: string): StageReviewInput['artifacts'][number] {
    const row = artifactRow(store, id);
    if (!row || row.mesh_id !== parent.meshId || !row.session_id
        || (row.task_id !== parent.id && !parent.inputArtifactIds?.includes(id))
        || (row.task_id === parent.id && !['worker', 'pipeline'].includes(row.producer_role))) throw new Error(`review_input_artifact_unauthorized: ${id}`);
    const root = realpathSync.native(row.workspace_root);
    const file = path.resolve(root, row.rel_path);
    if (root !== row.workspace_root || path.isAbsolute(row.rel_path) || row.rel_path.split(/[\\/]/).includes('..')) throw new Error(`review_input_artifact_path: ${id}`);
    const relative = path.relative(root, file);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`review_input_artifact_path: ${id}`);
    const grant = { id, file, sha256: row.sha256, size: row.size_bytes };
    if (!hashMatches(grant)) throw new Error(`review_input_artifact_hash: ${id}`);
    return grant;
}

export function attestStageReviewInput(parent: MeshWorkQueueEntry, input: {
    repoIdentity: string; machineId: string; nodeId: string; workspace: string;
}, artifacts: StageReviewInput['artifacts']): StageReviewInput {
    const proof = attestStageReviewCheckoutForRecovery(parent, input, artifacts);
    validateCurrentDiff(parent, artifacts, proof.checkout.worktree);
    return proof;
}

/** Recovery preflight ONLY. Its historical artifacts cannot authorize a child until final input attestation. */
export function attestStageReviewCheckoutForRecovery(parent: MeshWorkQueueEntry, input: {
    repoIdentity: string; machineId: string; nodeId: string; workspace: string;
}, artifacts: StageReviewInput['artifacts']): StageReviewInput {
    const state = parent.stageState!;
    const headSha = state.stageHeads.at(-1)?.rootSha ?? '';
    const checkout = attestLocalOwnership({ ...input, phase: 'source', paths: { paths: [] } });
    const submodules = checkoutState(checkout.worktree, headSha, checkout);
    return { version: 1, parentTaskId: parent.id, childTaskId: '', round: state.round, headSha, submodules, checkout, artifacts };
}

export function validateCurrentDiff(parent: MeshWorkQueueEntry, artifacts: StageReviewInput['artifacts'], workspace?: string): void {
    const latest = parent.stageState?.artifacts.diff.at(-1);
    const grant = artifacts.find(a => a.id === latest);
    if (!grant) {
        if (latest) throw new Error('review_diff_latest_missing');
        return;
    }
    const raw = readStageReviewArtifact(grant);
    const manifest = decodeStageSourceGenerated(raw) ?? decodeStageDiffManifest(raw);
    if (!manifest) return;
    if (manifest.scope.round !== parent.stageState!.round || manifest.scope.baseSha !== parent.stageState!.baseSha || manifest.scope.headSha !== parent.stageState!.stageHeads.at(-1)?.rootSha
        || manifest.scope.meshId !== parent.meshId || manifest.scope.taskId !== parent.id || manifest.scope.parentTaskId !== parent.id
        || manifest.scope.missionId !== parent.missionId) throw new Error('review_diff_parent_drift');
    if (workspace) {
        if ('sourceChunks' in manifest && git(workspace, 'rev-parse', '--abbrev-ref', 'HEAD') !== 'HEAD') {
            throw new Error('review_detached_checkout_required');
        }
        const current = stageDiffSources(workspace, manifest.scope.baseSha, manifest.scope.headSha, {} as never);
        if ((!('sourceChunks' in manifest) && JSON.stringify(current.checkout) !== JSON.stringify(manifest.scope.checkout))
            || JSON.stringify(current.gitlinks) !== JSON.stringify(manifest.scope.gitlinks)) throw new Error('review_diff_checkout_drift');
    }
    const resolve = (c: import('./stage-diff-manifest.js').StageDiffChunk) => {
        const chunk = artifacts.find(a => a.id === c.id);
        if (!chunk) throw new Error('review_diff_chunk_missing');
        if (chunk.size !== c.bytes || chunk.sha256 !== c.sha256) throw new Error('review_diff_chunk_metadata');
        return readStageReviewArtifact(chunk);
    };
    if ('sourceChunks' in manifest) readStageSourceGenerated(manifest, resolve);
    else validateStageDiffManifest(manifest, manifest.scope, resolve);
}

/** Actual claim/verdict DB gate, independent of persisted file grants or a manifest's assertions. */
export function validateStageReviewRetainedGrants(store: Pick<MeshRuntimeStore, 'db'>, parent: MeshWorkQueueEntry, ids: string[]): void {
    const grants = stageReviewArtifactGrants(store, parent, ids);
    validateCurrentDiff(parent, grants);
    const latest = grants.find(a => a.id === parent.stageState?.artifacts.diff.at(-1));
    if (latest && decodeStageSourceGenerated(readStageReviewArtifact(latest))
        && (!parent.stageReviewInput || parent.stageReviewInput.round !== parent.stageState?.round
            || JSON.stringify(ids) !== JSON.stringify(grants.map(a => a.id)))) throw new Error('review_diff_registered_grant_changed');
    if (parent.stageReviewInput && parent.stageReviewInput.round === parent.stageState?.round
        && JSON.stringify(grants) !== JSON.stringify(parent.stageReviewInput.artifacts)) throw new Error('review_diff_registered_grant_changed');
}

/** Artifact reads re-enter the same verifier for source/generated review grants. */
export function validateStageSourceGeneratedRead(store: Pick<MeshRuntimeStore, 'db'>, parent: MeshWorkQueueEntry,
    child: MeshWorkQueueEntry): PhysicalOwnershipScope | undefined {
    const id = parent.stageState?.artifacts.diff.at(-1);
    if (!id) return;
    const grant = stageReviewArtifactGrant(store, parent, id);
    if (!decodeStageSourceGenerated(readStageReviewArtifact(grant))) return;
    validateStageReviewRetainedGrants(store, parent, child.inputArtifactIds ?? []);
    const scope = currentStageReviewScope(parent, child);
    if (!scope) throw new Error('review_input_unavailable');
    return scope;
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
        const latest = proof.artifacts.find(a => a.id === state.artifacts.diff.at(-1));
        if (latest && decodeStageSourceGenerated(readStageReviewArtifact(latest))) {
            if (child.meshId !== parent.meshId || child.missionId !== parent.missionId || child.review?.sourceTaskId !== parent.id
                || state.reviewTaskIds.filter(id => id === child.id).length !== 1
                || child.reviewerWorkspace?.path !== proof.checkout.worktree
                || child.reviewerWorkspace.headSha !== proof.headSha) return undefined;
        }
        const current = currentPhysicalScope(proof.checkout, { paths: [] });
        if (!current || checkoutState(current.worktree, proof.headSha, current) !== proof.submodules || !proof.artifacts.length || !proof.artifacts.every(hashMatches)) return undefined;
        validateCurrentDiff(parent, proof.artifacts, current.worktree);
        return current;
    } catch { return undefined; }
}
