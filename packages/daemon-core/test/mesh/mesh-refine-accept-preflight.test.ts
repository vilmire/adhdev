import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  assessRefineAcceptPreflight,
  buildRefineAcceptPreflightRefusal,
  buildRefineAcceptPreflightWarning,
  chooseRefineAcceptPreflightCode,
  renderRefineAcceptPreflightMessage,
  resolveRefineBaseRepoRoot,
} from '../../src/mesh/mesh-refine-accept-preflight'

// ★REFINE-ACCEPT-BASE-PREFLIGHT.
//
// These exercise the four base states that each cost a full multi-node gate run on
// 2026-09-22 before failing: a dirty base worktree, stash entries, a base with
// unpushed local commits, and a diverged base. Every case runs against a REAL git
// repository — the whole point of the check is that it reads live git state, so a
// mocked status would test the assertion rather than the detection.

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

/** A bare origin + a clone acting as the base repo root, mirroring the real topology. */
function initRepoWithOrigin(root: string) {
  const origin = join(root, 'origin.git')
  mkdirSync(origin, { recursive: true })
  git(origin, 'init', '-q', '--bare', '-b', 'main')

  const repo = join(root, 'repo')
  git(root, 'clone', '-q', origin, repo)
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test User')
  writeFileSync(join(repo, 'README.md'), 'base\n', 'utf-8')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'init')
  git(repo, 'push', '-q', 'origin', 'main')
  return { origin, repo }
}

/**
 * ★Must be `async` + `await run(...)`: the body under test is asynchronous, and a
 * synchronous `finally` would delete the repository while the probe was still
 * reading it — which makes every case report `indeterminate` (the fail-open path)
 * and silently turns the whole suite into a no-op that passes nothing.
 */
async function withTempRepo(run: (repo: string, origin: string) => void | Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'refine-preflight-'))
  try {
    const { repo, origin } = initRepoWithOrigin(root)
    await run(repo, origin)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('assessRefineAcceptPreflight', () => {
  // ③ clean base passes — the guard against a check that blocks everything.
  it('passes on a clean, converged base', async () => {
    await withTempRepo(async (repo) => {
      const verdict = await assessRefineAcceptPreflight({ repoRoot: repo })
      expect(verdict.ok).toBe(true)
      expect(verdict.indeterminate).toBe(false)
      expect(verdict.findings).toEqual([])
      expect(verdict.message).toBe('')
    })
  })

  // ① dirty base blocks + ② the message names the repo AND the files.
  it('blocks on a dirty base worktree and names the repository and files', async () => {
    await withTempRepo(async (repo) => {
      writeFileSync(join(repo, 'README.md'), 'locally modified\n', 'utf-8')

      const verdict = await assessRefineAcceptPreflight({ repoRoot: repo })
      expect(verdict.ok).toBe(false)
      expect(verdict.code).toBe('base_worktree_dirty')

      const finding = verdict.findings.find(f => f.code === 'base_worktree_dirty')
      expect(finding).toBeDefined()
      // ★The file must be NAMED, not merely counted — a bare "base is dirty" is the
      // reporting failure this whole change exists to fix.
      expect(finding!.files).toContain('README.md')
      expect(finding!.fileCount).toBe(1)
      expect(finding!.repoPath).toBe(repo)

      // The rendered message carries both axes of "where".
      expect(verdict.message).toContain('README.md')
      expect(verdict.message).toContain(repo)
      expect(verdict.message).toContain('base_worktree_dirty')
    })
  })

  // Untracked files are NOT blockers — they do not prevent a merge, and blocking on
  // them would reject bases that every observed incident had in a mergeable state.
  it('does not block on untracked files alone', async () => {
    await withTempRepo(async (repo) => {
      writeFileSync(join(repo, 'scratch.txt'), 'untracked\n', 'utf-8')
      const verdict = await assessRefineAcceptPreflight({ repoRoot: repo })
      expect(verdict.ok).toBe(true)
    })
  })

  // ④ stash alone blocks — incident 1, where the worktree was otherwise clean.
  it('blocks when only stash entries are present', async () => {
    await withTempRepo(async (repo) => {
      writeFileSync(join(repo, 'README.md'), 'to be stashed\n', 'utf-8')
      git(repo, 'stash', 'push', '-q', '-m', 'wip: preflight fixture')

      // Precondition: the worktree is now clean, so ONLY the stash can block.
      expect(git(repo, 'status', '--porcelain')).toBe('')

      const verdict = await assessRefineAcceptPreflight({ repoRoot: repo })
      expect(verdict.ok).toBe(false)
      expect(verdict.code).toBe('base_stash_entries_present')

      const finding = verdict.findings.find(f => f.code === 'base_stash_entries_present')
      expect(finding!.stashCount).toBe(1)
      // The stash subject, so a coordinator knows WHICH stash without going to look.
      expect(finding!.latestStash).toContain('preflight fixture')
      expect(verdict.message).toContain('stash')
    })
  })

  // ⑤ ★local-ahead must NOT block.
  //
  // The Refinery merges into the LOCAL base and pushes afterwards — and under
  // `requireApprovalForPush` it never pushes at all — so a base holding commits
  // origin has not seen is the designed steady state (mesh-refine-base-cas.ts says
  // so in as many words). An earlier draft of this check blocked here, which
  // refused every refine on a push-approval mesh; this test pins the corrected
  // behaviour so it cannot regress.
  it('does NOT block when the base merely has local commits not yet pushed', async () => {
    await withTempRepo(async (repo) => {
      writeFileSync(join(repo, 'local.txt'), 'local only\n', 'utf-8')
      git(repo, 'add', '.')
      git(repo, 'commit', '-q', '-m', 'local commit never pushed')

      const verdict = await assessRefineAcceptPreflight({ repoRoot: repo })
      expect(verdict.ok).toBe(true)
      expect(verdict.findings).toEqual([])
    })
  })

  // ⑥ diverged blocks, and is classified differently from plain-ahead — the two
  // have different remedies and conflating them sends a coordinator the wrong way.
  it('blocks and reports divergence when both sides moved', async () => {
    await withTempRepo(async (repo, origin) => {
      // Advance origin/main through a second clone, behind this repo's back.
      const root = join(repo, '..')
      const peer = join(root, 'peer')
      git(root, 'clone', '-q', origin, peer)
      git(peer, 'config', 'user.email', 'peer@example.com')
      git(peer, 'config', 'user.name', 'Peer')
      writeFileSync(join(peer, 'peer.txt'), 'peer\n', 'utf-8')
      git(peer, 'add', '.')
      git(peer, 'commit', '-q', '-m', 'peer commit')
      git(peer, 'push', '-q', 'origin', 'main')

      // And advance the base locally, so neither side is an ancestor of the other.
      writeFileSync(join(repo, 'local.txt'), 'local\n', 'utf-8')
      git(repo, 'add', '.')
      git(repo, 'commit', '-q', '-m', 'local commit')

      // ★refreshUpstream is required for this axis: without a fetch the stale
      // remote-tracking ref reports behind=0 and the divergence is invisible.
      const verdict = await assessRefineAcceptPreflight({ repoRoot: repo, refreshUpstream: true })
      expect(verdict.ok).toBe(false)
      expect(verdict.code).toBe('base_diverged_from_origin')

      const finding = verdict.findings.find(f => f.code === 'base_diverged_from_origin')
      expect(finding!.ahead).toBe(1)
      expect(finding!.behind).toBe(1)
      // ★Divergence blocks precisely because no automatic rebase-and-retry can fix
      // it — the distinction from the plain-ahead case above.
      expect(finding!.remedy).toContain('manually')
    })
  })

  // ★The accept path must not fetch. IPC-ACCEPT-ASYNC-BOUNDARY caps accept at
  // sub-250ms regardless of repo size, and a `git fetch` measured ~185ms on a
  // trivial repo — enough to blow the budget under concurrent load (it did: the
  // 'returns before long validation completes' regression test in
  // mesh-refine-validation.test.ts). Divergence detection is therefore opt-in and
  // runs on the dry-run/plan path, which already fetches and has no such cap.
  it('does not refresh the upstream by default, so divergence is not detected on the accept path', async () => {
    await withTempRepo(async (repo, origin) => {
      const root = join(repo, '..')
      const peer = join(root, 'peer')
      git(root, 'clone', '-q', origin, peer)
      git(peer, 'config', 'user.email', 'peer@example.com')
      git(peer, 'config', 'user.name', 'Peer')
      writeFileSync(join(peer, 'peer.txt'), 'peer\n', 'utf-8')
      git(peer, 'add', '.')
      git(peer, 'commit', '-q', '-m', 'peer commit')
      git(peer, 'push', '-q', 'origin', 'main')

      writeFileSync(join(repo, 'local.txt'), 'local\n', 'utf-8')
      git(repo, 'add', '.')
      git(repo, 'commit', '-q', '-m', 'local commit')

      // Genuinely diverged — but without a fetch the stale ref hides it, and the
      // accept path must stay fast rather than pay to find out. base_cas catches it
      // before the merge regardless.
      const verdict = await assessRefineAcceptPreflight({ repoRoot: repo })
      expect(verdict.ok).toBe(true)

      // Same repo, fetch enabled → the divergence surfaces.
      const withFetch = await assessRefineAcceptPreflight({ repoRoot: repo, refreshUpstream: true })
      expect(withFetch.ok).toBe(false)
      expect(withFetch.code).toBe('base_diverged_from_origin')
    })
  })

  // The cheap axes — the ones that caught incidents 1 and 2 — still work with no fetch.
  it('still detects dirty and stash on the accept path without fetching', async () => {
    await withTempRepo(async (repo) => {
      writeFileSync(join(repo, 'README.md'), 'dirty\n', 'utf-8')
      const verdict = await assessRefineAcceptPreflight({ repoRoot: repo })
      expect(verdict.ok).toBe(false)
      expect(verdict.code).toBe('base_worktree_dirty')
    })
  })

  // Fail-open: a non-repo must not become a new way for refine to be unavailable.
  it('is indeterminate (not blocking) when the base cannot be inspected', async () => {
    const root = mkdtempSync(join(tmpdir(), 'refine-preflight-norepo-'))
    try {
      const verdict = await assessRefineAcceptPreflight({ repoRoot: root })
      expect(verdict.ok).toBe(true)
      expect(verdict.indeterminate).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // Several axes at once: both are reported, and the cheapest remedy leads.
  it('reports every blocking axis and leads with the cheapest remedy', async () => {
    await withTempRepo(async (repo) => {
      writeFileSync(join(repo, 'stashed.txt'), 'x\n', 'utf-8')
      git(repo, 'add', '.')
      git(repo, 'stash', 'push', '-q', '-m', 'wip')
      writeFileSync(join(repo, 'README.md'), 'dirty\n', 'utf-8')

      const verdict = await assessRefineAcceptPreflight({ repoRoot: repo })
      expect(verdict.ok).toBe(false)
      const codes = verdict.findings.map(f => f.code)
      expect(codes).toContain('base_worktree_dirty')
      expect(codes).toContain('base_stash_entries_present')
      expect(verdict.code).toBe('base_worktree_dirty')
    })
  })
})

describe('preflight verdict rendering and routing', () => {
  it('orders the primary code cheapest-remedy first', () => {
    const findings = [
      { scope: 'root', repoPath: '/r', code: 'base_diverged_from_origin' as const, files: [], fileCount: 0, remedy: '' },
      { scope: 'root', repoPath: '/r', code: 'base_stash_entries_present' as const, files: [], fileCount: 0, remedy: '' },
    ]
    expect(chooseRefineAcceptPreflightCode(findings)).toBe('base_stash_entries_present')
  })

  it('truncates long file lists but keeps the true total', () => {
    const files = Array.from({ length: 10 }, (_, i) => `file-${i}.ts`)
    const message = renderRefineAcceptPreflightMessage([
      { scope: 'root', repoPath: '/r', code: 'base_worktree_dirty', files, fileCount: 42, remedy: 'fix it' },
    ])
    expect(message).toContain('42 file(s)')
    // 42 total, 10 shown → the remainder must be surfaced, never silently dropped.
    expect(message).toContain('+32 more')
  })

  it('builds a refusal the coordinator cannot mistake for an accepted job (stage-terminal shape)', () => {
    const refusal = buildRefineAcceptPreflightRefusal({
      verdict: {
        ok: false,
        indeterminate: false,
        findings: [{ scope: 'root', repoPath: '/r', code: 'base_worktree_dirty', files: ['a.ts'], fileCount: 1, remedy: 'fix' }],
        code: 'base_worktree_dirty',
        message: 'blocked',
        durationMs: 5,
      },
      meshId: 'mesh1',
      nodeId: 'node1',
    })
    expect(refusal.success).toBe(false)
    // No async/jobId — the remedy is "act now", not "wait for a terminal event".
    expect(refusal.async).toBeUndefined()
    expect(refusal.jobId).toBeUndefined()
    expect(refusal.code).toBe('base_worktree_dirty')
    expect(refusal.nextStep).toContain('Nothing was dispatched')
  })

  it('renders the dry-run counterpart as a warning that names the execute consequence', () => {
    const warning = buildRefineAcceptPreflightWarning({
      ok: false,
      indeterminate: false,
      findings: [],
      code: 'base_worktree_dirty',
      message: 'blocked',
      durationMs: 5,
    })
    const detail = warning.basePreflightWarning as Record<string, unknown>
    expect(detail.wouldBlockExecute).toBe(true)
    expect(detail.code).toBe('base_worktree_dirty')
  })

  it('resolves the base repo root through clonedFromNodeId, else the non-worktree node', () => {
    const matches = (n: any, id: string) => n?.id === id
    const source = { id: 'src', isLocalWorktree: false, repoRoot: '/base' }
    const worktree = { id: 'wt', isLocalWorktree: true, workspace: '/wt', clonedFromNodeId: 'src' }
    expect(resolveRefineBaseRepoRoot({ node: worktree, nodes: [source, worktree], nodeIdMatches: matches })).toBe('/base')

    const orphan = { id: 'wt2', isLocalWorktree: true, workspace: '/wt2' }
    expect(resolveRefineBaseRepoRoot({ node: orphan, nodes: [source, orphan], nodeIdMatches: matches })).toBe('/base')
    // Nothing resolvable → undefined, which the callers treat as "cannot check".
    expect(resolveRefineBaseRepoRoot({ node: orphan, nodes: [orphan], nodeIdMatches: matches })).toBeUndefined()
  })
})
