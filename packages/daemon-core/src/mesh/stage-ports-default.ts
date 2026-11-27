import { createHostStageVendorRecipe } from './stage-vendor-replay.js';
import { createDetachedStageReviewerWorkspace } from './stage-review-detached.js';
import { decodeStageSourceGenerated, setDefaultStageGeneratedRecipe, setStageGeneratedRetention, writeStageSourceGenerated } from './stage-source-generated-provider.js';
// Review-in-task: production wiring of the stage ports (docs/design/2026-11-01-review-in-task.md).
//
// INTEGRATION SEAMS (connect at integration with the light-workspace work):
//   setStagePorts({ selfCheck })            — default reports 'unavailable' (the stage skips, no bounce).
//   setStagePorts({ reviewerWorkspace })    — optional checkout provider for ordinary stage diffs.
// Everything else is implemented here against the real queue, git, artifact store and notice runtime.

import type { ArtifactKind } from '../artifacts/types.js';

/** Layer-neutral guard shape (mesh must not value-import artifacts/). */
function isArtifactGuardLike(e: unknown): e is {
    name?: string
    code: string
    message: string
    retryable: boolean
    details?: Record<string, unknown>
} {
    if (!e || typeof e !== 'object') return false;
    const o = e as Record<string, unknown>;
    return typeof o.code === 'string' && typeof o.message === 'string' && typeof o.retryable === 'boolean'
        && (o.name === 'ArtifactGuardError' || o.details !== undefined || /^artifact_/.test(String(o.code)));
}
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { withQueueLock } from './mesh-work-queue.js';
import { enqueueTask } from './mesh-work-queue-enqueue.js';
import { cancelTask } from './mesh-work-queue.js';
import { isTerminalTurnState } from './turn-ledger/types.js';
import { commitTaskTerminal } from './mesh-task-terminal.js';
import { endTaskDispatchInFlight } from './mesh-task-inflight.js';
import { getConfigDir, getMachineId } from '../config/config.js';
import { getMesh, listMeshes } from '../config/mesh-config.js';
import { notifyMeshCoordinator } from './turn-ledger/deliver.js';
import { meshRecord } from './mesh-record.js';
import { recordAcceptedSessionCompletion } from './mesh-session-lifetime.js';
import { LOG } from '../logging/logger.js';
import { STAGE_PIPELINE_CEILING_DEFAULT_MS } from '@adhdev/mesh-shared';
import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';
import type { DaemonComponents } from '../boot/daemon-components.js';
import { StagePipelineRuntime } from './stage-pipeline-runtime.js';
import { setStageHookTarget } from './stage-hooks.js';
import { setStageNoticeLookup } from './stage-notice-silence.js';
import { isStageChild, isStageParent } from './stage-state.js';
import { FINGERPRINT_V2, type StageGitPort, type StageRuntimePorts, type SelfCheckRunner, type SelfCheckResult, type ReviewerWorkspaceProvider } from './stage-ports.js';
import { runMeshRefineValidationProfile } from './refine-profile-run.js';
import { prepareLightWorkspace, removeLightWorkspace } from './light-workspace.js';
import { loadLightWorkspaceConfig } from './light-workspace-config.js';
import { getLightWorkspace } from './mesh-light-workspace-store.js';
import { attestStageReviewInput, stageReviewArtifactGrants, stageReviewArtifactGrantsWithheld, currentStageReviewScope, validateCurrentDiff, validateStageReviewRetainedGrants, readStageReviewArtifact } from './stage-review-input.js';
import { streamStageGit, hashStageGit } from './stage-diff-stream.js';
import { assertStageDiffRetentionGrowth } from './stage-diff-retention.js';
import { StageDiffBlocked } from './stage-diff-manifest.js';
import { reviewInputBusy } from './mesh-task-routing-contract.js';
import { daemonIdsEquivalent, sessionIdsEquivalent } from '@adhdev/mesh-shared';
import { allowedClassifiedDifficultiesForSession, readSessionModel, taskMeetsSessionDifficultyFloor } from './mesh-difficulty-floor.js';
import { resolveNodeCapabilitySlots } from './mesh-node-slots.js';

const SELF_CHECK_LOG_MAX = 60_000;

const execFileAsync = promisify(execFile);
/** Past this many untracked files the stat hash is not attempted: the fingerprint is unavailable (fail closed). */
const MAX_FINGERPRINT_OTHER_FILES = 300_000;
/** Wall-clock budget and stat concurrency of the checkout fingerprint (fail closed past the budget). */
const FINGERPRINT_BUDGET_MS = 20_000;
const FINGERPRINT_STAT_CONCURRENCY = 32;

async function git(cwd: string, args: string[], maxBuffer = 8 * 1024 * 1024): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true, timeout: 30_000, maxBuffer });
    return stdout;
}

export const defaultStageGit: StageGitPort = {
    async baseSha(workspace) {
        for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
            try { return (await git(workspace, ['merge-base', 'HEAD', ref])).trim() || null; } catch { /* try next */ }
        }
        return null;
    },
    async headSha(workspace) { try { return (await git(workspace, ['rev-parse', 'HEAD'])).trim() || null; } catch { return null; } },
    async diff(workspace, base, head) { return git(workspace, ['diff', '--no-color', `${base}..${head}`], 16 * 1024 * 1024); },
    diffStream: streamStageGit,
    /**
     * Content-based checkout fingerprint (review-in-task §11). Covers: HEAD; porcelain status incl. untracked entries;
     * a hash of `git diff HEAD --binary` (tracked content); `git ls-files -v` (skip-worktree / assume-unchanged
     * bits); and a stat hash (path, size, mtime) of every untracked, non-ignored file. Git-IGNORED files are excluded on
     * purpose: a reviewer that runs the project's tests or build rewrites ignored output (dist/, caches, node_modules
     * state) and that is not a source mutation — counting it voided honest verdicts as `reviewer_mutated_source`.
     * Tracked source (diff, skip-worktree bits, HEAD) and untracked source files stay protected.
     * fsmonitor is disabled so a stale daemon cannot hide changes. Stats run asynchronously with
     * bounded concurrency under a wall-clock budget and an incremental file cap; any failure, cap or timeout → null (the
     * caller treats that as "cannot verify" and fails closed).
     */
    async fingerprint(workspace, limits: { budgetMs?: number; maxEntries?: number; concurrency?: number; legacy?: boolean } = {}) {
        const budgetMs = limits.budgetMs ?? FINGERPRINT_BUDGET_MS;
        const maxEntries = limits.maxEntries ?? MAX_FINGERPRINT_OTHER_FILES;
        const concurrency = limits.concurrency ?? FINGERPRINT_STAT_CONCURRENCY;
        const deadline = Date.now() + budgetMs;
        try {
            const g = (args: string[], max = 64 * 1024 * 1024) => git(workspace, ['-c', 'core.fsmonitor=false', ...args], max);
            const sha = (text: string) => createHash('sha256').update(text).digest('hex');
            const head = (await g(['rev-parse', 'HEAD'])).trim();
            // `legacy` reproduces the format written before git-ignored output was excluded (no version line, ignored
            // entries included), so a review that started before the upgrade is still verified like it would have been.
            const legacy = limits.legacy === true;
            const status = await g(['status', '--porcelain=v1', '--untracked-files=all', ...(legacy ? ['--ignored=matching'] : [])]);
            const diffHash = await hashStageGit(workspace, ['-c', 'core.fsmonitor=false', 'diff', 'HEAD', '--no-ext-diff', '--no-textconv', '--binary']);
            const lsv = await g(['ls-files', '-v']);
            const untracked = (await g(['ls-files', '-z', '-o', '--exclude-standard'])).split('\0').filter(Boolean);
            const ignored = legacy ? (await g(['ls-files', '-z', '-o', '-i', '--exclude-standard'])).split('\0').filter(Boolean) : [];
            const entries = [...untracked.map(p => `u:${p}`), ...ignored.map(p => `i:${p}`)];
            if (entries.length > maxEntries) return null;
            entries.sort();
            const lines: string[] = new Array(entries.length);
            let next = 0;
            let failed = false;
            const worker = async () => {
                for (;;) {
                    if (failed) return;
                    if (Date.now() > deadline) { failed = true; return; }
                    const i = next++;
                    if (i >= entries.length) return;
                    const rel = entries[i].slice(2);
                    try { const st = await fs.promises.lstat(path.join(workspace, rel)); lines[i] = `${entries[i]}\0${st.size}\0${st.mtimeMs}`; }
                    catch { lines[i] = `${entries[i]}\0gone`; }
                }
            };
            await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, entries.length)) }, worker));
            if (failed || Date.now() > deadline) return null;
            return [...(legacy ? [] : [FINGERPRINT_V2]), head, sha(status), diffHash, sha(lsv), sha(lines.join('\n'))].join('\n');
        } catch { return null; }
    },
    async isClean(workspace) { try { return (await git(workspace, ['status', '--porcelain'])).trim() === ''; } catch { return false; } },
};

/** Mapping of the shared profile runner's summary onto the stage self-check result (docs: review-in-task §4.2). */
export function mapProfileSummary(summary: { status?: string; failureCode?: string; skippedReason?: string; commandsRun?: unknown[] }): SelfCheckResult {
    const log = (() => { try { return JSON.stringify(summary.commandsRun ?? [], null, 1).slice(-SELF_CHECK_LOG_MAX); } catch { return ''; } })();
    if (summary.status === 'passed') return { status: 'passed', log };
    if (summary.failureCode === 'validation_profile_unknown' || summary.status === 'skipped') {
        return { status: 'skipped_not_configured', log: summary.skippedReason ?? 'no validation.profiles.fast configured' };
    }
    return { status: 'failed', log: `${summary.failureCode ? `${summary.failureCode}\n` : ''}${log}` };
}

export interface SelfCheckDeps {
    getMesh: (meshId: string) => unknown;
    run: (mesh: unknown, workspace: string, profile: string, opts: { baseSha: string }) => Promise<Parameters<typeof mapProfileSummary>[0]>;
}

/**
 * Self-check through the shared `fast` validation profile (refine-profile-run.ts, the same runner light landing uses).
 * Config without `profiles.fast` → skipped_not_configured; a thrown error → skipped_infra_error (never bounces).
 */
export function createRefineProfileSelfCheck(deps: SelfCheckDeps = { getMesh: id => getMesh(id), run: (m, w, p, o) => runMeshRefineValidationProfile(m, w, p, o) as never }): SelfCheckRunner {
    return {
        async run(req) {
            try {
                return mapProfileSummary(await deps.run(deps.getMesh(req.meshId) ?? null, req.workspace, req.profile, { baseSha: req.baseSha }));
            } catch (e: any) {
                return { status: 'skipped_infra_error', log: `self-check runner error: ${e?.message || e}` };
            }
        },
    };
}

/** Fallback when no runner is connected: skip without bouncing. */
export const unavailableSelfCheck: SelfCheckRunner = {
    async run() { return { status: 'unavailable', log: 'no self-check runner is connected on this daemon (fast profile not available)' }; },
};

export interface LightReviewerDeps {
    loadConfig: typeof loadLightWorkspaceConfig;
    prepare: typeof prepareLightWorkspace;
    remove: typeof removeLightWorkspace;
}

/**
 * Reviewer workspace backed by main's light workspace (detached checkout of the round head, no branch). Returns null
 * for a repo without `.adhdev/light-workspace.json` or when preparation fails (→ read-lease fallback).
 *
 * ★NOT installed in production by default: a prepared workspace only helps if the review child's claim is routed to a
 * session launched INTO that path (main's light dispatcher does that for `light` rows at the default base sha, not at
 * an arbitrary round head). Without that routing a regular session would claim the child with the read lease skipped,
 * which would also disable the mutation detector. Install with `setStagePorts({ reviewerWorkspace: createLightReviewerWorkspaceProvider() })`
 * once the dispatcher can launch a session into a given path for a stage child.
 */
export function createLightReviewerWorkspaceProvider(deps: LightReviewerDeps = { loadConfig: loadLightWorkspaceConfig, prepare: prepareLightWorkspace, remove: removeLightWorkspace }): ReviewerWorkspaceProvider {
    return {
        async prepare(req) {
            const cfg = deps.loadConfig(req.sourceWorkspace);
            if (!cfg.ok) return null;
            try {
                const handle = await deps.prepare({
                    meshId: req.meshId, taskId: req.parentTaskId, checkoutRoot: req.sourceWorkspace, config: cfg.config,
                    rootBaseSha: req.rootSha, branch: false, keySuffix: `review-r${req.round}`,
                });
                return {
                    path: handle.path, headSha: handle.rootBaseSha,
                    release: async () => { await deps.remove({ path: handle.path, checkoutRoot: req.sourceWorkspace, config: cfg.config }); },
                };
            } catch (e: any) {
                LOG.warn('StagePipeline', `light reviewer workspace unavailable for ${req.parentTaskId}: ${e?.message || e}`);
                return null;
            }
        },
    };
}

/** Fallback until a reviewer workspace is routed: the reviewer reads the parent's checkout under the read lease. */
export const noReviewerWorkspace: ReviewerWorkspaceProvider = { async prepare() { return null; } };

/**
 * Artifact registration is injected: src/mesh must not value-import src/artifacts (import-boundary gate).
 * boot/stages/mesh-runtime.ts wires `registerSessionArtifact` bound to the mesh runtime DB.
 */
export type StageArtifactRegistrar = (input: { sessionId: string; workspaceRoot: string; path: string; taskId: string; meshId: string; missionId?: string; producerRole: string; originDaemonId?: string; title: string; kind?: ArtifactKind }) => string | null;
let artifactRegistrar: StageArtifactRegistrar | null = null;
export function setStageArtifactRegistrar(fn: StageArtifactRegistrar | null): void { artifactRegistrar = fn; }
/** The boot-installed registrar (also used by light-task result capture); null until boot wires it. */
export function getStageArtifactRegistrar(): StageArtifactRegistrar | null { return artifactRegistrar; }

function stageArtifactOperationKey(input: { kind: string; content: string | Buffer; operationKey?: string }): string {
    if (typeof input.operationKey === 'string' && input.operationKey.trim()) {
        return input.operationKey.trim().replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
    }
    const digest = createHash('sha256').update(input.kind).update('\0').update(input.content).digest('hex').slice(0, 16);
    return `${input.kind}-${digest}`;
}

const defaultSelfCheck = createRefineProfileSelfCheck();
let overrides: { selfCheck?: SelfCheckRunner; reviewerWorkspace?: ReviewerWorkspaceProvider } = {};
/** Connect the light-workspace seams. Call before (or after) installStagePipeline; read lazily per use. */
export function setStagePorts(next: { selfCheck?: SelfCheckRunner; reviewerWorkspace?: ReviewerWorkspaceProvider }): void { overrides = { ...overrides, ...next }; }

/** `ADHDEV_STAGE_PIPELINE_CEILING_MS`, clamped like the turn-policy knobs (1 min … 24 h). */
export function resolveStagePipelineCeilingMs(env: NodeJS.ProcessEnv = process.env): number {
    const raw = Number(env.ADHDEV_STAGE_PIPELINE_CEILING_MS);
    if (!Number.isFinite(raw) || raw <= 0) return STAGE_PIPELINE_CEILING_DEFAULT_MS;
    return Math.min(Math.max(Math.trunc(raw), 60_000), 24 * 60 * 60 * 1000);
}

function stageArtifactDir(taskId: string): string {
    const segment = taskId.replace(/[^A-Za-z0-9_.-]/g, '_');
    if (!segment || segment === '.' || segment === '..') throw new StageDiffBlocked('review_diff_task_path', { taskId });
    return path.join(getConfigDir(), 'stage-artifacts', segment);
}

export function createProductionStagePorts(components: Pick<DaemonComponents, 'sessionRegistry' | 'instanceManager' | 'statusInstanceId'>): StageRuntimePorts {
    const store = () => MeshRuntimeStore.getInstance();
    setDefaultStageGeneratedRecipe(createHostStageVendorRecipe(() => path.join(getConfigDir(), 'stage-vendor-replay')));
    setStageGeneratedRetention(({ taskId, operationKey, index, sha256, bytes }) => {
        const file = path.join(stageArtifactDir(taskId), '.recovery', `${operationKey}-${index}.${sha256.slice(0, 12)}.bin`);
        return readStageReviewArtifact({ id: operationKey, file, sha256, size: bytes });
    });
    const reviewReplacementReady = (parent: MeshWorkQueueEntry): boolean => {
        const stage = parent.stageState;
        if (!stage) return false;
        return stage.reviewTaskIds.every(id => {
            const child = store().findQueueEntryById(parent.meshId, id);
            if (!child || child.parentTaskId !== parent.id || child.stageRole !== 'review') return false;
            if (child.status === 'pending' || child.status === 'assigned') return false;
            const attempt = store().turnStore().findLatestAttemptForTask(parent.meshId, id);
            if (attempt && !isTerminalTurnState(attempt.state)) return false;
            const stop = attempt?.data.writerStop;
            if (attempt && stop) {
                const session = child.assignedSessionId ?? child.autoLaunch?.sessionId;
                return stop.confirmed === true && !stop.settledBy
                    && (!session || sessionIdsEquivalent(session, attempt.sessionId));
            }
            // A completed review relinquishes its turn normally. An abandoned
            // launch or failed/cancelled attempt needs an exact stop receipt:
            // absence of the session from this daemon is not dead proof.
            return child.status === 'completed' || (!attempt && !child.attemptId
                && !child.assignedSessionId && !child.autoLaunch?.sessionId && child.autoLaunch?.status !== 'started');
        });
    };
    const detached = createDetachedStageReviewerWorkspace(() => path.join(getConfigDir(), 'stage-review-checkouts'));
    return {
        now: () => Date.now(),
        sourceGenerated: writeStageSourceGenerated,
        artifactOrigin: () => components.statusInstanceId ?? '',
        selfCheck: { run: req => (overrides.selfCheck ?? defaultSelfCheck).run(req) },
        reviewerWorkspace: {
            prepare: req => (req.required ? detached : overrides.reviewerWorkspace ?? noReviewerWorkspace).prepare(req),
            release: path => detached.release!(path),
        },
        git: defaultStageGit,
        artifacts: {
            readLegacySelfCheck(taskId, after, before) {
                // The old writer used self_check-<Date.now().toString(36)>.md.
                // Only the host's task directory and a unique file within the recorded attempt window qualify.
                if (!/^[a-f0-9-]{36}$/.test(taskId)) return null;
                try {
                    const dir = stageArtifactDir(taskId);
                    const names = fs.readdirSync(dir).filter(name => /^self_check-[a-z0-9]+\.md$/.test(name));
                    const name = names[0];
                    if (names.length !== 1 || !name) return null;
                    const timestamp = Number.parseInt(name.slice(11, -3), 36);
                    if (!(timestamp >= after && timestamp <= before)) return null;
                    const file = path.join(dir, name);
                    const stat = fs.lstatSync(file);
                    if (!stat.isFile() || stat.nlink !== 1 || stat.size > SELF_CHECK_LOG_MAX * 4 + 32
                        || (process.platform !== 'win32' && (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0))) return null;
                    if (fs.realpathSync.native(file) !== file) return null;
                    // Bound the initial digest read too. The normal verifier validates the full descriptor and digest.
                    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
                    let sha256: string;
                    try {
                        const bytes = Buffer.alloc(stat.size + 1);
                        let size = 0;
                        while (size < bytes.length) {
                            const n = fs.readSync(fd, bytes, size, bytes.length - size, null);
                            if (!n) break;
                            size += n;
                        }
                        if (size !== stat.size) return null;
                        sha256 = createHash('sha256').update(bytes.subarray(0, size)).digest('hex');
                    } finally { fs.closeSync(fd); }
                    const operationKey = name.slice(0, -3);
                    const content = readStageReviewArtifact({ id: operationKey, file, size: stat.size, sha256 });
                    if (!content.toString('utf8').startsWith('# Self-check (passed)\n\n')) return null;
                    return { operationKey, sha256, content };
                } catch { return null; }
            },
            verifyRegistered(input) {
                try {
                    const parent = store().findQueueEntryById(input.meshId, input.taskId);
                    if (!parent) return false;
                    const row = store().db.prepare('SELECT * FROM session_artifacts WHERE artifact_id = ?').get(input.artifactId) as any;
                    if (!row || row.task_id !== input.taskId || row.mesh_id !== input.meshId || row.producer_role !== 'pipeline'
                        || row.session_id !== `stage:${input.taskId}` || row.origin_daemon_id !== components.statusInstanceId) return false;
                    const grant = stageReviewArtifactGrants(store(), parent, [input.artifactId])[0];
                    return grant?.sha256 === input.sha256 && grant.size === input.bytes;
                } catch { return false; }
            },
            register(input) {
                const opKey = stageArtifactOperationKey(input);
                try {
                    const dir = stageArtifactDir(input.taskId);
                    const name = `${opKey}${input.ext}`;
                    const full = path.join(dir, name);
                    const nextBuf = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content, 'utf8');
                    if (input.kind === 'diff' && !fs.existsSync(full)) assertStageDiffRetentionGrowth(path.join(getConfigDir(), 'stage-artifacts'), nextBuf.length, fs.existsSync(dir) ? 1 : 2);
                    fs.mkdirSync(dir, { recursive: true });
                    // Idempotent retry: same operation key + same bytes → reuse file; never overwrite a different revision.
                    // Publish via temp+rename. Never unlink a final path just because new bytes extend an old prefix —
                    // a successfully registered shorter body must conflict (preserve evidence), not be "recovered".
                    if (fs.existsSync(full)) {
                        let identical = false;
                        try {
                            readStageReviewArtifact({ id: opKey, file: full, size: nextBuf.length, sha256: createHash('sha256').update(nextBuf).digest('hex') });
                            identical = true;
                        } catch { /* fail closed: changed, oversized, redirected, or non-regular prior payload */ }
                        if (!identical) {
                            return {
                                ok: false as const,
                                code: 'artifact_revision_conflict',
                                message: `Stage artifact path "${name}" already exists with different content`,
                                retryable: false,
                                preserved: true,
                            };
                        }
                    } else {
                        // Best-effort: remove leftover incomplete publish temps for this key (never the final).
                        if (input.kind !== 'diff') try {
                            for (const entry of fs.readdirSync(dir)) {
                                if (entry.startsWith(`${name}.publishing.`)) {
                                    try { fs.unlinkSync(path.join(dir, entry)); } catch { /* best-effort */ }
                                }
                            }
                        } catch { /* dir listing optional */ }
                        const tmp = `${full}.publishing.${process.pid}.${Date.now()}`;
                        try {
                            const fd = fs.openSync(tmp, 'wx');
                            try {
                                fs.writeFileSync(fd, nextBuf);
                                fs.fsyncSync(fd);
                            } finally {
                                fs.closeSync(fd);
                            }
                            fs.renameSync(tmp, full);
                        } catch (e) {
                            if (input.kind !== 'diff') try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
                            throw e;
                        }
                    }
                    if (!artifactRegistrar) {
                        return {
                            ok: false as const,
                            code: 'artifact_storage_unavailable',
                            message: 'Stage artifact registrar is not wired',
                            retryable: false,
                            preserved: true,
                        };
                    }
                    const id = artifactRegistrar({
                        sessionId: `stage:${input.taskId}`, workspaceRoot: dir, path: name, taskId: input.taskId, meshId: input.meshId,
                        ...(input.missionId ? { missionId: input.missionId } : {}), producerRole: 'pipeline', title: input.title,
                        ...(components.statusInstanceId ? { originDaemonId: components.statusInstanceId } : {}),
                    });
                    if (!id) {
                        return {
                            ok: false as const,
                            code: 'artifact_storage_unavailable',
                            message: 'Stage artifact registrar returned null',
                            retryable: false,
                            preserved: true,
                        };
                    }
                    return { ok: true as const, artifactId: id };
                } catch (e: any) {
                    if (e instanceof StageDiffBlocked) return { ok: false as const, code: e.code, message: e.message, retryable: false, preserved: false, details: e.details };
                    if (isArtifactGuardLike(e)) {
                        LOG.warn('StagePipeline', `artifact registration failed for ${input.taskId}: ${e.message}`);
                        return {
                            ok: false as const,
                            code: e.code,
                            message: e.message,
                            retryable: e.retryable,
                            preserved: e.details?.preserved === true || e.details?.preserved === undefined,
                            ...(e.details ? { details: { ...e.details } } : {}),
                        };
                    }
                    const code = String(e?.code ?? '');
                    const message = String(e?.message || e);
                    const mapped =
                        code === 'EEXIST' ? 'artifact_revision_conflict'
                            : (code === 'ENOSPC' || /artifact_storage_budget_exceeded|artifact_storage_unavailable|session_artifact_limit|mission_artifact_limit|mesh_artifact_limit|artifact_revision_conflict/i.test(message))
                                ? (message.match(/\(([a-z0-9_]+)\)\s*$/i)?.[1] ?? (code === 'ENOSPC' ? 'artifact_storage_unavailable' : 'artifact_storage_unavailable'))
                                : 'artifact_storage_unavailable';
                    LOG.warn('StagePipeline', `artifact registration failed for ${input.taskId}: ${message}`);
                    return {
                        ok: false as const,
                        code: mapped,
                        message,
                        retryable: false,
                        preserved: true,
                        ...(code === 'ENOSPC' ? { details: { errno: 'ENOSPC', recovery: 'free_disk_or_reduce_payload' } } : {}),
                    };
                }
            },
            writeRecovery(input) {
                const opKey = input.operationKey.trim().replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
                if (!opKey) return { ok: false as const, code: 'artifact_storage_unavailable', message: 'recovery operationKey required' };
                const ext = input.ext.startsWith('.') ? input.ext : `.${input.ext}`;
                const buf = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content, 'utf8');
                const sha256 = createHash('sha256').update(buf).digest('hex');
                const digest12 = sha256.slice(0, 12);
                // Digest-immutable name: never overwrite a different payload for the same opKey.
                const fileName = `${opKey}.${digest12}${ext}`;
                try {
                    const dir = path.join(stageArtifactDir(input.taskId), '.recovery');
                    const full = path.join(dir, fileName);
                    const relPath = path.posix.join('.recovery', fileName);
                    if (opKey.startsWith('diff-') && !fs.existsSync(full)) assertStageDiffRetentionGrowth(path.join(getConfigDir(), 'stage-artifacts'), buf.length, fs.existsSync(dir) ? 1 : 3);
                    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
                    if (fs.existsSync(full)) {
                        const existing = Buffer.isBuffer(input.content)
                            ? readStageReviewArtifact({ id: opKey, file: full, size: buf.length, sha256 })
                            : fs.readFileSync(full);
                        if (existing.equals(buf)) {
                            return { ok: true as const, relPath, sha256, bytes: buf.length, reused: true };
                        }
                        // Same path should be unique per digest; treat as conflict without overwrite.
                        return {
                            ok: false as const,
                            code: 'artifact_revision_conflict',
                            message: `Recovery path "${fileName}" exists with different content`,
                            preserved: true,
                            existingSha256: createHash('sha256').update(existing).digest('hex'),
                        };
                    }
                    // Detect a prior different-digest recovery for this op (do not delete it).
                    try {
                        for (const entry of fs.readdirSync(dir)) {
                            if (entry.includes('.publishing.')) continue;
                            if (!entry.startsWith(`${opKey}.`) || entry === fileName) continue;
                            // Another digest for this op already held — keep it; still publish this digest beside it.
                            break;
                        }
                    } catch { /* listing optional */ }
                    const tmp = `${full}.publishing.${process.pid}.${Date.now()}`;
                    try {
                        const fd = fs.openSync(tmp, 'wx', 0o600);
                        try {
                            fs.writeFileSync(fd, buf);
                            fs.fsyncSync(fd);
                        } finally {
                            fs.closeSync(fd);
                        }
                        fs.renameSync(tmp, full);
                    } catch (e) {
                        if (!opKey.startsWith('diff-')) try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
                        throw e;
                    }
                    return { ok: true as const, relPath, sha256, bytes: buf.length };
                } catch (e: any) {
                    if (e instanceof StageDiffBlocked) return { ok: false as const, code: e.code, message: JSON.stringify(e.details), preserved: false };
                    const code = String(e?.code ?? '');
                    return {
                        ok: false as const,
                        code: code === 'ENOSPC' ? 'artifact_storage_unavailable' : 'artifact_storage_unavailable',
                        message: String(e?.message || e),
                        preserved: false,
                    };
                }
            },
            readRecovery(input) {
                const opKey = input.operationKey.trim().replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
                if (!opKey) return null;
                const base = path.join(stageArtifactDir(input.taskId), '.recovery');
                const want = input.sha256?.toLowerCase();
                try {
                    const entries = fs.readdirSync(base).filter((e) => !e.includes('.publishing.') && e.startsWith(`${opKey}.`));
                    if (want) {
                        // Always hash file contents — digest-prefix filename alone is not integrity proof
                        // (a same-name file can be replaced with different valid JSON).
                        const prefer = entries.filter((e) => e.includes(`.${want.slice(0, 12)}.`));
                        const ordered = [...prefer, ...entries.filter((e) => !prefer.includes(e))];
                        for (const entry of ordered) {
                            const raw = fs.readFileSync(path.join(base, entry));
                            if (createHash('sha256').update(raw).digest('hex') === want) return raw.toString('utf8');
                        }
                        return null;
                    }
                    if (entries.length === 1) return fs.readFileSync(path.join(base, entries[0]!), 'utf8');
                } catch { /* missing dir */ }
                return null;
            },
        },
        queue: {
            reviewReplacementReady,
            requiresDetachedReview(parent) {
                const id = parent.stageState?.artifacts?.diff?.at(-1);
                if (!id) return false;
                const grant = stageReviewArtifactGrants(store(), parent, [id])[0];
                return !!grant && !!decodeStageSourceGenerated(readStageReviewArtifact(grant));
            },
            reviewInputValid: (parent, child) => {
                try {
                    validateStageReviewRetainedGrants(store(), parent, child.inputArtifactIds ?? []);
                    return child.reviewerWorkspace && !parent.stageReviewInput
                        ? child.reviewerWorkspace.headSha === parent.stageState?.stageHeads.at(-1)?.rootSha
                        : !!currentStageReviewScope(parent, child);
                }
                catch { return false; }
            },
            get: (meshId, taskId) => store().findQueueEntryById(meshId, taskId) ?? null,
            mutate: (meshId, taskId, fn) => withQueueLock(meshId, () => {
                const e = store().findQueueEntryById(meshId, taskId);
                if (!e) return null;
                fn(e);
                e.updatedAt = new Date().toISOString();
                store().updateQueueEntry(e);
                return e;
            }),
            listStageParents: () => {
                const out: MeshWorkQueueEntry[] = [];
                for (const mesh of listMeshes()) {
                    try { out.push(...store().getQueueEntries(mesh.id, ['assigned', 'pending']).filter(e => isStageParent(e) && !e.stageState!.released)); } catch { /* mesh without a queue */ }
                }
                return out;
            },
            enqueueReviewChild: (parent, spec) => {
                return withQueueLock(parent.meshId, () => {
                    const current = store().findQueueEntryById(parent.meshId, parent.id);
                    if (!current || current.status !== 'assigned' || current.stageState?.released
                        || (current.stageState?.phase !== 'awaiting_review' && current.stageState?.phase !== 'reviewing') || current.stageState.round !== spec.round
                        || (current.revision ?? 0) !== (parent.revision ?? 0)) throw new Error('stage_review_stale_parent');
                    // Transactional idempotency: a retry cannot create a second child for the same round.
                    const existing = current.stageState.reviewTaskIds.map(id => store().findQueueEntryById(parent.meshId, id))
                        .find(c => c?.stageRound === spec.round && (c.status === 'pending' || c.status === 'assigned'));
                    if (existing && (existing.status === 'assigned' || existing.assignedSessionId || existing.attemptId || existing.autoLaunch?.sessionId)) throw new Error('stage_review_already_started');
                    if (existing) return existing;
                    if (!reviewReplacementReady(current)) throw new Error('stage_review_writer_checkpoint_pending');
                    let proof;
                    let message = spec.message;
                    const { grants, withheld } = stageReviewArtifactGrantsWithheld(store(), current, spec.inputArtifactIds,
                        new Set(current.stageState.workerArtifactIds ?? []));
                    validateCurrentDiff(current, grants);
                    const inputArtifactIds = grants.map(g => g.id);
                    const latest = grants.find(g => g.id === current.stageState!.artifacts?.diff?.at(-1));
                    const latestBytes = latest && readStageReviewArtifact(latest);
                    const sourceGenerated = latestBytes && decodeStageSourceGenerated(latestBytes);
                    if (sourceGenerated) {
                        if (spec.reviewerWorkspace?.headSha !== sourceGenerated.scope.headSha) throw new Error('review_detached_checkout_required');
                        message += '\n\nRead the adhdev-stage-source-generated manifest and every sourceChunks artifact in order with artifact_read, following nextOffset until hasMore is false. Read the entire source patch and review the classified inventory. The manifest records host-verified generated output parity; raw generated bytes stay in private retention.';
                    } else if (latest?.file.endsWith('-manifest.json')) {
                        message += '\n\nThe full review diff is a versioned adhdev-stage-diff manifest. Use artifact_read on its id with byte offset/limit for a bounded page of the complete root+OSS input; artifact_fetch returns the manifest metadata. If an older/remote reader returns raw JSON, read the listed chunk ids in manifest order with artifact_read. byteContentBase64 preserves exact page bytes, including UTF-8 boundaries. Verify total/section hashes; a partial read is not evidence of reviewing the entire scope.';
                    }
                    if (withheld.length) {
                        message = `${message}\n\nNote: implementer artifact(s) ${withheld.join(', ')} changed or disappeared after registration and are withheld. Read the code and complete diff input.`;
                        LOG.warn('StagePipeline', `review child for ${parent.id}: withheld changed implementer artifact(s) ${withheld.join(', ')}`);
                    }
                    // The read-lease reviewer must run in the PARENT's checkout. Without a node target the
                    // queue could hand the child to any idle session, and a claim from another checkout is
                    // then refused review_input_unavailable (a generic hold) instead of being routed here.
                    const reviewNodeId = current.assignedNodeId ?? current.targetNodeId;
                    if (!spec.reviewerWorkspace || sourceGenerated) {
                        const nodeId = reviewNodeId;
                        const mesh = getMesh(current.meshId);
                        const node = mesh?.nodes?.find(n => n.id === nodeId);
                        const machineId = getMachineId();
                        if (!nodeId || !node?.workspace || !mesh?.repoIdentity || !machineId
                            || !components.statusInstanceId || !daemonIdsEquivalent(node.daemonId, components.statusInstanceId)) throw new Error('review_input_local_context_required');
                        // An artifact the implementer only cited may have changed after it was registered: withhold
                        // it (and say so) rather than failing the review; the pipeline's own evidence stays required.
                        proof = attestStageReviewInput(current, { repoIdentity: mesh.repoIdentity, machineId, nodeId, workspace: spec.reviewerWorkspace?.path ?? node.workspace }, grants);
                        if (sourceGenerated && proof.checkout.worktree === fs.realpathSync.native(node.workspace)) throw new Error('review_detached_checkout_required');
                        if (reviewInputBusy(current, proof.checkout, store().getQueueEntries(current.meshId, ['assigned', 'pending']), true)) throw new Error('review_input_busy');
                    }
                    const child = enqueueTask(parent.meshId, message, {
                        stageChild: { parentTaskId: parent.id, round: spec.round, review: { sourceTaskId: parent.id, independence: spec.independence }, ...(spec.reviewerWorkspace ? { reviewerWorkspace: spec.reviewerWorkspace } : {}) },
                        difficulty: parent.difficulty === 'difficult' ? 'difficult' : 'medium',
                        ...(parent.missionId ? { missionId: parent.missionId } : {}),
                        inputArtifactIds, inheritArtifacts: false,
                        ...(spec.targetSessionId ? { targetSessionId: spec.targetSessionId } : {}),
                        ...((!spec.reviewerWorkspace || sourceGenerated) && reviewNodeId ? { targetNodeId: reviewNodeId } : {}),
                        ...(parent.sourceCoordinatorSessionId ? { sourceCoordinatorSessionId: parent.sourceCoordinatorSessionId } : {}),
                    });
                    if (proof) { proof.childTaskId = child.id; current.stageReviewInput = proof; }
                    else delete current.stageReviewInput;
                    current.stageState.reviewTaskIds.push(child.id);
                    delete current.stageState.reviewFingerprint;
                    delete current.stageState.reviewFingerprintUnavailable;
                    if (spec.reviewFingerprint) current.stageState.reviewFingerprint = spec.reviewFingerprint;
                    else if (!spec.reviewerWorkspace) current.stageState.reviewFingerprintUnavailable = true;
                    store().updateQueueEntry(current);
                    return child;
                });
            },
            cancel: (meshId, taskId, reason) => { cancelTask(meshId, taskId, { reason, stageManaged: true }); },
            setChildIndependence: (meshId, childId, independence) => {
                withQueueLock(meshId, () => {
                    const c = store().findQueueEntryById(meshId, childId);
                    if (!c?.review || c.status !== 'pending') return;
                    c.review = { sourceTaskId: c.review.sourceTaskId, independence };
                    store().updateQueueEntry(c);
                });
            },
            commitParent: (parent, status, envelope, reason) => {
                commitTaskTerminal({
                    meshId: parent.meshId, taskId: parent.id, status, source: 'queue_policy', reason,
                    ...(parent.assignedSessionId ? { sessionId: parent.assignedSessionId } : {}),
                    envelope: { finalSummary: envelope.finalSummary, evidence: envelope.evidence, completedAt: new Date().toISOString() },
                });
            },
            requeueForRevision: (parent, memo, opts) => {
                withQueueLock(parent.meshId, () => {
                    const e = store().findQueueEntryById(parent.meshId, parent.id);
                    if (!e || !e.stageState) return;
                    const revisionGrants = opts.inputArtifactIds.length
                        ? stageReviewArtifactGrantsWithheld(store(), e, opts.inputArtifactIds, new Set(e.stageState.workerArtifactIds ?? [])).grants.map(g => g.id)
                        : [];
                    e.stageState.originalMessage ??= e.message;
                    // Keep the checkout: pin to the same node, and to the same session when it is still alive.
                    if (e.assignedNodeId) e.targetNodeId = e.assignedNodeId;
                    if (opts.sameSessionId) e.targetSessionId = opts.sameSessionId; else delete e.targetSessionId;
                    delete e.assignedNodeId; delete e.assignedSessionId; delete e.assignedProviderType; delete e.assignedModel;
                    delete e.dispatchTimestamp; delete e.autoLaunch; delete e.attemptId;
                    e.dispatchNonce = (e.dispatchNonce || 0) + 1;
                    e.message = `${memo}\n\n(Original task, for reference:)\n${e.stageState.originalMessage}`;
                    e.inputArtifactIds = [...new Set([...(e.inputArtifactIds ?? []), ...revisionGrants])];
                    e.status = 'pending';
                    // Re-anchor the target-pin TTL (it ages from requeuedAt/createdAt): without this a
                    // revision pinned back to the session that just finished the round inherits the
                    // task's original age and parks on the very next tick (live: 7491s ≥ 900s, 19 s
                    // after the round's report).
                    e.requeuedAt = new Date().toISOString();
                    e.updatedAt = e.requeuedAt;
                    store().updateQueueEntry(e);
                    endTaskDispatchInFlight(parent.meshId, parent.id);
                });
            },
            sessionAlive: sessionId => {
                if (!sessionId) return false;
                try { return !!(components.sessionRegistry?.has(sessionId) || components.instanceManager?.getInstance?.(sessionId)); } catch { return false; }
            },
            sessionMeetsDifficulty: (meshId, sessionId, difficulty) => {
                try {
                    const state: any = components.instanceManager?.getInstance?.(sessionId)?.getState?.();
                    if (!state) return true; // not observable here: let the claim side judge, as before
                    const settings = state.settings || {};
                    const nodeId = String(settings.meshNodeId || settings.nodeId || '');
                    const node = getMesh(meshId)?.nodes?.find(n => daemonIdsEquivalent(n.id, nodeId));
                    if (!node) return true;
                    const providerType = String(state.type || settings.providerType || '');
                    const allowed = allowedClassifiedDifficultiesForSession(node, resolveNodeCapabilitySlots(node, meshId), providerType, readSessionModel(state));
                    return taskMeetsSessionDifficultyFloor({ difficulty }, allowed);
                } catch { return true; }
            },
        },
        events: {
            progress: (meshId, taskId, text) => {
                try { meshRecord(meshId, 'stage_progress', { payload: { taskId, text: text.slice(0, 300) } }, { local: true }); } catch { /* audit only */ }
            },
            implementerFinished: parent => {
                // The worker-report hook skipped this while the report was held; record it now (same audit row the reaper reads).
                recordAcceptedSessionCompletion({ meshId: parent.meshId, taskId: parent.id, ...(parent.assignedSessionId ? { sessionId: parent.assignedSessionId } : {}), ...(parent.attemptId ? { attemptId: parent.attemptId } : {}) }, Date.now());
            },
            notifyParentTerminal: (parent, status, report) => {
                const message = `[System] Stage task ${parent.id} ${status}.\n${report}`;
                try {
                    notifyMeshCoordinator({
                        meshId: parent.meshId, event: 'mesh:stage_terminal', nodeLabel: parent.assignedNodeId ?? '',
                        ...(parent.assignedNodeId ? { nodeId: parent.assignedNodeId } : {}),
                        metadataEvent: { source: 'stage_pipeline', taskId: parent.id, status, coordinatorMessage: message },
                        coordinatorMessage: message, queuedAt: Date.now(),
                        eventId: `stage-terminal:${parent.id}:${status}`,
                        ...(parent.sourceCoordinatorSessionId ? { targetCoordinatorSessionId: parent.sourceCoordinatorSessionId } : {}),
                    });
                } catch (e: any) { LOG.warn('StagePipeline', `parent terminal notice failed for ${parent.id}: ${e?.message || e}`); }
            },
        },
        workspaceOf: parent => {
            // Light implementer: prefer the private light workspace path (Contract B provenance).
            if (parent.light && parent.lightWorkspaceId) {
                try {
                    const lw = getLightWorkspace(store().db, parent.lightWorkspaceId);
                    if (lw?.path) return lw.path;
                } catch { /* fall through */ }
            }
            const nodeId = parent.assignedNodeId ?? parent.targetNodeId;
            if (parent.ownershipScope?.worktree) return parent.ownershipScope.worktree;
            const mesh = getMesh(parent.meshId) as { nodes?: Array<{ id?: string; nodeId?: string; workspace?: string }> } | undefined;
            return mesh?.nodes?.find(n => (n.id ?? n.nodeId) === nodeId)?.workspace ?? null;
        },
        pipelineCeilingMs: () => resolveStagePipelineCeilingMs(),
    };
}


let installed: StagePipelineHandle | null = null;
/** The runtime installed for this daemon (undefined before boot) — used by the stage-decide command. */
export function getInstalledStagePipeline(): StagePipelineHandle | null { return installed; }

export interface StagePipelineHandle { runtime: StagePipelineRuntime; tick(): Promise<void>; dispose(): void }

/** Register the runtime with the terminal hooks and the notice-silence lookup. Idempotent per daemon boot. */
export function installStagePipeline(components: Pick<DaemonComponents, 'sessionRegistry' | 'instanceManager' | 'statusInstanceId'>, ports: StageRuntimePorts = createProductionStagePorts(components)): StagePipelineHandle {
    const runtime = new StagePipelineRuntime(ports);
    setStageHookTarget(runtime);
    setStageNoticeLookup((meshId, taskId) => {
        const e = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId);
        if (isStageChild(e)) return 'child';
        return isStageParent(e) && !e!.stageState!.released && e!.status === 'assigned' ? 'held_parent' : null;
    });
    installed = {
        runtime,
        tick: () => runtime.tick().catch(e => LOG.warn('StagePipeline', `tick failed: ${e?.message || e}`)),
        dispose() { setStageHookTarget(null); setStageNoticeLookup(null); installed = null; },
    };
    return installed;
}

