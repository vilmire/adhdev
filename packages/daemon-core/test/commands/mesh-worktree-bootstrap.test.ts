import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { DaemonCommandRouter } from '../../src/commands/router'
import {
  loadMeshWorktreeBootstrapConfig,
  validateMeshWorktreeBootstrapConfig,
  runMeshWorktreeBootstrap,
} from '../../src/mesh/worktree-bootstrap-config'

const execFileAsync = promisify(execFile)
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

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
    statusInstanceId: 'daemon-local',
  })
}

async function createRepo(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const repoRoot = join(dir, 'repo')
  await mkdir(repoRoot, { recursive: true })
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot })
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot })
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot })
  await mkdir(join(repoRoot, '.adhdev'), { recursive: true })
  await mkdir(join(repoRoot, 'scripts'), { recursive: true })
  await writeFile(join(repoRoot, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }, null, 2))
  await writeFile(join(repoRoot, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }, null, 2))
  await writeFile(join(repoRoot, 'scripts', 'bootstrap.mjs'), [
    "import { mkdirSync, writeFileSync } from 'node:fs';",
    "mkdirSync('node_modules/.bin', { recursive: true });",
    "writeFileSync('node_modules/.bin/vitest', '#!/usr/bin/env node\\n', { mode: 0o755 });",
    "writeFileSync('node_modules/.adhdev-bootstrap-ran', 'ready\\n');",
    '',
  ].join('\n'))
  await writeFile(join(repoRoot, '.adhdev', 'worktree_bootstrap.json'), JSON.stringify({
    version: 1,
    enabled: true,
    runOnClone: true,
    required: true,
    staleInputs: ['package-lock.json', 'package.json'],
    commands: [
      {
        command: 'node',
        args: ['scripts/bootstrap.mjs'],
        category: 'custom',
        timeoutMs: 60000,
      },
    ],
  }, null, 2))
  await execFileAsync('git', ['add', '.'], { cwd: repoRoot })
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: repoRoot })
  return { dir, repoRoot }
}

describe('mesh worktree bootstrap', () => {
  it('loads and validates repo-local bootstrap config with shared command rules', async () => {
    const { dir, repoRoot } = await createRepo('adhdev-worktree-bootstrap-config-')
    try {
      const loaded = loadMeshWorktreeBootstrapConfig({}, repoRoot)
      expect(loaded).toMatchObject({ source: '.adhdev/worktree_bootstrap.json', sourceType: 'repo_file' })
      const validation = validateMeshWorktreeBootstrapConfig(loaded.config, loaded.source)
      expect(validation.valid).toBe(true)
      expect(validation.commands[0]).toMatchObject({ command: 'node', args: ['scripts/bootstrap.mjs'], category: 'custom' })

      const rejected = validateMeshWorktreeBootstrapConfig({
        version: 1,
        commands: [{ command: 'npm run test && npm run build' }],
      })
      expect(rejected.valid).toBe(false)
      expect(rejected.rejectedCommands[0]?.reason).toContain('unsafe command string')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('runs required bootstrap command during clone before agents encounter missing vitest', async () => {
    const { dir, repoRoot } = await createRepo('adhdev-worktree-bootstrap-clone-')
    try {
      const router = createRouter()
      const inlineMesh: any = {
        id: 'mesh-bootstrap-clone',
        name: 'Bootstrap Mesh',
        repoIdentity: 'example/bootstrap',
        defaultBranch: 'main',
        policy: {},
        coordinator: {},
        nodes: [
          { id: 'node-source', workspace: repoRoot, repoRoot, daemonId: 'daemon-local', userOverrides: {}, policy: { providerPriority: ['codex-cli'] } },
        ],
      }

      const result: any = await router.execute('clone_mesh_node', {
        meshId: inlineMesh.id,
        sourceNodeId: 'node-source',
        branch: 'feat/bootstrap-deps',
        inlineMesh,
      })

      expect(result.success).toBe(true)
      expect(result.worktreeBootstrap).toMatchObject({ status: 'ready', required: true, exitCode: 0 })
      expect(result.node.worktreeBootstrap.status).toBe('ready')
      expect(existsSync(join(result.worktreePath, 'node_modules', '.bin', 'vitest'))).toBe(true)
      expect(readFileSync(join(result.worktreePath, 'node_modules', '.adhdev-bootstrap-ran'), 'utf-8')).toBe('ready\n')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns a registered worktree node before slow bootstrap exceeds IPC deadlines', async () => {
    const { dir, repoRoot } = await createRepo('adhdev-worktree-bootstrap-async-')
    try {
      await writeFile(join(repoRoot, 'scripts', 'bootstrap.mjs'), [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "await new Promise(resolve => setTimeout(resolve, 200));",
        "mkdirSync('node_modules/.bin', { recursive: true });",
        "writeFileSync('node_modules/.bin/vitest', '#!/usr/bin/env node\\n', { mode: 0o755 });",
        "writeFileSync('node_modules/.adhdev-bootstrap-ran', 'ready\\n');",
        '',
      ].join('\n'))
      await execFileAsync('git', ['add', 'scripts/bootstrap.mjs'], { cwd: repoRoot })
      await execFileAsync('git', ['commit', '-q', '-m', 'slow bootstrap'], { cwd: repoRoot })

      const router = createRouter()
      const inlineMesh: any = {
        id: 'mesh-bootstrap-async',
        name: 'Bootstrap Async Mesh',
        repoIdentity: 'example/bootstrap-async',
        defaultBranch: 'main',
        policy: {},
        coordinator: {},
        nodes: [
          { id: 'node-source', workspace: repoRoot, repoRoot, daemonId: 'daemon-local', userOverrides: {}, policy: { providerPriority: ['codex-cli'], initSubmodulesOnClone: false } },
        ],
      }

      const result: any = await router.execute('clone_mesh_node', {
        meshId: inlineMesh.id,
        sourceNodeId: 'node-source',
        branch: 'feat/bootstrap-async',
        inlineMesh,
        setupWaitMs: 10,
      })

      expect(result.success).toBe(true)
      expect(result.async).toBe(true)
      expect(result.node.worktreeBootstrap.status).toBe('running')
      expect(inlineMesh.nodes.some((node: any) => node.id === result.node.id)).toBe(true)

      for (let i = 0; i < 20 && !existsSync(join(result.worktreePath, 'node_modules', '.adhdev-bootstrap-ran')); i += 1) {
        await delay(50)
      }
      expect(readFileSync(join(result.worktreePath, 'node_modules', '.adhdev-bootstrap-ran'), 'utf-8')).toBe('ready\n')
      expect(result.node.worktreeBootstrap.status).toBe('ready')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('surfaces failed required bootstrap as launch-blocking mesh status', async () => {
    const router = createRouter()
    const result: any = await router.execute('mesh_status', {
      meshId: 'mesh-bootstrap-failed-status',
      inlineMesh: {
        id: 'mesh-bootstrap-failed-status',
        name: 'Bootstrap Failed Mesh',
        repoIdentity: 'example/bootstrap',
        defaultBranch: 'main',
        policy: {},
        coordinator: {},
        nodes: [
          {
            id: 'node-worktree',
            workspace: '/definitely/missing/worktree',
            repoRoot: '/definitely/missing/worktree',
            daemonId: 'daemon-local',
            userOverrides: {},
            policy: { providerPriority: ['codex-cli'] },
            isLocalWorktree: true,
            worktreeBootstrap: {
              status: 'failed',
              required: true,
              configSource: '.adhdev/worktree_bootstrap.json',
              lastCommand: 'node scripts/bootstrap.mjs',
              exitCode: 1,
              error: 'bootstrap failed',
            },
          },
        ],
      },
    })

    expect(result.success).toBe(true)
    expect(result.nodes[0]).toMatchObject({
      worktreeBootstrap: { status: 'failed', required: true, exitCode: 1 },
      launchReady: false,
      launchBlockedReason: 'worktree_bootstrap_failed',
      launchBlockedMessage: 'bootstrap failed',
    })
  })

  it('marks bootstrap stale when a staleInputs file appears during the run', async () => {
    const { dir, repoRoot } = await createRepo('adhdev-stale-inputs-appear-')
    try {
      // Write a first script that creates the marker file, and a second script that is the
      // real bootstrap. The stale check fires between commands: after step1 creates marker.lock,
      // the loop detects it before running step2 and returns status='stale'.
      await writeFile(join(repoRoot, 'scripts', 'step1.mjs'), [
        "import { writeFileSync } from 'node:fs';",
        "writeFileSync('marker.lock', 'locked');",
        '',
      ].join('\n'))
      await writeFile(join(repoRoot, 'scripts', 'step2.mjs'), [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "mkdirSync('node_modules/.bin', { recursive: true });",
        "writeFileSync('node_modules/.bin/vitest', '#!/usr/bin/env node\\n', { mode: 0o755 });",
        '',
      ].join('\n'))
      await execFileAsync('git', ['add', 'scripts/step1.mjs', 'scripts/step2.mjs'], { cwd: repoRoot })
      await execFileAsync('git', ['commit', '-q', '-m', 'two-step bootstrap for stale test'], { cwd: repoRoot })

      // Patch the config: two commands + marker.lock as staleInput (not pre-existing).
      // The stale guard fires at the top of the loop: after step1 runs and creates marker.lock,
      // the loop checks before step2 and returns status='stale'.
      const configPath = join(repoRoot, '.adhdev', 'worktree_bootstrap.json')
      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      config.staleInputs = ['marker.lock']
      config.commands = [
        { command: 'node', args: ['scripts/step1.mjs'], category: 'custom', timeoutMs: 10000 },
        { command: 'node', args: ['scripts/step2.mjs'], category: 'custom', timeoutMs: 10000 },
      ]
      await writeFile(configPath, JSON.stringify(config, null, 2))
      await execFileAsync('git', ['add', '.adhdev/worktree_bootstrap.json'], { cwd: repoRoot })
      await execFileAsync('git', ['commit', '-q', '-m', 'add marker.lock stale guard'], { cwd: repoRoot })

      const mesh = { id: 'mesh-stale', nodes: [] }
      const result = await runMeshWorktreeBootstrap(mesh, repoRoot)

      expect(result.status).toBe('stale')
      expect(result.error).toContain('marker.lock')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not mark bootstrap stale for staleInputs files that existed before bootstrap started', async () => {
    const { dir, repoRoot } = await createRepo('adhdev-stale-preexist-')
    try {
      // package-lock.json and package.json are in staleInputs but pre-exist — should not trigger stale
      const mesh = { id: 'mesh-preexist', nodes: [] }
      const result = await runMeshWorktreeBootstrap(mesh, repoRoot)
      expect(result.status).toBe('ready')
      expect(result.exitCode).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
