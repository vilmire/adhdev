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
import { getStageArtifactRegistrar } from './stage-ports-default.js';
import { getMachineId } from '../config/config.js';
import { resolveConfigDir } from '../config/config-dir.js';
import { getMesh } from '../config/mesh-config.js';
import { LOG } from '../logging/logger.js';
import { diffLightFingerprints, parseLightFingerprint, takeLightCheckoutFingerprint } from './light-checkout-fingerprint.js';
import { lightGit, lightGitOk } from './light-git.js';
import { lightRepoHash, lightTaskKey } from './light-workspace.js';
import { getLightWorkspace, setLightWorkspaceState, type LightWorkspaceRow } from './mesh-light-workspace-store.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { stopLightWorkerSession } from './light-session-stop.js';
import { commitTaskTerminal } from './mesh-task-terminal.js';
import { withQueueLock } from './mesh-work-queue.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';

export const LIGHT_CAPTURE_TIMEOUT_MS = 60_000;
const DEP_FILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', '.npmrc']);
const DEP_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies', 'overrides', 'resolutions', 'workspaces'];

export interface LightReportInput { outcome: string; testsRun?: LightTestRun[] }

export { setLightSessionStopper, stopLightWorkerSession, type LightSessionStopper } from './light-session-stop.js';

/** Fire-and-forget hook called by the worker-report accept path (one line there). */
export function captureLightResultInBackground(meshId: string, taskId: string, report: LightReportInput): void {
    void (async () => {
        let isLight = false;
        try {
            const task = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId);
            if (!task?.light || !task.lightWorkspaceId) return;
            isLight = true;
            await Promise.race([
                captureLightTaskResult({ meshId, taskId, report }),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('light_capture_timeout')), LIGHT_CAPTURE_TIMEOUT_MS).unref?.()),
            ]);
        } catch (e: any) {
            LOG.warn('LightTask', `result capture for ${taskId} failed: ${e?.message || e}`);
            try { recordResult(meshId, taskId, { landing: 'blocked', blockedReason: 'light_lineage_unproven', blockedDetail: `capture failed: ${e?.message || e}` }, undefined); } catch { /* best-effort */ }
        } finally {
            // Terminal (completed/blocked/failed) and captured: the session has nothing left to do.
            if (isLight) await stopLightWorkerSession(meshId, taskId);
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

/** Where a result's patch files live (outside the workspace, so they outlive its 24h removal). */
export function lightArtifactDir(ws: Pick<LightWorkspaceRow, 'repoRoot' | 'taskId'>): string {
    return path.join(resolveConfigDir(), 'light-artifacts', lightRepoHash(ws.repoRoot), lightTaskKey(ws.taskId));
}

function registerPatch(task: MeshWorkQueueEntry, ws: LightWorkspaceRow, name: string, content: string, title: string, kind: 'diff' | 'json' = 'diff'): string | undefined {
    if (!content) return undefined;
    const dir = lightArtifactDir(ws);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
    const sessionId = task.assignedSessionId || task.targetSessionId;
    if (!sessionId) return undefined;
    try {
        const register = getStageArtifactRegistrar();
        if (!register) throw new Error('artifact registrar not installed');
        return register({
            sessionId, workspaceRoot: dir, path: name, meshId: task.meshId, taskId: task.id, ...(task.missionId ? { missionId: task.missionId } : {}),
            producerRole: 'pipeline', kind, title,
        }) ?? undefined;
    } catch (e: any) {
        LOG.warn('LightTask', `patch artifact ${name} for ${task.id} not registered: ${e?.message || e}`);
        return undefined;
    }
}

/** Parse porcelain v1 paths (tracked + untracked). Paths are repo-relative posix. */
function porcelainTouchedPaths(porcelain: string): string[] {
    const out: string[] = [];
    for (const line of porcelain.split('\n')) {
        if (!line) continue;
        // "XY path" or "XY orig -> path" (rename). Untracked is "?? path".
        const body = line.slice(3);
        if (!body) continue;
        const arrow = body.lastIndexOf(' -> ');
        out.push(arrow >= 0 ? body.slice(arrow + 4) : body);
    }
    return [...new Set(out)].sort();
}

/**
 * Immutable dirty packet for one git root (workspace root or a submodule): tracked binary
 * diff + untracked-as-new-file diffs, without mutating the private index.
 */
async function captureDirtyRepoPacket(repo: string): Promise<{ patch: string; touchedPaths: string[]; headSha: string | null; gitDir: string | null; indexPath: string | null; patchSha256: string }> {
    // Do not use lightGitOk here: its .trim() eats the leading space of porcelain " M path".
    const statusRaw = await lightGit(repo, ['status', '--porcelain=v1', '--untracked-files=all']);
    const status = statusRaw.code === 0 ? statusRaw.stdout.replace(/\n$/, '') : '';
    const touchedPaths = porcelainTouchedPaths(status);
    const tracked = (await lightGit(repo, ['diff', 'HEAD', '--binary'], { timeoutMs: 50_000 })).stdout;
    const staged = (await lightGit(repo, ['diff', '--cached', '--binary'], { timeoutMs: 50_000 })).stdout;
    const untracked = (await lightGitOk(repo, ['ls-files', '-z', '-o', '--exclude-standard']))?.split('\0').filter(Boolean) ?? [];
    const parts: string[] = [];
    if (tracked) parts.push(tracked.endsWith('\n') ? tracked : `${tracked}\n`);
    if (staged) parts.push(staged.endsWith('\n') ? staged : `${staged}\n`);
    for (const rel of untracked) {
        const abs = path.join(repo, rel);
        // `git diff --no-index` exits 1 on difference; lightGit keeps stdout.
        const empty = process.platform === 'win32' ? 'NUL' : '/dev/null';
        const u = await lightGit(repo, ['diff', '--no-index', '--binary', '--', empty, abs], { timeoutMs: 50_000 });
        if (u.stdout) {
            // Rewrite /dev/null or NUL paths to a stable a/ / b/ form for the packet.
            const rewritten = u.stdout
                .replace(new RegExp(`(a/)${empty.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), `a/${rel}`)
                .replace(new RegExp(`(b/)${abs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), `b/${rel}`)
                .replace(new RegExp(abs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), rel);
            parts.push(rewritten.endsWith('\n') ? rewritten : `${rewritten}\n`);
        }
    }
    const patch = parts.join('');
    const headSha = await lightGitOk(repo, ['rev-parse', 'HEAD']);
    const gitDir = await lightGitOk(repo, ['rev-parse', '--absolute-git-dir']);
    const indexPath = await lightGitOk(repo, ['rev-parse', '--git-path', 'index']);
    return {
        patch, touchedPaths, headSha, gitDir,
        indexPath: indexPath ? path.resolve(repo, indexPath) : null,
        patchSha256: crypto.createHash('sha256').update(patch).digest('hex'),
    };
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

    // 1. uncommitted changes -> blocked. Capture EVERY dirty root/submodule as its own immutable
    // packet (patch + touchedPaths + hash + identity). Never promote dirty work to verified/landable.
    const dirtyUnits: Array<{ label: string; dir: string; prefix: string }> = [
        { label: 'root', dir: lw, prefix: '' },
        ...subs.map(s => ({ label: s, dir: path.join(lw, s), prefix: `${s}/` })),
    ];
    const dirtyPackets: Array<{
        label: string; prefix: string; patch: string; touchedPaths: string[]; headSha: string | null;
        gitDir: string | null; indexPath: string | null; patchSha256: string;
    }> = [];
    for (const unit of dirtyUnits) {
        const st = await lightGit(unit.dir, ['status', '--porcelain=v1', '--untracked-files=all']);
        // Preserve leading spaces; only treat spawn failure as unknown/dirty.
        if (st.code !== 0 || st.stdout.replace(/\n$/, '')) {
            const packet = await captureDirtyRepoPacket(unit.dir);
            dirtyPackets.push({ label: unit.label, prefix: unit.prefix, ...packet });
        }
    }
    if (dirtyPackets.length) {
        const patchIds: string[] = [];
        const touchedPaths = [...new Set(dirtyPackets.flatMap(p => p.touchedPaths.map(t => `${p.prefix}${t}`)))].sort();
        const patchBodies: string[] = [];
        for (const p of dirtyPackets) {
            const safe = p.label.replace(/[^a-zA-Z0-9_-]/g, '_');
            const name = p.label === 'root' ? 'uncommitted.root.patch' : `uncommitted.${safe}.patch`;
            patchBodies.push(p.patch);
            const id = registerPatch(task, ws, name, p.patch, `Light task uncommitted packet (${p.label})`);
            if (id) patchIds.push(id);
        }
        const mesh = getMesh(meshId);
        const logEvidence = (report.testsRun ?? []).map(t => ({
            command: t.command, exit: t.exit,
            logSha256: crypto.createHash('sha256').update(JSON.stringify({ command: t.command, exit: t.exit, passed: t.passed, failed: t.failed, note: t.note })).digest('hex'),
        }));
        const identity = {
            version: 1 as const,
            readiness: 'uncommitted' as const,
            taskId, missionId: task.missionId ?? '', revision: task.revision ?? 0,
            repoIdentity: mesh?.repoIdentity ?? '', machineId: getMachineId() ?? '',
            canonicalWorktree: lw,
            packets: dirtyPackets.map(p => ({
                label: p.label, touchedPaths: p.touchedPaths.map(t => `${p.prefix}${t}`),
                patchSha256: p.patchSha256, headSha: p.headSha, gitDir: p.gitDir, indexPath: p.indexPath,
            })),
            tests: logEvidence,
        };
        const identityJson = `${JSON.stringify(identity, null, 2)}\n`;
        const iid = registerPatch(task, ws, 'uncommitted.source-identity.json', identityJson, 'Light task uncommitted source identity', 'json');
        if (iid) patchIds.push(iid);
        const patchSha256 = crypto.createHash('sha256').update(patchBodies.join('\n')).digest('hex');
        const candidate: MeshSourceCandidate = {
            version: 1, readiness: 'uncommitted', taskId, missionId: task.missionId ?? '', revision: task.revision ?? 0,
            repoIdentity: mesh?.repoIdentity ?? '', machineId: getMachineId() ?? '', canonicalWorktree: lw,
            rootBaseSha: ws.rootBaseSha, ossBaseSha: ws.submoduleBases['oss'] ?? '',
            patchSha256,
            manifestSha256: crypto.createHash('sha256').update(JSON.stringify({
                readiness: 'uncommitted', packets: identity.packets, touchedPaths, patchSha256, tests: logEvidence,
            })).digest('hex'),
            touchedPaths, tests: logEvidence.map(t => ({ command: t.command, exit: t.exit, logSha256: t.logSha256 })),
            settledCommands: false, integrationTaskId: '', logicalOverlapTaskIds: [],
        };
        return finish({
            ...base, landing: 'blocked', blockedReason: 'light_uncommitted_changes',
            blockedDetail: JSON.stringify({ packetCount: dirtyPackets.length, labels: dirtyPackets.map(p => p.label), patchSha256 }),
            touchedPaths, patchArtifactIds: patchIds, sourceCandidate: candidate,
        });
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
    // Baseline lives in the daemon DB. Missing/unparsable = fail closed (it can only vanish through a daemon fault or tampering).
    const before = parseLightFingerprint(ws.fingerprintJson);
    if (!before) {
        return finish({ ...common, landing: 'blocked', blockedReason: 'shared_checkout_mutated', blockedDetail: 'baseline_missing', patchArtifactIds: patchIds, ...(ownedPathsMismatch ? { ownedPathsMismatch } : {}) });
    }
    {
        // Re-scan the directories recorded at prepare time (from the config), not anything the baseline file/JSON claims.
        const after = await takeLightCheckoutFingerprint(repo, ws.linkDirs, subs);
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
