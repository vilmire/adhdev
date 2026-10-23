import { useSyntheticPublicPushPatterns, bindPushDestination } from '../helpers/public-push-patterns'
import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { evaluatePublicPublishApproval } from '../../src/mesh/mesh-refine-gitlink-utils'
import { runMeshRefineSubmoduleReachabilityGate } from '../../src/commands/router'

/**
 * ★Owner rule 2026-10-22: nothing is pushed to the PUBLIC oss remote unless author +
 * committer are the vilmire noreply identity and the full pushed history is free of
 * personal paths. The repo's pre-push hook may be absent (installed daemon, fresh
 * worktree), so the Refinery's own `git push origin <commit>:refs/heads/main`
 * runs the checker itself, fail-closed, before sending anything.
 *
 * Local bare origins are explicitly public via remote.origin.adhdev-private=false.
 * Tests exercising private behavior explicitly override that local setting.
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
  mkdirSync(join(base, '.adhdev'), { recursive: true })
  writeFileSync(join(base, '.adhdev/public-push-patterns.json'), JSON.stringify({ ownerNames: ['fixture-owner'], knownHosts: ['FleetFixtureZ'] }))
  const sub = join(base, 'sub')
  git(sub, ['config', 'remote.origin.adhdev-private', 'false'])
  writeFileSync(join(sub, 'local-only.txt'), opts.content)
  git(sub, ['add', 'local-only.txt'], opts.id)
  git(sub, ['commit', '-q', '-m', 'sub local only'], opts.id)
  const localOnly = git(sub, ['rev-parse', 'HEAD'], opts.id)
  git(base, ['add', 'sub'], GOOD)
  git(base, ['commit', '-q', '-m', 'gitlink -> local only'], GOOD)
  const mergedTree = git(base, ['rev-parse', 'HEAD^{tree}'], GOOD)
  bindPushDestination(sub, origin, opts.originSubpath.endsWith('adhdev-providers') ? 'adhdev-providers' : 'oss')
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

  it('a local private marker cannot bypass public identity and approval checks', async () => {
    const f = fixture({ originSubpath: 'someone/other-repo', id: BAD, content: 'clean\n' })
    git(f.sub, ['config', 'remote.origin.adhdev-private', 'true'])
    const gate = await runMeshRefineSubmoduleReachabilityGate(f.base, f.mergedTree, AUTO_PUBLISH_ON)
    expect(gate.status).toBe('failed')
    expect(gate.unreachable[0].publishApproval).toBeDefined()
    expect(f.originMain()).not.toContain(f.localOnly)
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
        git(f.sub, ['config', '--unset-all', 'remote.origin.pushurl'])
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
      expect(gate.unreachable[0].error).toMatch(/public-oss push guard BLOCKED|unknown push destination/)
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
    expect(entry.publishApproval?.invalidApproved).toEqual(['deadbeefdeadbeef'])
    expect(f.originMain()).toEqual(before)
  })

  it('a guard-blocked commit is reported as blocked in the approval request', async () => {
    const f = fixture({ originSubpath: 'vilmire/adhdev', id: BAD, content: 'clean\n' })
    const gate = await runMeshRefineSubmoduleReachabilityGate(f.base, f.mergedTree, AUTO_PUBLISH_ON)
    expect(gate.unreachable[0].publishApproval?.commits[0].guardScan).toBe('blocked')
    expect(f.originMain()).not.toContain(f.localOnly)
  })

  it('a local private marker still requires exact public approval', async () => {
    const f = fixture({ originSubpath: 'someone/private-repo', id: GOOD, content: 'clean\n' })
    git(f.sub, ['config', 'remote.origin.adhdev-private', 'true'])
    const gate = await runMeshRefineSubmoduleReachabilityGate(f.base, f.mergedTree, AUTO_PUBLISH_ON)
    expect(gate.status).toBe('failed')
    expect(gate.unreachable[0].publishApproval).toBeDefined()
    expect(f.originMain()).not.toContain(f.localOnly)
  })
})


describe('review approval regressions', () => {
  function rawCommit(sub: string, parents: string[], message: string) {
    return [`tree ${git(sub, ['rev-parse', 'HEAD^{tree}'])}`, ...parents.map(p => `parent ${p}`),
      `author ${GOOD.name} <${GOOD.email}> 1700000000 +0000`, `committer ${GOOD.name} <${GOOD.email}> 1700000000 +0000`, '', message, ''].join('\n')
  }
  function store(sub: string, raw: string) {
    return execFileSync('git', ['hash-object', '-w', '-t', 'commit', '--stdin'], { cwd: sub, input: raw, encoding: 'utf8' }).trim()
  }
  it('P1-1: a colliding seven-hex approval cannot approve two pending commits', async () => {
    const f = fixture({ originSubpath: 'vilmire/adhdev', id: GOOD, content: 'clean\n' })
    const seen = new Map<string, string>()
    let a = '', b = '', prefix = ''
    const template = rawCommit(f.sub, [f.localOnly], 'nonce ')
    for (let i = 0; i < 200000; i++) {
      const raw = template + i
      const sha = createHash('sha1').update(`commit ${Buffer.byteLength(raw)}\0`).update(raw).digest('hex')
      prefix = sha.slice(0, 7)
      if (seen.has(prefix)) { a = store(f.sub, seen.get(prefix)!); b = store(f.sub, raw); break }
      seen.set(prefix, raw)
    }
    expect(a).not.toBe('')
    const merge = store(f.sub, rawCommit(f.sub, [a, b], 'merge collision'))
    const request = await evaluatePublicPublishApproval(f.sub, merge, 'main', [f.localOnly, prefix, merge])
    expect(request).toBeDefined()
    expect(request!.unapproved).toEqual(expect.arrayContaining([a, b]))
    expect((await evaluatePublicPublishApproval(f.sub, a, 'main', [f.localOnly, prefix]))?.unapproved).toContain(a)
  })
  it.each(['replace', 'graft'])('P1-2: %s cannot hide an unapproved ancestor', async (mode) => {
    const f = fixture({ originSubpath: 'vilmire/adhdev', id: GOOD, content: 'first\n' })
    const origin = git(f.sub, ['rev-parse', 'origin/main'])
    const tip = store(f.sub, rawCommit(f.sub, [f.localOnly], 'second'))
    if (mode === 'replace') git(f.sub, ['replace', tip, store(f.sub, rawCommit(f.sub, [origin], 'replacement'))])
    else writeFileSync(git(f.sub, ['rev-parse', '--git-path', 'info/grafts']).startsWith('/') ? git(f.sub, ['rev-parse', '--git-path', 'info/grafts']) : join(f.sub, git(f.sub, ['rev-parse', '--git-path', 'info/grafts'])), `${tip} ${origin}\n`)
    const request = await evaluatePublicPublishApproval(f.sub, tip, 'main', [tip])
    expect(request?.unapproved).toContain(f.localOnly)
  })
  it('P1-3: fresh fetch mirror cannot prove possession at another push destination', async () => {
    const f = fixture({ originSubpath: 'vilmire/adhdev', id: GOOD, content: 'first\n' })
    const mirror = join(f.base, '..', 'mirror.git')
    git(f.sub, ['clone', '-q', '--bare', f.sub, mirror])
    git(f.sub, ['remote', 'set-url', 'origin', mirror])
    bindPushDestination(f.sub, f.origin, 'oss')
    git(f.sub, ['fetch', 'origin', 'main:refs/remotes/origin/main'])
    const tip = store(f.sub, rawCommit(f.sub, [f.localOnly], 'second'))
    const request = await evaluatePublicPublishApproval(f.sub, tip, 'main', [tip])
    expect(request?.unapproved).toContain(f.localOnly)
  })
  it('P1-3: multiple push destinations require the union of pending commits', async () => {
    const f = fixture({ originSubpath: 'vilmire/adhdev', id: GOOD, content: 'first\n' })
    const mirror = join(f.base, '..', 'mirror.git')
    git(f.sub, ['clone', '-q', '--bare', f.sub, mirror])
    git(f.sub, ['remote', 'set-url', 'origin', mirror])
    bindPushDestination(f.sub, mirror, 'oss')
    const secondUrl = bindPushDestination(f.sub, f.origin, 'oss', 'second', 'ssh://git@github.com/vilmire/adhdev.git')
    git(f.sub, ['config', '--add', 'remote.origin.pushurl', secondUrl])
    git(f.sub, ['fetch', 'origin', 'main:refs/remotes/origin/main'])
    const tip = store(f.sub, rawCommit(f.sub, [f.localOnly], 'second'))
    expect((await evaluatePublicPublishApproval(f.sub, tip, 'main', [tip]))?.unapproved).toContain(f.localOnly)
    expect(await evaluatePublicPublishApproval(f.sub, tip, 'main', [f.localOnly, tip])).toBeUndefined()
  })
  it('P1-3: an unreadable push destination refuses even a complete approval', async () => {
    const f = fixture({ originSubpath: 'vilmire/adhdev', id: GOOD, content: 'clean\n' })
    bindPushDestination(f.sub, join(f.base, 'missing'), 'oss')
    expect(await evaluatePublicPublishApproval(f.sub, f.localOnly, 'main', [f.localOnly])).toBeDefined()
  })
  it('P1-4: unknown local destinations need approval; providers also runs the identity guard', async () => {
    const unknown = fixture({ originSubpath: 'unknown/repo', id: GOOD, content: 'clean\n' })
    git(unknown.sub, ['config', '--unset', 'remote.origin.adhdev-private'])
    git(unknown.sub, ['config', '--unset-all', 'remote.origin.pushurl'])
    expect((await runMeshRefineSubmoduleReachabilityGate(unknown.base, unknown.mergedTree, AUTO_PUBLISH_ON)).entries[0].autoPublishAttempted).toBe(false)
    const providers = fixture({ originSubpath: 'vilmire/adhdev-providers', id: BAD, content: 'clean\n' })
    const gate = await runMeshRefineSubmoduleReachabilityGate(providers.base, providers.mergedTree, approved(providers))
    expect(gate.status).toBe('failed')
    expect(gate.entries[0].error).toContain('identity')
  })
})


it('P1-5: the shared root publication assertion still runs the identity guard after approval', async () => {
  const { assertRefineryPublishApproved } = await import('../../src/mesh/mesh-refine-gitlink-utils')
  const f = fixture({ originSubpath: 'vilmire/adhdev', id: BAD, content: 'clean\n' })
  await expect(assertRefineryPublishApproved(f.sub, f.localOnly, 'main', [f.localOnly])).rejects.toThrow('identity')
})

it('round4 P2-A: missing private pattern config refuses an approved public publish', async () => {
  const f = fixture({ originSubpath: 'public', id: GOOD, content: 'clean\n' })
  const privateRoot = process.env.ADHDEV_PRIVATE_ROOT!
  const policy = join(privateRoot, '.adhdev/public-push-patterns.json')
  const { readFileSync } = await import('node:fs')
  const saved = readFileSync(policy)
  try {
    git(privateRoot, ['rm', '-q', '.adhdev/public-push-patterns.json'], GOOD)
    git(privateRoot, ['commit', '-qm', 'Remove synthetic policy'], GOOD)
    const request = await evaluatePublicPublishApproval(f.sub, f.localOnly, 'main', [f.localOnly])
    expect(request).toBeDefined()
    expect(request?.commits.some(c => c.guardScan === 'error')).toBe(true)
  } finally {
    mkdirSync(join(privateRoot, '.adhdev'), { recursive: true })
    writeFileSync(policy, saved)
    git(privateRoot, ['add', '.adhdev'], GOOD)
    git(privateRoot, ['commit', '-qm', 'Restore synthetic policy'], GOOD)
  }
})

it('round4 P2-A: configured fleet patterns reach the in-process scanner', async () => {
  const f = fixture({ originSubpath: 'public', id: GOOD, content: 'connect FleetFixtureZ\n' })
  mkdirSync(join(f.base, '.adhdev'), { recursive: true })
  writeFileSync(join(f.base, '.adhdev/public-push-patterns.json'), JSON.stringify({ ownerNames: ['fixture-owner'], knownHosts: ['FleetFixtureZ'] }))
  mkdirSync(join(f.sub, '.adhdev'), { recursive: true })
  writeFileSync(join(f.sub, '.adhdev/public-push-patterns.json'), JSON.stringify({ ownerNames: ['other'], knownHosts: ['OtherHostZ'] }))
  const gate = await runMeshRefineSubmoduleReachabilityGate(f.base, f.mergedTree, approved(f))
  expect(gate.status).toBe('failed')
  expect(gate.unreachable[0].error).toContain('personal path')
  expect(f.originMain()).not.toContain(f.localOnly)
})

it('round4 P2-B: per-repo approvals permit two public repos; a flat array refuses both before push', async () => {
  const f = fixture({ originSubpath: 'public', id: GOOD, content: 'first\n' })
  mkdirSync(join(f.base, '.adhdev'), { recursive: true })
  writeFileSync(join(f.base, '.adhdev/public-push-patterns.json'), JSON.stringify({ ownerNames: ['fixture-owner'], knownHosts: ['FleetFixtureZ'] }))
  git(f.base, ['config', 'remote.origin.url', 'https://github.com/vilmire/adhdev-cloud'])
  const other = fixture({ originSubpath: 'other', id: GOOD, content: 'second\n' })
  git(f.base, ['submodule', 'add', '-q', other.origin, 'second'], GOOD)
  const second = join(f.base, 'second')
  git(second, ['config', 'remote.origin.adhdev-private', 'false'])
  bindPushDestination(second, other.origin, 'adhdev-providers')
  git(second, ['fetch', other.sub, other.localOnly])
  git(second, ['checkout', '--detach', other.localOnly])
  git(f.base, ['add', 'second'], GOOD)
  git(f.base, ['commit', '-q', '-m', 'second pointer'], GOOD)
  const tree = git(f.base, ['rev-parse', 'HEAD^{tree}'])
  const flat = await runMeshRefineSubmoduleReachabilityGate(f.base, tree, { ...AUTO_PUBLISH_ON, approvedPublishShas: [f.localOnly] })
  expect(flat.status).toBe('failed')
  expect(f.originMain()).not.toContain(f.localOnly)
  const mapped = await runMeshRefineSubmoduleReachabilityGate(f.base, tree, { ...AUTO_PUBLISH_ON, approvedPublishShas: { oss: [f.localOnly], 'adhdev-providers': [other.localOnly] } })
  expect(mapped.status).toBe('passed')
  expect(f.originMain()).toContain(f.localOnly)
  expect(other.originMain()).toContain(other.localOnly)
})

useSyntheticPublicPushPatterns()
