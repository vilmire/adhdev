import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { runMeshRefineSubmoduleReachabilityGate } from '../../src/commands/router'

/**
 * ★Owner rule 2026-10-22: nothing is pushed to the PUBLIC oss remote unless author +
 * committer are the vilmire noreply identity and the full pushed history is free of
 * personal paths. The repo's pre-push hook may be absent (installed daemon, fresh
 * worktree), so the Refinery's own `git push origin <commit>:refs/heads/main`
 * runs the checker itself, fail-closed, before sending anything.
 *
 * Fixture trick: the guard recognises the public repo by URL (`…/vilmire/adhdev`), so the
 * "origin" is a local bare repo whose PATH ends in vilmire/adhdev.
 */

const GOOD = { name: 'vilmire', email: 'vilmire@users.noreply.github.com' }
const BAD = { name: 'Test User', email: 'test@example.com' }
const AUTO_PUBLISH_ON = { allowAutoPublishSubmoduleMainCommits: true } as const
// A PUBLIC remote additionally needs the owner's per-commit approval; these tests exercise the guard BEHIND it.
const approved = (f: { localOnly: string }) => ({ ...AUTO_PUBLISH_ON, approvedPublishShas: [f.localOnly] })
const cleanups: string[] = []

function git(cwd: string, args: string[], id = BAD): string {
  return execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, GIT_AUTHOR_NAME: id.name, GIT_AUTHOR_EMAIL: id.email, GIT_COMMITTER_NAME: id.name, GIT_COMMITTER_EMAIL: id.email },
  }).trim()
}

afterEach(() => {
  while (cleanups.length) {
    try { rmSync(cleanups.pop()!, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

function fixture(opts: { originSubpath: string; id: typeof GOOD; content: string }) {
  const tmp = mkdtempSync(join(tmpdir(), 'refine-public-guard-'))
  cleanups.push(tmp)
  const origin = join(tmp, opts.originSubpath)
  mkdirSync(origin, { recursive: true })
  git(origin, ['init', '-q', '--bare', '-b', 'main'])
  const seed = join(tmp, 'seed')
  mkdirSync(seed)
  git(seed, ['init', '-q', '-b', 'main'], GOOD)
  writeFileSync(join(seed, 'mod.txt'), 'v1\n')
  git(seed, ['add', '.'], GOOD)
  git(seed, ['commit', '-q', '-m', 'seed'], GOOD)
  git(seed, ['push', '-q', origin, 'main'], GOOD)
  const base = join(tmp, 'base')
  mkdirSync(base)
  git(base, ['init', '-q', '-b', 'main'], GOOD)
  writeFileSync(join(base, 'top.txt'), 'top\n')
  git(base, ['add', '.'], GOOD)
  git(base, ['commit', '-q', '-m', 'root'], GOOD)
  git(base, ['submodule', 'add', '-q', origin, 'sub'], GOOD)
  const sub = join(base, 'sub')
  writeFileSync(join(sub, 'local-only.txt'), opts.content)
  git(sub, ['add', 'local-only.txt'], opts.id)
  git(sub, ['commit', '-q', '-m', 'sub local only'], opts.id)
  const localOnly = git(sub, ['rev-parse', 'HEAD'], opts.id)
  git(base, ['add', 'sub'], GOOD)
  git(base, ['commit', '-q', '-m', 'gitlink -> local only'], GOOD)
  const mergedTree = git(base, ['rev-parse', 'HEAD^{tree}'], GOOD)
  const originMain = () => execFileSync('git', ['rev-list', 'main'], { cwd: origin, encoding: 'utf-8' }).split('\n').filter(Boolean)
  return { base, sub, origin, mergedTree, localOnly, originMain }
}

describe('Refinery oss auto-publish runs the public-push guard itself', () => {
  it('★refuses a commit with a foreign author/committer identity — nothing reaches origin', async () => {
    const f = fixture({ originSubpath: 'vilmire/adhdev', id: BAD, content: 'clean\n' })
    const before = f.originMain()
    const gate = await runMeshRefineSubmoduleReachabilityGate(f.base, f.mergedTree, approved(f))
    const [entry] = gate.unreachable
    expect(gate.status).toBe('failed')
    expect(entry.autoPublishSucceeded).toBe(false)
    expect(entry.error).toContain('public-oss push guard BLOCKED')
    expect(entry.error).toContain('identity')
    expect(f.originMain()).toEqual(before)
    expect(f.originMain()).not.toContain(f.localOnly)
  })

  it('★refuses a personal home path in the pushed history even with the right identity', async () => {
    const f = fixture({ originSubpath: 'vilmire/adhdev', id: GOOD, content: `const p = '${['C:', 'Users', 'mallory', 'repo'].join('\\\\')}'\n` })  // built at runtime: the tree scan must not see a literal leak
    const gate = await runMeshRefineSubmoduleReachabilityGate(f.base, f.mergedTree, approved(f))
    const [entry] = gate.unreachable
    expect(entry.autoPublishSucceeded).toBe(false)
    expect(entry.error).toContain('personal path')
    expect(f.originMain()).not.toContain(f.localOnly)
  })

  it('a clean vilmire-noreply commit is still auto-published and verified (no over-blocking)', async () => {
    const f = fixture({ originSubpath: 'vilmire/adhdev', id: GOOD, content: 'clean\n' })
    const gate = await runMeshRefineSubmoduleReachabilityGate(f.base, f.mergedTree, approved(f))
    expect(gate.status).toBe('passed')
    expect(f.originMain()).toContain(f.localOnly)
  })

  it('other submodule remotes (not the public oss repo) are not gated', async () => {
    const f = fixture({ originSubpath: 'someone/other-repo', id: BAD, content: 'clean\n' })
    const gate = await runMeshRefineSubmoduleReachabilityGate(f.base, f.mergedTree, AUTO_PUBLISH_ON)
    expect(gate.status).toBe('passed')
    expect(f.originMain()).toContain(f.localOnly)
  })
})


describe('round 3 destination proof and push URL regressions', () => {
  it('F11: the assertion scans unpublished ancestry behind forged tracking refs', async () => {
    const { assertPublishableToPublicOss } = await import('../../src/git/public-push-guard.mjs')
    const f = fixture({ originSubpath: 'vilmire/adhdev', id: GOOD, content: ['/', 'Users', 'mallory', 'private'].join('/') })
    writeFileSync(join(f.sub, 'local-only.txt'), 'clean\n')
    git(f.sub, ['commit', '-qam', 'cleanup'], GOOD)
    const tip = git(f.sub, ['rev-parse', 'HEAD'])
    git(f.sub, ['update-ref', 'refs/remotes/origin/main', tip])
    git(f.sub, ['update-ref', 'refs/remotes/origin/forged', tip])
    await expect(assertPublishableToPublicOss(f.sub, tip)).rejects.toThrow('personal path')
  })

  for (const rewrite of ['pushurl', 'url', 'insteadOf', 'pushInsteadOf']) {
    it(`F13: a public second push destination is guarded (${rewrite})`, async () => {
      const f = fixture({ originSubpath: 'someone/other-repo', id: BAD, content: 'clean\n' })
      const publicOrigin = join(f.base, '..', 'vilmire', 'adhdev')
      mkdirSync(join(f.base, '..', 'vilmire'), { recursive: true })
      git(f.base, ['clone', '-q', '--bare', f.origin, publicOrigin])
      const alias = 'fixture-public:repo'
      if (rewrite === 'url') {
        git(f.sub, ['config', '--add', 'remote.origin.url', publicOrigin])
      } else {
        git(f.sub, ['config', '--add', 'remote.origin.pushurl', f.origin])
        if (rewrite === 'pushurl') git(f.sub, ['config', '--add', 'remote.origin.pushurl', publicOrigin])
        else if (rewrite === 'insteadOf') {
          git(f.sub, ['config', `url.${publicOrigin}.insteadOf`, alias])
          git(f.sub, ['config', '--add', 'remote.origin.pushurl', alias])
        } else {
          git(f.sub, ['config', '--unset-all', 'remote.origin.pushurl'])
          git(f.sub, ['config', `url.${publicOrigin}.pushInsteadOf`, alias])
          git(f.sub, ['config', '--add', 'remote.origin.url', alias])
        }
      }
      const before = f.originMain()
      const gate = await runMeshRefineSubmoduleReachabilityGate(f.base, f.mergedTree, approved(f))
      expect(gate.status).toBe('failed')
      expect(gate.unreachable[0].error).toContain('public-oss push guard BLOCKED')
      expect(f.originMain()).toEqual(before)
      expect(git(publicOrigin, ['rev-parse', 'main'])).toBe(before[0])
    })
  }
})


describe('★owner rule: the Refinery never publishes to a PUBLIC remote without per-commit approval', () => {
  function publicFixtureWithTwoCommits() {
    const f = fixture({ originSubpath: 'vilmire/adhdev', id: GOOD, content: 'one\n' })
    const first = f.localOnly
    writeFileSync(join(f.sub, 'second.txt'), 'two\n')
    git(f.sub, ['add', 'second.txt'], GOOD)
    git(f.sub, ['commit', '-q', '-m', 'second local commit'], GOOD)
    const second = git(f.sub, ['rev-parse', 'HEAD'], GOOD)
    git(f.base, ['add', 'sub'], GOOD)
    git(f.base, ['commit', '-q', '-m', 'gitlink -> second'], GOOD)
    return { ...f, first, second, mergedTree: git(f.base, ['rev-parse', 'HEAD^{tree}'], GOOD) }
  }

  it('no approval → blocked BEFORE pushing, with every would-be-public commit listed', async () => {
    const f = publicFixtureWithTwoCommits()
    const before = f.originMain()
    const gate = await runMeshRefineSubmoduleReachabilityGate(f.base, f.mergedTree, AUTO_PUBLISH_ON)
    const [entry] = gate.unreachable
    expect(gate.status).toBe('failed')
    expect(entry.autoPublishAttempted).toBe(false)
    expect(entry.autoPublishSkippedReason).toContain('publish_approval_required')
    expect(entry.publishApproval?.commits.map(c => c.sha)).toEqual([f.first, f.second])
    expect(entry.publishApproval?.commits[1]).toMatchObject({ subject: 'second local commit', author: 'vilmire <vilmire@users.noreply.github.com>', committer: 'vilmire <vilmire@users.noreply.github.com>', guardScan: 'clean', approved: false })
    expect(f.originMain()).toEqual(before)
  })

  it('the exact approved set (abbreviated SHAs allowed) → published and verified', async () => {
    const f = publicFixtureWithTwoCommits()
    const gate = await runMeshRefineSubmoduleReachabilityGate(f.base, f.mergedTree, { ...AUTO_PUBLISH_ON, approvedPublishShas: [f.first.slice(0, 10), f.second] })
    expect(gate.status).toBe('passed')
    expect(f.originMain()).toContain(f.second)
  })

  it('an approved set that misses one commit → blocked, nothing pushed', async () => {
    const f = publicFixtureWithTwoCommits()
    const before = f.originMain()
    const gate = await runMeshRefineSubmoduleReachabilityGate(f.base, f.mergedTree, { ...AUTO_PUBLISH_ON, approvedPublishShas: [f.second] })
    const [entry] = gate.unreachable
    expect(gate.status).toBe('failed')
    expect(entry.publishApproval?.unapproved).toEqual([f.first])
    expect(f.originMain()).toEqual(before)
  })

  it('an approved set with an EXTRA sha (stale/wrong approval) → blocked, nothing pushed', async () => {
    const f = publicFixtureWithTwoCommits()
    const before = f.originMain()
    const gate = await runMeshRefineSubmoduleReachabilityGate(f.base, f.mergedTree, { ...AUTO_PUBLISH_ON, approvedPublishShas: [f.first, f.second, 'deadbeefdeadbeef'] })
    const [entry] = gate.unreachable
    expect(gate.status).toBe('failed')
    expect(entry.publishApproval?.extraApproved).toEqual(['deadbeefdeadbeef'])
    expect(f.originMain()).toEqual(before)
  })

  it('a guard-blocked commit is reported as blocked in the approval request', async () => {
    const f = fixture({ originSubpath: 'vilmire/adhdev', id: BAD, content: 'clean\n' })
    const gate = await runMeshRefineSubmoduleReachabilityGate(f.base, f.mergedTree, AUTO_PUBLISH_ON)
    expect(gate.unreachable[0].publishApproval?.commits[0].guardScan).toBe('blocked')
    expect(f.originMain()).not.toContain(f.localOnly)
  })

  it('a private remote is unchanged: auto-published with no approval argument', async () => {
    const f = fixture({ originSubpath: 'someone/private-repo', id: GOOD, content: 'clean\n' })
    const gate = await runMeshRefineSubmoduleReachabilityGate(f.base, f.mergedTree, AUTO_PUBLISH_ON)
    expect(gate.status).toBe('passed')
    expect(gate.entries[0].publishApproval).toBeUndefined()
    expect(f.originMain()).toContain(f.localOnly)
  })
})
