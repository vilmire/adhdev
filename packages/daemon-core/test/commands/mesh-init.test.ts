import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  runMeshInit,
  suggestMeshWorktreeBootstrapConfig,
  suggestNodeProviderPriority,
  MESH_INIT_REFINE_CONFIG_PATH,
  MESH_INIT_WORKTREE_BOOTSTRAP_CONFIG_PATH,
  MESH_INIT_CHANGE_IMPACT_CONFIG_PATH,
} from '../../src/mesh/mesh-init'
import { loadMeshRefineConfig } from '../../src/mesh/refine-config'
import { loadMeshWorktreeBootstrapConfig } from '../../src/mesh/worktree-bootstrap-config'
import { loadChangeImpactConfig } from '../../src/git/change-impact-config'
import type { CLIInfo } from '../../src/detection/cli-detector'

async function createWorkspace(prefix: string, opts: { lock?: boolean; scripts?: Record<string, string> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  await mkdir(join(dir, '.adhdev'), { recursive: true })
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ scripts: opts.scripts ?? { test: 'vitest run', typecheck: 'tsc --noEmit' } }, null, 2),
  )
  if (opts.lock !== false) {
    await writeFile(join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }, null, 2))
  }
  return dir
}

function cli(id: string, installed: boolean, displayName = id, version?: string): CLIInfo {
  return { id, displayName, icon: '', command: id, installed, version, category: 'cli' }
}

describe('suggestNodeProviderPriority', () => {
  it('orders preferred providers first, then the rest in input order, dropping uninstalled', () => {
    const detected = [
      cli('gemini-cli', true),
      cli('codex-cli', true),
      cli('claude-cli', true, 'Claude Code', '2.1.0'),
      cli('some-other-cli', true),
      cli('not-installed-cli', false),
    ]
    const result = suggestNodeProviderPriority(detected)
    expect(result.providerPriority).toEqual(['claude-cli', 'codex-cli', 'gemini-cli', 'some-other-cli'])
    expect(result.installedProviders).toHaveLength(4)
    expect(result.installedProviders.find(p => p.id === 'claude-cli')?.version).toBe('2.1.0')
  })

  it('returns an empty priority when nothing is installed', () => {
    expect(suggestNodeProviderPriority([cli('claude-cli', false)]).providerPriority).toEqual([])
  })
})

describe('suggestMeshWorktreeBootstrapConfig', () => {
  it('suggests npm ci + lockfile staleInputs when a package-lock exists', async () => {
    const ws = await createWorkspace('mesh-init-boot-')
    const s = suggestMeshWorktreeBootstrapConfig(ws)
    expect(s.commands).toEqual([{ command: 'npm', args: ['ci'] }])
    expect(s.staleInputs).toContain('package-lock.json')
    expect(s.suggestedConfig?.version).toBe(1)
  })

  it('falls back to npm install when there is no lockfile', async () => {
    const ws = await createWorkspace('mesh-init-nolock-', { lock: false })
    const s = suggestMeshWorktreeBootstrapConfig(ws)
    expect(s.commands).toEqual([{ command: 'npm', args: ['install'] }])
    expect(s.staleInputs).toEqual([])
  })
})

describe('runMeshInit', () => {
  const detected = [cli('claude-cli', true, 'Claude Code', '2.1.0'), cli('codex-cli', true)]

  it('dry-run does not write files but returns suggested configs + providerPriority', async () => {
    const ws = await createWorkspace('mesh-init-dry-')
    const result = runMeshInit({}, ws, detected)
    expect(result.dryRun).toBe(true)
    expect(result.refine.written).toBe(false)
    expect(result.worktreeBootstrap.written).toBe(false)
    expect(result.changeImpact.written).toBe(false)
    expect(result.refine.config).toBeDefined()
    expect(result.worktreeBootstrap.config).toBeDefined()
    expect(result.changeImpact.config).toBeDefined()
    expect(result.providers.providerPriority).toEqual(['claude-cli', 'codex-cli'])
    expect(existsSync(join(ws, MESH_INIT_REFINE_CONFIG_PATH))).toBe(false)
    expect(existsSync(join(ws, MESH_INIT_WORKTREE_BOOTSTRAP_CONFIG_PATH))).toBe(false)
    expect(existsSync(join(ws, MESH_INIT_CHANGE_IMPACT_CONFIG_PATH))).toBe(false)
  })

  it('dry-run echoes the currently-saved config per domain (current-vs-suggested diff source)', async () => {
    // Isolate machine-local config so the magiKindPanels echo is deterministic (not the real user's).
    const prevConfigDir = process.env.ADHDEV_CONFIG_DIR
    process.env.ADHDEV_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'mesh-init-echo-cfg-'))
    try {
      const ws = await createWorkspace('mesh-init-echo-')
      // No repo config saved yet → currentConfig reports absent (unavailable) for every domain.
      const fresh = runMeshInit({}, ws, detected)
      expect(fresh.currentConfig).toBeDefined()
      expect(fresh.currentConfig.refine).toBeUndefined()
      expect(fresh.currentConfig.changeImpact).toBeUndefined()
      expect(fresh.currentConfig.sourceTypes.refine).toBe('unavailable')
      expect(fresh.currentConfig.sourceTypes.changeImpact).toBe('unavailable')
      expect(fresh.currentConfig.magiKindPanels).toEqual({})

      // Once a refine config is on disk, the echo reflects the saved value.
      const existing = { version: 1, validation: { required: true, commands: [{ command: 'npm', args: ['run', 'lint'] }] } }
      await writeFile(join(ws, MESH_INIT_REFINE_CONFIG_PATH), JSON.stringify(existing, null, 2))
      const after = runMeshInit({}, ws, detected)
      expect(after.currentConfig.sourceTypes.refine).toBe('repo_file')
      expect(after.currentConfig.refine?.validation?.commands?.[0]?.args).toEqual(['run', 'lint'])
    } finally {
      if (prevConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = prevConfigDir
    }
  })

  it('write=true persists valid, loadable configs', async () => {
    const ws = await createWorkspace('mesh-init-write-')
    const result = runMeshInit({}, ws, detected, { write: true })
    expect(result.dryRun).toBe(false)
    expect(result.refine.written).toBe(true)
    expect(result.worktreeBootstrap.written).toBe(true)

    // Files exist and round-trip through the real loaders (config-driven execution path).
    const loadedRefine = loadMeshRefineConfig({}, ws)
    expect(loadedRefine.sourceType).toBe('repo_file')
    expect(loadedRefine.config?.validation?.commands?.length).toBeGreaterThan(0)

    const loadedBoot = loadMeshWorktreeBootstrapConfig({}, ws)
    expect(loadedBoot.sourceType).toBe('repo_file')
    expect(loadedBoot.config?.commands?.length).toBeGreaterThan(0)

    // change-impact is written and round-trips through its real loader too.
    expect(result.changeImpact.written).toBe(true)
    const loadedImpact = loadChangeImpactConfig(ws)
    expect(loadedImpact.sourceType).toBe('repo_file')
    expect(loadedImpact.config?.impactTargets?.daemon?.recommendedCommand).toBeTruthy()

    // Written JSON is pretty-printed and trailing-newline terminated.
    const raw = await readFile(join(ws, MESH_INIT_REFINE_CONFIG_PATH), 'utf-8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(JSON.parse(raw).version).toBe(1)
  })

  it('never clobbers an existing change-impact config unless overwrite=true', async () => {
    const ws = await createWorkspace('mesh-init-impact-keep-')
    const existing = { daemonRuntimePackages: ['server'], impactTargets: { daemon: { recommendedCommand: 'hand-authored' } } }
    await writeFile(join(ws, MESH_INIT_CHANGE_IMPACT_CONFIG_PATH), JSON.stringify(existing, null, 2))

    const kept = runMeshInit({}, ws, detected, { write: true })
    expect(kept.changeImpact.written).toBe(false)
    expect(kept.changeImpact.skippedReason).toBe('already_exists')
    const afterKeep = JSON.parse(await readFile(join(ws, MESH_INIT_CHANGE_IMPACT_CONFIG_PATH), 'utf-8'))
    expect(afterKeep.impactTargets.daemon.recommendedCommand).toBe('hand-authored')

    const overwritten = runMeshInit({}, ws, detected, { write: true, overwrite: true })
    expect(overwritten.changeImpact.written).toBe(true)
    const afterOver = JSON.parse(await readFile(join(ws, MESH_INIT_CHANGE_IMPACT_CONFIG_PATH), 'utf-8'))
    // The heuristic draft replaced the hand-authored recommendedCommand wholesale.
    expect(afterOver.impactTargets.daemon.recommendedCommand).not.toBe('hand-authored')
  })

  it('never clobbers an existing config unless overwrite=true', async () => {
    const ws = await createWorkspace('mesh-init-keep-')
    const existing = { version: 1, validation: { required: true, commands: [{ command: 'npm', args: ['run', 'lint'] }] } }
    await writeFile(join(ws, MESH_INIT_REFINE_CONFIG_PATH), JSON.stringify(existing, null, 2))

    const kept = runMeshInit({}, ws, detected, { write: true })
    expect(kept.refine.written).toBe(false)
    expect(kept.refine.skippedReason).toBe('already_exists')
    const afterKeep = JSON.parse(await readFile(join(ws, MESH_INIT_REFINE_CONFIG_PATH), 'utf-8'))
    expect(afterKeep.validation.commands[0].args).toEqual(['run', 'lint'])

    const overwritten = runMeshInit({}, ws, detected, { write: true, overwrite: true })
    expect(overwritten.refine.written).toBe(true)
  })

  it('skips a config family with no suggestion (no package.json)', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'mesh-init-empty-'))
    const result = runMeshInit({}, ws, detected, { write: true })
    expect(result.worktreeBootstrap.written).toBe(false)
    expect(result.worktreeBootstrap.skippedReason).toBe('no_suggestion')
    expect(result.refine.skippedReason).toBe('no_suggestion')
  })
})
