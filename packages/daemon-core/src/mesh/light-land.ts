/**
 * LIGHT-TASK landing core (design §11), independent of the refine router so it is testable with real git.
 *
 *  - validateLightLandRequest: which results may land, which need explicit acceptance;
 *  - prepareLightLandBatch: a fresh land workspace on the CURRENT base, then each result's commits
 *    cherry-picked in the given order (submodule first, then root, gitlink-only conflicts resolved to
 *    the land submodule HEAD); stops at the first real conflict;
 *  - applyLightResultsToCheckout: `git apply --3way` of the stored patches into the caller's checkout.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Database as DatabaseHandle } from 'better-sqlite3';
import { touchedFilesOutsideOwnership, type LightLandRequest } from '@adhdev/mesh-shared';
import type { LightWorkspaceConfig } from './light-workspace-config.js';
import { lightGit, lightGitOk } from './light-git.js';
import { lightArtifactDir } from './light-task-result.js';
import { prepareLightWorkspace, removeLightWorkspace, resolveLightBaseSha, type LightWorkspaceHandle } from './light-workspace.js';
import { getLightWorkspace, setLightWorkspaceState, type LightWorkspaceRow } from './mesh-light-workspace-store.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';

export type LightLandRefusal =
    | { code: 'light_task_not_found' | 'light_not_landable' | 'light_paths_outside_owned' | 'light_workspace_missing'; taskId: string; detail?: string };

export interface LightLandCandidate { task: MeshWorkQueueEntry; ws: LightWorkspaceRow }

/** Resolve rows + registry for the request; returns the first refusal otherwise the ordered candidates. */
export function validateLightLandRequest(
    db: DatabaseHandle, req: Pick<LightLandRequest, 'taskIds' | 'acceptPathsOutsideOwned'>, findTask: (id: string) => MeshWorkQueueEntry | null,
): { ok: true; candidates: LightLandCandidate[] } | { ok: false; refusal: LightLandRefusal } {
    const candidates: LightLandCandidate[] = [];
    for (const taskId of req.taskIds) {
        const task = findTask(taskId);
        if (!task?.light) return { ok: false, refusal: { code: 'light_task_not_found', taskId } };
        const r = task.lightResult;
        if (!r) return { ok: false, refusal: { code: 'light_not_landable', taskId, detail: 'no captured result yet (the worker has not reported, or capture failed)' } };
        if (r.landing !== 'ready') return { ok: false, refusal: { code: 'light_not_landable', taskId, detail: `landing state is '${r.landing}'${r.blockedReason ? ` (${r.blockedReason})` : ''}` } };
        if (r.ownedPathsMismatch?.length && !req.acceptPathsOutsideOwned) {
            return { ok: false, refusal: { code: 'light_paths_outside_owned', taskId, detail: r.ownedPathsMismatch.join(', ') } };
        }
        const ws = task.lightWorkspaceId ? getLightWorkspace(db, task.lightWorkspaceId) : undefined;
        if (!ws) return { ok: false, refusal: { code: 'light_workspace_missing', taskId } };
        candidates.push({ task, ws });
    }
    return { ok: true, candidates };
}

export interface LightLandPrepared {
    handle: LightWorkspaceHandle;
    branch: string;
    baseSha: string;
    /** task ids whose commits are in the land branch, in order */
    landed: string[];
    /** first task that conflicted (the batch stops there) */
    conflict?: { taskId: string; where: string; paths: string[] };
}

function identityEnv(prefix: 'AUTHOR' | 'COMMITTER', info: string): Record<string, string> {
    const [name, email, date] = info.split('\u0001');
    return name ? { [`GIT_${prefix}_NAME`]: name, [`GIT_${prefix}_EMAIL`]: email ?? '', ...(date ? { [`GIT_${prefix}_DATE`]: date } : {}) } : {};
}

async function cherryPickRange(cwd: string, range: string, gitlinkPaths: readonly string[]): Promise<{ ok: true } | { ok: false; paths: string[] }> {
    const shas = (await lightGit(cwd, ['rev-list', '--reverse', '--no-merges', range])).stdout.split('\n').filter(Boolean);
    for (const sha of shas) {
        const info = (await lightGit(cwd, ['log', '-1', '--format=%cn%x01%ce%x01%cd', '--date=iso-strict', sha])).stdout.trim();
        const env = identityEnv('COMMITTER', info);
        const r = await lightGit(cwd, ['cherry-pick', '--allow-empty', '--keep-redundant-commits', sha], { env });
        if (r.code === 0) continue;
        const unmerged = (await lightGit(cwd, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
        if (unmerged.length && unmerged.every(p => gitlinkPaths.includes(p))) {
            // Only submodule pointers disagree: the land submodule HEAD is authoritative (finalized below).
            for (const p of unmerged) await lightGit(cwd, ['add', p]);
            const cont = await lightGit(cwd, ['-c', 'core.editor=true', 'cherry-pick', '--continue'], { env });
            if (cont.code === 0) continue;
        }
        await lightGit(cwd, ['cherry-pick', '--abort']);
        return { ok: false, paths: unmerged.length ? unmerged : [`cherry-pick ${sha.slice(0, 8)} failed: ${r.stderr.trim().slice(0, 200)}`] };
    }
    return { ok: true };
}

export async function prepareLightLandBatch(input: {
    db: DatabaseHandle; meshId: string; batchId: string; checkoutRoot: string; config: LightWorkspaceConfig; candidates: LightLandCandidate[];
}): Promise<LightLandPrepared> {
    const base = await resolveLightBaseSha(input.checkoutRoot);
    const key = input.batchId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
    const branch = `mesh/land/${key}`;
    const handle = await prepareLightWorkspace({
        meshId: input.meshId, taskId: `land${key}`, checkoutRoot: input.checkoutRoot, config: input.config, rootBaseSha: base.sha, branch, db: input.db,
    });
    const subs = Object.keys(handle.submoduleBases);
    const out: LightLandPrepared = { handle, branch, baseSha: base.sha, landed: [] };
    for (const { task, ws } of input.candidates) {
        const r = task.lightResult!;
        for (const sub of subs) {
            const sh = r.submoduleHeads?.[sub];
            if (!sh) continue;
            const dir = path.join(handle.path, sub);
            const head = (await lightGitOk(dir, ['rev-parse', 'HEAD'])) ?? '';
            const ff = await lightGit(dir, ['merge-base', '--is-ancestor', head, sh.head]);
            if (ff.code === 0) { await lightGit(dir, ['merge', '--ff-only', sh.head]); continue; }
            const pick = await cherryPickRange(dir, `${sh.base}..${sh.head}`, []);
            if (!pick.ok) return { ...out, conflict: { taskId: task.id, where: sub, paths: pick.paths } };
        }
        if (r.rootHeadSha) {
            const pick = await cherryPickRange(handle.path, `${r.rootBaseSha}..${r.rootHeadSha}`, subs);
            if (!pick.ok) return { ...out, conflict: { taskId: task.id, where: '.', paths: pick.paths } };
        }
        out.landed.push(task.id);
        void ws;
    }
    // Make every submodule pointer agree with the land submodule HEAD (cherry-picks rewrite SHAs).
    for (const sub of subs) {
        const want = (await lightGitOk(path.join(handle.path, sub), ['rev-parse', 'HEAD'])) ?? '';
        const have = (await lightGitOk(handle.path, ['rev-parse', `HEAD:${sub}`])) ?? '';
        if (want && have && want !== have) {
            const last = input.candidates[input.candidates.length - 1]?.task.lightResult?.rootHeadSha ?? 'HEAD';
            const author = (await lightGit(handle.path, ['log', '-1', '--format=%an%x01%ae%x01%ad', '--date=iso-strict', last])).stdout.trim();
            await lightGit(handle.path, ['add', sub]);
            await lightGit(handle.path, ['commit', '-m', `chore(${sub}): point submodule at the combined light task commits`], { env: { ...identityEnv('AUTHOR', author), ...identityEnv('COMMITTER', author) } });
        }
    }
    return out;
}

export async function removeLightLandBatch(prep: LightLandPrepared, ctx: { db: DatabaseHandle; checkoutRoot: string; config: LightWorkspaceConfig }, keepBranch = false): Promise<void> {
    await removeLightWorkspace({
        path: prep.handle.path, checkoutRoot: ctx.checkoutRoot, config: ctx.config, db: ctx.db, workspaceId: prep.handle.workspaceId,
        submodules: Object.keys(prep.handle.submoduleBases), deleteBranches: !keepBranch,
    }).catch(() => undefined);
}

export interface ApplyToCheckoutResult { ok: boolean; applied: string[]; failed?: { taskId: string; reason: string; paths?: string[] } }

/** MCP-only interactive callers: apply the stored patches to their own checkout, staged but NOT committed. */
export async function applyLightResultsToCheckout(checkoutRoot: string, candidates: LightLandCandidate[]): Promise<ApplyToCheckoutResult> {
    // 1. every touched path must be clean in the caller's checkout (and nothing may be staged there)
    for (const { task } of candidates) {
        const touched = task.lightResult!.touchedPaths;
        const dirty = (await lightGit(checkoutRoot, ['status', '--porcelain=v1', '--', ...touched])).stdout.split('\n').filter(Boolean);
        if (dirty.length) return { ok: false, applied: [], failed: { taskId: task.id, reason: 'checkout_paths_not_clean', paths: dirty.map(l => l.slice(3)) } };
    }
    const applied: string[] = [];
    for (const { task, ws } of candidates) {
        const dir = lightArtifactDir(ws);
        const files: Array<{ cwd: string; file: string }> = [{ cwd: checkoutRoot, file: path.join(dir, 'root.patch') }];
        for (const sub of Object.keys(ws.submoduleBases)) files.push({ cwd: path.join(checkoutRoot, sub), file: path.join(dir, `${sub.replace(/[^a-zA-Z0-9_-]/g, '_')}.patch`) });
        for (const { cwd, file } of files) {
            if (!fs.existsSync(file)) continue;
            if (fs.statSync(file).size === 0) continue;
            const r = await lightGit(cwd, ['apply', '--3way', '--index', file]);
            if (r.code !== 0) return { ok: false, applied, failed: { taskId: task.id, reason: `git apply failed in ${cwd === checkoutRoot ? '.' : path.basename(cwd)}: ${r.stderr.trim().slice(0, 300)}` } };
        }
        applied.push(task.id);
    }
    return { ok: true, applied };
}

export function markLightResultsLanded(db: DatabaseHandle, candidates: LightLandCandidate[], via: 'refine' | 'apply_to_checkout', write: (task: MeshWorkQueueEntry) => void): void {
    for (const { task, ws } of candidates) {
        task.lightResult = { ...task.lightResult!, landing: 'landed', landedAt: new Date().toISOString(), landedVia: via };
        write(task);
        setLightWorkspaceState(db, ws.workspaceId, 'landed');
    }
}

export function outsideOwned(task: MeshWorkQueueEntry): string[] {
    const r = task.lightResult;
    return r && task.ownedPaths ? [...touchedFilesOutsideOwnership(r.touchedPaths, task.ownedPaths).undeclaredTouched] : [];
}
