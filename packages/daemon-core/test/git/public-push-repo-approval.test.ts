import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { handleGitCommand, createDefaultGitCommandServices } from '../../src/git/git-commands'
import { fastForwardMeshNode } from '../../src/mesh/mesh-fast-forward'
import { assertRefineryPublishApproved, runMeshRefineSubmoduleReachabilityGate } from '../../src/mesh/mesh-refine-gitlink-utils'
import { useSyntheticPublicPushPatterns } from '../helpers/public-push-patterns'
useSyntheticPublicPushPatterns()
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
function fixture(key: string) {
  const tmp = mkdtempSync(join(tmpdir(), 'repo-approval-'))
  const work = join(tmp, key); const remote = join(tmp, 'remote.git')
  mkdirSync(work); git(work, 'init', '-q', '-b', 'main'); git(work, 'init', '-q', '--bare', '-b', 'main', remote)
  git(work, 'config', 'user.name', 'vilmire'); git(work, 'config', 'user.email', 'vilmire@users.noreply.github.com')
  const repoName = { root: 'adhdev-cloud', oss: 'adhdev', 'adhdev-providers': 'adhdev-providers', 'homebrew-adhdev': 'homebrew-adhdev' }[key]
  if (repoName) git(remote, 'config', 'remote.origin.url', `https://github.com/vilmire/${repoName}.git`)
  git(work, 'remote', 'add', 'origin', remote)
  writeFileSync(join(work, 'file'), 'base\n'); git(work, 'add', 'file'); git(work, 'commit', '-qm', 'base'); git(work, 'push', '-qu', 'origin', 'main')
  writeFileSync(join(work, 'file'), 'pending\n'); git(work, 'commit', '-qam', 'pending')
  const sha = git(work, 'rev-parse', 'HEAD'); const before = git(remote, 'rev-parse', 'main')
  mkdirSync(join(work, '.adhdev')); writeFileSync(join(work, '.adhdev/public-push-patterns.json'), JSON.stringify({ ownerNames: ['fixture-owner'], knownHosts: ['FixtureHostZ'], blockedText: ['forged-token'] }))
  writeFileSync(join(work, '.git/info/exclude'), '.adhdev/\n')
  return { tmp, work, remote, sha, before }
}
for (const key of ['root', 'oss', 'adhdev-providers', 'homebrew-adhdev']) describe(`round5 P2-3 ${key} approval identity`, () => {
  for (const command of ['git_push', 'fast_forward']) it(`${command} rejects every other repository's key then accepts only its own`, async () => {
    const f = fixture(key)
    try {
      for (const wrong of ['root', 'oss', 'adhdev-providers', 'homebrew-adhdev'].filter(k => k !== key)) {
        const approvals = { [wrong]: [f.sha] }
        const result: any = command === 'git_push'
          ? await handleGitCommand('git_push', { workspace: f.work, approvedPublishShas: approvals }, createDefaultGitCommandServices())
          : await fastForwardMeshNode({ workspace: f.work, execute: true, mode: 'push', approvedPublishShas: approvals })
        expect(result.success, `${wrong} must not authorise ${key}`).toBe(false)
        expect(git(f.remote, 'rev-parse', 'main')).toBe(f.before)
      }
      const result: any = command === 'git_push'
        ? await handleGitCommand('git_push', { workspace: f.work, approvedPublishShas: { [key]: [f.sha] } }, createDefaultGitCommandServices())
        : await fastForwardMeshNode({ workspace: f.work, execute: true, mode: 'push', approvedPublishShas: { [key]: [f.sha] } })
      expect(result.success, result.error || result.operationError).toBe(true)
      expect(git(f.remote, 'rev-parse', 'main')).toBe(f.sha)
    } finally { rmSync(f.tmp, { recursive: true, force: true }) }
  }, 60000)
})
it('round5 P2-3 explicit key mismatch and canonical origin identity refuse cross-repo approvals', async () => {
  const f = fixture('oss')
  try {
    await expect(assertRefineryPublishApproved(f.work, f.sha, 'main', { root: [f.sha] }, 'origin', 'root')).rejects.toThrow()
    git(f.work, 'remote', 'add', 'mirror', f.remote)
    git(f.work, 'remote', 'set-url', 'origin', 'https://github.com/vilmire/adhdev.git')
    await expect(assertRefineryPublishApproved(f.work, f.sha, 'main', { root: [f.sha] }, 'mirror')).rejects.toThrow()
    await expect(assertRefineryPublishApproved(f.work, f.sha, 'main', { oss: [f.sha] }, 'mirror')).resolves.toBeUndefined()
  } finally { rmSync(f.tmp, { recursive: true, force: true }) }
})
it('round5 P2-3 zero-pending root is not counted and unreadable root evidence fails closed', async () => {
  const f = fixture('root')
  try {
    git(f.work, 'push', '-q', 'origin', 'main')
    const tree = git(f.work, 'rev-parse', 'HEAD^{tree}')
    const zero = await runMeshRefineSubmoduleReachabilityGate(f.work, tree, { approvedPublishShas: [], rootCommit: f.sha, rootBranch: 'main' } as any)
    expect(zero.status).toBe('passed'); expect((zero as any).publicRepoCount).toBe(0)
    git(f.work, 'remote', 'set-url', 'origin', join(f.tmp, 'missing.git'))
    const unreadable = await runMeshRefineSubmoduleReachabilityGate(f.work, tree, { approvedPublishShas: [f.sha], rootCommit: f.sha, rootBranch: 'main' } as any)
    expect(unreadable.status).toBe('failed'); expect(unreadable.error).toBeTruthy()
    expect(git(f.remote, 'rev-parse', 'main')).toBe(f.sha)
  } finally { rmSync(f.tmp, { recursive: true, force: true }) }
})

it('round5 P2-3 a renamed local clone follows its public origin identity', async () => {
  const f = fixture('renamed-public-checkout')
  try {
    git(f.remote, 'config', 'remote.origin.url', 'https://github.com/vilmire/adhdev.git')
    await expect(assertRefineryPublishApproved(f.work, f.sha, 'main', { root: [f.sha] })).rejects.toThrow()
    await expect(assertRefineryPublishApproved(f.work, f.sha, 'main', { oss: [f.sha] })).resolves.toBeUndefined()
  } finally { rmSync(f.tmp, { recursive: true, force: true }) }
})
it('round5 P2-3 an unidentified standalone repo never defaults to the root approval key', async () => {
  const f = fixture('unidentified')
  try {
    await expect(assertRefineryPublishApproved(f.work, f.sha, 'main', { root: [f.sha] })).rejects.toThrow()
    expect(git(f.remote, 'rev-parse', 'main')).toBe(f.before)
  } finally { rmSync(f.tmp, { recursive: true, force: true }) }
})
it('round5 P2-3 an unknown submodule named root cannot consume the root namespace', async () => {
  const f = fixture('unidentified')
  try {
    const parent = join(f.tmp, 'parent'); mkdirSync(parent); git(parent, 'init', '-q', '-b', 'main')
    git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', f.remote, 'root')
    const sub = join(parent, 'root')
    git(sub, 'fetch', '-q', f.work, f.sha); git(sub, 'checkout', '-q', '--detach', f.sha)
    await expect(assertRefineryPublishApproved(sub, f.sha, 'main', { root: [f.sha] })).rejects.toThrow()
    expect(git(f.remote, 'rev-parse', 'main')).toBe(f.before)
  } finally { rmSync(f.tmp, { recursive: true, force: true }) }
})
