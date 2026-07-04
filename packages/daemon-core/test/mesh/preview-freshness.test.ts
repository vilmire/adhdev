import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { buildPreviewFreshness, isPreviewPipelineConfigured } from '../../src/mesh/preview-freshness'

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

async function createTempGitRepo(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  const repoRoot = join(dir, 'repo')
  await execFileAsync('git', ['init', repoRoot])
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot })
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot })
  await writeFile(join(repoRoot, 'README.md'), '# test\n')
  await execFileAsync('git', ['add', 'README.md'], { cwd: repoRoot })
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoRoot })
  return repoRoot
}

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe('preview-freshness F15 gate', () => {
  it('reports not-configured and returns null for a repo without any preview pipeline artifact', async () => {
    const repoRoot = await createTempGitRepo('preview-freshness-unconfigured-')

    expect(isPreviewPipelineConfigured(repoRoot)).toBe(false)
    // No private pipeline guidance must be produced for an unconfigured repo.
    expect(buildPreviewFreshness(repoRoot)).toBeNull()
  })

  it('treats a repo with the deploy:preview npm script as configured (no record yet)', async () => {
    const repoRoot = await createTempGitRepo('preview-freshness-npm-script-')
    await writeFile(join(repoRoot, 'package.json'), JSON.stringify({
      name: 'demo',
      scripts: { 'deploy:preview': 'node scripts/deploy-preview-local.mjs' },
    }))
    const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim()

    expect(isPreviewPipelineConfigured(repoRoot)).toBe(true)
    const freshness = buildPreviewFreshness(repoRoot)
    expect(freshness).not.toBeNull()
    // No deploy record → status is unknown, and the existing pipeline guidance is retained.
    expect(freshness).toEqual(expect.objectContaining({
      status: 'unknown',
      lastPreviewCommit: null,
      currentMainCommit: head,
      currentMainCommitSource: 'HEAD',
      recordPath: '.adhdev/preview-deploy.json',
    }))
    expect(freshness?.nextAction).toContain('deploy:preview')
  })

  it('treats a repo with a preview-deploy record as configured and preserves the existing surface', async () => {
    const repoRoot = await createTempGitRepo('preview-freshness-record-')
    await mkdir(join(repoRoot, '.adhdev'))
    await writeFile(join(repoRoot, '.adhdev', 'preview-deploy.json'), JSON.stringify({
      schemaVersion: 1,
      updatedAt: '2026-05-29T00:00:00.000Z',
      lastPreviewCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      target: 'all',
    }))
    const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim()

    expect(isPreviewPipelineConfigured(repoRoot)).toBe(true)
    const freshness = buildPreviewFreshness(repoRoot)
    expect(freshness).toEqual(expect.objectContaining({
      status: 'stale',
      lastPreviewCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      currentMainCommit: head,
      currentMainCommitSource: 'HEAD',
      recordPath: '.adhdev/preview-deploy.json',
      lastTarget: 'all',
    }))
  })

  it('treats a repo with the preview-freshness driver script as configured', async () => {
    const repoRoot = await createTempGitRepo('preview-freshness-script-')
    await mkdir(join(repoRoot, 'scripts'))
    await writeFile(join(repoRoot, 'scripts', 'preview-freshness.mjs'), '// driver\n')

    expect(isPreviewPipelineConfigured(repoRoot)).toBe(true)
    expect(buildPreviewFreshness(repoRoot)).not.toBeNull()
  })
})
