import * as fs from 'node:fs'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonCommandRouter } from '../../src/commands/router.js'
import {
  applyMeshCoordinatorSystemPromptInjection,
  coordinatorWrapperSentinels,
  resolveCoordinatorDisallowedToolsArgs,
  stripCoordinatorWrapperFile,
} from '../../src/commands/mesh-coordinator.js'
import {
  INJECTION_CLEANUP_MIN_SETTLE_MS,
  localSessionReadyProbe,
  scheduleInjectionCleanup,
} from '../../src/commands/coordinator-injection-cleanup.js'
import type { ProviderModule } from '../../src/providers/contracts.js'

// Batch 3 (coordinator rules → code): the context_file inject-then-remove used to
// (a) strip on a fixed 5 s timer that only ran when the launch succeeded — a failed
// launch left the coordinator block in AGENTS.md for every later session; (b) strip
// with HARD-CODED legacy sentinels, so a provider whose wrapper declares other
// markers kept its block forever; (c) honour `owned:true` by deleting whatever file
// was at the path, including one the user wrote. These pin the fixed behaviour.

const CUSTOM_WRAPPER = '<!-- custom-coord-open -->\n{prompt}\n<!-- custom-coord-close -->'

function tempWorkspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function inject(workspace: string, rule: Record<string, unknown>) {
  return applyMeshCoordinatorSystemPromptInjection('COORDINATOR PROMPT BODY', rule as any, {
    cliArgs: [], launchEnv: {}, workspace, cliType: 'test-cli',
  })
}

describe('context_file strip uses the provider-declared sentinels', () => {
  it('derives the sentinel pair from the wrapper the writer used', () => {
    expect(coordinatorWrapperSentinels(CUSTOM_WRAPPER)).toEqual({ open: '<!-- custom-coord-open -->', close: '<!-- custom-coord-close -->' })
    expect(coordinatorWrapperSentinels(undefined)).toEqual({ open: '', close: '' })
  })

  it('removes a custom-wrapper block and restores the user content around it', () => {
    const ws = tempWorkspace('adhdev-ctx-sentinel-')
    try {
      const target = join(ws, 'AGENTS.md')
      writeFileSync(target, '# User rules\n\nkeep me\n', 'utf-8')
      const effect = inject(ws, { mode: 'context_file', path: 'AGENTS.md', wrapper: CUSTOM_WRAPPER })
      expect(effect.contextFileSentinels).toEqual({ open: '<!-- custom-coord-open -->', close: '<!-- custom-coord-close -->' })
      expect(readFileSync(target, 'utf-8')).toContain('COORDINATOR PROMPT BODY')

      stripCoordinatorWrapperFile(effect.contextFilePath!, effect.contextFileOwned === true, effect.contextFileSentinels)

      const after = readFileSync(target, 'utf-8')
      expect(after).not.toContain('COORDINATOR PROMPT BODY')
      expect(after).not.toContain('custom-coord')
      expect(after).toContain('keep me')
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('a strip without recorded sentinels falls back to the legacy pair (older registry entries)', () => {
    const ws = tempWorkspace('adhdev-ctx-legacy-')
    try {
      const effect = inject(ws, {
        mode: 'context_file', path: 'AGENTS.md',
        wrapper: '<!-- adhdev-mesh-coordinator-prompt -->\n{prompt}\n<!-- /adhdev-mesh-coordinator-prompt -->',
      })
      stripCoordinatorWrapperFile(effect.contextFilePath!)
      expect(existsSync(join(ws, 'AGENTS.md'))).toBe(false)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })
})

describe('owned:true never takes a pre-existing file', () => {
  it('a file with foreign content at the owned path is kept: injection downgrades to a sentinel block', () => {
    const ws = tempWorkspace('adhdev-ctx-owned-')
    try {
      const target = join(ws, '.grok', 'rules', 'coord.md')
      fs.mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, 'user-authored rule\n', 'utf-8')
      const effect = inject(ws, { mode: 'context_file', path: '.grok/rules/coord.md', wrapper: CUSTOM_WRAPPER, owned: true })
      expect(effect.contextFileOwned).toBe(false)

      stripCoordinatorWrapperFile(effect.contextFilePath!, effect.contextFileOwned === true, effect.contextFileSentinels)

      expect(readFileSync(target, 'utf-8')).toBe('user-authored rule\n')
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('a fresh path (or one holding only our previous block) is owned and deleted on strip', () => {
    const ws = tempWorkspace('adhdev-ctx-owned-fresh-')
    try {
      const rule = { mode: 'context_file', path: '.grok/rules/coord.md', wrapper: CUSTOM_WRAPPER, owned: true }
      const first = inject(ws, rule)
      expect(first.contextFileOwned).toBe(true)
      // A crashed launch left its block behind; the relaunch still owns the file.
      const second = inject(ws, rule)
      expect(second.contextFileOwned).toBe(true)
      stripCoordinatorWrapperFile(second.contextFilePath!, true, second.contextFileSentinels)
      expect(existsSync(join(ws, '.grok', 'rules', 'coord.md'))).toBe(false)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })
})

describe('scheduleInjectionCleanup timing', () => {
  afterEach(() => { vi.useRealTimers() })

  it('a failed launch strips at once', async () => {
    const ws = tempWorkspace('adhdev-ctx-fail-')
    try {
      const effect = inject(ws, { mode: 'context_file', path: 'AGENTS.md', wrapper: CUSTOM_WRAPPER })
      await scheduleInjectionCleanup(effect, { launched: false, label: 'test' })
      expect(existsSync(join(ws, 'AGENTS.md'))).toBe(false)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('a successful launch strips once the session is ready, never before the settle floor', async () => {
    vi.useFakeTimers()
    const ws = tempWorkspace('adhdev-ctx-ready-')
    try {
      const effect = inject(ws, { mode: 'context_file', path: 'AGENTS.md', wrapper: CUSTOM_WRAPPER })
      const target = join(ws, 'AGENTS.md')
      let ready = false
      const done = scheduleInjectionCleanup(effect, { launched: true, isReady: () => ready, label: 'test', pollMs: 100, maxWaitMs: 60_000 })
      await vi.advanceTimersByTimeAsync(INJECTION_CLEANUP_MIN_SETTLE_MS + 1_000)
      expect(existsSync(target)).toBe(true) // not ready yet → still on disk
      ready = true
      await vi.advanceTimersByTimeAsync(200)
      await done
      expect(existsSync(target)).toBe(false)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('a session that never becomes ready is still stripped at the ceiling', async () => {
    vi.useFakeTimers()
    const ws = tempWorkspace('adhdev-ctx-ceiling-')
    try {
      const effect = inject(ws, { mode: 'context_file', path: 'AGENTS.md', wrapper: CUSTOM_WRAPPER })
      const done = scheduleInjectionCleanup(effect, { launched: true, isReady: () => false, label: 'test', maxWaitMs: 20_000 })
      await vi.advanceTimersByTimeAsync(21_000)
      await done
      expect(existsSync(join(ws, 'AGENTS.md'))).toBe(false)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('the readiness probe reads the local adapter; a vanished session counts as ready', () => {
    const adapters = new Map<string, any>([['s1', { isReady: () => false, currentStatus: 'starting' }]])
    const probe = localSessionReadyProbe(adapters, 's1')!
    expect(probe()).toBe(false)
    adapters.set('s1', { isReady: () => false, currentStatus: 'idle' })
    expect(probe()).toBe(true)
    adapters.delete('s1')
    expect(probe()).toBe(true)
    expect(localSessionReadyProbe(adapters, undefined)).toBeUndefined()
  })
})

function createRouter(provider: ProviderModule, cliManager: { launchCli: ReturnType<typeof vi.fn> }) {
  return new DaemonCommandRouter({
    commandHandler: { handle: vi.fn(async () => ({ success: false })) } as any,
    cliManager: cliManager as any,
    cdpManagers: new Map(),
    providerLoader: { resolve: vi.fn(() => provider), getMeta: vi.fn(() => provider) } as any,
    instanceManager: { collectAllStates: () => [], listInstanceIds: () => [], getInstance: () => null } as any,
    detectedIdes: { value: [] },
    sessionRegistry: {} as any,
    sessionHostControl: { listSessions: vi.fn(async () => []) } as any,
    packageName: 'adhdev',
    statusVersion: '0.9.71',
  })
}

function contextFileProvider(extra: Record<string, unknown> = {}): ProviderModule {
  return {
    type: 'claude-cli',
    name: 'Claude Code',
    category: 'cli',
    spawn: { command: 'claude' },
    meshCoordinator: {
      supported: true,
      mcpConfig: { mode: 'auto_import', format: 'claude_mcp_json', path: '.mcp.json', serverName: 'adhdev-mesh' },
      systemPromptInjection: { mode: 'context_file', path: 'AGENTS.md', wrapper: CUSTOM_WRAPPER } as any,
      ...extra,
    } as any,
  }
}

async function launchCoordinator(provider: ProviderModule, launchCli: ReturnType<typeof vi.fn>, prefix: string) {
  const workspace = tempWorkspace(prefix)
  const mcpEntry = join(workspace, 'mcp-server.js')
  writeFileSync(mcpEntry, '#!/usr/bin/env node\n', 'utf-8')
  const previous = process.env.ADHDEV_MCP_SERVER_PATH
  process.env.ADHDEV_MCP_SERVER_PATH = mcpEntry
  const cliManager = { launchCli }
  const router = createRouter(provider, cliManager)
  const meshId = `mesh_${prefix.replace(/[^a-z]/g, '')}`
  const inlineMesh = { id: meshId, name: 'M', repoIdentity: 'example/repo', nodes: [{ id: 'node-1', workspace, policy: {} }], policy: {}, coordinator: {} }
  let result: any
  let thrown: unknown
  try {
    result = await router.execute('launch_mesh_coordinator', { meshId, cliType: 'claude-cli', inlineMesh })
  } catch (e) {
    thrown = e
  } finally {
    if (previous === undefined) delete process.env.ADHDEV_MCP_SERVER_PATH
    else process.env.ADHDEV_MCP_SERVER_PATH = previous
  }
  return { workspace, result, thrown, cliManager }
}

describe('launch_mesh_coordinator — context_file on a failed launch', () => {
  it('a launch that answers success:false leaves no coordinator block behind', async () => {
    const { workspace, result } = await launchCoordinator(
      contextFileProvider(),
      vi.fn(async () => ({ success: false, error: 'spawn failed' })),
      'adhdev-coord-launch-fail-',
    )
    try {
      expect(result).toMatchObject({ success: false })
      expect(existsSync(join(workspace, 'AGENTS.md'))).toBe(false)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('a launch that throws leaves no coordinator block behind', async () => {
    const { workspace, result } = await launchCoordinator(
      contextFileProvider(),
      vi.fn(async () => { throw new Error('pty exploded') }),
      'adhdev-coord-launch-throw-',
    )
    try {
      expect(result?.success).toBe(false)
      expect(existsSync(join(workspace, 'AGENTS.md'))).toBe(false)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})

describe('meshCoordinator.disallowedTools (route, do not implement)', () => {
  it('renders one `<flag>=<rules>` argv and skips malformed entries', () => {
    expect(resolveCoordinatorDisallowedToolsArgs({ flag: '--disallowedTools', tools: ['Agent', 'Bash(git reset --hard*)', 'Agent'] }, 'claude-cli'))
      .toEqual(['--disallowedTools=Agent,Bash(git reset --hard*)'])
    expect(resolveCoordinatorDisallowedToolsArgs({ flag: '--disallowedTools', tools: ['a,b', '', 'Agent'] }, 'claude-cli'))
      .toEqual(['--disallowedTools=Agent'])
    expect(resolveCoordinatorDisallowedToolsArgs({ flag: 'rm -rf', tools: ['Agent'] }, 'x')).toEqual([])
    expect(resolveCoordinatorDisallowedToolsArgs(undefined, 'x')).toEqual([])
  })

  it('the coordinator launch carries the provider deny list next to the MCP pre-allow', async () => {
    const provider = contextFileProvider({
      systemPromptInjection: { mode: 'cli_arg', flag: '--append-system-prompt' },
      disallowedTools: { flag: '--disallowedTools', tools: ['Agent', 'Bash(git push --force*)'] },
    })
    const { workspace, result, cliManager } = await launchCoordinator(
      provider,
      vi.fn(async () => ({ success: true, sessionId: 'coord-deny-session' })),
      'adhdev-coord-deny-',
    )
    try {
      expect(result).toMatchObject({ success: true })
      const cliArgs: string[] = (cliManager.launchCli as any).mock.calls[0]?.[0]?.cliArgs || []
      expect(cliArgs).toContain('--disallowedTools=Agent,Bash(git push --force*)')
      expect(cliArgs).toContain('--allowedTools=mcp__adhdev-mesh')
      expect(cliArgs.some(a => /dangerously/.test(a))).toBe(false)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  const claudeManifest = (() => {
    let current = path.resolve(__dirname, '..', '..')
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(current, 'adhdev-providers', 'cli', 'claude-cli', 'provider.v1.json')
      if (fs.existsSync(candidate)) return JSON.parse(fs.readFileSync(candidate, 'utf-8'))
      current = path.dirname(current)
    }
    return null
  })()

  it.skipIf(!claudeManifest)('the claude-cli manifest denies sub-agents and destructive git for coordinators', () => {
    const decl = claudeManifest.meshCoordinator.disallowedTools
    expect(decl.flag).toBe('--disallowedTools')
    expect(decl.tools).toContain('Agent')
    expect(decl.tools).toEqual(expect.arrayContaining(['Bash(git push --force*)', 'Bash(git reset --hard*)']))
    // Never anything that would remove the coordinator's own MCP tools.
    expect(decl.tools.some((t: string) => t.startsWith('mcp__'))).toBe(false)
  })
})
