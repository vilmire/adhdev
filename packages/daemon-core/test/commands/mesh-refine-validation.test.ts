import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { DaemonCommandRouter } from '../../src/commands/router'
import { readLedgerEntries } from '../../src/mesh/mesh-ledger'
import { drainPendingMeshCoordinatorEvents, handleMeshForwardEvent } from '../../src/mesh/mesh-events'

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
    } as any,
    detectedIdes: { value: [] },
    sessionRegistry: {} as any,
    packageName: 'adhdev',
    statusVersion: '0.9.76',
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
}, includeRefineConfig = true) {
  const refineCommands = ['typecheck', 'test', 'lint', 'build'].flatMap((category: any) => {
    const entries = commands[category]
    return Array.isArray(entries) ? entries.map((entry: any) => ({ command: entry.command, category })) : []
  })
  return {
    id: `mesh-${nodeId}`,
    name: 'Validation Mesh',
    repoIdentity: 'example/repo',
    defaultBranch: 'main',
    policy: includeRefineConfig ? { refineConfig: { version: 1, validation: { required: true, commands: refineCommands } } } : {},
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
  writeFileSync(join(worktree, 'README.md'), 'base\nfeature\n', 'utf-8')
  execFileSync('git', ['add', 'README.md'], { cwd: worktree })
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
    getState: () => ({ instanceId: `coord-${idx}`, settings: { meshCoordinatorFor: meshId } }),
    onEvent: (_event: string, payload: any) => messages.push(payload?.input?.text || ''),
  }))
  return {
    cliManager: { adapters: new Map(), handleCliCommand: async () => ({ success: true }) },
    instanceManager: { getByCategory: () => coordinators },
  } as any
}

async function waitForRefineLedger(meshId: string, jobId: string, timeoutMs = 5000): Promise<any> {
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
  it('delivers async refine completion and failure as coordinator-visible system messages with duplicate suppression', () => {
    const meshId = `mesh-refine-delivery-${Date.now()}`
    const messages: string[] = []
    const components = createMeshEventComponents(meshId, messages)

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
    expect(completed).toMatchObject({ success: true, forwarded: 1 })
    expect(messages[0]).toContain('completed successfully')
    expect(messages[0]).toContain('job_id=refine_job_delivery_completed')
    expect(messages[0]).toContain('validation=passed')

    const duplicate = handleMeshForwardEvent(components, {
      event: 'refine:completed',
      meshId,
      nodeId: 'node-delivery',
      jobId: 'refine_job_delivery_completed',
      status: 'completed',
    })
    expect(duplicate).toMatchObject({ success: true, suppressed: true, duplicateRefineTerminalEvent: true })
    expect(messages).toHaveLength(1)

    const failed = handleMeshForwardEvent(components, {
      event: 'refine:failed',
      meshId,
      nodeId: 'node-delivery',
      jobId: 'refine_job_delivery_failed',
      status: 'failed',
      result: { success: false, code: 'validation_failed', error: 'validation failed' },
    })
    expect(failed).toMatchObject({ success: true, forwarded: 1 })
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
      expect(events.some(event => event.event === 'refine:failed' && (event.metadataEvent as any).jobId === result.jobId)).toBe(true)
      expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('base\n')
      expect(mesh.nodes.some((node: any) => node.id === 'node-fail')).toBe(true)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)

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
      const first: any = await router.execute('refine_mesh_node', { meshId: mesh.id, nodeId: 'node-slow', inlineMesh: mesh })
      const elapsedMs = Date.now() - started
      const second: any = await router.execute('refine_mesh_node', { meshId: mesh.id, nodeId: 'node-slow', inlineMesh: mesh })

      expectAccepted(first, 'node-slow')
      expect(elapsedMs).toBeLessThan(250)
      expect(second).toMatchObject({ success: true, async: true, status: 'accepted', duplicate: true, jobId: first.jobId })
      const terminal = await waitForRefineLedger(mesh.id, first.jobId)
      expect(terminal.kind).toBe('task_completed')
      expect((terminal.payload as any).result).toMatchObject({ success: true, merged: true })
      const events = drainPendingMeshCoordinatorEvents(mesh.id)
      expect(events.some(event => event.event === 'refine:accepted' && (event.metadataEvent as any).jobId === first.jobId)).toBe(true)
      expect(events.some(event => event.event === 'refine:completed' && (event.metadataEvent as any).jobId === first.jobId)).toBe(true)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)

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

      const first: any = await router.execute('refine_mesh_node', { meshId: mesh.id, nodeId: 'node-retry-failed', inlineMesh: mesh })
      expectAccepted(first, 'node-retry-failed')
      const firstTerminal = await waitForRefineLedger(mesh.id, first.jobId)
      expect(firstTerminal.kind).toBe('task_failed')

      const retry: any = await router.execute('refine_mesh_node', { meshId: mesh.id, nodeId: 'node-retry-failed', inlineMesh: mesh })
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
  }, 60000)

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

      const first: any = await router.execute('refine_mesh_node', { meshId: mesh.id, nodeId: 'node-retry-completed', inlineMesh: mesh })
      expectAccepted(first, 'node-retry-completed')
      const firstTerminal = await waitForRefineLedger(mesh.id, first.jobId)
      expect(firstTerminal.kind).toBe('task_completed')

      execFileSync('git', ['worktree', 'add', '-q', worktree, 'feat/refine'], { cwd: repo })
      writeFileSync(join(worktree, 'README.md'), `${readFileSync(join(worktree, 'README.md'), 'utf-8')}retry\n`, 'utf-8')
      execFileSync('git', ['add', 'README.md'], { cwd: worktree })
      execFileSync('git', ['commit', '-q', '-m', 'retry change'], { cwd: worktree })
      mesh.nodes.push(originalNode)

      const retry: any = await router.execute('refine_mesh_node', { meshId: mesh.id, nodeId: 'node-retry-completed', inlineMesh: mesh })
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
  }, 60000)

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
      const mesh = createMesh(repo, worktree)
      const router = createRouter()

      const accepted: any = await router.execute('refine_mesh_node', {
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
      expect(result.refineStages.map((entry: any) => entry.stage)).toEqual([
        'resolve_refs',
        'validation',
        'patch_equivalence',
        'submodule_reachability',
        'merge',
        'cleanup',
        'ledger',
      ])
      expect(result.patchEquivalence).toMatchObject({ status: 'passed', equivalent: true })
      expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('base\nfeature\n')
      expect(readFileSync(join(repo, 'SOURCE_ONLY.md'), 'utf-8')).toBe('source change\n')
      expect(mesh.nodes.some((node: any) => node.id === 'node-worktree')).toBe(false)
      expect(result.finalBranchConvergenceState).toMatchObject({ branch: 'main', merged: true, validation: 'passed' })
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)

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
      const router = createRouter()

      const accepted: any = await router.execute('refine_mesh_node', {
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
        expect.objectContaining({ path: 'oss', commit: missingCommit, error: 'Submodule checkout missing at oss' }),
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
      expect(result.refineStages.some((entry: any) => entry.stage === 'merge')).toBe(false)
      expect(result.refineStages.some((entry: any) => entry.stage === 'cleanup')).toBe(false)
      expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('base\n')
      expect(mesh.nodes.some((node: any) => node.id === 'node-missing-submodule')).toBe(true)
      const events = drainPendingMeshCoordinatorEvents(mesh.id)
      const failedEvent = events.find(event => event.event === 'refine:failed' && (event.metadataEvent as any).jobId === accepted.jobId)
      expect((failedEvent?.metadataEvent as any)?.result).toMatchObject({ code: 'submodule_reachability_failed' })
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)

  it('requires submodule gitlink commits to be reachable from the configured remote, not only local checkout', async () => {
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
          publishRequired: true,
          error: expect.stringContaining('Submodule remote reachability check failed for origin'),
        }),
      ])
      expect(result.unreachableSubmoduleCommits).toEqual([
        expect.objectContaining({
          path: 'oss',
          commit: localOnlyCommit,
          remote: 'origin',
          remoteUrl: submoduleOrigin,
          remoteReachable: false,
          error: expect.stringContaining('Submodule remote reachability check failed for origin'),
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
            error: expect.stringContaining('Submodule remote reachability check failed for origin'),
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
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)

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
  }, 60000)

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
  }, 60000)

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
  }, 60000)

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
})
