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
  writeFileSync(join(process.env.ADHDEV_CONFIG_DIR!, 'launch-defaults.json'), JSON.stringify({ version: 1, revision: 1, history: [] }))
  return new DaemonCommandRouter({
    commandHandler: { handle: vi.fn(async () => ({ success: false })) } as any,
    cliManager: cliManager as any,
    cdpManagers: new Map(),
    providerLoader: {
      resolveAlias: (t: string) => t,
      getAvailableProviderInfos: () => [{ type: provider.type, enabled: true, installed: true }],
      resolve: vi.fn(() => provider),
      getMeta: vi.fn(() => provider),
    } as any,
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

/**
 * Simulate Antigravity CLI 1.4.2's `parseRuleFile` + `resolveFileIncludes`
 * (`rules.go:528-545, 643-693`):
 *   1. Expand `@[label](path)` references (`~/` -> `homeDir`, relative -> `workspaceRoot`),
 *      trimming included file whitespace and stripping leading `--- ... ---` YAML
 *      frontmatter if the included file starts with `---`.
 *   2. Cap the resulting rule file at 24,000 UTF-8 bytes (`0x5dc0`).
 */
function simulateAntigravityParseRuleFile(
  ruleFilePath: string,
  workspaceRoot: string,
  homeDir: string,
): { expanded: string; byteLength: number; truncated: boolean } {
  const raw = readFileSync(ruleFilePath, 'utf-8')
  const expanded = raw.replace(/@\[([^\]]*)\]\(([^)]+)\)/g, (fullMatch, _label: string, rawTarget: string) => {
    const trimmedTarget = rawTarget.trim()
    const resolvedTarget = trimmedTarget.startsWith('~/')
      ? join(homeDir, trimmedTarget.slice(2))
      : path.isAbsolute(trimmedTarget)
        ? trimmedTarget
        : join(workspaceRoot, trimmedTarget)
    if (!existsSync(resolvedTarget)) return fullMatch
    let included = readFileSync(resolvedTarget, 'utf-8').trim()
    if (included.startsWith('---')) {
      const endIdx = included.indexOf('\n---', 3)
      if (endIdx !== -1) {
        included = included.slice(endIdx + 4).trim()
      }
    }
    return included
  })
  const buf = Buffer.from(expanded, 'utf-8')
  const truncated = buf.byteLength > 24_000
  return {
    expanded: truncated ? buf.subarray(0, 24_000).toString('utf-8') : expanded,
    byteLength: buf.byteLength,
    truncated,
  }
}

function collectAntigravityLoadedRules(workspace: string, homeDir: string): {
  files: Array<{ path: string; expanded: string; byteLength: number; truncated: boolean }>
  combined: string
} {
  const rulePaths: string[] = []
  const agentsPath = join(workspace, 'AGENTS.md')
  if (existsSync(agentsPath)) rulePaths.push(agentsPath)
  const rulesDir = join(workspace, '.agents', 'rules')
  if (existsSync(rulesDir)) {
    for (const entry of fs.readdirSync(rulesDir).sort()) {
      if (entry.endsWith('.md')) rulePaths.push(join(rulesDir, entry))
    }
  }
  const files = rulePaths.map((p) => ({
    path: p,
    ...simulateAntigravityParseRuleFile(p, workspace, homeDir),
  }))
  return {
    files,
    combined: files.map((f) => f.expanded).join('\n\n'),
  }
}

const ANTIGRAVITY_WRAPPER = '<!-- adhdev-mesh-coordinator-prompt -->\n{prompt}\n<!-- /adhdev-mesh-coordinator-prompt -->'

describe('antigravity-cli coordinator per-turn context_file lifecycle & >24KB split/include delivery', () => {
  afterEach(() => { vi.useRealTimers() })

  it('retains antigravity-cli context_file across startup idle, Turn 1, and Turn 2+, while failed launches strip at once', async () => {
    vi.useFakeTimers()
    const ws = tempWorkspace('adhdev-agy-lifetime-')
    const coordHome = tempWorkspace('adhdev-agy-home-')
    try {
      const prompt = 'COORD_HEAD_MARKER\n' + 'Section line with coordinator rules.\n'.repeat(950) + 'COORD_TAIL_BEYOND_24KB_MARKER'
      expect(Buffer.byteLength(prompt, 'utf-8')).toBeGreaterThan(34_000)

      const effect = applyMeshCoordinatorSystemPromptInjection(
        prompt,
        { mode: 'context_file', path: 'AGENTS.md', wrapper: ANTIGRAVITY_WRAPPER },
        { cliArgs: [], launchEnv: { HOME: coordHome }, workspace: ws, cliType: 'antigravity-cli' },
      )
      expect(effect.retainContextFileForSessionLifetime).toBe(true)
      expect(effect.contextFilePath).toBe(join(ws, 'AGENTS.md'))
      expect(effect.additionalOwnedFiles?.length).toBeGreaterThan(0)

      // Startup idle arrives at ~17s, well before Turn 1 at ~2m44s:
      // scheduleInjectionCleanup with launched:true MUST NOT strip the rules.
      const done = scheduleInjectionCleanup(effect, {
        launched: true,
        isReady: () => true,
        label: 'coordinator cli_command',
        pollMs: 100,
        maxWaitMs: 60_000,
      })
      await vi.advanceTimersByTimeAsync(180_000)
      await done

      // Turn 1 & Turn 2+: rules remain on disk and expand completely without truncation.
      const turn1 = collectAntigravityLoadedRules(ws, coordHome)
      expect(turn1.files.length).toBeGreaterThanOrEqual(2)
      for (const file of turn1.files) {
        expect(file.truncated).toBe(false)
        expect(file.byteLength).toBeLessThanOrEqual(24_000)
      }
      expect(turn1.combined).toContain('COORD_HEAD_MARKER')
      expect(turn1.combined).toContain('COORD_TAIL_BEYOND_24KB_MARKER')

      // Failed launch: strips AGENTS.md and all companion files immediately.
      await scheduleInjectionCleanup(effect, { launched: false, label: 'coordinator cli_command' })
      expect(existsSync(join(ws, 'AGENTS.md'))).toBe(false)
      for (const extra of effect.additionalOwnedFiles ?? []) {
        expect(existsSync(extra)).toBe(false)
      }
    } finally {
      rmSync(ws, { recursive: true, force: true })
      rmSync(coordHome, { recursive: true, force: true })
    }
  })

  it('delivers the full >35KB coordinator prompt (including --- horizontal rules and multi-byte UTF-8) within the 24,000-byte per-file cap and isolates base-node workers', async () => {
    const { buildCoordinatorSystemPrompt } = await import('../../src/mesh/coordinator-prompt.js')
    const ws = tempWorkspace('adhdev-agy-split-')
    const coordHome = tempWorkspace('adhdev-agy-coord-home-')
    const workerHome = tempWorkspace('adhdev-agy-worker-home-')
    try {
      const userRules = '# Project Rules\n\n- Keep USER_ORIGINAL_RULE_441 intact.\n- Respect existing edits.\n'
      writeFileSync(join(ws, 'AGENTS.md'), userRules, 'utf-8')

      const basePrompt = buildCoordinatorSystemPrompt({
        mesh: {
          id: 'mesh_prefex',
          name: 'MoltBook Prefex',
          repoIdentity: 'github.com/acme/prefex',
          nodes: [{ id: 'node_1', workspace: ws, daemonId: 'daemon_1', userOverrides: {}, policy: {} }],
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        } as any,
        userInstruction: '---\n### Tail Rule (Beyond 24KB)\nAlways preserve UTF-8 symbols (한글/日本語/🚀) and COORD_FINAL_TAIL_TOKEN_999.',
      })
      expect(Buffer.byteLength(basePrompt, 'utf-8')).toBeGreaterThan(35_000)

      const effect = applyMeshCoordinatorSystemPromptInjection(
        basePrompt,
        { mode: 'context_file', path: 'AGENTS.md', wrapper: ANTIGRAVITY_WRAPPER },
        { cliArgs: [], launchEnv: { HOME: coordHome }, workspace: ws, cliType: 'antigravity-cli' },
      )
      expect(effect.contextFileOwned).toBe(false)

      // 1. Coordinator view (coordHome): sees user rules + 100% of >35KB prompt, zero files > 24,000 bytes.
      const coordLoaded = collectAntigravityLoadedRules(ws, coordHome)
      for (const file of coordLoaded.files) {
        expect(file.truncated).toBe(false)
        expect(file.byteLength).toBeLessThanOrEqual(24_000)
      }
      expect(coordLoaded.combined).toContain('USER_ORIGINAL_RULE_441')
      expect(coordLoaded.combined).toContain('Repo Mesh Coordinator')
      expect(coordLoaded.combined).toContain('### Tail Rule (Beyond 24KB)')
      expect(coordLoaded.combined).toContain('COORD_FINAL_TAIL_TOKEN_999')

      // 2. Base-node delegated worker view (workerHome in same workspace):
      // sees user rules in AGENTS.md, but zero coordinator prompt instructions.
      const workerLoaded = collectAntigravityLoadedRules(ws, workerHome)
      expect(workerLoaded.combined).toContain('USER_ORIGINAL_RULE_441')
      expect(workerLoaded.combined).not.toContain('Repo Mesh Coordinator')
      expect(workerLoaded.combined).not.toContain('COORD_FINAL_TAIL_TOKEN_999')

      // 3. Cleanup restores user AGENTS.md byte-for-byte and removes all companion files.
      stripCoordinatorWrapperFile(effect.contextFilePath!, effect.contextFileOwned === true, effect.contextFileSentinels)
      expect(readFileSync(join(ws, 'AGENTS.md'), 'utf-8')).toBe(userRules)
      for (const extra of effect.additionalOwnedFiles ?? []) {
        expect(existsSync(extra)).toBe(false)
      }
    } finally {
      rmSync(ws, { recursive: true, force: true })
      rmSync(coordHome, { recursive: true, force: true })
      rmSync(workerHome, { recursive: true, force: true })
    }
  })

  it('preserves a large existing user AGENTS.md (~21KB) under the 24,000-byte cap by routing all coordinator parts to companion rules', () => {
    const ws = tempWorkspace('adhdev-agy-large-user-')
    const coordHome = tempWorkspace('adhdev-agy-large-home-')
    try {
      const largeUserRules = '# Large User AGENTS.md\n' + 'User rule line that must never be truncated.\n'.repeat(460)
      expect(Buffer.byteLength(largeUserRules, 'utf-8')).toBeGreaterThan(20_500)
      expect(Buffer.byteLength(largeUserRules, 'utf-8')).toBeLessThan(22_500)
      writeFileSync(join(ws, 'AGENTS.md'), largeUserRules, 'utf-8')

      const prompt = 'COORD_LARGE_USER_HEAD\n' + 'Coordinator instruction line.\n'.repeat(1_100) + 'COORD_LARGE_USER_TAIL'
      const effect = applyMeshCoordinatorSystemPromptInjection(
        prompt,
        { mode: 'context_file', path: 'AGENTS.md', wrapper: ANTIGRAVITY_WRAPPER },
        { cliArgs: [], launchEnv: { HOME: coordHome }, workspace: ws, cliType: 'antigravity-cli' },
      )

      const loaded = collectAntigravityLoadedRules(ws, coordHome)
      for (const file of loaded.files) {
        expect(file.truncated).toBe(false)
        expect(file.byteLength).toBeLessThanOrEqual(24_000)
      }
      expect(loaded.combined).toContain('Large User AGENTS.md')
      expect(loaded.combined).toContain('COORD_LARGE_USER_HEAD')
      expect(loaded.combined).toContain('COORD_LARGE_USER_TAIL')

      stripCoordinatorWrapperFile(effect.contextFilePath!, effect.contextFileOwned === true, effect.contextFileSentinels)
      expect(readFileSync(join(ws, 'AGENTS.md'), 'utf-8')).toBe(largeUserRules)
    } finally {
      rmSync(ws, { recursive: true, force: true })
      rmSync(coordHome, { recursive: true, force: true })
    }
  })

  it('cleans up antigravity-cli context_file and companion files on unregisterMeshCoordinator and pruneDeadMeshCoordinators while respecting surviving same-workspace coordinators', async () => {
    const {
      registerMeshCoordinator,
      unregisterMeshCoordinator,
      pruneDeadMeshCoordinators,
    } = await import('../../src/mesh/coordinator-registry.js')
    const ws = tempWorkspace('adhdev-agy-reg-')
    const coordHome = tempWorkspace('adhdev-agy-reg-home-')
    try {
      const prompt = 'COORD_REG_HEAD\n' + 'Rule line.\n'.repeat(2_200) + 'COORD_REG_TAIL'
      const effect = applyMeshCoordinatorSystemPromptInjection(
        prompt,
        { mode: 'context_file', path: 'AGENTS.md', wrapper: ANTIGRAVITY_WRAPPER },
        { cliArgs: [], launchEnv: { HOME: coordHome }, workspace: ws, cliType: 'antigravity-cli' },
      )
      const contextFileRecord = {
        path: effect.contextFilePath!,
        owned: effect.contextFileOwned === true,
        open: effect.contextFileSentinels?.open,
        close: effect.contextFileSentinels?.close,
        additionalOwnedFiles: effect.additionalOwnedFiles,
        retainForSessionLifetime: effect.retainContextFileForSessionLifetime,
      }
      registerMeshCoordinator({
        meshId: 'mesh-reg-1',
        sessionId: 'coord-sess-1',
        workspace: ws,
        startedAt: Date.now() - 10_000,
        cliType: 'antigravity-cli',
        systemPrompt: prompt,
        injection: { mode: 'context_file', target: 'AGENTS.md', contextFile: contextFileRecord },
      })
      registerMeshCoordinator({
        meshId: 'mesh-reg-1',
        sessionId: 'coord-sess-2',
        workspace: ws,
        startedAt: Date.now(),
        cliType: 'antigravity-cli',
        systemPrompt: prompt,
        injection: { mode: 'context_file', target: 'AGENTS.md', contextFile: contextFileRecord },
      })

      // Unregistering the older coordinator must NOT strip files still owned by coord-sess-2.
      unregisterMeshCoordinator('coord-sess-1')
      expect(existsSync(join(ws, 'AGENTS.md'))).toBe(true)
      for (const extra of effect.additionalOwnedFiles ?? []) {
        expect(existsSync(extra)).toBe(true)
      }

      // Boot-time prune of dead coord-sess-2 strips AGENTS.md and all companion files.
      const pruned = pruneDeadMeshCoordinators(new Set(['unrelated-live-session']))
      expect(pruned.map((p) => p.sessionId)).toContain('coord-sess-2')
      expect(existsSync(join(ws, 'AGENTS.md'))).toBe(false)
      for (const extra of effect.additionalOwnedFiles ?? []) {
        expect(existsSync(extra)).toBe(false)
      }
    } finally {
      unregisterMeshCoordinator('coord-sess-1')
      unregisterMeshCoordinator('coord-sess-2')
      rmSync(ws, { recursive: true, force: true })
      rmSync(coordHome, { recursive: true, force: true })
    }
  })

  it('re-materializes missing antigravity-cli context_file and companion rules on coordinator restore/restart from registry systemPrompt', async () => {
    const {
      registerMeshCoordinator,
      unregisterMeshCoordinator,
      getCoordinatorForSession,
    } = await import('../../src/mesh/coordinator-registry.js')
    const meshCoordMod: any = await import('../../src/commands/mesh-coordinator.js')
    const ws = tempWorkspace('adhdev-agy-restore-')
    const coordHome = tempWorkspace('adhdev-agy-restore-home-')
    try {
      const userRules = '# User Rules\nKeep USER_RESTORE_RULE_777.\n'
      writeFileSync(join(ws, 'AGENTS.md'), userRules, 'utf-8')
      const prompt = 'COORD_RESTORE_HEAD\n' + 'Coordinator restore line.\n'.repeat(1_100) + 'COORD_RESTORE_TAIL_BEYOND_24KB'

      // Simulate a coordinator entry persisted in mesh-coordinators.json whose
      // AGENTS.md wrapper block was previously stripped (e.g. pre-rc24 startup strip
      // or stopSession during restartSession).
      registerMeshCoordinator({
        meshId: 'mesh-restore-1',
        sessionId: 'coord-restore-sess',
        workspace: ws,
        startedAt: Date.now() - 60_000,
        cliType: 'antigravity-cli',
        systemPrompt: prompt,
        injection: {
          mode: 'context_file',
          target: 'AGENTS.md',
          owned: false,
        },
      })

      expect(typeof meshCoordMod.ensureCoordinatorContextFileMaterialized).toBe('function')
      const rematerialized = meshCoordMod.ensureCoordinatorContextFileMaterialized(
        getCoordinatorForSession('coord-restore-sess')!,
        { HOME: coordHome },
      )
      expect(rematerialized).toBe(true)

      const updatedEntry = getCoordinatorForSession('coord-restore-sess')
      expect(updatedEntry?.injection?.contextFile?.retainForSessionLifetime).toBe(true)
      expect(updatedEntry?.injection?.contextFile?.additionalOwnedFiles?.length).toBeGreaterThan(0)

      const loaded = collectAntigravityLoadedRules(ws, coordHome)
      for (const file of loaded.files) {
        expect(file.truncated).toBe(false)
        expect(file.byteLength).toBeLessThanOrEqual(24_000)
      }
      expect(loaded.combined).toContain('USER_RESTORE_RULE_777')
      expect(loaded.combined).toContain('COORD_RESTORE_HEAD')
      expect(loaded.combined).toContain('COORD_RESTORE_TAIL_BEYOND_24KB')

      // Unregister cleans up the re-materialized files and restores user AGENTS.md.
      unregisterMeshCoordinator('coord-restore-sess')
      expect(readFileSync(join(ws, 'AGENTS.md'), 'utf-8')).toBe(userRules)
    } finally {
      unregisterMeshCoordinator('coord-restore-sess')
      rmSync(ws, { recursive: true, force: true })
      rmSync(coordHome, { recursive: true, force: true })
    }
  })

  it('F1: budgets existing user @[label](path) includes after expansion so expanded AGENTS.md never exceeds 24,000 bytes', () => {
    const ws = tempWorkspace('adhdev-agy-f1-ws-')
    const coordHome = tempWorkspace('adhdev-agy-f1-home-')
    try {
      writeFileSync(join(ws, 'user-rules.md'), 'User rules.\n'.repeat(1_000), 'utf-8')
      writeFileSync(join(ws, 'AGENTS.md'), '@[user](user-rules.md)\n', 'utf-8')

      const prompt = 'COORD_HEAD\n' + 'Coordinator rule line.\n'.repeat(1_700) + 'COORD_TAIL'
      const effect = applyMeshCoordinatorSystemPromptInjection(
        prompt,
        { mode: 'context_file', path: 'AGENTS.md', wrapper: ANTIGRAVITY_WRAPPER },
        { cliArgs: [], launchEnv: { HOME: coordHome }, workspace: ws, cliType: 'antigravity-cli' },
      )

      const loaded = collectAntigravityLoadedRules(ws, coordHome)
      for (const file of loaded.files) {
        expect(file.truncated).toBe(false)
        expect(file.byteLength).toBeLessThanOrEqual(24_000)
      }
      expect(loaded.combined).toContain('User rules.')
      expect(loaded.combined).toContain('COORD_HEAD')
      expect(loaded.combined).toContain('COORD_TAIL')

      stripCoordinatorWrapperFile(effect.contextFilePath!, false, effect.contextFileSentinels, effect.additionalOwnedFiles)
      expect(readFileSync(join(ws, 'AGENTS.md'), 'utf-8')).toBe('@[user](user-rules.md)\n')
    } finally {
      rmSync(ws, { recursive: true, force: true })
      rmSync(coordHome, { recursive: true, force: true })
    }
  })

  it('F2: keeps active coordinator delivery intact after an overlapping launch fails (both registered and provisional)', async () => {
    const {
      registerMeshCoordinator,
      unregisterMeshCoordinator,
    } = await import('../../src/mesh/coordinator-registry.js')
    const ws = tempWorkspace('adhdev-agy-f2-ws-')
    const coordHome = tempWorkspace('adhdev-agy-f2-home-')
    try {
      const prompt = 'ACTIVE_HEAD\n' + 'Active coordinator rule.\n'.repeat(1_700) + 'ACTIVE_TAIL'
      const active = applyMeshCoordinatorSystemPromptInjection(
        prompt,
        { mode: 'context_file', path: 'AGENTS.md', wrapper: ANTIGRAVITY_WRAPPER },
        { cliArgs: [], launchEnv: { HOME: coordHome }, workspace: ws, cliType: 'antigravity-cli' },
      )
      registerMeshCoordinator({
        meshId: 'review-active',
        sessionId: 'review-active',
        workspace: ws,
        startedAt: Date.now(),
        cliType: 'antigravity-cli',
        systemPrompt: prompt,
        injection: {
          mode: 'context_file',
          target: 'AGENTS.md',
          contextFile: {
            path: active.contextFilePath!,
            owned: false,
            additionalOwnedFiles: active.additionalOwnedFiles,
            retainForSessionLifetime: true,
          },
        },
      })

      // Overlapping launch B with same prompt fails: active coordinator files must remain intact.
      const failedSame = applyMeshCoordinatorSystemPromptInjection(
        prompt,
        { mode: 'context_file', path: 'AGENTS.md', wrapper: ANTIGRAVITY_WRAPPER },
        { cliArgs: [], launchEnv: { HOME: coordHome }, workspace: ws, cliType: 'antigravity-cli' },
      )
      await scheduleInjectionCleanup(failedSame, { launched: false, label: 'failed overlap same' })
      expect(existsSync(active.contextFilePath!)).toBe(true)
      expect(active.additionalOwnedFiles!.filter(existsSync).length).toBe(active.additionalOwnedFiles!.length)

      // Overlapping launch C with a different prompt fails: active coordinator files and content must be restored.
      const failedDifferent = applyMeshCoordinatorSystemPromptInjection(
        'OTHER_HEAD\nShort failed prompt.\nOTHER_TAIL',
        { mode: 'context_file', path: 'AGENTS.md', wrapper: ANTIGRAVITY_WRAPPER },
        { cliArgs: [], launchEnv: { HOME: coordHome }, workspace: ws, cliType: 'antigravity-cli' },
      )
      await scheduleInjectionCleanup(failedDifferent, { launched: false, label: 'failed overlap different' })
      expect(existsSync(active.contextFilePath!)).toBe(true)
      expect(active.additionalOwnedFiles!.filter(existsSync).length).toBe(active.additionalOwnedFiles!.length)
      const loaded = collectAntigravityLoadedRules(ws, coordHome)
      expect(loaded.combined).toContain('ACTIVE_HEAD')
      expect(loaded.combined).toContain('ACTIVE_TAIL')
      expect(loaded.combined).not.toContain('OTHER_HEAD')

      // Unregister active coordinator and verify provisional-only overlap (before registerMeshCoordinator)
      unregisterMeshCoordinator('review-active')
      expect(existsSync(active.contextFilePath!)).toBe(false)

      const provisionalA = applyMeshCoordinatorSystemPromptInjection(
        prompt,
        { mode: 'context_file', path: 'AGENTS.md', wrapper: ANTIGRAVITY_WRAPPER },
        { cliArgs: [], launchEnv: { HOME: coordHome }, workspace: ws, cliType: 'antigravity-cli' },
      )
      const failedProvisionalB = applyMeshCoordinatorSystemPromptInjection(
        'PROVISIONAL_B_HEAD\nFailed provisional prompt.\nPROVISIONAL_B_TAIL',
        { mode: 'context_file', path: 'AGENTS.md', wrapper: ANTIGRAVITY_WRAPPER },
        { cliArgs: [], launchEnv: { HOME: coordHome }, workspace: ws, cliType: 'antigravity-cli' },
      )
      await scheduleInjectionCleanup(failedProvisionalB, { launched: false, label: 'failed provisional overlap' })
      expect(existsSync(provisionalA.contextFilePath!)).toBe(true)
      expect(provisionalA.additionalOwnedFiles!.filter(existsSync).length).toBe(provisionalA.additionalOwnedFiles!.length)
      const loadedProvisional = collectAntigravityLoadedRules(ws, coordHome)
      expect(loadedProvisional.combined).toContain('ACTIVE_HEAD')
      expect(loadedProvisional.combined).not.toContain('PROVISIONAL_B_HEAD')

      await scheduleInjectionCleanup(provisionalA, { launched: false, label: 'provisionalA failed' })
      expect(existsSync(provisionalA.contextFilePath!)).toBe(false)
    } finally {
      unregisterMeshCoordinator('review-active')
      rmSync(ws, { recursive: true, force: true })
      rmSync(coordHome, { recursive: true, force: true })
    }
  })

  it('preserves user AGENTS.md bytes verbatim (no-trailing-newline, leading/trailing blank lines, CRLF, and concurrent user edits) across inject and strip', () => {
    const cases = [
      'User rule without newline',
      '\n\nUser rule with whitespace\n\n',
      'User rule CRLF\r\n',
    ]
    for (const original of cases) {
      const ws = tempWorkspace('adhdev-agy-bytes-ws-')
      const coordHome = tempWorkspace('adhdev-agy-bytes-home-')
      try {
        writeFileSync(join(ws, 'AGENTS.md'), original, 'utf-8')
        const effect = applyMeshCoordinatorSystemPromptInjection(
          'COORD_PROMPT',
          { mode: 'context_file', path: 'AGENTS.md', wrapper: ANTIGRAVITY_WRAPPER },
          { cliArgs: [], launchEnv: { HOME: coordHome }, workspace: ws, cliType: 'antigravity-cli' },
        )
        stripCoordinatorWrapperFile(
          effect.contextFilePath!,
          false,
          effect.contextFileSentinels,
          effect.additionalOwnedFiles,
        )
        expect(readFileSync(join(ws, 'AGENTS.md'), 'utf-8')).toBe(original)
      } finally {
        rmSync(ws, { recursive: true, force: true })
        rmSync(coordHome, { recursive: true, force: true })
      }
    }

    // Concurrent user edit before and after the sentinel block while coordinator is active.
    const ws = tempWorkspace('adhdev-agy-concurrent-ws-')
    const coordHome = tempWorkspace('adhdev-agy-concurrent-home-')
    try {
      writeFileSync(join(ws, 'AGENTS.md'), 'Initial user rule', 'utf-8')
      const effect = applyMeshCoordinatorSystemPromptInjection(
        'COORD_PROMPT',
        { mode: 'context_file', path: 'AGENTS.md', wrapper: ANTIGRAVITY_WRAPPER },
        { cliArgs: [], launchEnv: { HOME: coordHome }, workspace: ws, cliType: 'antigravity-cli' },
      )
      const injected = readFileSync(join(ws, 'AGENTS.md'), 'utf-8')
      const concurrentlyEdited = injected.replace('Initial user rule', 'Edited user rule\nSecond line') + '\nTrailing user addition'
      writeFileSync(join(ws, 'AGENTS.md'), concurrentlyEdited, 'utf-8')

      stripCoordinatorWrapperFile(
        effect.contextFilePath!,
        false,
        effect.contextFileSentinels,
        effect.additionalOwnedFiles,
      )
      expect(readFileSync(join(ws, 'AGENTS.md'), 'utf-8')).toBe('Edited user rule\nSecond line\nTrailing user addition')
    } finally {
      rmSync(ws, { recursive: true, force: true })
      rmSync(coordHome, { recursive: true, force: true })
    }
  })

  it('F4: rolls back partial materialization and returns a fail-closed error when .agents/rules cannot be created', async () => {
    const ws = tempWorkspace('adhdev-agy-f4-ws-')
    const coordHome = tempWorkspace('adhdev-agy-f4-home-')
    try {
      // Seed a regular file at workspace/.agents so mkdir(.agents/rules) fails with ENOTDIR.
      writeFileSync(join(ws, '.agents'), 'existing file', 'utf-8')
      const effect = applyMeshCoordinatorSystemPromptInjection(
        'COORD_HEAD\n' + 'Coordinator line.\n'.repeat(2_000) + 'COORD_TAIL',
        { mode: 'context_file', path: 'AGENTS.md', wrapper: ANTIGRAVITY_WRAPPER },
        { cliArgs: [], launchEnv: { HOME: coordHome }, workspace: ws, cliType: 'antigravity-cli' },
      )
      await scheduleInjectionCleanup(effect, { launched: false, label: 'partial write failure' })

      expect(effect.error).toBeTruthy()
      expect(effect.errorCode).toBe('mesh_coordinator_context_file_write_failed')
      expect(existsSync(join(ws, 'AGENTS.md'))).toBe(false)
      expect(existsSync(join(coordHome, '.gemini', 'config', 'adhdev-mesh-coordinator'))).toBe(false)
      expect(readFileSync(join(ws, '.agents'), 'utf-8')).toBe('existing file')

      // Also verify that if AGENTS.md had existing user content before the failed partial write,
      // the user file is preserved verbatim.
      const userContent = 'User rule without trailing newline'
      writeFileSync(join(ws, 'AGENTS.md'), userContent, 'utf-8')
      const effectWithUser = applyMeshCoordinatorSystemPromptInjection(
        'COORD_HEAD\n' + 'Coordinator line.\n'.repeat(2_000) + 'COORD_TAIL',
        { mode: 'context_file', path: 'AGENTS.md', wrapper: ANTIGRAVITY_WRAPPER },
        { cliArgs: [], launchEnv: { HOME: coordHome }, workspace: ws, cliType: 'antigravity-cli' },
      )
      expect(effectWithUser.error).toBeTruthy()
      expect(readFileSync(join(ws, 'AGENTS.md'), 'utf-8')).toBe(userContent)
      expect(existsSync(join(coordHome, '.gemini', 'config', 'adhdev-mesh-coordinator'))).toBe(false)
    } finally {
      rmSync(ws, { recursive: true, force: true })
      rmSync(coordHome, { recursive: true, force: true })
    }
  })

  it('F3 & F5: rolls back registration and rules on restartSession spawn failure, and restores missing chunks in registered coordinator HOME when daemon restore supplies no launchEnv', async () => {
    const {
      registerMeshCoordinator,
      unregisterMeshCoordinator,
      getCoordinatorForSession,
    } = await import('../../src/mesh/coordinator-registry.js')
    const { ensureCoordinatorContextFileMaterialized } = await import('../../src/commands/mesh-coordinator.js')
    const { DaemonCliManager } = await import('../../src/commands/cli-manager.js')
    const cliDetectorMod = await import('../../src/detection/cli-detector.js')
    const validateMod = await import('../../src/launch-defaults/validate.js')

    const detectSpy = vi.spyOn(cliDetectorMod, 'detectCLI').mockResolvedValue({ version: '1.4.2' } as any)
    const validateSpy = vi.spyOn(validateMod, 'validateLaunchDefault').mockReturnValue({ ok: true } as any)

    const ws = tempWorkspace('adhdev-agy-f35-ws-')
    const coordHome = tempWorkspace('adhdev-agy-f35-home-')
    const key = 'review-lifecycle-session'
    try {
      const prompt = 'COORD_LIFECYCLE_HEAD\n' + 'Coordinator rule.\n'.repeat(2_000) + 'COORD_LIFECYCLE_TAIL'
      const effect = applyMeshCoordinatorSystemPromptInjection(
        prompt,
        { mode: 'context_file', path: 'AGENTS.md', wrapper: ANTIGRAVITY_WRAPPER },
        { cliArgs: [], launchEnv: { HOME: coordHome }, workspace: ws, cliType: 'antigravity-cli' },
      )
      const entry = {
        meshId: 'review-lifecycle',
        sessionId: key,
        workspace: ws,
        startedAt: Date.now(),
        cliType: 'antigravity-cli',
        systemPrompt: prompt,
        injection: {
          mode: 'context_file',
          target: 'AGENTS.md',
          contextFile: {
            path: effect.contextFilePath!,
            owned: false,
            additionalOwnedFiles: effect.additionalOwnedFiles,
            retainForSessionLifetime: true,
          },
        },
      }
      registerMeshCoordinator(entry)

      // F5: Delete part-01 in coordHome, then call ensureCoordinatorContextFileMaterialized(entry)
      // WITHOUT launchEnv (as cli-manager-restore.ts does). Must restore into coordHome, not daemon HOME.
      rmSync(effect.additionalOwnedFiles![0]!)
      const restored = ensureCoordinatorContextFileMaterialized(entry)
      expect(restored).toBe(true)
      const loadedAfterRestore = collectAntigravityLoadedRules(ws, coordHome)
      expect(loadedAfterRestore.combined).toContain('COORD_LIFECYCLE_HEAD')
      expect(loadedAfterRestore.combined).toContain('COORD_LIFECYCLE_TAIL')

      // F3: Call restartSession where stopSession unregisters the coordinator and startSession rejects.
      // Registration and re-materialized files must be rolled back.
      const launch = {
        providerType: 'antigravity-cli',
        workspace: ws,
        launchedBy: 'mesh',
        roleLaunch: { role: 'coordinator', selection: { provider: 'antigravity-cli' } },
        model: { source: 'provider_default' },
        thinkingLevel: { source: 'provider_default' },
      }
      const manager = Object.create(DaemonCliManager.prototype) as any
      manager.findAdapter = () => ({ key, adapter: { workingDir: ws } })
      manager.deps = {
        getSessionRegistry: () => ({ get: () => ({ launch }) }),
        getInstanceManager: () => ({
          getInstance: () => ({ getState: () => ({ settings: { meshCoordinatorFor: 'review-lifecycle' } }) }),
        }),
      }
      manager.roleRestartInputs = new Map([[key, { cliArgs: [], options: { extraEnv: { HOME: coordHome } } }]])
      manager.stopSession = vi.fn(async () => unregisterMeshCoordinator(key))
      manager.startSession = vi.fn(async () => {
        throw new Error('scratch spawn failed')
      })

      await expect(manager.restartSession({ cliType: 'antigravity-cli', targetSessionId: key, dir: ws }))
        .rejects.toThrow('scratch spawn failed')
      expect(getCoordinatorForSession(key)).toBeUndefined()
      expect(existsSync(join(ws, 'AGENTS.md'))).toBe(false)
      expect(effect.additionalOwnedFiles!.filter(existsSync).length).toBe(0)
    } finally {
      detectSpy.mockRestore()
      validateSpy.mockRestore()
      unregisterMeshCoordinator(key)
      rmSync(ws, { recursive: true, force: true })
      rmSync(coordHome, { recursive: true, force: true })
    }
  })

  it('exercises production buildCoordinatorDelegatedCliLaunchOptions worker isolation alongside active coordinator rules', async () => {
    const { buildCoordinatorDelegatedCliLaunchOptions } = await import('../../src/commands/cli-delegated-launch.js')
    let current = path.resolve(__dirname, '..', '..')
    let agyManifest: any = null
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(current, 'adhdev-providers', 'cli', 'antigravity-cli', 'provider.v1.json')
      if (fs.existsSync(candidate)) {
        agyManifest = JSON.parse(fs.readFileSync(candidate, 'utf-8'))
        break
      }
      current = path.dirname(current)
    }
    expect(agyManifest).toBeTruthy()

    const ws = tempWorkspace('adhdev-agy-prod-worker-ws-')
    const coordHome = tempWorkspace('adhdev-agy-prod-coord-home-')
    let workerHome = ''
    try {
      writeFileSync(join(ws, 'AGENTS.md'), '# Repo Rules\nPreserve USER_PROD_WORKER_RULE_321.\n', 'utf-8')
      const prompt = 'COORD_PROD_HEAD\n' + 'Coordinator instruction.\n'.repeat(1_500) + 'COORD_PROD_TAIL_BEYOND_24KB'
      const effect = applyMeshCoordinatorSystemPromptInjection(
        prompt,
        agyManifest.meshCoordinator.systemPromptInjection,
        { cliArgs: [], launchEnv: { HOME: coordHome }, workspace: ws, cliType: 'antigravity-cli' },
      )

      const delegated = buildCoordinatorDelegatedCliLaunchOptions({
        cliType: 'antigravity-cli',
        workspace: ws,
        isolation: agyManifest.meshCoordinator.delegatedWorkerIsolation,
        mcpConfig: agyManifest.meshCoordinator.mcpConfig,
        sessionKey: 'worker-prod-session-1',
      })
      workerHome = delegated.env.HOME
      expect(workerHome).toBeTruthy()
      expect(workerHome).not.toBe(coordHome)
      expect(existsSync(join(workerHome, '.gemini', 'config', 'adhdev-mesh-coordinator'))).toBe(false)

      const coordView = collectAntigravityLoadedRules(ws, coordHome)
      expect(coordView.combined).toContain('USER_PROD_WORKER_RULE_321')
      expect(coordView.combined).toContain('COORD_PROD_HEAD')
      expect(coordView.combined).toContain('COORD_PROD_TAIL_BEYOND_24KB')

      const workerView = collectAntigravityLoadedRules(ws, workerHome)
      expect(workerView.combined).toContain('USER_PROD_WORKER_RULE_321')
      expect(workerView.combined).not.toContain('COORD_PROD_HEAD')
      expect(workerView.combined).not.toContain('COORD_PROD_TAIL_BEYOND_24KB')

      // Also verify production DaemonCliManager.restoreHostedSessions re-materializes
      // antigravity-cli coordinator rules into coordHome when missing on disk.
      const { registerMeshCoordinator, unregisterMeshCoordinator } = await import(
        '../../src/mesh/coordinator-registry.js'
      )
      registerMeshCoordinator({
        meshId: 'mesh-prod-restore',
        sessionId: 'coord-prod-restore-1',
        workspace: ws,
        startedAt: Date.now(),
        cliType: 'antigravity-cli',
        systemPrompt: prompt,
        injection: {
          mode: 'context_file',
          target: 'AGENTS.md',
          contextFile: {
            path: effect.contextFilePath!,
            owned: effect.contextFileOwned === true,
            open: effect.contextFileSentinels?.open,
            close: effect.contextFileSentinels?.close,
            retainForSessionLifetime: true,
            additionalOwnedFiles: effect.additionalOwnedFiles,
            homeDir: effect.contextFileHomeDir,
          },
        },
      })
      stripCoordinatorWrapperFile(effect.contextFilePath!, false, effect.contextFileSentinels, effect.additionalOwnedFiles)
      expect(readFileSync(join(ws, 'AGENTS.md'), 'utf-8')).not.toContain('COORD_PROD_HEAD')

      const { DaemonCliManager } = await import('../../src/commands/cli-manager.js')
      const { ProviderLoader } = await import('../../src/providers/provider-loader.js')
      const providerRoot = tempWorkspace('adhdev-agy-prod-providers-')
      try {
        const binDir = join(providerRoot, 'bin')
        fs.mkdirSync(binDir, { recursive: true })
        const executable = join(binDir, 'agy')
        writeFileSync(executable, '#!/bin/sh\nexit 0\n', 'utf-8')
        fs.chmodSync(executable, 0o755)
        const cliDir = join(providerRoot, 'cli', 'antigravity-cli')
        fs.mkdirSync(cliDir, { recursive: true })
        writeFileSync(join(cliDir, 'provider.json'), JSON.stringify(agyManifest), 'utf-8')
        writeFileSync(
          join(cliDir, 'spec.json'),
          JSON.stringify({
            $schema: 'adhdev:cli/spec@4',
            id: 'antigravity-cli',
            name: 'antigravity-cli',
            binary: 'agy',
            send_message: { submit_key: '\r' },
            sections: {},
            states: [{ id: 'idle', label: 'Idle', initial: true, status: 'idle' }],
            transitions: [],
          }),
          'utf-8',
        )
        class ProdTestProviderLoader extends ProviderLoader {
          constructor() {
            super({ userDir: providerRoot, disableUpstream: true })
          }
          protected override readConfig(): any {
            return {
              machineProviders: { 'antigravity-cli': { enabled: true, executable } },
              providerSettings: { 'antigravity-cli': { autoApprove: true } },
            }
          }
          protected override writeConfig(): void {}
        }
        const loader = new ProdTestProviderLoader()
        loader.loadAll()
        const addInstance = vi.fn()
        const manager = new DaemonCliManager(
          {
            getServerConn: () => null,
            getP2p: () => null,
            onStatusChange: vi.fn(),
            removeAgentTracking: vi.fn(),
            getInstanceManager: () => ({ addInstance, removeInstance: vi.fn(), getInstance: () => null } as any),
            getSessionRegistry: () => ({ register: vi.fn() } as any),
          },
          loader,
        )
        const restoredCount = await manager.restoreHostedSessions([
          { runtimeId: 'coord-prod-restore-1', cliType: 'antigravity-cli', workspace: ws },
        ])
        expect(restoredCount).toBe(1)
        expect(addInstance).toHaveBeenCalledTimes(1)
        const restoredView = collectAntigravityLoadedRules(ws, coordHome)
        expect(restoredView.combined).toContain('USER_PROD_WORKER_RULE_321')
        expect(restoredView.combined).toContain('COORD_PROD_HEAD')
        expect(restoredView.combined).toContain('COORD_PROD_TAIL_BEYOND_24KB')
      } finally {
        unregisterMeshCoordinator('coord-prod-restore-1')
        rmSync(providerRoot, { recursive: true, force: true })
      }
    } finally {
      rmSync(ws, { recursive: true, force: true })
      rmSync(coordHome, { recursive: true, force: true })
      if (workerHome) rmSync(workerHome, { recursive: true, force: true })
    }
  })

  it('D1-D4: handles out-of-order provisional/registered overlap failures, repoints survivor on latest termination, and preserves concurrent user edits and CRLF blank lines', async () => {
    const { registerMeshCoordinator, unregisterMeshCoordinator } = await import(
      '../../src/mesh/coordinator-registry.js'
    )
    const makePrompt = (token: string) => `${token}_HEAD\n` + 'Coordinator rule.\n'.repeat(2_000) + `${token}_TAIL`
    const inject = (ws: string, home: string, prompt: string) =>
      applyMeshCoordinatorSystemPromptInjection(
        prompt,
        { mode: 'context_file', path: 'AGENTS.md', wrapper: ANTIGRAVITY_WRAPPER },
        { cliArgs: [], launchEnv: { HOME: home }, workspace: ws, cliType: 'antigravity-cli' },
      )
    const reg = (id: string, ws: string, prompt: string, e: any) =>
      registerMeshCoordinator({
        meshId: id,
        sessionId: id,
        workspace: ws,
        cliType: 'antigravity-cli',
        systemPrompt: prompt,
        startedAt: Date.now(),
        injection: {
          mode: 'context_file',
          target: 'AGENTS.md',
          contextFile: {
            path: e.contextFilePath,
            owned: false,
            open: e.contextFileSentinels.open,
            close: e.contextFileSentinels.close,
            additionalOwnedFiles: e.additionalOwnedFiles,
            homeDir: e.contextFileHomeDir,
            retainForSessionLifetime: true,
          },
        },
      })

    // D1a: preserves newer provisional B when earlier provisional A fails first
    const ws1 = tempWorkspace('adhdev-agy-d1a-ws-')
    const home1 = tempWorkspace('adhdev-agy-d1a-home-')
    try {
      const a = inject(ws1, home1, makePrompt('A'))
      const b = inject(ws1, home1, makePrompt('B'))
      await scheduleInjectionCleanup(a, { launched: false, label: 'A failed before B resolves' })
      const view = collectAntigravityLoadedRules(ws1, home1).combined
      expect(view).toContain('B_HEAD')
      expect(view).toContain('B_TAIL')
      await scheduleInjectionCleanup(b, { launched: false, label: 'B dispose' })
      expect(existsSync(join(ws1, 'AGENTS.md'))).toBe(false)
    } finally {
      rmSync(ws1, { recursive: true, force: true })
      rmSync(home1, { recursive: true, force: true })
    }

    // D1b: does not resurrect both-failed provisional injections
    const ws2 = tempWorkspace('adhdev-agy-d1b-ws-')
    const home2 = tempWorkspace('adhdev-agy-d1b-home-')
    try {
      writeFileSync(join(ws2, 'AGENTS.md'), 'User only', 'utf-8')
      const a = inject(ws2, home2, makePrompt('A'))
      const b = inject(ws2, home2, makePrompt('B'))
      await scheduleInjectionCleanup(a, { launched: false, label: 'A fail first' })
      await scheduleInjectionCleanup(b, { launched: false, label: 'B fail second' })
      expect(readFileSync(join(ws2, 'AGENTS.md'), 'utf-8')).toBe('User only')
    } finally {
      rmSync(ws2, { recursive: true, force: true })
      rmSync(home2, { recursive: true, force: true })
    }

    // D1c: preserves newer registered C when older pending B fails after C succeeds
    const ws3 = tempWorkspace('adhdev-agy-d1c-ws-')
    const home3 = tempWorkspace('adhdev-agy-d1c-home-')
    try {
      const pa = makePrompt('A')
      const pb = makePrompt('B')
      const pc = makePrompt('C')
      const a = inject(ws3, home3, pa)
      reg('delta-A', ws3, pa, a)
      const b = inject(ws3, home3, pb)
      const c = inject(ws3, home3, pc)
      reg('delta-C', ws3, pc, c)
      await scheduleInjectionCleanup(b, { launched: false, label: 'B fail after C success' })
      const view = collectAntigravityLoadedRules(ws3, home3).combined
      expect(view).toContain('C_HEAD')
      expect(view).toContain('C_TAIL')
      expect(view).not.toContain('A_HEAD')
    } finally {
      unregisterMeshCoordinator('delta-C')
      unregisterMeshCoordinator('delta-A')
      rmSync(ws3, { recursive: true, force: true })
      rmSync(home3, { recursive: true, force: true })
    }

    // D2: repoints AGENTS to surviving A when latest registered B terminates
    const ws4 = tempWorkspace('adhdev-agy-d2-ws-')
    const home4 = tempWorkspace('adhdev-agy-d2-home-')
    try {
      const pa = makePrompt('A')
      const pb = makePrompt('B')
      const a = inject(ws4, home4, pa)
      reg('terminate-A', ws4, pa, a)
      const b = inject(ws4, home4, pb)
      reg('terminate-B', ws4, pb, b)
      unregisterMeshCoordinator('terminate-B')
      const view = collectAntigravityLoadedRules(ws4, home4).combined
      expect(view).toContain('A_HEAD')
      expect(view).toContain('A_TAIL')
      expect(b.additionalOwnedFiles!.filter(existsSync).length).toBe(0)
      expect(a.additionalOwnedFiles!.filter(existsSync).length).toBe(3)
    } finally {
      unregisterMeshCoordinator('terminate-A')
      rmSync(ws4, { recursive: true, force: true })
      rmSync(home4, { recursive: true, force: true })
    }

    // D3: preserves concurrent user edits when failed overlap rolls back
    const ws5 = tempWorkspace('adhdev-agy-d3-ws-')
    const home5 = tempWorkspace('adhdev-agy-d3-home-')
    try {
      const target = join(ws5, 'AGENTS.md')
      writeFileSync(target, 'Original user\r\n', 'utf-8')
      const pa = makePrompt('A')
      const a = inject(ws5, home5, pa)
      reg('edit-A', ws5, pa, a)
      const b = inject(ws5, home5, makePrompt('B'))
      writeFileSync(
        target,
        readFileSync(target, 'utf-8').replace('Original user', 'Edited user') + '\r\nUSER_CONCURRENT_SUFFIX',
        'utf-8',
      )
      await scheduleInjectionCleanup(b, { launched: false, label: 'B failure after user edits' })
      const current = readFileSync(target, 'utf-8')
      expect(current).toContain('Edited user')
      expect(current).toContain('USER_CONCURRENT_SUFFIX')
      const view = collectAntigravityLoadedRules(ws5, home5).combined
      expect(view).toContain('A_HEAD')
      expect(view).toContain('A_TAIL')
    } finally {
      unregisterMeshCoordinator('edit-A')
      rmSync(ws5, { recursive: true, force: true })
      rmSync(home5, { recursive: true, force: true })
    }

    // D4: preserves user-added surrounding newlines when daemon originally created AGENTS
    const ws6 = tempWorkspace('adhdev-agy-d4-ws-')
    const home6 = tempWorkspace('adhdev-agy-d4-home-')
    try {
      const e = inject(ws6, home6, 'PROMPT')
      const target = join(ws6, 'AGENTS.md')
      const prefix = '# User prepended\r\n\r\n'
      const suffix = '\r\nUser appended'
      writeFileSync(target, prefix + readFileSync(target, 'utf-8') + suffix, 'utf-8')
      stripCoordinatorWrapperFile(e.contextFilePath!, false, e.contextFileSentinels, e.additionalOwnedFiles)
      expect(readFileSync(target, 'utf-8')).toBe(prefix + suffix)
    } finally {
      rmSync(ws6, { recursive: true, force: true })
      rmSync(home6, { recursive: true, force: true })
    }
  })

  it('R1 & R2: retains departing chunks when read-only AGENTS.md blocks survivor repointing (with idempotent retry on unregister/prune) and persists wrapper separator provenance across registry reload', async () => {
    const {
      registerMeshCoordinator,
      unregisterMeshCoordinator,
      pruneDeadMeshCoordinators,
    } = await import('../../src/mesh/coordinator-registry.js')
    const { computeAntigravityCoordinatorScope } = await import('../../src/commands/antigravity-coordinator-rules.js')

    const makePrompt = (tag: string) =>
      `${tag}_HEAD\n` + 'Coordinator rule.\n'.repeat(2_000) + `${tag}_TAIL`

    const inject = (ws: string, home: string, prompt: string) =>
      applyMeshCoordinatorSystemPromptInjection(
        prompt,
        { mode: 'context_file', path: 'AGENTS.md', wrapper: ANTIGRAVITY_WRAPPER },
        { cliArgs: [], launchEnv: { HOME: home }, workspace: ws, cliType: 'antigravity-cli' },
      )

    const makeEntry = (id: string, ws: string, prompt: string, e: any) => ({
      meshId: id,
      sessionId: id,
      workspace: ws,
      cliType: 'antigravity-cli',
      systemPrompt: prompt,
      startedAt: Date.now(),
      injection: {
        mode: 'context_file',
        target: 'AGENTS.md',
        contextFile: {
          path: e.contextFilePath!,
          owned: false,
          open: e.contextFileSentinels?.open,
          close: e.contextFileSentinels?.close,
          additionalOwnedFiles: e.additionalOwnedFiles,
          homeDir: e.contextFileHomeDir,
          retainForSessionLifetime: true,
        },
      },
    })

    // R1 (unregister & prune): read-only AGENTS.md blocks repointing to survivor A ->
    // departing B's referenced chunks MUST be retained while AGENTS.md still references B,
    // and cleaned up on idempotent retry once AGENTS.md becomes writable.
    if (process.getuid?.() !== 0) {
      for (const mode of ['unregister', 'prune'] as const) {
        const ws = tempWorkspace(`adhdev-agy-r1-${mode}-ws-`)
        const home = tempWorkspace(`adhdev-agy-r1-${mode}-home-`)
        const target = join(ws, 'AGENTS.md')
        try {
          const pa = makePrompt('A')
          const pb = makePrompt('B')
          const scopeA = computeAntigravityCoordinatorScope(ws, pa)
          const scopeB = computeAntigravityCoordinatorScope(ws, pb)
          const a = inject(ws, home, pa)
          registerMeshCoordinator(makeEntry(`r1-${mode}-A`, ws, pa, a))
          const b = inject(ws, home, pb)
          registerMeshCoordinator(makeEntry(`r1-${mode}-B`, ws, pb, b))

          fs.chmodSync(target, 0o444)
          if (mode === 'prune') {
            pruneDeadMeshCoordinators(new Set([`r1-${mode}-A`]))
          } else {
            unregisterMeshCoordinator(`r1-${mode}-B`)
          }

          // Because AGENTS.md was read-only, repointing failed and AGENTS.md still references scopeB;
          // all 3 of B's chunk files must remain on disk so AGENTS.md has no dangling includes.
          expect(readFileSync(target, 'utf-8')).toContain(scopeB)
          expect(b.additionalOwnedFiles!.filter(existsSync).length).toBe(3)

          // Restore write permission and retry unregister/prune idempotently:
          fs.chmodSync(target, 0o644)
          if (mode === 'prune') {
            pruneDeadMeshCoordinators(new Set([`r1-${mode}-A`]))
          } else {
            unregisterMeshCoordinator(`r1-${mode}-B`)
          }

          expect(readFileSync(target, 'utf-8')).toContain(scopeA)
          expect(readFileSync(target, 'utf-8')).not.toContain(scopeB)
          expect(b.additionalOwnedFiles!.filter(existsSync).length).toBe(0)
          expect(a.additionalOwnedFiles!.filter(existsSync).length).toBe(3)
        } finally {
          try { fs.chmodSync(target, 0o644) } catch { /* ignore */ }
          unregisterMeshCoordinator(`r1-${mode}-B`)
          unregisterMeshCoordinator(`r1-${mode}-A`)
          rmSync(ws, { recursive: true, force: true })
          rmSync(home, { recursive: true, force: true })
        }
      }
    }

    // R2: persisted registry reload preserves daemon-created LF separators and concurrent user edits
    const wsReload = tempWorkspace('adhdev-agy-r2-ws-')
    const homeReload = tempWorkspace('adhdev-agy-r2-home-')
    try {
      const target = join(wsReload, 'AGENTS.md')
      const pa = makePrompt('RELOAD')
      const a = inject(wsReload, homeReload, pa)
      registerMeshCoordinator(makeEntry('r2-reload-A', wsReload, pa, a))

      const prefix = '# Concurrent user\n\n'
      const suffix = '\nUser suffix'
      writeFileSync(target, prefix + readFileSync(target, 'utf-8') + suffix, 'utf-8')

      vi.resetModules()
      const freshRegistry = await import('../../src/mesh/coordinator-registry.js')
      freshRegistry.loadMeshCoordinatorRegistry()
      const freshMesh = await import('../../src/commands/mesh-coordinator.js')
      const restoredEntry = freshRegistry.getCoordinatorForSession('r2-reload-A')
      expect(restoredEntry).toBeTruthy()
      const rematerialized = freshMesh.ensureCoordinatorContextFileMaterialized(restoredEntry)
      expect(rematerialized).toBe(false)

      freshRegistry.unregisterMeshCoordinator('r2-reload-A')
      expect(readFileSync(target, 'utf-8')).toBe(prefix + suffix)
    } finally {
      unregisterMeshCoordinator('r2-reload-A')
      rmSync(wsReload, { recursive: true, force: true })
      rmSync(homeReload, { recursive: true, force: true })
    }
  })
})
