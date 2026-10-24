import { execFileSync } from 'node:child_process';
import { snapshotRefinePublicationContract } from '../../src/mesh/mesh-refine-publication-contract.js';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

import { DaemonCommandRouter } from '../../src/commands/router'
import { resumePendingRefineJobsOnStartup } from '../../src/commands/router-refine-resume.js';
import { createMesh, addNode } from '../../src/config/mesh-config'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store'
import { insertLocalRecordRow } from '../helpers/local-records'
import { readLocalRecords } from '../../src/mesh/mesh-local-records'
import type { RefinePublicationOptions } from '../../src/mesh/mesh-refine-publication-contract'

/**
 * JOBID-RESUME-PRESERVE regression suite.
 *
 * Root cause (mesh investigation task 16129ea9): resumePendingRefineJobsOnStartup
 * re-dispatched an interrupted refine job via `startMeshRefineJob(self, meshId,
 * nodeId, { coordinatorDaemonId })` — WITHOUT the original jobId. startMeshRefineJob
 * always minted a fresh `refine_${...}` jobId, so:
 *   (1) ZOMBIE: the ORIGINAL jobId's `task_dispatched` ledger entry could never
 *       receive a matching `task_completed`/`task_failed` (those are stamped with
 *       the NEW jobId), so every future boot saw it as still-unterminated and
 *       resumed it again — forever.
 *   (2) GHOST: the NEW jobId ran a full second execution against a worktree/mesh
 *       state a coordinator may already consider converged.
 *
 * The fix: startMeshRefineJob honors `args.jobId` when present, and
 * resumePendingRefineJobsOnStartup passes the original jobId through. A grace
 * window (RESUME-DISPATCH-GRACE) defers resuming dispatches that are too recent to
 * safely assume dead; a zombie cutoff (RESUME-ZOMBIE-CUTOFF) closes out ancient
 * un-terminated dispatches as failed instead of resuming them forever.
 */

function createRouter() {
  return new DaemonCommandRouter({
    commandHandler: { handle: async () => ({ success: false }) } as any,
    cliManager: {} as any,
    cdpManagers: new Map(),
    providerLoader: {} as any,
    instanceManager: {
      collectAllStates: () => [],
      listInstanceIds: () => [],
      getInstance: () => null,
      getByCategory: () => [],
    } as any,
    detectedIdes: { value: [] },
    sessionRegistry: {} as any,
    packageName: 'adhdev',
    statusVersion: '0.9.76',
  } as any)
}

// Appends a task_dispatched ledger entry directly at the SQLite store layer (the
// primary read path — see mesh-ledger.ts G2 comment) with a CALLER-CONTROLLED
// timestamp. mesh-ledger.ts's own seedLocalRecord always stamps `new
// Date().toISOString()`, which cannot express "dispatched N ms ago" for the
// grace/cutoff tests below.
function appendDispatchedEntry(meshId: string, nodeId: string, jobId: string, timestamp: string, publicationContract?: RefinePublicationOptions) {
  insertLocalRecordRow({
    id: randomUUID(),
    meshId,
    timestamp,
    kind: 'task_dispatched',
    nodeId,
    payload: {
      source: 'refine_mesh_node_async_job',
      refineJob: { jobId, meshId, nodeId, status: 'accepted', startedAt: timestamp, publicationContract },
      async: true,
    },
  })
}

describe('resumePendingRefineJobsOnStartup — JOBID-RESUME-PRESERVE', () => {
  let root: string
  let previousConfigDir: string | undefined

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'adhdev-refine-resume-jobid-'))
    previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    process.env.ADHDEV_CONFIG_DIR = join(root, '.adhdev')
    MeshRuntimeStore.resetForTests()
  })

  afterEach(() => {
    MeshRuntimeStore.resetForTests()
    if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
    else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { rmSync(root, { recursive: true, force: true }); return } catch { /* retry */ }
    }
  })

  function setUpMeshWithWorktreeNode(nodeId: string) {
    const repo = join(root, 'repo')
    const worktree = join(root, 'worktree')
    mkdirSync(repo, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    const mesh = createMesh({ name: 'Resume JobId Mesh', repoRemoteUrl: 'https://example.com/example/repo.git' })
    const sourceNode = addNode(mesh.id, { workspace: repo, repoRoot: repo })!
    addNode(mesh.id, {
      id: nodeId,
      workspace: worktree,
      repoRoot: worktree,
      isLocalWorktree: true,
      worktreeBranch: 'feat/refine',
      clonedFromNodeId: sourceNode.id,
    })
    return mesh.id
  }

  it('①resumes an old (past the grace window) interrupted job UNDER ITS ORIGINAL jobId, not a freshly minted one', async () => {
    const meshId = setUpMeshWithWorktreeNode('node-old-dispatch')
    const originalJobId = 'refine_original_zombie_test'
    // 10 minutes ago — well past the default 60s grace window, well under the 24h
    // zombie cutoff: squarely "genuinely interrupted, safe to resume".
    const dispatchedAt = new Date(Date.now() - 10 * 60_000).toISOString()
    appendDispatchedEntry(meshId, 'node-old-dispatch', originalJobId, dispatchedAt)

    const router = createRouter()
    await resumePendingRefineJobsOnStartup(router)

    // The resumed run reserved runningRefineJobs under the ORIGINAL jobId — proof
    // that startMeshRefineJob was called WITH args.jobId, not left to mint its own.
    // Before the fix this key would hold a DIFFERENT (freshly minted) jobId.
    const key = `${meshId}:node-old-dispatch`
    const handle = (router as any).runningRefineJobs.get(key)
    expect(handle).toBeDefined()
    expect(handle.jobId).toBe(originalJobId)
  })

  it('②does NOT resume a dispatch inside the grace window — it may still be running elsewhere', async () => {
    const meshId = setUpMeshWithWorktreeNode('node-fresh-dispatch')
    const originalJobId = 'refine_fresh_inflight_test'
    // 1 second ago — inside the default 60s RESUME-DISPATCH-GRACE window.
    const dispatchedAt = new Date(Date.now() - 1_000).toISOString()
    appendDispatchedEntry(meshId, 'node-fresh-dispatch', originalJobId, dispatchedAt)

    const router = createRouter()
    await resumePendingRefineJobsOnStartup(router)

    // Nothing was dispatched: no placeholder/handle was ever reserved for this key.
    const key = `${meshId}:node-fresh-dispatch`
    expect((router as any).runningRefineJobs.has(key)).toBe(false)
  })

  it('rc28 recovery preserves FF-only authority and records it on the resumed dispatch', async () => {
    const nodeId = 'node-strict-dispatch';
    const meshId = setUpMeshWithWorktreeNode(nodeId);
    const contract: RefinePublicationOptions = { mergeMode: 'ff-only', approvedTargetShas: { [nodeId]: 'a'.repeat(40) }, approvedPublishShas: { root: ['a'.repeat(40)] } };
    appendDispatchedEntry(meshId, nodeId, 'refine_strict_recovery', new Date(Date.now() - 600_000).toISOString(), contract);
    const router = createRouter();
    await resumePendingRefineJobsOnStartup(router);
    // Recovery schedules async acceptance; wait for its durable dispatch rather
    // than inspecting the synchronous slot-reservation placeholder.
    await vi.waitFor(() => {
      const dispatches = readLocalRecords(meshId, { kind: ['task_dispatched'], turnTerminals: false });
      expect(dispatches.filter(e => JSON.stringify((e.payload as any).refineJob?.publicationContract) === JSON.stringify(contract)).length).toBe(2);
    });
  })

  for (const kind of ['divergent approved batch node', 'undefined map', 'missing node', 'corrupt envelope'] as const) {
    it(`R2 durable recovery ${kind} retains authority and refuses before rewrite/commit/push`, async () => {
      const nodeId = 'node-recovery'; const meshId = setUpMeshWithWorktreeNode(nodeId);
      const repo = join(root, 'repo'), worktree = join(root, 'worktree'), bare = join(root, 'remote.git');
      const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.name', 'vilmire'); git(repo, 'config', 'user.email', 'vilmire@users.noreply.github.com');
      writeFileSync(join(repo, 'base'), 'base'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'Fixture base');
      git(repo, 'init', '-q', '--bare', '-b', 'main', bare); git(repo, 'remote', 'add', 'origin', bare); git(repo, 'push', '-qu', 'origin', 'main');
      git(repo, 'worktree', 'add', '-qb', 'feat/refine', worktree);
      writeFileSync(join(worktree, 'candidate'), 'approved'); git(worktree, 'add', '.'); git(worktree, 'commit', '-qm', 'Approved candidate');
      const target = git(worktree, 'rev-parse', 'HEAD');
      writeFileSync(join(repo, 'advance'), 'main advanced'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'Main advance'); git(repo, 'push', '-q', 'origin', 'main');
      const before = { refs: git(repo, 'show-ref', '--heads'), parents: git(worktree, 'show', '-s', '--format=%P', 'HEAD'), count: git(repo, 'cat-file', '--batch-all-objects', '--batch-check=%(objecttype)'), remote: git(bare, 'rev-parse', 'main') };
      const contract = kind === 'corrupt envelope' ? null : snapshotRefinePublicationContract({ mergeMode: 'merge',
        ...(kind === 'divergent approved batch node' ? { approvedPublishShasByNode: { [nodeId]: { root: [target] } } }
          : kind === 'undefined map' ? { approvedPublishShasByNode: undefined } : { approvedPublishShasByNode: {} }),
      });
      appendDispatchedEntry(meshId, nodeId, 'refine_r2_recovery', new Date(Date.now() - 600_000).toISOString(), contract as any);
      const trace = join(root, 'trace'); writeFileSync(trace, ''); const oldTrace = process.env.GIT_TRACE; process.env.GIT_TRACE = trace;
      try {
        const router = createRouter(); await resumePendingRefineJobsOnStartup(router);
        await vi.waitFor(() => {
          const terminal = readLocalRecords(meshId, { kind: ['task_failed'], turnTerminals: false }).find(e => (e.payload as any)?.refineJob?.jobId === 'refine_r2_recovery');
          expect((terminal?.payload as any)?.result?.code).toBe(kind === 'divergent approved batch node' ? 'approved_history_requires_ff' : 'publish_approval_required');
        }, { timeout: 15000 });
        const dispatches = readLocalRecords(meshId, { kind: ['task_dispatched'], turnTerminals: false });
        expect(dispatches.some(e => JSON.stringify((e.payload as any).refineJob?.publicationContract) === JSON.stringify(contract === null ? { approvedPublishShas: null } : contract))).toBe(true);
        expect({ refs: git(repo, 'show-ref', '--heads'), parents: git(worktree, 'show', '-s', '--format=%P', 'HEAD'), count: git(repo, 'cat-file', '--batch-all-objects', '--batch-check=%(objecttype)'), remote: git(bare, 'rev-parse', 'main') }).toEqual(before);
        expect(readFileSync(trace, 'utf8')).not.toMatch(/built-in: git (?:[^\n]* )?(?:rebase|commit|commit-tree|merge|push)(?: |$)/m);
      } finally { if (oldTrace === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = oldTrace; }
    }, 30000);
  }

  it('③closes out an ancient (past the zombie cutoff) dispatch as failed WITHOUT resuming it, and does not re-surface it on a later boot', async () => {
    const meshId = setUpMeshWithWorktreeNode('node-ancient-dispatch')
    const originalJobId = 'refine_ancient_zombie_test'
    // 30 days ago — far past the default 24h RESUME-ZOMBIE-CUTOFF.
    const dispatchedAt = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString()
    appendDispatchedEntry(meshId, 'node-ancient-dispatch', originalJobId, dispatchedAt)

    const router = createRouter()
    await resumePendingRefineJobsOnStartup(router)

    // Not resumed: no running-job placeholder was ever created for it.
    const key = `${meshId}:node-ancient-dispatch`
    expect((router as any).runningRefineJobs.has(key)).toBe(false)

    // A synthetic task_failed entry closes the ledger loop so this dispatch stops
    // reading as "pending" — without this, resumePendingRefineJobsOnStartup would
    // see the SAME un-terminated task_dispatched entry again on the next boot.
    const { readLocalRecords } = await import('../../src/mesh/mesh-local-records')
    const entries = readLocalRecords(meshId, { kind: ['task_completed', 'task_failed'] })
    const terminalForJob = entries.find(e => (e.payload as any)?.refineJob?.jobId === originalJobId)
    expect(terminalForJob).toBeDefined()
    expect(terminalForJob!.kind).toBe('task_failed')

    // Simulate a SECOND boot: this dispatch must not be treated as pending again —
    // proof that the zombie is actually closed out, not just skipped this once.
    const secondRouter = createRouter()
    await resumePendingRefineJobsOnStartup(secondRouter)
    expect((secondRouter as any).runningRefineJobs.has(key)).toBe(false)
  })

  it('④a genuinely failed validation (real cmds>0 failure) still surfaces as a normal terminal entry — the grace/cutoff guards do not swallow real failures', async () => {
    // This is a documentation-style assertion of the constraint, not a re-test of
    // the validation gate itself (covered elsewhere): resumePendingRefineJobsOnStartup
    // only touches entries that are STILL `task_dispatched` with NO terminal match.
    // A real validation failure always appends its own task_failed entry (see
    // finishMeshRefineJob / appendRefineJobLedger call sites elsewhere in
    // router-refine.ts) which immediately satisfies the `terminal.has(...)` check
    // on the very next boot scan — so a real failure is never reachable by the
    // grace-window or zombie-cutoff branches added here, regardless of commandsRun.
    const meshId = setUpMeshWithWorktreeNode('node-real-failure')
    const jobId = 'refine_real_failure_test'
    const dispatchedAt = new Date(Date.now() - 10 * 60_000).toISOString()
    appendDispatchedEntry(meshId, 'node-real-failure', jobId, dispatchedAt)
    insertLocalRecordRow({
      id: randomUUID(),
      meshId,
      timestamp: new Date().toISOString(),
      kind: 'task_failed',
      nodeId: 'node-real-failure',
      payload: {
        source: 'refine_mesh_node_async_job',
        refineJob: { jobId, meshId, nodeId: 'node-real-failure', status: 'failed' },
        result: { success: false, code: 'validation_failed', validationSummary: { commandsRun: [{ passed: false }] } },
      },
    })

    const router = createRouter()
    await resumePendingRefineJobsOnStartup(router)

    // Already terminal — must not be resumed, and no synthetic zombie entry needed.
    const key = `${meshId}:node-real-failure`
    expect((router as any).runningRefineJobs.has(key)).toBe(false)
  })
})
