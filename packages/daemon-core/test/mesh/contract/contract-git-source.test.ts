/**
 * Contract versioning Cut A — exact multi-repository source (real git).
 *   AC08 three-repository immutable blob chain (root → oss, root → providers)
 *   AC09 repository binding, .git variants and adversarial replace/filter/path input
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitContractSourceReader, type ContractRepoBindingRecord } from '../../../src/mesh/contract/contract-git-source'
import { ContractRefusal } from '../../../src/mesh/contract/contract-types'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8', windowsHide: true,
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
}).trim()

function initRepo(dir: string, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true })
    writeFileSync(join(dir, p), body)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  return git(dir, 'rev-parse', 'HEAD')
}

const code = (fn: () => unknown) => { try { fn(); return null } catch (e) { return e instanceof ContractRefusal ? e.code : String(e) } }

let tmp: string
let rootDir: string, ossDir: string, provDir: string, wtDir: string
let rootCommit: string, ossCommit: string, provCommit: string
const reader = new GitContractSourceReader()
let bindings: Map<string, ContractRepoBindingRecord>

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'contract-git-'))
  ossDir = join(tmp, 'oss'); provDir = join(tmp, 'providers'); rootDir = join(tmp, 'root')
  ossCommit = initRepo(ossDir, { 'contracts/api.md': 'OSS API v1\n' })
  provCommit = initRepo(provDir, { 'spec/provider.json': '{"v":1}\n' })
  initRepo(rootDir, { 'contracts/root.md': 'ROOT contract\n', 'contracts/dir/x.md': 'x' })
  git(rootDir, 'update-index', '--add', '--cacheinfo', `160000,${ossCommit},oss`)
  git(rootDir, 'update-index', '--add', '--cacheinfo', `160000,${provCommit},providers`)
  symlinkSync('root.md', join(rootDir, 'contracts/link.md'))
  git(rootDir, 'add', 'contracts/link.md')
  git(rootDir, 'commit', '-q', '-m', 'gitlinks')
  rootCommit = git(rootDir, 'rev-parse', 'HEAD')
  wtDir = join(tmp, 'root-wt')
  git(rootDir, 'worktree', 'add', '-q', '--detach', wtDir, rootCommit)
  bindings = new Map()
  for (const [id, dir] of [['root', rootDir], ['oss', ossDir], ['providers', provDir], ['root-wt', wtDir]] as const) {
    const d = reader.describeRepository(dir)
    bindings.set(id, { repoBindingId: id, repoPath: dir, commonDir: d.commonDir, hashAlgorithm: d.hashAlgorithm })
  }
})

afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ } })

describe('AC08 — three-repository immutable blob chain', () => {
  it('returns committed bytes for root, root→oss and root→providers, independent of dirty working bytes and checkout drift', () => {
    writeFileSync(join(rootDir, 'contracts/root.md'), 'DIRTY working bytes\n')
    // Child checkout drifts to a different HEAD than the gitlink pins.
    writeFileSync(join(ossDir, 'contracts/api.md'), 'OSS API v2\n')
    git(ossDir, 'commit', '-q', '-am', 'drift')
    const root = reader.resolveBlob(bindings, { repoBindingId: 'root', commitOid: rootCommit, path: 'contracts/root.md' }, 1 << 20)
    expect(root.bytes.toString()).toBe('ROOT contract\n')
    expect(root.entry.sha256).toBe(createHash('sha256').update('ROOT contract\n').digest('hex'))
    const oss = reader.resolveBlob(bindings, { repoBindingId: 'root', commitOid: rootCommit, gitlinks: [{ path: 'oss', childRepoBindingId: 'oss' }], path: 'contracts/api.md' }, 1 << 20)
    expect(oss.bytes.toString()).toBe('OSS API v1\n')
    expect(oss.entry.gitlinks).toEqual([{ path: 'oss', childRepoBindingId: 'oss', childCommitOid: ossCommit }])
    const prov = reader.resolveBlob(bindings, { repoBindingId: 'root', commitOid: rootCommit, gitlinks: [{ path: 'providers', childRepoBindingId: 'providers' }], path: 'spec/provider.json' }, 1 << 20)
    expect(prov.bytes.toString()).toBe('{"v":1}\n')
    // Drift is observed separately, never served as the pinned bytes.
    const obs = reader.observeWorkspace(bindings.get('root')!, ['contracts/root.md'], 1)
    expect(obs.entries[0].status.trim()).toBe('M')
    expect(obs.entries[0].worktreeSha256).toBe(createHash('sha256').update('DIRTY working bytes\n').digest('hex'))
    expect(obs.headOid).toBe(rootCommit)
    // No repository mutation: the working file is untouched.
    expect(readFileSync(join(rootDir, 'contracts/root.md'), 'utf8')).toBe('DIRTY working bytes\n')
  })

  it('refuses a tree or gitlink passed as a blob, a symlink, a missing object and a broken chain; never fetches', () => {
    expect(code(() => reader.resolveBlob(bindings, { repoBindingId: 'root', commitOid: rootCommit, path: 'contracts/dir' }, 1 << 20))).toBe('invalid_source')
    expect(code(() => reader.resolveBlob(bindings, { repoBindingId: 'root', commitOid: rootCommit, path: 'oss' }, 1 << 20))).toBe('invalid_source')
    expect(code(() => reader.resolveBlob(bindings, { repoBindingId: 'root', commitOid: rootCommit, path: 'contracts/link.md' }, 1 << 20))).toBe('invalid_source')
    expect(code(() => reader.resolveBlob(bindings, { repoBindingId: 'root', commitOid: '0'.repeat(40), path: 'contracts/root.md' }, 1 << 20))).toBe('source_unavailable')
    expect(code(() => reader.resolveBlob(bindings, { repoBindingId: 'root', commitOid: rootCommit, path: 'contracts/nope.md' }, 1 << 20))).toBe('source_unavailable')
    // Wrong child: the gitlink names an oss commit that the providers repository does not hold.
    expect(code(() => reader.resolveBlob(bindings, { repoBindingId: 'root', commitOid: rootCommit, gitlinks: [{ path: 'oss', childRepoBindingId: 'providers' }], path: 'contracts/api.md' }, 1 << 20))).toBe('source_unavailable')
    // A non-gitlink hop.
    expect(code(() => reader.resolveBlob(bindings, { repoBindingId: 'root', commitOid: rootCommit, gitlinks: [{ path: 'contracts', childRepoBindingId: 'oss' }], path: 'contracts/api.md' }, 1 << 20))).toBe('invalid_source')
    expect(code(() => reader.resolveBlob(bindings, { repoBindingId: 'root', commitOid: rootCommit.slice(0, 12), path: 'contracts/root.md' }, 1 << 20))).toBe('invalid_source')
    // Budget: over-size blob is refused, not truncated.
    expect(code(() => reader.resolveBlob(bindings, { repoBindingId: 'root', commitOid: rootCommit, path: 'contracts/root.md' }, 4))).toBe('budget_exceeded')
  })
})

describe('AC09 — repository binding and .git variants', () => {
  it('a linked worktree (.git file → common dir) resolves the same verified bytes as the main checkout', () => {
    const a = reader.resolveBlob(bindings, { repoBindingId: 'root', commitOid: rootCommit, path: 'contracts/root.md' }, 1 << 20)
    const b = reader.resolveBlob(bindings, { repoBindingId: 'root-wt', commitOid: rootCommit, path: 'contracts/root.md' }, 1 << 20)
    expect(b.entry.sha256).toBe(a.entry.sha256)
    expect(bindings.get('root-wt')!.commonDir).toBe(bindings.get('root')!.commonDir)
  })

  it('replace objects, smudge filters, hostile env and traversal cannot change accepted bytes or escape the binding', () => {
    const blobOid = git(rootDir, 'rev-parse', `${rootCommit}:contracts/root.md`)
    const evil = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: rootDir, input: 'EVIL replaced\n', encoding: 'utf8', windowsHide: true }).trim()
    git(rootDir, 'replace', blobOid, evil)
    writeFileSync(join(rootDir, '.gitattributes'), '*.md filter=evil diff=evil\n')
    git(rootDir, 'config', 'filter.evil.smudge', 'sed s/ROOT/EVIL/')
    git(rootDir, 'config', 'diff.evil.textconv', 'sed s/ROOT/EVIL/')
    const prev = { GIT_DIR: process.env.GIT_DIR, GIT_OBJECT_DIRECTORY: process.env.GIT_OBJECT_DIRECTORY }
    process.env.GIT_DIR = join(ossDir, '.git')
    process.env.GIT_OBJECT_DIRECTORY = join(ossDir, '.git', 'objects')
    try {
      const r = reader.resolveBlob(bindings, { repoBindingId: 'root', commitOid: rootCommit, path: 'contracts/root.md' }, 1 << 20)
      expect(r.bytes.toString()).toBe('ROOT contract\n')
      expect(r.entry.blobOid).toBe(blobOid)
    } finally {
      if (prev.GIT_DIR === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = prev.GIT_DIR
      if (prev.GIT_OBJECT_DIRECTORY === undefined) delete process.env.GIT_OBJECT_DIRECTORY; else process.env.GIT_OBJECT_DIRECTORY = prev.GIT_OBJECT_DIRECTORY
      git(rootDir, 'replace', '-d', blobOid)
    }
    for (const p of ['../oss/contracts/api.md', '/etc/passwd', 'contracts/../contracts/root.md', '.git/config', 'contracts\\root.md', '']) {
      expect(code(() => reader.resolveBlob(bindings, { repoBindingId: 'root', commitOid: rootCommit, path: p }, 1 << 20))).toBe('invalid_source')
    }
    // An unknown binding id (caller-supplied path is never authority).
    expect(code(() => reader.resolveBlob(bindings, { repoBindingId: tmp, commitOid: rootCommit, path: 'contracts/root.md' }, 1 << 20))).toBe('invalid_source')
  })

  it('a binding whose repository identity changed (path now points at another repo) is refused', () => {
    const swapped = new Map(bindings)
    swapped.set('root', { ...bindings.get('root')!, repoPath: ossDir })
    expect(code(() => reader.resolveBlob(swapped, { repoBindingId: 'root', commitOid: rootCommit, path: 'contracts/root.md' }, 1 << 20))).toBe('invalid_source')
  })
})
