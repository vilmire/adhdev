/**
 * LIGHT-TASK result capture (design §7.2). Runs right after the worker's `report_completion` is
 * accepted: inspects the light workspace, registers the patch artifacts, apply-checks against the
 * current base and records a `LightTaskResult` on the queue row. The daemon never commits on the
 * worker's behalf and never rebases; anything that breaks trust in the result blocks it.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    touchedFilesOutsideOwnership,
    type LightApplyCheck, type LightApplyCheckSide, type LightTaskResult, type LightTestRun, type LightWarning,
    type MeshSourceCandidate,
} from '@adhdev/mesh-shared';
import { ArtifactStore } from '../artifacts/artifact-store.js';
import { getMachineId } from '../config/config.js';
import { resolveConfigDir } from '../config/config-dir.js';
import { getMesh } from '../config/mesh-config.js';
import { LOG } from '../logging/logger.js';
import { diffLightFingerprints, loadLightFingerprint, takeLightCheckoutFingerprint } from './light-checkout-fingerprint.js';
import { lightGit, lightGitOk } from './light-git.js';
import { lightRepoHash, lightTaskKey } from './light-workspace.js';
import { getLightWorkspace, setLightWorkspaceState, type LightWorkspaceRow } from './mesh-light-workspace-store.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { commitTaskTerminal } from './mesh-task-terminal.js';
import { withQueueLock } from './mesh-work-queue.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';

export const LIGHT_CAPTURE_TIMEOUT_MS = 60_000;
const DEP_FILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', '.npmrc']);
const DEP_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies', 'overrides', 'resolutions', 'workspaces'];

export interface LightReportInput { outcome: string; testsRun?: LightTestRun[] }

/** Fire-and-forget hook called by the worker-report accept path (one line there). */
export function captureLightResultInBackground(meshId: string, taskId: string, report: LightReportInput): void {
    void (async () => {
        try {
            const task = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId);
            if (!task?.light || !task.lightWorkspaceId) return;
            await Promise.race([
                captureLightTaskResult({ meshId, taskId, report }),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('light_capture_timeout')), LIGHT_CAPTURE_TIMEOUT_MS).unref?.()),
            ]);
        } catch (e: any) {
            LOG.warn('LightTask', `result capture for ${taskId} failed: ${e?.message || e}`);
            try { recordResult(meshId, taskId, { landing: 'blocked', blockedReason: 'light_lineage_unproven', blockedDetail: `capture failed: ${e?.message || e}` }, undefined); } catch { /* best-effort */ }
        }
    })();
}

type Partial_ = Partial<LightTaskResult> & Pick<LightTaskResult, 'landing'>;

function recordResult(meshId: string, taskId: string, result: Partial_, ws: LightWorkspaceRow | undefined): LightTaskResult {
    const full: LightTaskResult = {
        workspaceId: ws?.workspaceId ?? '', branch: ws?.branchRefs['.'] ?? '', rootBaseSha: ws?.rootBaseSha ?? '', touchedPaths: [], patchArtifactIds: [],
        capturedAt: new Date().toISOString(), ...result,
    };
    withQueueLock(meshId, () => {
        const store = MeshRuntimeStore.getInstance();
        const row = store.findQueueEntryById(meshId, taskId);
        if (!row) return;
        row.lightResult = full;
        store.updateQueueEntry(row);
    });
    return full;
}

async function dependencyChange(repo: string, base: string, head: string, files: string[]): Promise<string | undefined> {
    for (const f of files) {
        const name = path.posix.basename(f);
        if (DEP_FILES.has(name)) return f;
        if (name !== 'package.json') continue;
        const [a, b] = await Promise.all([lightGitOk(repo, ['show', `${base}:${f}`]), lightGitOk(repo, ['show', `${head}:${f}`])]);
        try {
            const pa = a ? JSON.parse(a) : {}; const pb = b ? JSON.parse(b) : {};
            if (DEP_SECTIONS.some(k => JSON.stringify(pa[k] ?? null) !== JSON.stringify(pb[k] ?? null))) return f;
        } catch { return f; } // unparseable package.json: assume the worst
    }
    return undefined;
}

// No `--merge-base`: it needs git >= 2.40; the computed base equals the workspace base for the linear histories light tasks produce.
async function mergeTreeSide(repo: string, current: string, head: string): Promise<LightApplyCheckSide> {
    const r = await lightGit(repo, ['merge-tree', '--write-tree', '--name-only', current, head]);
    if (r.code === 0) return { against: current, status: 'clean' };
    if (r.code === 1) {
        const lines = r.stdout.split('\n');
        const blank = lines.findIndex((l, i) => i > 0 && l === '');
        const conflictPaths = lines.slice(1, blank < 0 ? lines.length : blank).filter(Boolean);
        return { against: current, status: 'conflict', conflictPaths };
    }
    return { against: current, status: 'base_unavailable' };
}

/** apply-check of root + submodules against `rootAgainst` (a root commit-ish): worst side wins. */
async function applyCheck(repo: string, ws: LightWorkspaceRow, rootHead: string, subHeads: Record<string, string>, rootAgainst: string): Promise<LightApplyCheckSide> {
    const rootSide = await mergeTreeSide(repo, rootAgainst, rootHead);
    const conflicts = [...(rootSide.conflictPaths ?? [])];
    let status = rootSide.status;
    for (const [sub, head] of Object.entries(subHeads)) {
        const cur = await lightGitOk(repo, ['rev-parse', `${rootAgainst}:${sub}`]);
        if (!cur) { if (status === 'clean') status = 'base_unavailable'; continue; }
        const side = await mergeTreeSide(path.join(repo, sub), cur, head);
        conflicts.push(...(side.conflictPaths ?? []).map(p => `${sub}/${p}`));
        if (side.status === 'conflict') status = 'conflict';
        else if (side.status === 'base_unavailable' && status === 'clean') status = 'base_unavailable';
    }
    return { against: rootAgainst, status, ...(conflicts.length ? { conflictPaths: conflicts } : {}) };
}

function artifactDir(ws: LightWorkspaceRow): string {
    return path.join(resolveConfigDir(), 'light-artifacts', lightRepoHash(ws.repoRoot), lightTaskKey(ws.taskId));
}

function registerPatch(task: MeshWorkQueueEntry, ws: LightWorkspaceRow, name: string, content: string, title: string): string | undefined {
    if (!content) return undefined;
    const dir = artifactDir(ws);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
    const sessionId = task.assignedSessionId || task.targetSessionId;
    if (!sessionId) return undefined;
    try {
        return new ArtifactStore(MeshRuntimeStore.getInstance().db).register({
            sessionId, workspaceRoot: dir, path: name, meshId: task.meshId, taskId: task.id, missionId: task.missionId ?? null,
            producerRole: 'pipeline', kind: 'diff', title,
        }).record.artifactId;
    } catch (e: any) {
        LOG.warn('LightTask', `patch artifact ${name} for ${task.id} not registered: ${e?.message || e}`);
        return undefined;
    }
}

export async function captureLightTaskResult(input: { meshId: string; taskId: string; report: LightReportInput }): Promise<LightTaskResult | null> {
    const { meshId, taskId, report } = input;
    const store = MeshRuntimeStore.getInstance();
    const task = store.findQueueEntryById(meshId, taskId);
    const ws = task?.lightWorkspaceId ? getLightWorkspace(store.db, task.lightWorkspaceId) : undefined;
    if (!task || !ws) return null;
    if (report.outcome !== 'completed') {
        // Nothing landable: keep the partial work for the 1h failure window, then the sweep removes it.
        setLightWorkspaceState(store.db, ws.workspaceId, 'failed');
        return null;
    }
    const lw = ws.path;
    const repo = ws.repoRoot;
    const subs = Object.keys(ws.submoduleBases);
    const warnings: LightWarning[] = [];
    const finish = (r: Partial_): LightTaskResult => {
        const full = recordResult(meshId, taskId, { ...r, ...(warnings.length ? { warnings: [...warnings] } : {}), testsRun: report.testsRun }, ws);
        setLightWorkspaceState(store.db, ws.workspaceId, 'result_ready');
        if (full.landing === 'blocked') {
            try { commitTaskTerminal({ meshId, taskId, status: 'blocked', source: 'queue_policy', reason: full.blockedReason }); } catch (e: any) { LOG.warn('LightTask', `could not mark ${taskId} blocked: ${e?.message || e}`); }
        }
        return full;
    };
    const base: Pick<LightTaskResult, 'workspaceId' | 'branch' | 'rootBaseSha'> & { submoduleBranches?: Record<string, string> } = {
        workspaceId: ws.workspaceId, branch: ws.branchRefs['.'] ?? '', rootBaseSha: ws.rootBaseSha,
        ...(subs.length ? { submoduleBranches: Object.fromEntries(subs.map(s => [s, ws.branchRefs[s] ?? ''])) } : {}),
    };

    // 1. uncommitted changes -> blocked, the diff is kept as an artifact (never committed for the worker)
    const dirty: string[] = [];
    for (const dir of [lw, ...subs.map(s => path.join(lw, s))]) {
        const st = await lightGitOk(dir, ['status', '--porcelain=v1', '--untracked-files=all']);
        if (st === null || st) dirty.push(dir);
    }
    if (dirty.length) {
        const diff = (await lightGit(lw, ['diff', 'HEAD', '--binary'])).stdout;
        const id = registerPatch(task, ws, 'uncommitted.patch', diff, 'Light task: uncommitted changes');
        return finish({ ...base, landing: 'blocked', blockedReason: 'light_uncommitted_changes', touchedPaths: [], patchArtifactIds: id ? [id] : [] });
    }

    // 2. lineage: heads descend from their bases
    const rootHead = await lightGitOk(lw, ['rev-parse', 'HEAD']);
    const subHeads: Record<string, string> = {};
    let lineageOk = !!rootHead && (await lightGit(repo, ['merge-base', '--is-ancestor', ws.rootBaseSha, rootHead])).code === 0;
    for (const s of subs) {
        const h = await lightGitOk(path.join(lw, s), ['rev-parse', 'HEAD']);
        if (!h) { lineageOk = false; continue; }
        subHeads[s] = h;
        if ((await lightGit(path.join(repo, s), ['merge-base', '--is-ancestor', ws.submoduleBases[s], h])).code !== 0) lineageOk = false;
    }
    if (!lineageOk || !rootHead) return finish({ ...base, landing: 'blocked', blockedReason: 'light_lineage_unproven', touchedPaths: [], patchArtifactIds: [] });

    // touched paths + dependency scan
    const rootFiles = (await lightGit(repo, ['diff', '--name-only', `${ws.rootBaseSha}..${rootHead}`])).stdout.split('\n').filter(Boolean);
    const subFiles: Record<string, string[]> = {};
    for (const s of subs) subFiles[s] = (await lightGit(path.join(repo, s), ['diff', '--name-only', `${ws.submoduleBases[s]}..${subHeads[s]}`])).stdout.split('\n').filter(Boolean);
    const touchedPaths = [...new Set([...rootFiles, ...subs.flatMap(s => subFiles[s].map(f => `${s}/${f}`))])].sort();
    const common = { ...base, rootHeadSha: rootHead, touchedPaths, ...(subs.length ? { submoduleHeads: Object.fromEntries(subs.map(s => [s, { base: ws.submoduleBases[s], head: subHeads[s] }])) } : {}) };

    // 3. patch artifacts (kept even when the result is blocked below)
    const patchIds: string[] = [];
    const rootPatch = (await lightGit(repo, ['diff', '--binary', `${ws.rootBaseSha}..${rootHead}`], { timeoutMs: 50_000 })).stdout;
    const rid = registerPatch(task, ws, 'root.patch', rootPatch, 'Light task patch (root)');
    if (rid) patchIds.push(rid);
    const subPatches: string[] = [];
    for (const s of subs) {
        if (!subFiles[s].length) continue;
        const p = (await lightGit(path.join(repo, s), ['diff', '--binary', `${ws.submoduleBases[s]}..${subHeads[s]}`], { timeoutMs: 50_000 })).stdout;
        subPatches.push(p);
        const id = registerPatch(task, ws, `${s.replace(/[^a-zA-Z0-9_-]/g, '_')}.patch`, p, `Light task patch (${s})`);
        if (id) patchIds.push(id);
    }

    // dependency change -> blocked, patch preserved
    const depRoot = await dependencyChange(repo, ws.rootBaseSha, rootHead, rootFiles);
    let depHit = depRoot;
    for (const s of subs) depHit ??= await dependencyChange(path.join(repo, s), ws.submoduleBases[s], subHeads[s], subFiles[s]).then(f => (f ? `${s}/${f}` : undefined));
    if (depHit) return finish({ ...common, landing: 'blocked', blockedReason: 'light_dependency_change', blockedDetail: depHit, patchArtifactIds: patchIds });

    // 4. owned_paths comparison (evidence; landing demands an explicit accept, §8.1)
    let ownedPathsMismatch: string[] | undefined;
    if (task.ownedPaths?.paths.length) {
        const out = touchedFilesOutsideOwnership(touchedPaths, task.ownedPaths).undeclaredTouched;
        if (out.length) ownedPathsMismatch = [...out];
    }

    // 5. shared checkout fingerprint
    const before = loadLightFingerprint(lw);
    if (before) {
        // Re-scan exactly the directories the baseline covered (already glob-expanded), not a freshly loaded config.
        const after = await takeLightCheckoutFingerprint(repo, Object.keys(before.nodeModules), subs);
        const diff = diffLightFingerprints(before, after, { touchedPaths, owned: task.ownedPaths });
        if (diff.overlappingPaths.length || diff.nodeModulesChanged.length) {
            return finish({ ...common, landing: 'blocked', blockedReason: 'shared_checkout_mutated', blockedDetail: JSON.stringify({ paths: diff.overlappingPaths.slice(0, 20), nodeModules: diff.nodeModulesChanged }), patchArtifactIds: patchIds, ...(ownedPathsMismatch ? { ownedPathsMismatch } : {}) });
        }
        if (diff.changedPaths.length || diff.headMoved || diff.refsChanged.length || diff.stashChanged) warnings.push('shared_checkout_changed_during_task');
    }

    // 6. apply-check vs the base HEAD and origin/<branch>
    const headSide = await applyCheck(repo, ws, rootHead, subHeads, 'HEAD');
    const branchName = (await lightGitOk(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])) || '';
    const remoteRef = branchName && branchName !== 'HEAD' ? `refs/remotes/origin/${branchName}` : '';
    const remoteSha = remoteRef ? await lightGitOk(repo, ['rev-parse', '--verify', '--quiet', `${remoteRef}^{commit}`]) : null;
    const check: LightApplyCheck = { head: { ...headSide, against: (await lightGitOk(repo, ['rev-parse', 'HEAD'])) || 'HEAD' } };
    if (remoteSha) check.remote = { ...(await applyCheck(repo, ws, rootHead, subHeads, remoteSha)), against: remoteSha };

    // 7. source candidate record
    const patchSha256 = crypto.createHash('sha256').update(rootPatch).update(subPatches.join('\n')).digest('hex');
    const mesh = getMesh(meshId);
    const candidate: MeshSourceCandidate = {
        version: 1, readiness: 'verified_source_candidate', taskId, missionId: task.missionId ?? '', revision: task.revision ?? 0,
        repoIdentity: mesh?.repoIdentity ?? '', machineId: getMachineId() ?? '', canonicalWorktree: lw,
        rootBaseSha: ws.rootBaseSha, ossBaseSha: ws.submoduleBases['oss'] ?? '', rootCandidateSha: rootHead,
        ...(subHeads['oss'] ? { ossCandidateSha: subHeads['oss'] } : {}),
        patchSha256, manifestSha256: crypto.createHash('sha256').update(JSON.stringify({ b: ws.rootBaseSha, h: rootHead, s: subHeads, t: touchedPaths, p: patchSha256 })).digest('hex'),
        touchedPaths, tests: (report.testsRun ?? []).map(t => ({ command: t.command, exit: t.exit, logSha256: '' })),
        settledCommands: false, integrationTaskId: '', logicalOverlapTaskIds: [],
    };
    const conflict = check.head.status === 'conflict' || check.remote?.status === 'conflict';
    return finish({ ...common, landing: conflict ? 'conflict' : 'ready', applyCheck: check, patchArtifactIds: patchIds, ...(ownedPathsMismatch ? { ownedPathsMismatch } : {}), sourceCandidate: candidate });
}
