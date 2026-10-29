import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalPushIdentity, resolvePushPolicy } from '../../src/git/public-push-guard.mjs'
import { fastForwardMeshNode } from '../../src/mesh/mesh-fast-forward.js'
import { useSyntheticPublicPushPatterns, bindPushDestination } from '../helpers/public-push-patterns'

useSyntheticPublicPushPatterns({ 'github.com/fixture/widget': 'public', 'github.com/fixture/internal': 'private', 'github.com/vilmire/adhdev': 'private' })
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'publish-policy-'))
  const remote = join(root, 'remote.git'), work = join(root, 'work')
  mkdirSync(work); git(root, 'init', '--bare', '-q', remote); git(work, 'init', '-q', '-b', 'main')
  git(work, 'config', 'user.name', 'vilmire'); git(work, 'config', 'user.email', 'vilmire@users.noreply.github.com')
  writeFileSync(join(work, 'file.txt'), 'base\n'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'Base')
  git(work, 'remote', 'add', 'origin', remote); git(work, 'push', '-qu', 'origin', 'main')
  writeFileSync(join(work, 'file.txt'), 'pending\n'); git(work, 'commit', '-qam', 'Pending')
  return { root, work, remote, tip: git(work, 'rev-parse', 'HEAD') }
}
it('canonical owner-supplied repository identity is independent of visibility', () => {
  expect(canonicalPushIdentity('https://github.com/vilmire/Prefex.git')).toBe('github.com/vilmire/prefex')
})
for (const url of ['https://GitHub.COM/Fixture/Widget.git', 'ssh://git@github.com:22/FIXTURE/widget.git', 'git@github.com:fixture/widget', 'https://github.com/fixture/widget/']) {
  it(`canonical ${url}`, () => expect(canonicalPushIdentity(url)).toBe('github.com/fixture/widget'))
}
for (const url of ['https://github.com/fixture/../widget', 'https://github.com/fixture/%2e%2e/widget', 'https://github.com/fixture%2fwidget', 'https://github.com/fixture/widget?x=1', 'https://github.com./fixture/widget', 'http://github.com/fixture/widget', 'ssh://github.com:443/fixture/widget', '/local/widget', 'https://github.com/a/b/c', 'https://github.com/fixture/widget.git.git']) {
  it(`malformed ${url}`, () => expect(() => canonicalPushIdentity(url)).toThrow(/publish_destination_malformed/))
}
it('explicit public/private policy, built-in no downgrade, and rewritten public URL', async () => {
  const f = fixture()
  try {
    for (const [url, isPublic, repoKey] of [
      ['https://github.com/Fixture/Widget.git', true, 'github.com/fixture/widget'],
      ['git@github.com:fixture/internal.git', false, 'github.com/fixture/internal'],
      ['https://github.com/vilmire/adhdev.git', true, 'oss'],
      ['https://github.com/vilmire/adhdev-cloud.git', false, 'root'],
    ] as const) {
      git(f.work, 'config', 'remote.origin.pushurl', url)
      expect(await resolvePushPolicy(f.work)).toMatchObject({ isPublic, keyed: [{ repoKey }] })
    }
    git(f.work, 'config', 'remote.origin.pushurl', 'https://github.com/fixture/widget.git')
    git(f.work, 'config', 'url.https://github.com/fixture/internal.git.insteadOf', 'https://github.com/fixture/widget.git')
    expect(await resolvePushPolicy(f.work)).toMatchObject({ isPublic: true, keyed: [{ repoKey: 'github.com/fixture/internal' }] })
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
it('unknown visibility and every effective push URL', async () => {
  const f = fixture()
  try {
    git(f.work, 'config', 'remote.origin.pushurl', 'https://github.com/fixture/widget.git')
    git(f.work, 'config', '--add', 'remote.origin.pushurl', 'https://github.com/fixture/unmapped.git')
    await expect(resolvePushPolicy(f.work)).rejects.toMatchObject({ code: 'publish_policy_unmapped' })
    git(f.work, 'config', '--unset-all', 'remote.origin.pushurl')
    git(f.work, 'config', 'remote.origin.pushurl', 'https://github.com/fixture/widget.git')
    git(f.work, 'config', '--add', 'remote.origin.pushurl', 'git@github.com:fixture/internal.git')
    expect(await resolvePushPolicy(f.work)).toMatchObject({ isPublic: true, keyed: [{ repoKey: 'github.com/fixture/widget' }, { repoKey: 'github.com/fixture/internal' }] })
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
for (const [url, code] of [
  ['https://github.com/fixture/widget.git', 'publish_approval_required'],
  ['https://github.com/fixture/unmapped.git', 'publish_policy_unmapped'],
  ['https://github.com/fixture/widget?bad=1', 'publish_destination_malformed'],
]) it(`dry-run/execute parity ${code}`, async () => {
  const f = fixture()
  try {
    bindPushDestination(f.work, f.remote, 'oss', 'origin', url)
    const before = git(f.remote, 'rev-parse', 'main')
    for (const execute of [false, true]) expect(await fastForwardMeshNode({ workspace: f.work, mode: 'push', execute })).toMatchObject({ code, success: false, allowed: false, executed: false, finalBranchConvergenceState: { status: 'blocked_review' } })
    expect(git(f.remote, 'rev-parse', 'main')).toBe(before)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
it('exact canonical approval permits planning, extra SHA and missing patterns refuse', async () => {
  const f = fixture(), saved = process.env.ADHDEV_PUBLIC_PUSH_PATTERNS_SHA256
  try {
    bindPushDestination(f.work, f.remote, 'oss', 'origin', 'https://github.com/fixture/widget.git')
    expect(await fastForwardMeshNode({ workspace: f.work, mode: 'push', approvedPublishShas: { 'github.com/fixture/widget': [f.tip] } })).toMatchObject({ code: 'push_available', executed: false })
    for (const execute of [false, true]) expect(await fastForwardMeshNode({ workspace: f.work, mode: 'push', execute, approvedPublishShas: { 'github.com/fixture/widget': [f.tip, 'abcdef0'] } })).toMatchObject({ code: 'publish_approval_required', executed: false })
    bindPushDestination(f.work, f.remote, 'oss', 'origin', 'https://github.com/vilmire/adhdev.git')
    process.env.ADHDEV_PUBLIC_PUSH_PATTERNS_SHA256 = '0'.repeat(64)
    for (const execute of [false, true]) {
      const result = await fastForwardMeshNode({ workspace: f.work, mode: 'push', execute, approvedPublishShas: { oss: [f.tip] } })
      expect(result).toMatchObject({ code: 'publish_approval_required', executed: false })
      expect(result.publishApproval?.error).toContain('pattern config')
    }
  } finally {
    if (saved === undefined) delete process.env.ADHDEV_PUBLIC_PUSH_PATTERNS_SHA256; else process.env.ADHDEV_PUBLIC_PUSH_PATTERNS_SHA256 = saved
    rmSync(f.root, { recursive: true, force: true })
  }
})
it('explicit private policy skips approval only when every URL proves private', async () => {
  const f = fixture()
  try {
    bindPushDestination(f.work, f.remote, 'oss', 'origin', 'https://github.com/fixture/internal.git')
    expect(await fastForwardMeshNode({ workspace: f.work, mode: 'push' })).toMatchObject({ code: 'push_available', executed: false })
    for (const execute of [false, true]) expect(await fastForwardMeshNode({ workspace: f.work, mode: 'push', execute, approvedPublishShas: {} })).toMatchObject({ code: 'publish_approval_required', executed: false })
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
it('multiple repositories require per-repository exact approvals', async () => {
  const f = fixture()
  try {
    const first = bindPushDestination(f.work, f.remote, 'oss', 'origin', 'https://github.com/fixture/widget.git')
    bindPushDestination(f.work, f.remote, 'oss', 'origin', 'https://github.com/fixture/internal.git')
    git(f.work, 'config', '--add', 'remote.origin.pushurl', first)
    for (const execute of [false, true]) expect(await fastForwardMeshNode({ workspace: f.work, mode: 'push', execute, approvedPublishShas: [f.tip] })).toMatchObject({ code: 'publish_approval_required', executed: false })
    expect(await fastForwardMeshNode({ workspace: f.work, mode: 'push', approvedPublishShas: { 'github.com/fixture/widget': [f.tip], 'github.com/fixture/internal': [f.tip] } })).toMatchObject({ code: 'push_available', executed: false })
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
