import { it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { handleGitCommand, createDefaultGitCommandServices } from '../../src/git/git-commands'
import { fastForwardMeshNode } from '../../src/mesh/mesh-fast-forward'
import { assertRefineryPublishApproved } from '../../src/mesh/mesh-refine-gitlink-utils'
import { useSyntheticPublicPushPatterns, bindPushDestination } from '../helpers/public-push-patterns'
useSyntheticPublicPushPatterns()
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
function fixture(originKind: string, host: string) {
  const temp = mkdtempSync(join(tmpdir(), 'approval-round6-')), work = join(temp, 'work'), bare = join(temp, 'remote.git')
  mkdirSync(work)
  git(work, 'init', '-q', '-b', 'main'); git(work, 'init', '-q', '--bare', '-b', 'main', bare)
  git(work, 'config', 'user.name', 'vilmire'); git(work, 'config', 'user.email', 'vilmire@users.noreply.github.com')
  git(work, 'remote', 'add', 'origin', bare)
  writeFileSync(join(work, 'file'), 'base\n'); git(work, 'add', 'file'); git(work, 'commit', '-qm', 'base'); git(work, 'push', '-qu', 'origin', 'main')
  const before = git(bare, 'rev-parse', 'main')
  writeFileSync(join(work, 'file'), 'pending\n'); git(work, 'commit', '-qam', 'pending'); const sha = git(work, 'rev-parse', 'HEAD')
  if (originKind === 'private') {
    const url = bindPushDestination(work, bare, 'root')
    git(work, 'remote', 'set-url', 'origin', url)
  } else git(bare, 'config', 'remote.origin.url', 'https://github.com/vilmire/adhdev-providers.git')
  bindPushDestination(work, bare, 'oss', 'origin', `https://${host}/vilmire/adhdev`)
  return { temp, work, bare, sha, before }
}
for (const host of ['www.github.com', 'github.com.']) for (const originKind of ['private', 'providers-mirror']) for (const entry of ['Refinery', 'git_push', 'mesh_fast_forward_node']) it(`round6 ${entry}: ${host} cannot borrow ${originKind} approval`, async () => {
  const f = fixture(originKind, host)
  const approvals = { [originKind === 'private' ? 'root' : 'adhdev-providers']: [f.sha] }
  try {
    if (entry === 'Refinery') await expect(assertRefineryPublishApproved(f.work, f.sha, 'main', approvals)).rejects.toThrow(/destination/i)
    else if (entry === 'git_push') {
      const result: any = await handleGitCommand('git_push', { workspace: f.work, approvedPublishShas: approvals }, createDefaultGitCommandServices())
      expect(result.success).toBe(false); expect(result.error).toMatch(/destination/i)
    } else {
      const result = await fastForwardMeshNode({ workspace: f.work, execute: true, mode: 'push', approvedPublishShas: approvals })
      expect(result.success).toBe(false); expect(result.operationError).toMatch(/destination/i)
    }
    expect(git(f.bare, 'rev-parse', 'main')).toBe(f.before)
  } finally { rmSync(f.temp, { recursive: true, force: true }) }
}, 60000)
it('round6 canonical push destination alone chooses the key despite a private origin', async () => {
  const f = fixture('private', 'github.com')
  try {
    await expect(assertRefineryPublishApproved(f.work, f.sha, 'main', { root: [f.sha] })).rejects.toThrow()
    await expect(assertRefineryPublishApproved(f.work, f.sha, 'main', { oss: [f.sha] })).resolves.toBeUndefined()
    expect(git(f.bare, 'rev-parse', 'main')).toBe(f.before)
  } finally { rmSync(f.temp, { recursive: true, force: true }) }
})
it('round6 each destination needs its own key; unknown extra destination always refuses', async () => {
  const f = fixture('private', 'github.com')
  try {
    const second = bindPushDestination(f.work, f.bare, 'adhdev-providers', 'other')
    git(f.work, 'config', '--add', 'remote.origin.pushurl', second)
    await expect(assertRefineryPublishApproved(f.work, f.sha, 'main', { oss: [f.sha] })).rejects.toThrow()
    await expect(assertRefineryPublishApproved(f.work, f.sha, 'main', [f.sha])).rejects.toThrow()
    await expect(assertRefineryPublishApproved(f.work, f.sha, 'main', { oss: [f.sha], 'adhdev-providers': [f.sha] })).resolves.toBeUndefined()
    git(f.work, 'config', '--add', 'remote.origin.pushurl', 'https://unknown.invalid/repo')
    await expect(assertRefineryPublishApproved(f.work, f.sha, 'main', { oss: [f.sha], 'adhdev-providers': [f.sha], root: [f.sha] })).rejects.toThrow(/destination/i)
    expect(git(f.bare, 'rev-parse', 'main')).toBe(f.before)
  } finally { rmSync(f.temp, { recursive: true, force: true }) }
})
for (const entry of ['git_push', 'mesh_fast_forward_node']) it(`round6 ${entry} requires all destination approvals before sending either push`, async () => {
  const f = fixture('private', 'github.com')
  try {
    const second = bindPushDestination(f.work, f.bare, 'adhdev-providers', 'other')
    git(f.work, 'config', '--add', 'remote.origin.pushurl', second)
    const run = async (approvals: Record<string, string[]>) => entry === 'git_push'
      ? await handleGitCommand('git_push', { workspace: f.work, approvedPublishShas: approvals }, createDefaultGitCommandServices())
      : await fastForwardMeshNode({ workspace: f.work, execute: true, mode: 'push', approvedPublishShas: approvals })
    expect((await run({ oss: [f.sha] })).success).toBe(false)
    expect(git(f.bare, 'rev-parse', 'main')).toBe(f.before)
    const approved: any = await run({ oss: [f.sha], 'adhdev-providers': [f.sha] })
    expect(approved.success, approved.error || approved.operationError).toBe(true)
    expect(git(f.bare, 'rev-parse', 'main')).toBe(f.sha)
  } finally { rmSync(f.temp, { recursive: true, force: true }) }
}, 60000)
it('round6 git_push raw URL refusal explains the named remote requirement', async () => {
  const f = fixture('private', 'github.com')
  try {
    const result: any = await handleGitCommand('git_push', { workspace: f.work, remote: 'https://github.com/vilmire/adhdev', approvedPublishShas: { oss: [f.sha] } }, createDefaultGitCommandServices())
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Raw URL.*named Git remote/)
    expect(git(f.bare, 'rev-parse', 'main')).toBe(f.before)
  } finally { rmSync(f.temp, { recursive: true, force: true }) }
})
