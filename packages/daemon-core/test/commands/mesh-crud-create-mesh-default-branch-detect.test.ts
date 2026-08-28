import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

// create_mesh (F18/root-axis, item 3) — auto-detects mesh.defaultBranch from the
// workspace's git state when the caller does not pass one explicitly, instead of
// silently leaving it unset (every downstream reader then assumes 'main').
const testConfigDir = mkdtempSync(join(tmpdir(), 'adhdev-create-mesh-cfg-'))
vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => testConfigDir,
  loadConfig: () => ({ machineId: 'test-machine' } as any),
}))

import { meshCrudHandlers } from '../../src/commands/med-family/mesh-crud.js'
import { getMesh } from '../../src/config/mesh-config.js'
import type { MedFamilyContext } from '../../src/commands/med-family/types.js'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function initRepo(defaultBranch: string): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), `adhdev-create-mesh-repo-`)))
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-q', '-b', defaultBranch])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'ADHDev Test'])
  writeFileSync(join(repo, 'f.txt'), 'x\n', 'utf-8')
  git(repo, ['add', 'f.txt'])
  git(repo, ['commit', '-q', '-m', 'init'])
  return repo
}

const fakeCtx = { deps: {} } as unknown as MedFamilyContext

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
afterAll(() => {
  rmSync(testConfigDir, { recursive: true, force: true })
})

describe('create_mesh — defaultBranch auto-detection', () => {
  it('detects a master-default workspace when defaultBranch is not passed', async () => {
    const repo = initRepo('master')
    roots.push(repo)

    const result: any = await meshCrudHandlers.create_mesh(fakeCtx, {
      name: 'auto-detect-master',
      repoIdentity: 'local/test-master',
      workspace: repo,
    })

    expect(result.success).toBe(true)
    expect(result.mesh.defaultBranch).toBe('master')
    expect(getMesh(result.mesh.id)?.defaultBranch).toBe('master')
  }, 30000)

  it('stays byte-identical (detects "main") for a main-default workspace', async () => {
    const repo = initRepo('main')
    roots.push(repo)

    const result: any = await meshCrudHandlers.create_mesh(fakeCtx, {
      name: 'auto-detect-main',
      repoIdentity: 'local/test-main',
      workspace: repo,
    })

    expect(result.success).toBe(true)
    expect(result.mesh.defaultBranch).toBe('main')
  }, 30000)

  it('an explicit defaultBranch always wins over detection', async () => {
    const repo = initRepo('master')
    roots.push(repo)

    const result: any = await meshCrudHandlers.create_mesh(fakeCtx, {
      name: 'explicit-wins',
      repoIdentity: 'local/test-explicit',
      workspace: repo,
      defaultBranch: 'custom-trunk',
    })

    expect(result.success).toBe(true)
    expect(result.mesh.defaultBranch).toBe('custom-trunk')
  }, 30000)
})
