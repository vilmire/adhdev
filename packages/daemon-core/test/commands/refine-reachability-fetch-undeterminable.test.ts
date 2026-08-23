import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  buildSubmodulePublishRequiredNextStep,
  runMeshRefineSubmoduleReachabilityGate,
} from '../../src/commands/router'

/**
 * ★The submodule reachability gate used to run `fetch origin` and `merge-base
 * --is-ancestor` under ONE shared `catch`. Every failure of either collapsed to
 * the same value, and the caller read that value as "the commit is not on
 * origin/main": it set `publishRequired: true` and — with
 * `allowAutoPublishSubmoduleMainCommits` enabled — performed a real `git push`.
 *
 * So a transient fetch failure (offline, auth rejected, remote deleted, DNS,
 * timeout) could publish a commit on the strength of evidence that was never
 * obtained. The in-code comment even asserted "Only the ancestry-only verdict
 * reaches here", which was false — the fetch shared the catch.
 *
 * These tests pin the corrected contract:
 *   fetch failed        → 'undeterminable' → NO push, NO publishRequired, gate still fails
 *   fetch ok + exit 1   → 'absent'         → publishRequired, publish prescription (unchanged)
 *   fetch ok + ancestor → 'contained'      → reachable (unchanged)
 *
 * ★NOTE: every fixture points `origin` at a LOCAL path that is then removed or
 * corrupted. No test in this file can reach a network or perform a real push to
 * any remote that exists.
 */

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], {
    cwd,
    encoding: 'utf-8',
  }).trim()
}

function initRepo(repo: string) {
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test User'])
}

function commitFile(repo: string, name: string, content: string, message: string): string {
  writeFileSync(join(repo, name), content, 'utf-8')
  git(repo, ['add', name])
  git(repo, ['commit', '-q', '-m', message])
  return git(repo, ['rev-parse', 'HEAD'])
}

const AUTO_PUBLISH_ON = { allowAutoPublishSubmoduleMainCommits: true } as const

const cleanups: string[] = []

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'refine-reach-undeterminable-'))
  cleanups.push(dir)
  return dir
}

afterEach(() => {
  while (cleanups.length) {
    const dir = cleanups.pop()!
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

/**
 * A root repo with one submodule whose gitlink points at a commit that exists
 * locally but NOT on the submodule origin. Returns the pieces a test needs to
 * then break (or keep) the remote.
 */
function buildFixture() {
  const tmp = makeTmp()
  const submoduleOrigin = join(tmp, 'sub-origin')
  const base = join(tmp, 'base')

  initRepo(submoduleOrigin)
  commitFile(submoduleOrigin, 'mod.txt', 'v1\n', 'sub v1')

  initRepo(base)
  commitFile(base, 'top.txt', 'top\n', 'root init')
  git(base, ['submodule', 'add', '-q', submoduleOrigin, 'sub'])
  const subRepo = join(base, 'sub')

  // A submodule commit that exists only in the base checkout.
  writeFileSync(join(subRepo, 'local-only.txt'), 'not published\n', 'utf-8')
  git(subRepo, ['add', 'local-only.txt'])
  git(subRepo, ['commit', '-q', '-m', 'sub local only'])
  const localOnly = git(subRepo, ['rev-parse', 'HEAD'])

  git(base, ['add', 'sub'])
  git(base, ['commit', '-q', '-m', 'gitlink -> local only'])
  const mergedTree = git(base, ['rev-parse', 'HEAD^{tree}'])

  return { tmp, submoduleOrigin, base, subRepo, localOnly, mergedTree }
}

/** Head count of commits on the submodule origin's main — proves no push landed. */
function originMainCommits(submoduleOrigin: string): string[] {
  return git(submoduleOrigin, ['rev-list', 'main']).split('\n').filter(Boolean)
}

describe('submodule reachability gate — fetch failure is not a publish verdict', () => {
  it('★does NOT push when the fetch fails, even with auto-publish enabled', async () => {
    // This is the core regression. Before the fix the removed remote made
    // `fetch` throw, the shared catch read it as "not an ancestor", and the
    // gate pushed `localOnly` to origin/main.
    const { submoduleOrigin, base, subRepo, localOnly, mergedTree } = buildFixture()
    const before = originMainCommits(submoduleOrigin)

    // Break the remote by moving it away — `fetch` now fails, ancestry is
    // unanswerable. The origin repo still exists at the moved path so we can
    // assert afterwards that nothing was pushed into it.
    const movedAside = `${submoduleOrigin}-moved`
    renameSync(submoduleOrigin, movedAside)
    expect(existsSync(submoduleOrigin)).toBe(false)

    const gate = await runMeshRefineSubmoduleReachabilityGate(base, mergedTree, AUTO_PUBLISH_ON)

    const [entry] = gate.unreachable
    expect(gate.status).toBe('failed')
    expect(gate.unreachable).toHaveLength(1)

    // The verdict is "we could not tell", not "it is unpublished".
    expect(entry.remoteMainUndeterminable).toBe(true)
    expect(entry.remoteMainReachable).toBeUndefined()
    expect(entry.publishRequired).toBe(false)

    // ★No push was attempted.
    expect(entry.autoPublishAttempted).toBe(false)
    expect(entry.autoPublishSucceeded).toBeUndefined()
    expect(entry.autoPublishRefspec).toBeUndefined()
    expect(entry.autoPublishSkippedReason).toContain('could not be determined')

    // ★And the origin really did not receive the commit.
    expect(originMainCommits(movedAside)).toEqual(before)
    expect(originMainCommits(movedAside)).not.toContain(localOnly)

    // The operator is told to fix access, NOT to approve a push.
    const nextStep = buildSubmodulePublishRequiredNextStep(gate.unreachable)
    expect(nextStep).toContain('could not be determined')
    expect(nextStep).not.toContain('Ask the user for explicit approval')

    expect(subRepo).toBeTruthy()
  })

  it('★still blocks the merge on an undetermined verdict (fail-closed, not fail-open)', async () => {
    // Withholding the publish prescription must not become "looks fine, merge it".
    const { submoduleOrigin, base, mergedTree } = buildFixture()
    renameSync(submoduleOrigin, `${submoduleOrigin}-moved`)

    const gate = await runMeshRefineSubmoduleReachabilityGate(base, mergedTree, AUTO_PUBLISH_ON)

    expect(gate.status).toBe('failed')
    expect(gate.unreachable).toHaveLength(1)
    expect(gate.unreachable[0].reachable).toBe(false)
    expect(gate.unreachable[0].error).toContain('not evidence')
    expect(buildSubmodulePublishRequiredNextStep(gate.unreachable))
      .toContain('Do not merge the root branch')
  })

  it('a genuinely unpublished commit on a REACHABLE remote still demands a publish', async () => {
    // Over-correction guard: the fix must only intercept the case where the
    // remote was never consulted. A successful fetch plus a real exit-1
    // ancestry answer keeps the historical publish prescription.
    const { base, mergedTree, localOnly } = buildFixture()

    const gate = await runMeshRefineSubmoduleReachabilityGate(base, mergedTree)

    const [entry] = gate.unreachable
    expect(gate.status).toBe('failed')
    expect(entry.remoteMainUndeterminable).toBeUndefined()
    expect(entry.remoteMainReachable).toBe(false)
    expect(entry.publishRequired).toBe(true)
    expect(entry.error).toContain('Submodule remote main reachability check failed')

    const nextStep = buildSubmodulePublishRequiredNextStep(gate.unreachable)
    expect(nextStep).toContain('Ask the user for explicit approval')
    expect(nextStep).toContain(`sub@${localOnly}`)
  })

  it('a published commit on a reachable remote passes unchanged', async () => {
    // Over-correction guard, other direction: the happy path must stay green.
    const tmp = makeTmp()
    const submoduleOrigin = join(tmp, 'sub-origin')
    const base = join(tmp, 'base')

    initRepo(submoduleOrigin)
    commitFile(submoduleOrigin, 'mod.txt', 'v1\n', 'sub v1')

    initRepo(base)
    commitFile(base, 'top.txt', 'top\n', 'root init')
    git(base, ['submodule', 'add', '-q', submoduleOrigin, 'sub'])
    git(base, ['add', 'sub'])
    git(base, ['commit', '-q', '-m', 'gitlink -> published'])
    const mergedTree = git(base, ['rev-parse', 'HEAD^{tree}'])

    const gate = await runMeshRefineSubmoduleReachabilityGate(base, mergedTree)

    expect(gate.status).toBe('passed')
    expect(gate.unreachable).toHaveLength(0)
    expect(gate.entries[0].reachable).toBe(true)
    expect(gate.entries[0].remoteMainUndeterminable).toBeUndefined()
  })

  it('★finds a published twin beyond an unreadable candidate instead of pushing', async () => {
    // Same class, one function downstream: findEquivalentPublishedCommit used to
    // abort its whole scan on the first unreadable tree object and report "no
    // twin" — and "no twin" is what permits the auto-publish push. A partial
    // enumeration failure must not be published as a complete negative.
    const tmp = makeTmp()
    const submoduleOrigin = join(tmp, 'sub-origin')
    const base = join(tmp, 'base')

    initRepo(submoduleOrigin)
    commitFile(submoduleOrigin, 'mod.txt', 'v1\n', 'sub v1')
    // Allow pushes into this non-bare origin (its `main` is checked out).
    git(submoduleOrigin, ['config', 'receive.denyCurrentBranch', 'ignore'])

    initRepo(base)
    commitFile(base, 'top.txt', 'top\n', 'root init')
    git(base, ['submodule', 'add', '-q', submoduleOrigin, 'sub'])
    const subRepo = join(base, 'sub')

    // Publish the CONTENT on origin/main under one SHA...
    writeFileSync(join(subRepo, 'shared.txt'), 'shared content\n', 'utf-8')
    git(subRepo, ['add', 'shared.txt'])
    git(subRepo, ['commit', '-q', '-m', 'published twin'])
    git(subRepo, ['push', '-q', 'origin', 'HEAD:refs/heads/main'])
    const published = git(subRepo, ['rev-parse', 'HEAD'])

    // ...then push several later commits so the twin is NOT the newest candidate,
    // i.e. the scan must get past intervening entries to reach it.
    for (const n of ['a', 'b']) {
      writeFileSync(join(subRepo, `${n}.txt`), `${n}\n`, 'utf-8')
      git(subRepo, ['add', `${n}.txt`])
      git(subRepo, ['commit', '-q', '-m', `later ${n}`])
    }
    git(subRepo, ['push', '-q', 'origin', 'HEAD:refs/heads/main'])

    // Build a local same-content twin of `published` (identical tree, new SHA).
    git(subRepo, ['checkout', '-q', '--detach', published])
    git(subRepo, ['commit', '-q', '--amend', '--no-edit', '--date', 'Wed Feb 16 14:00 2033 +0100'])
    const localTwin = git(subRepo, ['rev-parse', 'HEAD'])
    expect(localTwin).not.toBe(published)
    expect(git(subRepo, ['rev-parse', `${localTwin}^{tree}`]))
      .toBe(git(subRepo, ['rev-parse', `${published}^{tree}`]))

    git(base, ['add', 'sub'])
    git(base, ['commit', '-q', '-m', 'gitlink -> local twin'])
    const mergedTree = git(base, ['rev-parse', 'HEAD^{tree}'])

    const beforeOrigin = originMainCommits(submoduleOrigin)
    const gate = await runMeshRefineSubmoduleReachabilityGate(base, mergedTree, AUTO_PUBLISH_ON)

    const [entry] = gate.unreachable
    // The twin was found → converge, do not publish.
    expect(entry.equivalentPublishedCommit).toBe(published)
    expect(entry.publishRequired).toBe(false)
    expect(entry.autoPublishAttempted).toBe(false)
    expect(originMainCommits(submoduleOrigin)).toEqual(beforeOrigin)
    expect(originMainCommits(submoduleOrigin)).not.toContain(localTwin)
  })

  it('★does not push when the fetch fails even though the commit IS local', async () => {
    // `localReachable === true` was the other half of the old push condition.
    // Having the object locally must not substitute for a remote verdict.
    const { submoduleOrigin, base, mergedTree } = buildFixture()
    const movedAside = `${submoduleOrigin}-moved`
    const before = originMainCommits(submoduleOrigin)
    renameSync(submoduleOrigin, movedAside)

    const gate = await runMeshRefineSubmoduleReachabilityGate(base, mergedTree, AUTO_PUBLISH_ON)

    const [entry] = gate.unreachable
    expect(entry.localReachable).toBe(true)
    expect(entry.autoPublishAttempted).toBe(false)
    expect(originMainCommits(movedAside)).toEqual(before)
  })
})
