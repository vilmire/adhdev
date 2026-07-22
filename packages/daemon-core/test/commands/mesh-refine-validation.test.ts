import { beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { DaemonCommandRouter } from '../../src/commands/router'
import { readLedgerEntries } from '../../src/mesh/mesh-ledger'
import { drainPendingMeshCoordinatorEvents, getPendingMeshCoordinatorEvents, handleMeshForwardEvent, runMeshReconcileTick } from '../../src/mesh/mesh-events'
import { computeStaleInputsDigest } from '../../src/mesh/worktree-bootstrap-config'

function createRouter(meshId?: string, messages?: string[], statusInstanceId?: string) {
  const coordinator = meshId && messages
    ? {
        // status: 'idle' so the reconcile loop will drain + inject queued events
        // (queue-only delivery: injectMeshSystemMessage no longer pushes directly).
        getState: () => ({ instanceId: 'coord-refine-test', status: 'idle', settings: { meshCoordinatorFor: meshId } }),
        onEvent: (_event: string, payload: any) => messages.push(payload?.input?.text || ''),
      }
    : null
  return new DaemonCommandRouter({
    commandHandler: { handle: async () => ({ success: false }) } as any,
    cliManager: {} as any,
    cdpManagers: new Map(),
    providerLoader: {} as any,
    instanceManager: {
      collectAllStates: () => [],
      listInstanceIds: () => [],
      getInstance: () => null,
      getByCategory: (category: string) => category === 'cli' && coordinator ? [coordinator] : [],
    } as any,
    detectedIdes: { value: [] },
    sessionRegistry: {} as any,
    packageName: 'adhdev',
    statusVersion: '0.9.76',
    // DS3: identify this daemon so requestCoordinatorLocalCatchup can resolve the
    // coordinator base node as self-hosted and run the guarded local fast-forward.
    ...(statusInstanceId ? { statusInstanceId } : {}),
  })
}

function initGitRepo(repo: string) {
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo })
  writeFileSync(join(repo, 'README.md'), 'base\n', 'utf-8')
  writeFileSync(join(repo, 'package.json'), JSON.stringify({
    scripts: {
      test: 'node validation.js',
      typecheck: 'node typecheck.js',
    },
  }, null, 2), 'utf-8')
  writeFileSync(join(repo, 'validation.js'), 'process.exit(0)\n', 'utf-8')
  writeFileSync(join(repo, 'typecheck.js'), 'process.exit(0)\n', 'utf-8')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
  // DS1/DS2: give the root repo a real `origin` remote so the auto-push path
  // (merge → push → cleanup) and the base-movement CAS (fetch origin/<base>) have a
  // real remote to talk to. Without it, the DS1 push fails and short-circuits before
  // cleanup. A bare sibling repo mirrors production (Refinery always pushes to origin).
  const originBare = `${repo}-origin.git`
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', originBare])
  execFileSync('git', ['remote', 'add', 'origin', originBare], { cwd: repo })
  execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: repo })
}

function initSubmoduleOrigin(repo: string) {
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo })
  writeFileSync(join(repo, 'README.md'), 'submodule base\n', 'utf-8')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'submodule init'], { cwd: repo })
}

function addSubmodule(repo: string, submoduleOrigin: string, path = 'oss') {
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', submoduleOrigin, path], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', `add ${path} submodule`], { cwd: repo })
}

function createMesh(repo: string, worktree: string, nodeId = 'node-worktree', commands: any = {
  test: [{ command: 'npm run test', sourcePath: 'package.json', confidence: 'high' }],
  typecheck: [{ command: 'npm run typecheck', sourcePath: 'package.json', confidence: 'high' }],
}, includeRefineConfig = true, opts: { requireApprovalForPush?: boolean } = {}) {
  const refineCommands = ['typecheck', 'test', 'lint', 'build'].flatMap((category: any) => {
    const entries = commands[category]
    return Array.isArray(entries) ? entries.map((entry: any) => ({ command: entry.command, category })) : []
  })
  // DS1: the auto-push path (merge → push → cleanup) needs requireApprovalForPush=false.
  // Default the test mesh to auto-push so the convergence tests exercise the full path;
  // the origin remote from initGitRepo makes the push succeed. Tests that specifically
  // exercise the approval-gated path pass { requireApprovalForPush: true }.
  const requireApprovalForPush = opts.requireApprovalForPush === true
  const basePolicy: Record<string, unknown> = { requireApprovalForPush }
  return {
    id: `mesh-${nodeId}`,
    name: 'Validation Mesh',
    repoIdentity: 'example/repo',
    defaultBranch: 'main',
    policy: includeRefineConfig
      ? { ...basePolicy, refineConfig: { version: 1, validation: { required: true, commands: refineCommands } } }
      : basePolicy,
    coordinator: {},
    projectContext: {
      version: 1,
      generatedAt: new Date().toISOString(),
      sources: [],
      repo: { identity: 'example/repo', defaultBranch: 'main', currentBranches: ['main', 'feat/refine'] },
      layout: { packageManager: 'npm', workspaceFiles: ['package.json'], packageRoots: [repo], likelyEntryPoints: [] },
      commands,
      instructions: { files: [], summary: '' },
      conventions: { pathHints: [], validationNotes: [], riskyAreas: [] },
    },
    nodes: [
      { id: 'node-source', workspace: repo, repoRoot: repo, daemonId: 'daemon-source', userOverrides: {}, policy: {} },
      { id: nodeId, workspace: worktree, repoRoot: worktree, daemonId: 'daemon-source', userOverrides: {}, policy: {}, isLocalWorktree: true, worktreeBranch: 'feat/refine', clonedFromNodeId: 'node-source' },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

function createWorktreeWithCommit(root: string, repo: string) {
  const worktree = join(root, '.adhdev-worktrees', 'Validation Mesh', 'feat-refine')
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'feat/refine', worktree], { cwd: repo })
  // DOCS-ROOT: change a daemon-runtime package file (not just README) so the branch
  // is code-affecting (changeArea 'daemon') and the validation gate actually runs its
  // commands. A README-only branch is now classified docs-only ('none'), which skips
  // all un-scoped code validation — these tests exercise validation, so they need a
  // code change. mkdirSync recursively creates packages/daemon-core/src.
  mkdirSync(join(worktree, 'packages', 'daemon-core', 'src'), { recursive: true })
  writeFileSync(join(worktree, 'packages', 'daemon-core', 'src', 'feature.ts'), 'export const feature = 1\n', 'utf-8')
  writeFileSync(join(worktree, 'README.md'), 'base\nfeature\n', 'utf-8')
  execFileSync('git', ['add', '.'], { cwd: worktree })
  execFileSync('git', ['commit', '-q', '-m', 'feature change'], { cwd: worktree })
  return worktree
}

function withConfigDir(root: string) {
  process.env.ADHDEV_CONFIG_DIR = join(root, '.adhdev')
}

function expectAccepted(result: any, nodeId: string) {
  expect(result).toMatchObject({
    success: true,
    async: true,
    status: 'accepted',
    targetNodeId: nodeId,
  })
  expect(result.jobId).toMatch(/^refine_/)
  expect(result.interactionId).toMatch(/^ix_/)
  expect(result.startedAt).toMatch(/T/)
}

function createMeshEventComponents(meshId: string, messages: string[], coordinatorCount = 1) {
  const coordinators = Array.from({ length: coordinatorCount }, (_, idx) => ({
    // status: 'idle' so the reconcile loop drains + injects queued events into them
    // (queue-only delivery — injectMeshSystemMessage no longer pushes directly).
    getState: () => ({ instanceId: `coord-${idx}`, status: 'idle', settings: { meshCoordinatorFor: meshId } }),
    onEvent: (_event: string, payload: any) => messages.push(payload?.input?.text || ''),
  }))
  return {
    cliManager: { adapters: new Map(), handleCliCommand: async () => ({ success: true }) },
    instanceManager: { getByCategory: () => coordinators },
  } as any
}

async function waitForRefineLedger(meshId: string, jobId: string, timeoutMs = 60000): Promise<any> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const entries = readLedgerEntries(meshId)
    const terminal = entries.find(entry =>
      (entry.kind === 'task_completed' || entry.kind === 'task_failed')
      && (entry.payload as any)?.refineJob?.jobId === jobId
    )
    if (terminal) return terminal
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for refine job ${jobId}`)
}

describe('refine_mesh_node validation gate', () => {
  beforeAll(() => {
    vi.setConfig({ testTimeout: 90000 })
  })

  it('delivers async refine completion and failure as coordinator-visible system messages with duplicate suppression', async () => {
    const meshId = `mesh-refine-delivery-${Date.now()}`
    const messages: string[] = []
    const components = createMeshEventComponents(meshId, messages)

    // Queue-only delivery: handleMeshForwardEvent now ONLY persists to the pending
    // queue (forwarded: 0). The reconcile tick drains + injects into the idle
    // coordinator, which is what actually lands the system message in `messages`.
    const completed = handleMeshForwardEvent(components, {
      event: 'refine:completed',
      meshId,
      nodeId: 'node-delivery',
      workspace: '/tmp/node-delivery',
      jobId: 'refine_job_delivery_completed',
      status: 'completed',
      result: {
        success: true,
        merged: true,
        branch: 'feat/refine',
        into: 'main',
        validationSummary: { status: 'passed' },
      },
    })
    expect(completed).toMatchObject({ success: true, forwarded: 0 })
    await runMeshReconcileTick(components)
    expect(messages[0]).toContain('completed successfully')
    expect(messages[0]).toContain('job_id=refine_job_delivery_completed')
    expect(messages[0]).toContain('validation=passed')

    // Duplicate is suppressed at queue time → never queued → tick injects nothing new.
    const duplicate = handleMeshForwardEvent(components, {
      event: 'refine:completed',
      meshId,
      nodeId: 'node-delivery',
      jobId: 'refine_job_delivery_completed',
      status: 'completed',
    })
    expect(duplicate).toMatchObject({ success: true, suppressed: true, duplicateRefineTerminalEvent: true })
    await runMeshReconcileTick(components)
    expect(messages).toHaveLength(1)

    const failed = handleMeshForwardEvent(components, {
      event: 'refine:failed',
      meshId,
      nodeId: 'node-delivery',
      jobId: 'refine_job_delivery_failed',
      status: 'failed',
      result: { success: false, code: 'validation_failed', error: 'validation failed' },
    })
    expect(failed).toMatchObject({ success: true, forwarded: 0 })
    await runMeshReconcileTick(components)
    expect(messages[1]).toContain('failed')
    expect(messages[1]).toContain('job_id=refine_job_delivery_failed')
    expect(messages[1]).toContain('code=validation_failed')
  })

  it('buffers forwarded refine terminal events for MCP coordinators when no live CLI coordinator exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-pending-delivery-'))
    const meshId = `mesh-refine-pending-${Date.now()}`
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      const messages: string[] = []
      const components = createMeshEventComponents(meshId, messages, 0)
      const forwarded = handleMeshForwardEvent(components, {
        event: 'refine:completed',
        meshId,
        nodeId: 'node-pending',
        workspace: '/tmp/node-pending',
        jobId: 'refine_job_pending_completed',
        status: 'completed',
        result: { success: true, merged: true, validationSummary: { status: 'passed' } },
      })

      expect(forwarded).toMatchObject({ success: true, forwarded: 0 })
      expect(messages).toEqual([])
      const pending = drainPendingMeshCoordinatorEvents(meshId)
      expect(pending).toHaveLength(1)
      expect(pending[0]).toMatchObject({ event: 'refine:completed', meshId, nodeId: 'node-pending' })
      expect((pending[0].metadataEvent as any)).toMatchObject({
        jobId: 'refine_job_pending_completed',
        status: 'completed',
        result: { success: true, merged: true },
      })
      expect(pending[0].coordinatorMessage).toContain('Refinery async job')
      expect(pending[0].coordinatorMessage).toContain('job_id=refine_job_pending_completed')
      expect(pending[0].coordinatorMessage).toContain('merge=merged')
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('accepts refine asynchronously and records validation failure in ledger and pending events', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-validation-fail-'))
    const repo = join(root, 'repo')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      initGitRepo(repo)
      writeFileSync(join(repo, 'validation.js'), 'console.error("validation failed")\nprocess.exit(7)\n', 'utf-8')
      execFileSync('git', ['add', 'validation.js'], { cwd: repo })
      execFileSync('git', ['commit', '-q', '-m', 'make validation fail'], { cwd: repo })
      const worktree = createWorktreeWithCommit(root, repo)
      const mesh = createMesh(repo, worktree, 'node-fail', {
        test: [{ command: 'npm run test', sourcePath: 'package.json', confidence: 'high' }],
      })
      const router = createRouter()

      const result: any = await router.execute('refine_mesh_node', {
        execute: true,
        meshId: mesh.id,
        nodeId: 'node-fail',
        inlineMesh: mesh,
      })

      expectAccepted(result, 'node-fail')
      const terminal = await waitForRefineLedger(mesh.id, result.jobId)
      expect(terminal.kind).toBe('task_failed')
      expect((terminal.payload as any).result).toMatchObject({ success: false, code: 'validation_failed', convergenceStatus: 'blocked_review' })
      expect((terminal.payload as any).result.validationSummary.commandsRun[0]).toMatchObject({ command: 'npm', args: ['run', 'test'], exitCode: 7, passed: false })
      expect((terminal.payload as any).result.validationSummary.commandsRun[0].stderr).toContain('validation failed')
      const events = drainPendingMeshCoordinatorEvents(mesh.id)
      const failedEvent = events.find(event => event.event === 'refine:failed' && (event.metadataEvent as any).jobId === result.jobId)
      expect(failedEvent).toBeTruthy()
      // QW2: the slim terminal event carries compact failure diagnostics so the
      // coordinator can decide next-step without pulling the full ledger record —
      // the first failing command, its exit code, and a bounded output tail.
      const slimResult = (failedEvent!.metadataEvent as any).result
      expect(slimResult).toMatchObject({ code: 'validation_failed', terminalKind: 'validation_failed' })
      expect(slimResult.validationSummary.failure).toMatchObject({
        firstFailedCommand: 'npm run test',
        exitCode: 7,
      })
      expect(slimResult.validationSummary.failure.outputTail).toContain('validation failed')
      // ...and the slim event does NOT carry the heavy per-command detail.
      expect(slimResult.validationSummary.commandsRun).toBeUndefined()
      expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('base\n')
      expect(mesh.nodes.some((node: any) => node.id === 'node-fail')).toBe(true)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 90000)

  it('classifies missing package dependencies before running package-manager validation when no bootstrap is configured', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-missing-deps-'))
    const repo = join(root, 'repo')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      initGitRepo(repo)
      writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }, null, 2), 'utf-8')
      execFileSync('git', ['add', 'package-lock.json'], { cwd: repo })
      execFileSync('git', ['commit', '-q', '-m', 'add lockfile'], { cwd: repo })
      const worktree = createWorktreeWithCommit(root, repo)
      const mesh = createMesh(repo, worktree, 'node-missing-deps')
      const router = createRouter()

      const accepted: any = await router.execute('refine_mesh_node', {
        execute: true,
        meshId: mesh.id,
        nodeId: 'node-missing-deps',
        inlineMesh: mesh,
      })

      expectAccepted(accepted, 'node-missing-deps')
      const terminal = await waitForRefineLedger(mesh.id, accepted.jobId)
      expect(terminal.kind).toBe('task_failed')
      const result = (terminal.payload as any).result
      expect(result).toMatchObject({
        success: false,
        code: 'missing_dependencies',
        convergenceStatus: 'blocked_review',
      })
      expect(result.validationSummary).toMatchObject({
        status: 'failed',
        failureKind: 'missing_dependencies',
        failureCode: 'missing_dependencies',
        bootstrapCommandsRun: [],
      })
      expect(result.validationSummary.commandsRun[0]).toMatchObject({
        displayCommand: 'npm run typecheck',
        passed: false,
        skipped: true,
        failureKind: 'missing_dependencies',
      })
      expect(result.refineStages.some((entry: any) => entry.stage === 'patch_equivalence')).toBe(false)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 90000)

  it('runs configured bootstrap commands before package-manager validation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-bootstrap-deps-'))
    const repo = join(root, 'repo')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      initGitRepo(repo)
      writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }, null, 2), 'utf-8')
      execFileSync('git', ['add', 'package-lock.json'], { cwd: repo })
      execFileSync('git', ['commit', '-q', '-m', 'add lockfile'], { cwd: repo })
      const worktree = createWorktreeWithCommit(root, repo)
      const mesh = createMesh(repo, worktree, 'node-bootstrap-deps')
      mesh.policy.refineConfig.validation.bootstrapCommands = [
        { command: 'node', args: ['-e', 'require("fs").mkdirSync("node_modules", { recursive: true })'], category: 'custom' },
      ]
      const router = createRouter()

      const accepted: any = await router.execute('refine_mesh_node', {
        execute: true,
        meshId: mesh.id,
        nodeId: 'node-bootstrap-deps',
        inlineMesh: mesh,
      })

      expectAccepted(accepted, 'node-bootstrap-deps')
      const terminal = await waitForRefineLedger(mesh.id, accepted.jobId)
      expect(terminal.kind).toBe('task_completed')
      const result = (terminal.payload as any).result
      expect(result).toMatchObject({ success: true, merged: true })
      expect(result.validationSummary.bootstrapCommandsRun[0]).toMatchObject({
        displayCommand: 'node -e require("fs").mkdirSync("node_modules", { recursive: true })',
        passed: true,
      })
      expect(result.validationSummary.commandsRun.map((entry: any) => entry.displayCommand)).toEqual(['npm run typecheck', 'npm run test'])
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 90000)

  it('returns before long validation completes and reuses the in-flight job for duplicate refine requests', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-async-duplicate-'))
    const repo = join(root, 'repo')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      initGitRepo(repo)
      writeFileSync(join(repo, 'validation.js'), 'setTimeout(() => process.exit(0), 750)\n', 'utf-8')
      execFileSync('git', ['add', 'validation.js'], { cwd: repo })
      execFileSync('git', ['commit', '-q', '-m', 'slow validation'], { cwd: repo })
      const worktree = createWorktreeWithCommit(root, repo)
      const mesh = createMesh(repo, worktree, 'node-slow', {
        test: [{ command: 'npm run test', sourcePath: 'package.json', confidence: 'high' }],
      })
      const router = createRouter()

      const started = Date.now()
      const first: any = await router.execute('refine_mesh_node', { meshId: mesh.id, nodeId: 'node-slow', inlineMesh: mesh, execute: true })
      const elapsedMs = Date.now() - started
      const second: any = await router.execute('refine_mesh_node', { meshId: mesh.id, nodeId: 'node-slow', inlineMesh: mesh, execute: true })

      expectAccepted(first, 'node-slow')
      expect(elapsedMs).toBeLessThan(250)
      expect(second).toMatchObject({ success: true, async: true, status: 'accepted', duplicate: true, jobId: first.jobId })
      const terminal = await waitForRefineLedger(mesh.id, first.jobId)
      expect(terminal.kind).toBe('task_completed')
      expect((terminal.payload as any).result).toMatchObject({ success: true, merged: true })
      const events = drainPendingMeshCoordinatorEvents(mesh.id)
      // Once the terminal refine:completed exists for the job, the provisional
      // refine:accepted is reconciled away — the coordinator only needs the outcome.
      expect(events.some(event => event.event === 'refine:accepted' && (event.metadataEvent as any).jobId === first.jobId)).toBe(false)
      expect(events.some(event => event.event === 'refine:completed' && (event.metadataEvent as any).jobId === first.jobId)).toBe(true)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 90000)

  it('starts a new async refine job after a terminal validation failure instead of returning the failed job as duplicate', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-retry-failed-'))
    const repo = join(root, 'repo')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      initGitRepo(repo)
      writeFileSync(join(repo, 'validation.js'), 'console.error("validation failed")\nprocess.exit(7)\n', 'utf-8')
      execFileSync('git', ['add', 'validation.js'], { cwd: repo })
      execFileSync('git', ['commit', '-q', '-m', 'make validation fail'], { cwd: repo })
      const worktree = createWorktreeWithCommit(root, repo)
      const mesh = createMesh(repo, worktree, 'node-retry-failed', {
        test: [{ command: 'npm run test', sourcePath: 'package.json', confidence: 'high' }],
      })
      const router = createRouter()

      const first: any = await router.execute('refine_mesh_node', { meshId: mesh.id, nodeId: 'node-retry-failed', inlineMesh: mesh, execute: true })
      expectAccepted(first, 'node-retry-failed')
      const firstTerminal = await waitForRefineLedger(mesh.id, first.jobId)
      expect(firstTerminal.kind).toBe('task_failed')

      const retry: any = await router.execute('refine_mesh_node', { meshId: mesh.id, nodeId: 'node-retry-failed', inlineMesh: mesh, execute: true })
      expectAccepted(retry, 'node-retry-failed')
      expect(retry.jobId).not.toBe(first.jobId)
      expect(retry.duplicate).not.toBe(true)
      expect(retry.retryOfJobId).toBe(first.jobId)
      const retryDispatched = readLedgerEntries(mesh.id).find(entry =>
        entry.kind === 'task_dispatched'
        && (entry.payload as any)?.refineJob?.jobId === retry.jobId
      )
      expect((retryDispatched?.payload as any)?.refineJob?.retryOfJobId).toBe(first.jobId)
      const events = drainPendingMeshCoordinatorEvents(mesh.id)
      expect(events.some(event => event.event === 'refine:accepted'
        && (event.metadataEvent as any).jobId === retry.jobId
        && (event.metadataEvent as any).retryOfJobId === first.jobId)).toBe(true)
      await waitForRefineLedger(mesh.id, retry.jobId)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 90000)

  it('starts a new async refine job after a completed terminal job when the same node is reintroduced', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-retry-completed-'))
    const repo = join(root, 'repo')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      initGitRepo(repo)
      const worktree = createWorktreeWithCommit(root, repo)
      const mesh = createMesh(repo, worktree, 'node-retry-completed')
      const originalNode = { ...mesh.nodes[1] }
      const router = createRouter()

      const first: any = await router.execute('refine_mesh_node', { meshId: mesh.id, nodeId: 'node-retry-completed', inlineMesh: mesh, execute: true })
      expectAccepted(first, 'node-retry-completed')
      const firstTerminal = await waitForRefineLedger(mesh.id, first.jobId)
      expect(firstTerminal.kind).toBe('task_completed')

      // 057d5def ("delete merged worktree branch ref on removal") deletes the feat/refine
      // branch ref when the first refine merges and removes its worktree, so re-adding the
      // worktree against feat/refine would fail with "fatal: invalid reference: feat/refine".
      // Recreate the branch from main (which now contains the merged feature) before re-adding
      // the worktree — the "reintroduced node" scenario this test models. -f is safe because
      // the merged worktree (and thus the branch checkout) was already removed.
      execFileSync('git', ['branch', '-f', 'feat/refine', 'main'], { cwd: repo })
      execFileSync('git', ['worktree', 'add', '-q', worktree, 'feat/refine'], { cwd: repo })
      writeFileSync(join(worktree, 'README.md'), `${readFileSync(join(worktree, 'README.md'), 'utf-8')}retry\n`, 'utf-8')
      execFileSync('git', ['add', 'README.md'], { cwd: worktree })
      execFileSync('git', ['commit', '-q', '-m', 'retry change'], { cwd: worktree })
      mesh.nodes.push(originalNode)

      const retry: any = await router.execute('refine_mesh_node', { meshId: mesh.id, nodeId: 'node-retry-completed', inlineMesh: mesh, execute: true })
      expectAccepted(retry, 'node-retry-completed')
      expect(retry.jobId).not.toBe(first.jobId)
      expect(retry.duplicate).not.toBe(true)
      expect(retry.retryOfJobId).toBe(first.jobId)
      const retryTerminal = await waitForRefineLedger(mesh.id, retry.jobId)
      expect(retryTerminal.kind).toBe('task_completed')
      expect((retryTerminal.payload as any).refineJob.retryOfJobId).toBe(first.jobId)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 90000)

  it('records validation pass, merge, cleanup and final convergence in completion evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-validation-pass-'))
    const repo = join(root, 'repo')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      initGitRepo(repo)
      const worktree = createWorktreeWithCommit(root, repo)
      writeFileSync(join(repo, 'SOURCE_ONLY.md'), 'source change\n', 'utf-8')
      execFileSync('git', ['add', 'SOURCE_ONLY.md'], { cwd: repo })
      execFileSync('git', ['commit', '-q', '-m', 'source-only change'], { cwd: repo })
      // Keep origin/main current with the post-worktree base commit so resolve_refs
      // (which prefers origin/<base>) sees SOURCE_ONLY as part of the base.
      execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: repo })
      const mesh = createMesh(repo, worktree)
      const messages: string[] = []
      const router = createRouter(mesh.id, messages)

      const accepted: any = await router.execute('refine_mesh_node', {
        execute: true,
        meshId: mesh.id,
        nodeId: 'node-worktree',
        inlineMesh: mesh,
      })

      expectAccepted(accepted, 'node-worktree')
      const terminal = await waitForRefineLedger(mesh.id, accepted.jobId)
      expect(terminal.kind).toBe('task_completed')
      const result = (terminal.payload as any).result
      expect(result).toMatchObject({ success: true, merged: true })
      expect(result.validationSummary.status).toBe('passed')
      expect(result.validationSummary.commandsRun.map((entry: any) => `${entry.command} ${entry.args.join(' ')}`)).toEqual([
        'npm run typecheck',
        'npm run test',
      ])
      // DS2 adds sync_base + base_cas; DS1 adds a push stage before cleanup and a
      // coordinator_catchup after; assert the ordered CORE stages are present as a
      // subsequence rather than an exact list.
      const stageOrder: string[] = result.refineStages.map((entry: any) => entry.stage)
      for (const s of ['resolve_refs', 'sync_base', 'validation', 'patch_equivalence', 'submodule_reachability', 'effective_diff', 'base_cas', 'merge', 'push', 'cleanup', 'ledger']) {
        expect(stageOrder).toContain(s)
      }
      expect(stageOrder.indexOf('push')).toBeLessThan(stageOrder.indexOf('cleanup')) // DS1: push before cleanup
      expect(result.patchEquivalence).toMatchObject({ status: 'passed', equivalent: true })
      // DS1: auto-push succeeded → the merge is on origin and the change on local base.
      expect(result).toMatchObject({ pushed: true })
      expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('base\nfeature\n')
      expect(readFileSync(join(repo, 'SOURCE_ONLY.md'), 'utf-8')).toBe('source change\n')
      expect(mesh.nodes.some((node: any) => node.id === 'node-worktree')).toBe(false)
      expect(result.finalBranchConvergenceState).toMatchObject({ branch: 'main', merged: true, pushed: true, validation: 'passed', status: 'merged_pushed' })
      // Queue-only delivery: refine completion is persisted to the pending queue
      // (not pushed). Peek (non-destructive) to assert the queue carries the
      // completion and NOT the intermediate accepted event...
      const pendingEvents = getPendingMeshCoordinatorEvents(mesh.id)
      expect(pendingEvents.some(event =>
        event.event === 'refine:completed'
        && (event.metadataEvent as any).jobId === accepted.jobId
      )).toBe(true)
      expect(pendingEvents.some(event =>
        event.event === 'refine:accepted'
        && (event.metadataEvent as any).jobId === accepted.jobId
      )).toBe(false)
      // ...then the reconcile tick drains + injects it into the idle coordinator,
      // landing the coordinator-visible system message. (createMeshEventComponents
      // builds the same idle-coordinator-on-this-daemon shape the loop expects,
      // pushing injected text into the shared `messages` sink.)
      await runMeshReconcileTick(createMeshEventComponents(mesh.id, messages))
      expect(messages.some(message =>
        message.includes(`job_id=${accepted.jobId}`)
        && message.includes('validation=passed')
        && message.includes('patch_equivalence=passed')
        && message.includes('merge=merged')
        // DS1: auto-push landed → convergence is merged_pushed.
        && message.includes('final_convergence=merged_pushed')
        && message.includes('Next step: Continue from the updated mesh state.')
      )).toBe(true)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 90000)

  it('fails before merge or cleanup when the merged tree points at an unreachable submodule gitlink', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-missing-submodule-'))
    const repo = join(root, 'repo')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      initGitRepo(repo)
      const worktree = createWorktreeWithCommit(root, repo)
      const missingCommit = '1234567890abcdef1234567890abcdef12345678'
      execFileSync('git', ['update-index', '--add', '--cacheinfo', '160000', missingCommit, 'oss'], { cwd: worktree })
      execFileSync('git', ['commit', '-q', '-m', 'point submodule at missing commit'], { cwd: worktree })
      const mesh = createMesh(repo, worktree, 'node-missing-submodule')
      mesh.policy.allowAutoPublishSubmoduleMainCommits = true
      const messages: string[] = []
      const router = createRouter(mesh.id, messages)

      const accepted: any = await router.execute('refine_mesh_node', {
        execute: true,
        meshId: mesh.id,
        nodeId: 'node-missing-submodule',
        inlineMesh: mesh,
      })

      expectAccepted(accepted, 'node-missing-submodule')
      const terminal = await waitForRefineLedger(mesh.id, accepted.jobId)
      expect(terminal.kind).toBe('task_failed')
      const result = (terminal.payload as any).result
      expect(result).toMatchObject({
        success: false,
        code: 'submodule_reachability_failed',
        convergenceStatus: 'blocked_review',
        publishRequired: true,
        blockedReason: 'submodule_publish_required',
      })
      expect(result.nextStep).toContain(`oss@${missingCommit}`)
      expect(result.nextStep).toContain('Ask the user for explicit approval')
      expect(result.nextStep).toContain('rerun mesh_refine_node')
      expect(result.nextStep).toContain('Do not merge the root branch')
      expect(result.nextSteps).toContain('Ask the user for explicit approval before pushing or publishing any submodule commit.')
      expect(result.unreachableSubmoduleCommits).toEqual([
        expect.objectContaining({
          path: 'oss',
          commit: missingCommit,
          autoPublishAllowed: true,
          autoPublishAttempted: false,
          autoPublishSkippedReason: expect.stringContaining('submodule checkout missing'),
          error: 'Submodule checkout missing at oss',
        }),
      ])
      expect(result.submoduleReachability).toMatchObject({
        status: 'failed',
        checked: 1,
        unreachable: [{ path: 'oss', commit: missingCommit, reachable: false, publishRequired: true }],
      })
      expect(result.finalBranchConvergenceState).toMatchObject({
        status: 'blocked_review',
        reason: 'submodule_publish_required',
        nextStep: expect.stringContaining('Do not merge the root branch'),
      })
      expect(result.refineStages.map((entry: any) => `${entry.stage}:${entry.status}`)).toContain('submodule_reachability:failed')
      const reachabilityStage = result.refineStages.find((entry: any) => entry.stage === 'submodule_reachability')
      expect(reachabilityStage).toMatchObject({
        autoPublishAllowed: true,
        autoPublishPolicySource: 'mesh.policy.allowAutoPublishSubmoduleMainCommits',
        autoPublished: [],
        autoPublishSkipped: [
          expect.objectContaining({
            path: 'oss',
            commit: missingCommit,
            reason: expect.stringContaining('submodule checkout missing'),
          }),
        ],
      })
      expect(result.refineStages.some((entry: any) => entry.stage === 'merge')).toBe(false)
      expect(result.refineStages.some((entry: any) => entry.stage === 'cleanup')).toBe(false)
      expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('base\n')
      expect(mesh.nodes.some((node: any) => node.id === 'node-missing-submodule')).toBe(true)
      // Queue-only delivery: peek (non-destructive) the queue for the terminal
      // refine:failed (and absence of the intermediate accepted)...
      const pendingEvents = getPendingMeshCoordinatorEvents(mesh.id)
      expect(pendingEvents.some(event =>
        event.event === 'refine:failed'
        && (event.metadataEvent as any).jobId === accepted.jobId
      )).toBe(true)
      expect(pendingEvents.some(event =>
        event.event === 'refine:accepted'
        && (event.metadataEvent as any).jobId === accepted.jobId
      )).toBe(false)
      // ...then the reconcile tick drains + injects it into the idle coordinator.
      await runMeshReconcileTick(createMeshEventComponents(mesh.id, messages))
      expect(messages.some(message =>
        message.includes(`job_id=${accepted.jobId}`)
        && message.includes('code=submodule_reachability_failed')
        && message.includes('validation=passed')
        && message.includes('patch_equivalence=passed')
        && message.includes('merge=not_merged')
        && message.includes('convergence=blocked_review')
        && message.includes('reason=submodule_publish_required')
        && message.includes('Next step:')
        && message.includes(`oss@${missingCommit}`)
      )).toBe(true)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 90000)

  it('requires submodule gitlink commits to be reachable from the configured remote main branch, not only local checkout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-local-only-submodule-'))
    const repo = join(root, 'repo')
    const submoduleOrigin = join(root, 'submodule-origin')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      initSubmoduleOrigin(submoduleOrigin)
      initGitRepo(repo)
      addSubmodule(repo, submoduleOrigin, 'oss')
      const worktree = createWorktreeWithCommit(root, repo)
      execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', 'oss'], { cwd: worktree })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: join(worktree, 'oss') })
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: join(worktree, 'oss') })
      writeFileSync(join(worktree, 'oss', 'LOCAL_ONLY.md'), 'not published\n', 'utf-8')
      execFileSync('git', ['add', 'LOCAL_ONLY.md'], { cwd: join(worktree, 'oss') })
      execFileSync('git', ['commit', '-q', '-m', 'local only submodule commit'], { cwd: join(worktree, 'oss') })
      const localOnlyCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: join(worktree, 'oss'), encoding: 'utf-8' }).trim()
      execFileSync('git', ['fetch', join(worktree, 'oss'), localOnlyCommit], { cwd: join(repo, 'oss') })
      execFileSync('git', ['add', 'oss'], { cwd: worktree })
      execFileSync('git', ['commit', '-q', '-m', 'point submodule at local-only commit'], { cwd: worktree })
      const mesh = createMesh(repo, worktree, 'node-local-only-submodule')
      const router = createRouter()

      const accepted: any = await router.execute('refine_mesh_node', {
        execute: true,
        meshId: mesh.id,
        nodeId: 'node-local-only-submodule',
        inlineMesh: mesh,
      })

      expectAccepted(accepted, 'node-local-only-submodule')
      const terminal = await waitForRefineLedger(mesh.id, accepted.jobId)
      expect(terminal.kind).toBe('task_failed')
      const result = (terminal.payload as any).result
      expect(result).toMatchObject({
        success: false,
        code: 'submodule_reachability_failed',
        convergenceStatus: 'blocked_review',
        publishRequired: true,
        blockedReason: 'submodule_publish_required',
      })
      expect(result.submoduleReachability.unreachable).toEqual([
        expect.objectContaining({
          path: 'oss',
          commit: localOnlyCommit,
          reachable: false,
          localReachable: true,
          remote: 'origin',
          remoteUrl: submoduleOrigin,
          remoteReachable: false,
          remoteMainBranch: 'main',
          remoteMainReachable: false,
          publishRequired: true,
          error: expect.stringContaining('Submodule remote main reachability check failed for origin/main'),
        }),
      ])
      expect(result.unreachableSubmoduleCommits).toEqual([
        expect.objectContaining({
          path: 'oss',
          commit: localOnlyCommit,
          remote: 'origin',
          remoteUrl: submoduleOrigin,
          remoteReachable: false,
          remoteMainBranch: 'main',
          remoteMainReachable: false,
          error: expect.stringContaining('Submodule remote main reachability check failed for origin/main'),
        }),
      ])
      const reachabilityStage = result.refineStages.find((entry: any) => entry.stage === 'submodule_reachability')
      expect(reachabilityStage).toMatchObject({
        status: 'failed',
        unreachable: [
          expect.objectContaining({
            path: 'oss',
            commit: localOnlyCommit,
            publishRequired: true,
            remote: 'origin',
            remoteUrl: submoduleOrigin,
            remoteReachable: false,
            remoteMainBranch: 'main',
            remoteMainReachable: false,
            error: expect.stringContaining('Submodule remote main reachability check failed for origin/main'),
          }),
        ],
      })
      expect(result.nextStep).toContain(`oss@${localOnlyCommit}`)
      expect(result.nextStep).toContain('explicit approval')
      expect(result.finalBranchConvergenceState).toMatchObject({
        status: 'blocked_review',
        reason: 'submodule_publish_required',
        nextStep: expect.stringContaining('rerun mesh_refine_node'),
      })
      expect(result.refineStages.some((entry: any) => entry.stage === 'merge')).toBe(false)
      expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('base\n')
      expect(() => execFileSync('git', ['merge-base', '--is-ancestor', localOnlyCommit, 'main'], { cwd: submoduleOrigin })).toThrow()
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 90000)

  it('auto-publishes unreachable submodule gitlink commits only when repo refine config opts in, then verifies origin/main reachability', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-auto-publish-submodule-'))
    const repo = join(root, 'repo')
    const submoduleOrigin = join(root, 'submodule-origin')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      initSubmoduleOrigin(submoduleOrigin)
      execFileSync('git', ['config', 'receive.denyCurrentBranch', 'updateInstead'], { cwd: submoduleOrigin })
      initGitRepo(repo)
      addSubmodule(repo, submoduleOrigin, 'oss')
      const worktree = createWorktreeWithCommit(root, repo)
      mkdirSync(join(worktree, '.adhdev'), { recursive: true })
      writeFileSync(join(worktree, '.adhdev', 'refine.json'), JSON.stringify({
        version: 1,
        allowAutoPublishSubmoduleMainCommits: true,
        validation: {
          required: true,
          commands: [
            { command: 'npm', args: ['run', 'typecheck'], category: 'typecheck' },
            { command: 'npm', args: ['run', 'test'], category: 'test' },
          ],
        },
      }, null, 2), 'utf-8')
      execFileSync('git', ['add', '.adhdev/refine.json'], { cwd: worktree })
      execFileSync('git', ['commit', '-q', '-m', 'opt in to submodule auto publish'], { cwd: worktree })
      execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', 'oss'], { cwd: worktree })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: join(worktree, 'oss') })
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: join(worktree, 'oss') })
      writeFileSync(join(worktree, 'oss', 'AUTO_PUBLISHED.md'), 'published by refinery\n', 'utf-8')
      execFileSync('git', ['add', 'AUTO_PUBLISHED.md'], { cwd: join(worktree, 'oss') })
      execFileSync('git', ['commit', '-q', '-m', 'auto publish submodule commit'], { cwd: join(worktree, 'oss') })
      const autoPublishedCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: join(worktree, 'oss'), encoding: 'utf-8' }).trim()
      execFileSync('git', ['add', 'oss'], { cwd: worktree })
      execFileSync('git', ['commit', '-q', '-m', 'point submodule at auto-published commit'], { cwd: worktree })
      const mesh = createMesh(repo, worktree, 'node-auto-publish-submodule', undefined, false)
      const router = createRouter()

      const accepted: any = await router.execute('refine_mesh_node', {
        execute: true,
        meshId: mesh.id,
        nodeId: 'node-auto-publish-submodule',
        inlineMesh: mesh,
      })

      expectAccepted(accepted, 'node-auto-publish-submodule')
      const terminal = await waitForRefineLedger(mesh.id, accepted.jobId)
      expect(terminal.kind).toBe('task_completed')
      const result = (terminal.payload as any).result
      expect(result).toMatchObject({ success: true, merged: true })
      const entry = result.submoduleReachability.entries.find((candidate: any) => candidate.path === 'oss')
      expect(entry).toMatchObject({
        path: 'oss',
        commit: autoPublishedCommit,
        reachable: true,
        remote: 'origin',
        remoteUrl: submoduleOrigin,
        remoteMainBranch: 'main',
        remoteMainReachable: true,
        autoPublishAllowed: true,
        autoPublishAttempted: true,
        autoPublishSucceeded: true,
        autoPublishVerified: true,
        autoPublishRefspec: `${autoPublishedCommit}:refs/heads/main`,
        importedFromWorktree: true,
      })
      expect(entry.autoPublishRefspec.startsWith('+')).toBe(false)
      const reachabilityStage = result.refineStages.find((stage: any) => stage.stage === 'submodule_reachability')
      expect(reachabilityStage).toMatchObject({
        status: 'passed',
        autoPublishAllowed: true,
        autoPublishPolicySource: expect.stringContaining('.adhdev/refine.json'),
        autoPublished: [
          expect.objectContaining({
            path: 'oss',
            commit: autoPublishedCommit,
            remote: 'origin',
            remoteUrl: submoduleOrigin,
            remoteMainBranch: 'main',
            refspec: `${autoPublishedCommit}:refs/heads/main`,
            succeeded: true,
            verified: true,
            remoteMainReachable: true,
          }),
        ],
      })
      expect(execFileSync('git', ['merge-base', '--is-ancestor', autoPublishedCommit, 'main'], { cwd: submoduleOrigin }).toString()).toBe('')
      expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('base\nfeature\n')
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 90000)

  it('accepts a submodule gitlink commit that is an ancestor of fetched remote main', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-submodule-main-ancestor-'))
    const repo = join(root, 'repo')
    const submoduleOrigin = join(root, 'submodule-origin')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      initSubmoduleOrigin(submoduleOrigin)
      writeFileSync(join(submoduleOrigin, 'PUBLISHED_ANCESTOR.md'), 'published ancestor\n', 'utf-8')
      execFileSync('git', ['add', 'PUBLISHED_ANCESTOR.md'], { cwd: submoduleOrigin })
      execFileSync('git', ['commit', '-q', '-m', 'published ancestor commit'], { cwd: submoduleOrigin })
      const ancestorCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: submoduleOrigin, encoding: 'utf-8' }).trim()
      writeFileSync(join(submoduleOrigin, 'REMOTE_MAIN_TIP.md'), 'newer main tip\n', 'utf-8')
      execFileSync('git', ['add', 'REMOTE_MAIN_TIP.md'], { cwd: submoduleOrigin })
      execFileSync('git', ['commit', '-q', '-m', 'advance remote main'], { cwd: submoduleOrigin })
      initGitRepo(repo)
      addSubmodule(repo, submoduleOrigin, 'oss')
      const worktree = createWorktreeWithCommit(root, repo)
      execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', 'oss'], { cwd: worktree })
      execFileSync('git', ['fetch', 'origin', 'main'], { cwd: join(worktree, 'oss') })
      execFileSync('git', ['checkout', '-q', ancestorCommit], { cwd: join(worktree, 'oss') })
      execFileSync('git', ['add', 'oss'], { cwd: worktree })
      execFileSync('git', ['commit', '-q', '-m', 'point submodule at published main ancestor'], { cwd: worktree })
      const mesh = createMesh(repo, worktree, 'node-submodule-main-ancestor')
      const router = createRouter()

      const accepted: any = await router.execute('refine_mesh_node', {
        execute: true,
        meshId: mesh.id,
        nodeId: 'node-submodule-main-ancestor',
        inlineMesh: mesh,
      })

      expectAccepted(accepted, 'node-submodule-main-ancestor')
      const terminal = await waitForRefineLedger(mesh.id, accepted.jobId)
      expect(terminal.kind).toBe('task_completed')
      const result = (terminal.payload as any).result
      expect(result).toMatchObject({ success: true, merged: true })
      const reachabilityStage = result.refineStages.find((entry: any) => entry.stage === 'submodule_reachability')
      expect(reachabilityStage).toMatchObject({
        status: 'passed',
        checked: 1,
        unreachable: [],
      })
      expect(result.refineStages.map((entry: any) => `${entry.stage}:${entry.status}`)).toContain('submodule_reachability:passed')
      expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('base\nfeature\n')
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 90000)

  it('aligns the base submodule checkout after merging a changed gitlink', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-submodule-align-'))
    const repo = join(root, 'repo')
    const submoduleOrigin = join(root, 'submodule-origin')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      initSubmoduleOrigin(submoduleOrigin)
      initGitRepo(repo)
      addSubmodule(repo, submoduleOrigin, 'oss')
      const baseSubmoduleCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: join(repo, 'oss'), encoding: 'utf-8' }).trim()

      writeFileSync(join(submoduleOrigin, 'PUBLISHED_UPDATE.md'), 'published update\n', 'utf-8')
      execFileSync('git', ['add', 'PUBLISHED_UPDATE.md'], { cwd: submoduleOrigin })
      execFileSync('git', ['commit', '-q', '-m', 'published update'], { cwd: submoduleOrigin })
      const updatedSubmoduleCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: submoduleOrigin, encoding: 'utf-8' }).trim()

      const worktree = createWorktreeWithCommit(root, repo)
      execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', 'oss'], { cwd: worktree })
      execFileSync('git', ['fetch', 'origin', 'main'], { cwd: join(worktree, 'oss') })
      execFileSync('git', ['checkout', '-q', updatedSubmoduleCommit], { cwd: join(worktree, 'oss') })
      execFileSync('git', ['add', 'oss'], { cwd: worktree })
      execFileSync('git', ['commit', '-q', '-m', 'point submodule at published update'], { cwd: worktree })

      execFileSync('git', ['fetch', 'origin', 'main'], { cwd: join(repo, 'oss') })
      expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: join(repo, 'oss'), encoding: 'utf-8' }).trim()).toBe(baseSubmoduleCommit)

      const mesh = createMesh(repo, worktree, 'node-submodule-align')
      const router = createRouter()
      const accepted: any = await router.execute('refine_mesh_node', {
        execute: true,
        meshId: mesh.id,
        nodeId: 'node-submodule-align',
        inlineMesh: mesh,
      })

      expectAccepted(accepted, 'node-submodule-align')
      const terminal = await waitForRefineLedger(mesh.id, accepted.jobId)
      expect(terminal.kind).toBe('task_completed')
      const result = (terminal.payload as any).result
      expect(result).toMatchObject({ success: true, merged: true })
      expect(result.submoduleAlignment).toMatchObject({
        status: 'passed',
        changedGitlinkPaths: ['oss'],
        updatedPaths: ['oss'],
        verifiedPaths: ['oss'],
      })
      expect(result.refineStages.map((entry: any) => `${entry.stage}:${entry.status}`)).toContain('submodule_alignment:passed')
      expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: join(repo, 'oss'), encoding: 'utf-8' }).trim()).toBe(updatedSubmoduleCommit)
      expect(execFileSync('git', ['status', '--short'], { cwd: repo, encoding: 'utf-8' }).trim()).toBe('')
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 90000)

  // DS3: a diverged submodule gitlink is auto-converged (rebased onto base) when the
  // submodule content is non-conflicting; the block below is only reached when the
  // submodule content GENUINELY conflicts, so both sides edit the SAME line of
  // README.md here. (The auto-converge success path is covered by
  // refine-diverged-gitlink-converge.test.ts.)
  it('adds an actionable hint when patch equivalence fails on a genuinely conflicting submodule divergence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-submodule-conflict-hint-'))
    const repo = join(root, 'repo')
    const submoduleOrigin = join(root, 'submodule-origin')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      initSubmoduleOrigin(submoduleOrigin)
      initGitRepo(repo)
      addSubmodule(repo, submoduleOrigin, 'oss')
      const worktree = createWorktreeWithCommit(root, repo)

      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: join(repo, 'oss') })
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: join(repo, 'oss') })
      // Base side edits README.md line 1 → conflicts with the branch-side edit below,
      // so the submodule rebase cannot converge and the historical block is preserved.
      writeFileSync(join(repo, 'oss', 'README.md'), 'submodule base side edit\n', 'utf-8')
      execFileSync('git', ['add', 'README.md'], { cwd: join(repo, 'oss') })
      execFileSync('git', ['commit', '-q', '-m', 'base side submodule commit'], { cwd: join(repo, 'oss') })
      const baseSideCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: join(repo, 'oss'), encoding: 'utf-8' }).trim()
      execFileSync('git', ['add', 'oss'], { cwd: repo })
      execFileSync('git', ['commit', '-q', '-m', 'point base at base-side submodule commit'], { cwd: repo })
      // Keep origin/main current so resolve_refs sees the base-side submodule gitlink
      // (otherwise the divergent-gitlink conflict is computed against a stale base).
      execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: repo })

      execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', 'oss'], { cwd: worktree })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: join(worktree, 'oss') })
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: join(worktree, 'oss') })
      // Branch side edits the SAME README.md line 1 differently → genuine content conflict.
      writeFileSync(join(worktree, 'oss', 'README.md'), 'submodule branch side edit\n', 'utf-8')
      execFileSync('git', ['add', 'README.md'], { cwd: join(worktree, 'oss') })
      execFileSync('git', ['commit', '-q', '-m', 'branch side submodule commit'], { cwd: join(worktree, 'oss') })
      const branchSideCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: join(worktree, 'oss'), encoding: 'utf-8' }).trim()
      execFileSync('git', ['add', 'oss'], { cwd: worktree })
      execFileSync('git', ['commit', '-q', '-m', 'point branch at branch-side submodule commit'], { cwd: worktree })

      const mesh = createMesh(repo, worktree, 'node-submodule-conflict-hint')
      const router = createRouter()
      const accepted: any = await router.execute('refine_mesh_node', {
        execute: true,
        meshId: mesh.id,
        nodeId: 'node-submodule-conflict-hint',
        inlineMesh: mesh,
      })

      expectAccepted(accepted, 'node-submodule-conflict-hint')
      const terminal = await waitForRefineLedger(mesh.id, accepted.jobId)
      expect(terminal.kind).toBe('task_failed')
      const result = (terminal.payload as any).result
      expect(result).toMatchObject({
        success: false,
        code: 'patch_equivalence_failed',
        convergenceStatus: 'blocked_review',
      })
      expect(result.patchEquivalence.actionableHint).toMatchObject({
        kind: 'submodule_conflict',
        conflicts: [
          expect.objectContaining({
            path: 'oss',
            baseCommit: baseSideCommit,
            branchCommit: branchSideCommit,
          }),
        ],
      })
      expect(result.patchEquivalence.actionableHint.nextSteps.join('\n')).toContain('rerun mesh_refine_node')
      expect(result.refineStages.find((entry: any) => entry.stage === 'patch_equivalence')).toMatchObject({
        status: 'failed',
        actionableHint: expect.objectContaining({ kind: 'submodule_conflict' }),
      })
      expect(result.refineStages.some((entry: any) => entry.stage === 'merge')).toBe(false)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 90000)

  it('does not treat submodule feature-branch reachability as remote main convergence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-feature-submodule-'))
    const repo = join(root, 'repo')
    const submoduleOrigin = join(root, 'submodule-origin')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      initSubmoduleOrigin(submoduleOrigin)
      initGitRepo(repo)
      addSubmodule(repo, submoduleOrigin, 'oss')
      const worktree = createWorktreeWithCommit(root, repo)
      execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', 'oss'], { cwd: worktree })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: join(worktree, 'oss') })
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: join(worktree, 'oss') })
      writeFileSync(join(worktree, 'oss', 'FEATURE_ONLY.md'), 'feature branch only\n', 'utf-8')
      execFileSync('git', ['add', 'FEATURE_ONLY.md'], { cwd: join(worktree, 'oss') })
      execFileSync('git', ['commit', '-q', '-m', 'feature only submodule commit'], { cwd: join(worktree, 'oss') })
      const featureOnlyCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: join(worktree, 'oss'), encoding: 'utf-8' }).trim()
      execFileSync('git', ['push', '-q', 'origin', `HEAD:refs/heads/feature-only`], { cwd: join(worktree, 'oss') })
      execFileSync('git', ['add', 'oss'], { cwd: worktree })
      execFileSync('git', ['commit', '-q', '-m', 'point submodule at feature branch commit'], { cwd: worktree })
      const mesh = createMesh(repo, worktree, 'node-feature-only-submodule')
      const router = createRouter()

      const accepted: any = await router.execute('refine_mesh_node', {
        execute: true,
        meshId: mesh.id,
        nodeId: 'node-feature-only-submodule',
        inlineMesh: mesh,
      })

      expectAccepted(accepted, 'node-feature-only-submodule')
      const terminal = await waitForRefineLedger(mesh.id, accepted.jobId)
      expect(terminal.kind).toBe('task_failed')
      const result = (terminal.payload as any).result
      expect(result).toMatchObject({
        success: false,
        code: 'submodule_reachability_failed',
        blockedReason: 'submodule_publish_required',
      })
      expect(result.submoduleReachability.unreachable).toEqual([
        expect.objectContaining({
          path: 'oss',
          commit: featureOnlyCommit,
          remote: 'origin',
          remoteUrl: submoduleOrigin,
          remoteReachable: false,
          remoteMainBranch: 'main',
          remoteMainReachable: false,
          publishRequired: true,
        }),
      ])
      expect(result.nextStep).toContain('submodule remote main branch')
      expect(result.refineStages.some((entry: any) => entry.stage === 'merge')).toBe(false)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 90000)

  it('records cleanup failure as an observable partial convergence state after merge', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-cleanup-fail-'))
    const repo = join(root, 'repo')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      initGitRepo(repo)
      const worktree = createWorktreeWithCommit(root, repo)
      const mesh = createMesh(repo, worktree, 'node-cleanup-fail')
      delete mesh.nodes[1].worktreeBranch
      const router = createRouter()

      const accepted: any = await router.execute('refine_mesh_node', {
        execute: true,
        meshId: mesh.id,
        nodeId: 'node-cleanup-fail',
        inlineMesh: mesh,
      })

      expectAccepted(accepted, 'node-cleanup-fail')
      const terminal = await waitForRefineLedger(mesh.id, accepted.jobId)
      expect(terminal.kind).toBe('task_failed')
      const result = (terminal.payload as any).result
      expect(result).toMatchObject({ success: false, code: 'cleanup_failed', merged: true })
      expect(result.removeResult).toMatchObject({ success: false, removed: false, code: 'mesh_worktree_cleanup_missing_branch' })
      expect(result.refineStages.map((entry: any) => `${entry.stage}:${entry.status}`)).toContain('cleanup:failed')
      expect(result.finalBranchConvergenceState).toMatchObject({ status: 'merged_cleanup_failed', merged: true, removed: false })
      expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('base\nfeature\n')
      expect(mesh.nodes.some((node: any) => node.id === 'node-cleanup-fail')).toBe(true)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 90000)

  // ── DS1: push-before-cleanup — a push failure withholds cleanup ─────────────
  it('DS1: a push failure after merge is terminal blocked with cleanup WITHHELD (worktree + branch preserved, not counted as remote-merged)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-push-fail-'))
    const repo = join(root, 'repo')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      initGitRepo(repo)
      const worktree = createWorktreeWithCommit(root, repo)
      const mesh = createMesh(repo, worktree, 'node-push-fail')
      // Break the push: repoint origin at a bare repo that rejects the push by removing
      // it, so `git push origin main` fails (no such remote path). The merge still lands
      // on local base; DS1 must NOT clean up the worktree and must report merged/pushed=false.
      execFileSync('git', ['remote', 'set-url', 'origin', join(root, 'does-not-exist.git')], { cwd: repo })
      const router = createRouter()

      const accepted: any = await router.execute('refine_mesh_node', {
        execute: true, meshId: mesh.id, nodeId: 'node-push-fail', inlineMesh: mesh,
      })
      expectAccepted(accepted, 'node-push-fail')
      const terminal = await waitForRefineLedger(mesh.id, accepted.jobId)
      expect(terminal.kind).toBe('task_failed')
      const result = (terminal.payload as any).result
      // Merged locally, push failed → terminal blocked, retryable, NOT remote-converged.
      expect(result).toMatchObject({ success: false, code: 'push_failed', merged: true, mergedLocal: true, pushed: false, retryable: true })
      expect(result.finalBranchConvergenceState).toMatchObject({ status: 'merged_push_failed', merged: true, pushed: false, removed: false })
      // Cleanup was WITHHELD — the worktree node is still in the mesh, no cleanup stage ran.
      expect(mesh.nodes.some((node: any) => node.id === 'node-push-fail')).toBe(true)
      const stageNames = result.refineStages.map((e: any) => `${e.stage}:${e.status}`)
      expect(stageNames).toContain('push:failed')
      expect(stageNames.some((s: string) => s.startsWith('cleanup'))).toBe(false)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 90000)

  // ── DS1 approval path: merge lands locally, cleanup withheld (pending push) ──
  it('DS1: requireApprovalForPush leaves the merge on local base with cleanup withheld (merged_local_pending_push)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-approval-pending-'))
    const repo = join(root, 'repo')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      initGitRepo(repo)
      const worktree = createWorktreeWithCommit(root, repo)
      const mesh = createMesh(repo, worktree, 'node-approval', undefined, true, { requireApprovalForPush: true })
      const router = createRouter()

      const accepted: any = await router.execute('refine_mesh_node', {
        execute: true, meshId: mesh.id, nodeId: 'node-approval', inlineMesh: mesh,
      })
      expectAccepted(accepted, 'node-approval')
      const terminal = await waitForRefineLedger(mesh.id, accepted.jobId)
      expect(terminal.kind).toBe('task_completed')
      const result = (terminal.payload as any).result
      expect(result).toMatchObject({ success: true, merged: true, mergedLocal: true, pushed: false, pushReady: true })
      expect(result.finalBranchConvergenceState).toMatchObject({ status: 'merged_local_pending_push', merged: true, pushed: false, removed: false })
      // Merge landed on local base but worktree cleanup is withheld until push is approved.
      expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('base\nfeature\n')
      expect(mesh.nodes.some((node: any) => node.id === 'node-approval')).toBe(true)
      const stageNames = result.refineStages.map((e: any) => `${e.stage}:${e.status}`)
      expect(stageNames.some((s: string) => s.startsWith('cleanup'))).toBe(false)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 90000)

  // ── DS2: a diverged laggard is rebased in sync_base then merges cleanly ──────
  it('DS2: a DIVERGED laggard (ahead>0 AND behind>0) is rebased in sync_base (patch_equivalence_after_auto_rebase) and then merges; branch ancestry is linear', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-diverged-laggard-'))
    const repo = join(root, 'repo')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      initGitRepo(repo)
      const worktree = createWorktreeWithCommit(root, repo)
      // Advance the BASE with a disjoint file AFTER the worktree branch was created, so the
      // branch is DIVERGED: it has its own commit (ahead) AND base has a commit it lacks
      // (behind). The old ancestor-only auto-rebase would have MISSED this (branch is not a
      // strict ancestor of base). Push so resolve_refs sees the advanced base.
      writeFileSync(join(repo, 'BASE_ADVANCE.md'), 'base advance\n', 'utf-8')
      execFileSync('git', ['add', 'BASE_ADVANCE.md'], { cwd: repo })
      execFileSync('git', ['commit', '-q', '-m', 'advance base disjointly'], { cwd: repo })
      execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: repo })
      const mesh = createMesh(repo, worktree, 'node-laggard')
      const router = createRouter()

      const accepted: any = await router.execute('refine_mesh_node', {
        execute: true, meshId: mesh.id, nodeId: 'node-laggard', inlineMesh: mesh,
      })
      expectAccepted(accepted, 'node-laggard')
      const terminal = await waitForRefineLedger(mesh.id, accepted.jobId)
      expect(terminal.kind).toBe('task_completed')
      const result = (terminal.payload as any).result
      expect(result).toMatchObject({ success: true, merged: true, pushed: true })
      // sync_base rebased the diverged laggard and recorded the ancestry-visible stage.
      const syncBase = result.refineStages.find((e: any) => e.stage === 'sync_base')
      expect(syncBase).toMatchObject({ status: 'passed', rebased: true, diverged: true })
      expect(result.refineStages.some((e: any) => e.stage === 'patch_equivalence_after_auto_rebase' && e.status === 'passed')).toBe(true)
      // Both the base advance and the feature change are present after convergence.
      expect(readFileSync(join(repo, 'BASE_ADVANCE.md'), 'utf-8')).toBe('base advance\n')
      expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('base\nfeature\n')
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 90000)

  // ── DS3: post-push coordinator local catch-up ───────────────────────────────
  it('DS3: after auto-push, the local coordinator base checkout is fast-forwarded to the pushed commit (coordinator_catchup)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-coord-catchup-'))
    const repo = join(root, 'repo')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      initGitRepo(repo)
      const worktree = createWorktreeWithCommit(root, repo)
      const mesh = createMesh(repo, worktree, 'node-catchup')
      // This daemon IS the coordinator (its status id matches the source node's daemonId),
      // so requestCoordinatorLocalCatchup resolves the source node as the self-hosted
      // coordinator base and runs the guarded local fast-forward.
      const router = createRouter(undefined, undefined, 'daemon-source')

      const accepted: any = await router.execute('refine_mesh_node', {
        execute: true, meshId: mesh.id, nodeId: 'node-catchup', inlineMesh: mesh, coordinatorDaemonId: 'daemon-source',
      })
      expectAccepted(accepted, 'node-catchup')
      const terminal = await waitForRefineLedger(mesh.id, accepted.jobId)
      expect(terminal.kind).toBe('task_completed')
      const result = (terminal.payload as any).result
      expect(result).toMatchObject({ success: true, merged: true, pushed: true })
      // The coordinator base node is the source node (repoRoot === repo) hosted by this
      // daemon; refine ran the guarded local fast-forward. Since repoRoot IS the base it
      // just merged+pushed, the ff is a no-op (already_up_to_date) — the important assertion
      // is that the catch-up path RAN and produced a local_fast_forward summary.
      expect(result.coordinatorCatchup).toMatchObject({ mode: 'local_fast_forward' })
      // Base checkout is at the pushed commit (has the feature merge).
      expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('base\nfeature\n')
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 90000)

  it('records config/command guard failures asynchronously without running unsafe commands', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-validation-injection-'))
    const repo = join(root, 'repo')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      initGitRepo(repo)
      const worktree = createWorktreeWithCommit(root, repo)
      const pwned = join(worktree, 'pwned')
      const mesh = createMesh(repo, worktree, 'node-injection', {
        test: [{ command: `npm run test && touch ${pwned}`, sourcePath: 'package.json', confidence: 'high' }],
      })
      const router = createRouter()

      const accepted: any = await router.execute('refine_mesh_node', {
        execute: true,
        meshId: mesh.id,
        nodeId: 'node-injection',
        inlineMesh: mesh,
      })

      expectAccepted(accepted, 'node-injection')
      const terminal = await waitForRefineLedger(mesh.id, accepted.jobId)
      expect(terminal.kind).toBe('task_failed')
      const result = (terminal.payload as any).result
      expect(result).toMatchObject({ success: false, code: 'validation_unavailable', convergenceStatus: 'blocked_review' })
      expect(result.validationSummary.status).toBe('skipped')
      expect(result.validationSummary.rejectedCommands[0].reason).toMatch(/not allowlisted|unsafe/i)
      expect(existsSync(pwned)).toBe(false)
      expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('base\n')
      expect(mesh.nodes.some((node: any) => node.id === 'node-injection')).toBe(true)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 90000)

  it('does not execute heuristic package scripts when repo mesh/refine config is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-validation-no-config-'))
    const repo = join(root, 'repo')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      initGitRepo(repo)
      writeFileSync(join(repo, 'validation.js'), 'console.error("heuristic should not run")\nprocess.exit(9)\n', 'utf-8')
      execFileSync('git', ['add', 'validation.js'], { cwd: repo })
      execFileSync('git', ['commit', '-q', '-m', 'make heuristic fail'], { cwd: repo })
      const worktree = createWorktreeWithCommit(root, repo)
      const mesh = createMesh(repo, worktree, 'node-no-config', {
        test: [{ command: 'npm run test', sourcePath: 'package.json', confidence: 'high' }],
      }, false)
      const router = createRouter()

      const accepted: any = await router.execute('refine_mesh_node', {
        execute: true,
        meshId: mesh.id,
        nodeId: 'node-no-config',
        inlineMesh: mesh,
      })

      expectAccepted(accepted, 'node-no-config')
      const terminal = await waitForRefineLedger(mesh.id, accepted.jobId)
      const result = (terminal.payload as any).result
      expect(result).toMatchObject({ success: false, code: 'validation_unavailable', convergenceStatus: 'blocked_review' })
      expect(result.validationSummary.status).toBe('skipped')
      expect(result.validationSummary.commandsRun).toEqual([])
      expect(result.validationSummary.skippedReason).toContain('No repo mesh/refine config found')
      expect(result.validationSummary.suggestedConfig.validation.commands[0]).toMatchObject({ command: 'npm run test', category: 'test' })
      expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('base\n')
      expect(mesh.nodes.some((node: any) => node.id === 'node-no-config')).toBe(true)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 90000)

  it('returns a dry-run refine plan with config source and heuristic suggestions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-plan-'))
    const repo = join(root, 'repo')
    try {
      initGitRepo(repo)
      const worktree = createWorktreeWithCommit(root, repo)
      const mesh = createMesh(repo, worktree, 'node-plan')
      const router = createRouter()

      const result: any = await router.execute('plan_mesh_refine_node', {
        meshId: mesh.id,
        nodeId: 'node-plan',
        inlineMesh: mesh,
      })

      expect(result).toMatchObject({ success: true, dryRun: true, mergeWillRun: false, cleanupWillRun: false })
      expect(result.validationPlan.source).toBe('mesh.policy.refineConfig')
      expect(result.validationPlan.sourceType).toBe('mesh_policy')
      expect(result.validationPlan.commands.map((entry: any) => entry.displayCommand)).toEqual(['npm run typecheck', 'npm run test'])
      expect(result.validationPlan.note).toContain('heuristics are suggestions only')
      expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('base\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refine_mesh_node defaults to a synchronous dry-run plan (no merge) unless execute=true', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-dryrun-'))
    const repo = join(root, 'repo')
    try {
      initGitRepo(repo)
      const worktree = createWorktreeWithCommit(root, repo)
      const mesh = createMesh(repo, worktree, 'node-dryrun')
      const router = createRouter()

      // No execute / no dry_run → dry-run by default: plan only, NOT async, no merge.
      const planned: any = await router.execute('refine_mesh_node', {
        meshId: mesh.id,
        nodeId: 'node-dryrun',
        inlineMesh: mesh,
      })
      expect(planned).toMatchObject({ success: true, dryRun: true, mergeWillRun: false, cleanupWillRun: false })
      expect(planned.async).not.toBe(true)
      expect(planned.validationPlan).toBeDefined()
      // The worktree node must NOT have been merged/removed by a dry-run.
      expect(mesh.nodes.some((node: any) => node.id === 'node-dryrun')).toBe(true)
      expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('base\n')

      // Explicit dry_run:true (without execute) is also a plan-only response.
      const explicitDry: any = await router.execute('refine_mesh_node', {
        meshId: mesh.id,
        nodeId: 'node-dryrun',
        dryRun: true,
        inlineMesh: mesh,
      })
      expect(explicitDry).toMatchObject({ success: true, dryRun: true, mergeWillRun: false })
      expect(explicitDry.async).not.toBe(true)

      // execute:true opts into the async refine job (mirrors batch_refine_mesh_nodes).
      const executed: any = await router.execute('refine_mesh_node', {
        meshId: mesh.id,
        nodeId: 'node-dryrun',
        execute: true,
        inlineMesh: mesh,
      })
      expect(executed).toMatchObject({ success: true, async: true, status: 'accepted' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('M2-2: refine skips bootstrap when worktree_bootstrap is ready with unchanged staleInputs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-m2-cached-'))
    const repo = join(root, 'repo')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      initGitRepo(repo)
      mkdirSync(join(repo, '.adhdev'), { recursive: true })
      writeFileSync(join(repo, 'bootstrap-marker.js'), "require('fs').writeFileSync(require('path').join('..', 'bootstrap-marker-ran'), 'ran')\n", 'utf-8')
      writeFileSync(join(repo, '.adhdev', 'worktree_bootstrap.json'), JSON.stringify({
        version: 1, required: true, staleInputs: ['package.json'],
        commands: [{ command: 'node bootstrap-marker.js' }],
      }), 'utf-8')
      execFileSync('git', ['add', '.'], { cwd: repo })
      execFileSync('git', ['commit', '-q', '-m', 'add bootstrap config'], { cwd: repo })
      const worktree = createWorktreeWithCommit(root, repo)
      const mesh = createMesh(repo, worktree, 'node-m2-cached')
      const node: any = mesh.nodes.find((n: any) => n.id === 'node-m2-cached')
      node.worktreeBootstrap = {
        status: 'ready', required: true, staleInputs: ['package.json'],
        staleInputsDigest: computeStaleInputsDigest(worktree, ['package.json']),
      }
      const router = createRouter()

      const accepted: any = await router.execute('refine_mesh_node', { meshId: mesh.id, nodeId: 'node-m2-cached', inlineMesh: mesh, execute: true })
      expectAccepted(accepted, 'node-m2-cached')
      const terminal = await waitForRefineLedger(mesh.id, accepted.jobId)
      expect(terminal.kind).toBe('task_completed')
      const result = (terminal.payload as any).result
      expect(result.validationSummary.bootstrap).toMatchObject({ stage: 'cached', status: 'ready', skipped: true })
      // Bootstrap was NOT re-run: the marker script never executed.
      expect(existsSync(join(worktree, '..', 'bootstrap-marker-ran'))).toBe(false)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 90000)

  it('M2-2: refine reruns bootstrap when a staleInputs digest changed (base merge scenario)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-m2-stale-'))
    const repo = join(root, 'repo')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      initGitRepo(repo)
      mkdirSync(join(repo, '.adhdev'), { recursive: true })
      writeFileSync(join(repo, 'bootstrap-marker.js'), "require('fs').writeFileSync(require('path').join('..', 'bootstrap-marker-ran'), 'ran')\n", 'utf-8')
      writeFileSync(join(repo, '.adhdev', 'worktree_bootstrap.json'), JSON.stringify({
        version: 1, required: true, staleInputs: ['package.json'],
        commands: [{ command: 'node bootstrap-marker.js' }],
      }), 'utf-8')
      execFileSync('git', ['add', '.'], { cwd: repo })
      execFileSync('git', ['commit', '-q', '-m', 'add bootstrap config'], { cwd: repo })
      const worktree = createWorktreeWithCommit(root, repo)
      const mesh = createMesh(repo, worktree, 'node-m2-stale')
      const node: any = mesh.nodes.find((n: any) => n.id === 'node-m2-stale')
      // Persisted digest recorded against an older package.json — a base merge changed it since.
      node.worktreeBootstrap = {
        status: 'ready', required: true, staleInputs: ['package.json'],
        staleInputsDigest: { 'package.json': 'stale-digest-from-before-base-merge' },
      }
      const router = createRouter()

      const accepted: any = await router.execute('refine_mesh_node', { meshId: mesh.id, nodeId: 'node-m2-stale', inlineMesh: mesh, execute: true })
      expectAccepted(accepted, 'node-m2-stale')
      const terminal = await waitForRefineLedger(mesh.id, accepted.jobId)
      expect(terminal.kind).toBe('task_completed')
      const result = (terminal.payload as any).result
      expect(result.validationSummary.bootstrap.stage).toBe('ran')
      expect(result.validationSummary.bootstrap.status).toBe('ready')
      expect(result.validationSummary.bootstrap.staleReason).toContain('digest_mismatch')
      // Bootstrap actually re-ran.
      expect(existsSync(join(worktree, '..', 'bootstrap-marker-ran'))).toBe(true)
      // The re-run state was persisted back onto the node with a fresh digest.
      expect(node.worktreeBootstrap.status).toBe('ready')
      expect(node.worktreeBootstrap.staleInputsDigest['package.json']).not.toBe('stale-digest-from-before-base-merge')
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 90000)

  it('M2-2: legacy bootstrapCommands-only repos keep working and surface a deprecation warning', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-m2-legacy-'))
    const repo = join(root, 'repo')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      initGitRepo(repo)
      const worktree = createWorktreeWithCommit(root, repo)
      const mesh = createMesh(repo, worktree, 'node-m2-legacy')
      ;(mesh.policy.refineConfig.validation as any).bootstrapCommands = [
        { command: 'node', args: ['-e', 'require("fs").mkdirSync("node_modules", { recursive: true })'], category: 'custom' },
      ]
      const router = createRouter()

      const accepted: any = await router.execute('refine_mesh_node', { meshId: mesh.id, nodeId: 'node-m2-legacy', inlineMesh: mesh, execute: true })
      expectAccepted(accepted, 'node-m2-legacy')
      const terminal = await waitForRefineLedger(mesh.id, accepted.jobId)
      expect(terminal.kind).toBe('task_completed')
      const result = (terminal.payload as any).result
      expect(result.validationSummary.bootstrap.stage).toBe('legacy')
      expect(result.validationSummary.bootstrapCommandsRun).toHaveLength(1)
      expect(result.validationSummary.deprecationWarnings[0]).toContain('deprecated')
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 90000)

})
