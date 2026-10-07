/**
 * WORKSPACE CLOBBER (audit 2026-10-07).
 *
 * kimi, cursor-cli, opencode and grok-cli declare a WORKSPACE-relative
 * `mcpConfig.path`. `isPrivateWorkerTarget()` used to answer true whenever a
 * worker-private root existed — but the declared path still resolved to
 * `<workspace>/…`, so the worker config REPLACED the shared file: the
 * coordinator's entry and the owner's servers were erased, and concurrent
 * base-node workers raced on it.
 *
 * Contract pinned here, per provider: the worker config never replaces an
 * existing workspace file. Either it lives outside the workspace (private
 * user layer / inline env), or — only when a workspace layer would shadow the
 * private one — it is MERGED and taken back out at session teardown.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  __resetSharedWorkerMcpEntriesForTest,
  __resetWorkerSessionBindsForTest,
  deriveWorkerMcpDeliveryStatus,
  releaseWorkerMcpSharedEntries,
  resolveWorkerMcpIsolation,
  revokeWorkerSessionBindsForSession,
  subscribeWorkerMcpSharedConfigCleanup,
  writeWorkerMcpConfig,
} from '../../src/mesh/worker-mcp-isolation'
import { buildCoordinatorDelegatedCliLaunchOptions } from '../../src/commands/cli-delegated-launch'

const ON = { ADHDEV_WORKER_MCP: '1' } as NodeJS.ProcessEnv
const SERVER = { command: 'adhdev', args: ['mcp', '--mode', 'ipc', '--worker'] }
const COORD = { command: 'adhdev', args: ['mcp', '--mode', 'ipc', '--repo-mesh', 'mesh_x'] }
const dirs: string[] = []

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function fakeRealHome(): string {
  const home = tmp('adhdev-clobber-realhome-')
  // grok's spec requires an owner-only auth.json; the others need nothing.
  mkdirSync(join(home, '.grok'), { recursive: true })
  writeFileSync(join(home, '.grok', 'auth.json'), '{"token":"fixture"}')
  chmodSync(join(home, '.grok', 'auth.json'), 0o600)
  return home
}

function writeJson(file: string, value: unknown): string {
  mkdirSync(join(file, '..'), { recursive: true })
  const text = JSON.stringify(value, null, 2)
  writeFileSync(file, text)
  return text
}

const PROVIDERS = {
  kimi: { declared: '.kimi-code/mcp.json', format: 'claude_mcp_json', key: 'mcpServers' },
  'cursor-cli': { declared: '.cursor/mcp.json', format: 'claude_mcp_json', key: 'mcpServers' },
  opencode: { declared: 'opencode.json', format: 'opencode_json', key: 'mcp' },
  'grok-cli': { declared: '.mcp.json', format: 'claude_mcp_json', key: 'mcpServers' },
} as const

function launch(providerType: keyof typeof PROVIDERS, workspace: string, sessionId: string, realHome = fakeRealHome()) {
  const p = PROVIDERS[providerType]
  return resolveWorkerMcpIsolation({
    providerType,
    workspace,
    sessionKey: sessionId,
    realHome,
    baseDir: tmp('adhdev-clobber-base-'),
    mcpConfig: { mode: 'auto_import', format: p.format, path: p.declared, serverName: 'adhdev-mesh' },
    server: SERVER,
    bindContext: { meshId: 'mesh_x', sessionId },
  }, ON)!
}

beforeEach(() => {
  __resetWorkerSessionBindsForTest()
  __resetSharedWorkerMcpEntriesForTest()
})

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('worker MCP config never replaces a shared workspace file', () => {
  for (const providerType of Object.keys(PROVIDERS) as Array<keyof typeof PROVIDERS>) {
    const p = PROVIDERS[providerType]

    it(`${providerType}: writes to the private root and leaves an existing ${p.declared} byte-identical`, () => {
      const workspace = tmp(`adhdev-clobber-${providerType}-`)
      const ownerFile = join(workspace, p.declared)
      const before = writeJson(ownerFile, { [p.key]: { mine: providerType === 'opencode' ? { type: 'local', command: ['my-server'] } : { command: 'my-server' } } })

      const result = launch(providerType, workspace, `sess_${providerType}`)

      expect(readFileSync(ownerFile, 'utf-8')).toBe(before)
      expect(result.configPath).toBeTruthy()
      expect(result.configPath!.startsWith(result.workerHome!)).toBe(true)
      expect(result.configShared).toBeFalsy()
      const written = JSON.parse(readFileSync(result.configPath!, 'utf-8'))
      expect(Object.keys(written[p.key])).toEqual(['adhdev-mesh'])
      expect(deriveWorkerMcpDeliveryStatus(result, true)).toEqual({ delivered: true })
    })
  }

  it('cursor-cli lands in the private HOME global layer cursor loads without approval', () => {
    const result = launch('cursor-cli', tmp('adhdev-clobber-cursor-path-'), 'sess_cursor_path')
    expect(result.configPath).toBe(join(result.workerHome!, '.cursor', 'mcp.json'))
  })

  it('kimi lands in $KIMI_CODE_HOME/mcp.json (the root IS the .kimi-code dir)', () => {
    const result = launch('kimi', tmp('adhdev-clobber-kimi-path-'), 'sess_kimi_path')
    expect(result.configPath).toBe(join(result.workerHome!, 'mcp.json'))
  })

  it('opencode keeps the sanitized owner config (model/provider) in the private opencode.json', () => {
    const realHome = fakeRealHome()
    writeJson(join(realHome, '.config', 'opencode', 'opencode.json'), {
      model: 'kimi/k2', provider: { kimi: { name: 'Kimi' } }, mcp: { ownerServer: { type: 'local', command: ['x'] } },
    })
    const result = launch('opencode', tmp('adhdev-clobber-oc-model-'), 'sess_oc_model', realHome)
    expect(result.configPath).toBe(join(result.workerHome!, 'opencode', 'opencode.json'))
    const written = JSON.parse(readFileSync(result.configPath!, 'utf-8'))
    expect(written.model).toBe('kimi/k2')
    expect(written.provider).toEqual({ kimi: { name: 'Kimi' } })
    // The owner's mcp block was stripped on import and stays absent: only ours.
    expect(Object.keys(written.mcp)).toEqual(['adhdev-mesh'])
  })

  it('grok-cli shadows a coordinator .mcp.json entry from the private ~/.claude.json without touching it', () => {
    const workspace = tmp('adhdev-clobber-grok-coord-')
    const before = writeJson(join(workspace, '.mcp.json'), { mcpServers: { 'adhdev-mesh': COORD } })
    const result = launch('grok-cli', workspace, 'sess_grok_coord')
    expect(readFileSync(join(workspace, '.mcp.json'), 'utf-8')).toBe(before)
    expect(result.configPath).toBe(join(result.workerHome!, '.claude.json'))
  })

  it('★red→green: writeWorkerMcpConfig with a worker root MERGES a workspace-relative target instead of replacing it', () => {
    // The exact pre-fix shape: `workerHome` set, declared path workspace-relative.
    const workspace = tmp('adhdev-clobber-direct-')
    const workerHome = tmp('adhdev-clobber-direct-home-')
    writeJson(join(workspace, '.kimi-code', 'mcp.json'), { mcpServers: { 'adhdev-mesh': COORD, mine: { command: 'my-server' } } })

    const target = writeWorkerMcpConfig({
      declaredPath: '.kimi-code/mcp.json', format: 'claude_mcp_json', serverName: 'adhdev-worker',
      workspace, workerHome, server: SERVER,
    })

    expect(target).toBe(join(workspace, '.kimi-code', 'mcp.json'))
    const written = JSON.parse(readFileSync(target, 'utf-8'))
    expect(written.mcpServers['adhdev-mesh']).toEqual(COORD)
    expect(written.mcpServers.mine).toEqual({ command: 'my-server' })
    expect(written.mcpServers['adhdev-worker'].args).toContain('--worker')
  })
})

describe('collision fallback: a workspace layer already declares adhdev-mesh', () => {
  it('opencode delivers inline via OPENCODE_CONFIG_CONTENT and writes no file', () => {
    const workspace = tmp('adhdev-clobber-oc-coll-')
    const before = writeJson(join(workspace, 'opencode.json'), { mcp: { 'adhdev-mesh': { type: 'local', command: ['adhdev', 'mcp'] } } })
    const result = launch('opencode', workspace, 'sess_oc_coll')

    expect(readFileSync(join(workspace, 'opencode.json'), 'utf-8')).toBe(before)
    expect(result.configPath).toBeUndefined()
    const inline = JSON.parse(result.configEnv!.OPENCODE_CONFIG_CONTENT)
    expect(inline.mcp['adhdev-mesh'].command).toContain('--worker')
    expect(inline.mcp['adhdev-mesh'].environment.ADHDEV_WORKER_SESSION_BIND).toBe(result.bind)
    expect(deriveWorkerMcpDeliveryStatus(result, true)).toEqual({ delivered: true })
  })

  it('the launch seam exports the inline config into the worker env', () => {
    const workspace = tmp('adhdev-clobber-oc-seam-')
    writeJson(join(workspace, 'opencode.json'), { mcp: { 'adhdev-mesh': { type: 'local', command: ['adhdev', 'mcp'] } } })
    const options = buildCoordinatorDelegatedCliLaunchOptions({
      cliType: 'opencode',
      workspace,
      mcpConfig: { mode: 'auto_import', format: 'opencode_json', path: 'opencode.json', serverName: 'adhdev-mesh' },
      sessionKey: 'sess_oc_seam',
      realHome: fakeRealHome(),
      workerHomeBaseDir: tmp('adhdev-clobber-oc-seam-base-'),
      runtimeEnv: ON,
      bindContext: { meshId: 'mesh_x', sessionId: 'sess_oc_seam' },
    })
    expect(JSON.parse(options.env.OPENCODE_CONFIG_CONTENT).mcp['adhdev-mesh']).toBeTruthy()
  })

  for (const [providerType, coordFile] of [['kimi', '.mcp.json'], ['kimi', '.kimi-code/mcp.json'], ['cursor-cli', '.cursor/mcp.json']] as const) {
    it(`${providerType} (${coordFile} declares it): merges into the declared file, keeps siblings, restores at teardown`, () => {
      const workspace = tmp(`adhdev-clobber-coll-${providerType}-`)
      const declared = join(workspace, PROVIDERS[providerType].declared)
      writeJson(join(workspace, coordFile), { mcpServers: { 'adhdev-mesh': COORD, mine: { command: 'my-server' } } })
      const declaredBefore = existsSync(declared) ? JSON.parse(readFileSync(declared, 'utf-8')) : null

      const result = launch(providerType, workspace, 'sess_coll')

      expect(result.configShared).toBe(true)
      expect(result.configPath).toBe(declared)
      const merged = JSON.parse(readFileSync(declared, 'utf-8'))
      expect(merged.mcpServers['adhdev-mesh'].args).toContain('--worker')
      if (declaredBefore) expect(merged.mcpServers.mine).toEqual({ command: 'my-server' })

      expect(releaseWorkerMcpSharedEntries('sess_coll')).toBe(1)
      const after = JSON.parse(readFileSync(declared, 'utf-8'))
      if (declaredBefore) {
        // The coordinator's entry it shadowed is back, the owner's server never left.
        expect(after).toEqual(declaredBefore)
      } else {
        expect(after.mcpServers['adhdev-mesh']).toBeUndefined()
      }
    })
  }

  it('two concurrent workers: the survivor keeps its entry, the last one out restores the coordinator', () => {
    const workspace = tmp('adhdev-clobber-concurrent-')
    const declared = join(workspace, '.kimi-code', 'mcp.json')
    writeJson(declared, { mcpServers: { 'adhdev-mesh': COORD, mine: { command: 'my-server' } } })

    const w1 = launch('kimi', workspace, 'sess_w1')
    const w2 = launch('kimi', workspace, 'sess_w2')
    const entryOf = () => JSON.parse(readFileSync(declared, 'utf-8')).mcpServers['adhdev-mesh']
    expect(entryOf().env.ADHDEV_WORKER_SESSION_BIND).toBe(w2.bind)

    // W2 leaves first: W1 is still running and must get ITS entry back.
    releaseWorkerMcpSharedEntries('sess_w2')
    expect(entryOf().env.ADHDEV_WORKER_SESSION_BIND).toBe(w1.bind)

    releaseWorkerMcpSharedEntries('sess_w1')
    expect(entryOf()).toEqual(COORD)
    expect(JSON.parse(readFileSync(declared, 'utf-8')).mcpServers.mine).toEqual({ command: 'my-server' })
  })

  it('leaves the slot alone when someone else rewrote it after the worker', () => {
    const workspace = tmp('adhdev-clobber-rewritten-')
    const declared = join(workspace, '.cursor', 'mcp.json')
    writeJson(declared, { mcpServers: { 'adhdev-mesh': COORD } })
    launch('cursor-cli', workspace, 'sess_rw')
    const relaunched = { command: 'adhdev', args: ['mcp', '--repo-mesh', 'mesh_y'] }
    writeJson(declared, { mcpServers: { 'adhdev-mesh': relaunched } })

    expect(releaseWorkerMcpSharedEntries('sess_rw')).toBe(0)
    expect(JSON.parse(readFileSync(declared, 'utf-8')).mcpServers['adhdev-mesh']).toEqual(relaunched)
  })

  it('does not restore a dead worker entry left by a previous daemon — deletes the key instead', () => {
    const workspace = tmp('adhdev-clobber-dead-')
    const declared = join(workspace, '.cursor', 'mcp.json')
    const deadWorker = { command: 'adhdev', args: ['mcp', '--worker'], env: { ADHDEV_WORKER_SESSION_BIND: 'wsb_dead_never_minted' } }
    writeJson(declared, { mcpServers: { 'adhdev-mesh': deadWorker, mine: { command: 'my-server' } } })
    launch('cursor-cli', workspace, 'sess_dead')
    releaseWorkerMcpSharedEntries('sess_dead')
    const after = JSON.parse(readFileSync(declared, 'utf-8'))
    expect(after.mcpServers['adhdev-mesh']).toBeUndefined()
    expect(after.mcpServers.mine).toEqual({ command: 'my-server' })
  })

  it('teardown is wired to session termination (but not daemon shutdown)', () => {
    const workspace = tmp('adhdev-clobber-bus-')
    const declared = join(workspace, '.cursor', 'mcp.json')
    writeJson(declared, { mcpServers: { 'adhdev-mesh': COORD } })
    let handler: ((event: { sessionId: string; cause?: string }) => void) | null = null
    const bus = { on: (_name: string, fn: any) => { handler = fn; return () => { handler = null } } } as any
    const off = subscribeWorkerMcpSharedConfigCleanup(bus)

    launch('cursor-cli', workspace, 'sess_bus')
    handler!({ sessionId: 'sess_bus', cause: 'daemon_shutdown' })
    expect(JSON.parse(readFileSync(declared, 'utf-8')).mcpServers['adhdev-mesh'].args).toContain('--worker')

    revokeWorkerSessionBindsForSession('sess_bus')
    handler!({ sessionId: 'sess_bus', cause: 'stopped' })
    expect(JSON.parse(readFileSync(declared, 'utf-8')).mcpServers['adhdev-mesh']).toEqual(COORD)
    off()
  })
})
