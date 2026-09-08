import { describe, expect, it, vi } from 'vitest'
import {
    hasGitStatusEvidence,
    normalizeGitStatus,
    pickBestTransitGitStatus,
    readGitSubmodules,
    scoreGitStatusCandidate,
} from '../src/git-normalize'

describe('readGitSubmodules', () => {
    it('does not invent a check time when the source omits it', () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(9_999)
        const subs = readGitSubmodules([{ path: 'oss', commit: 'abc123' }])

        expect(subs?.[0].lastCheckedAt).toBeUndefined()
        expect(now).not.toHaveBeenCalled()
        now.mockRestore()
    })

    it('keeps a submodule that has path + commit but NO repoPath (cloud transit)', () => {
        const subs = readGitSubmodules([
            { path: 'oss', commit: 'c3c722f858bd0a01652ed7d9d5de25b27d233b8a', dirty: false, outOfSync: false },
            { path: 'adhdev-providers', commit: '1c29790fc14ad87f75fc6aed958fda8f36dbab0d', dirty: false, outOfSync: false },
        ])
        expect(subs).toHaveLength(2)
        expect(subs?.map(s => s.path).sort()).toEqual(['adhdev-providers', 'oss'])
        // repoPath stays undefined rather than being forced to a bogus value.
        expect(subs?.every(s => s.repoPath === undefined)).toBe(true)
    })

    it('derives repoPath from parentRepoRoot when available', () => {
        const subs = readGitSubmodules(
            [{ path: 'oss', commit: 'abc123', dirty: false, outOfSync: false }],
            '/Users/x/adhdev',
        )
        expect(subs?.[0].repoPath).toBe('/Users/x/adhdev/oss')
    })

    it('drops a submodule missing path or commit', () => {
        expect(readGitSubmodules([{ path: 'oss' }, { commit: 'abc' }])).toBeUndefined()
    })
})

describe('hasGitStatusEvidence', () => {
    it('treats a repoRoot-only status as evidence (not dropped)', () => {
        expect(hasGitStatusEvidence({ repoRoot: '/Users/x/adhdev' })).toBe(true)
    })

    it('treats a workspace-only status as evidence (not dropped)', () => {
        expect(hasGitStatusEvidence({ workspace: '/Users/x/adhdev' })).toBe(true)
    })

    it('treats a snake_case repo_root-only status as evidence', () => {
        expect(hasGitStatusEvidence({ repo_root: '/Users/x/adhdev' })).toBe(true)
    })

    it('still recognises classic branch/isGitRepo evidence', () => {
        expect(hasGitStatusEvidence({ branch: 'main' })).toBe(true)
        expect(hasGitStatusEvidence({ isGitRepo: false })).toBe(true)
    })

    it('returns false for an empty / non-evidential record', () => {
        expect(hasGitStatusEvidence({})).toBe(false)
        expect(hasGitStatusEvidence({ unrelated: 'x' })).toBe(false)
    })
})

describe('normalizeGitStatus', () => {
    it('does not invent a check time when the source omits it', () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(9_999)
        const git = normalizeGitStatus({ isGitRepo: true, branch: 'main' }, {})

        expect(git?.lastCheckedAt).toBeUndefined()
        expect(now).not.toHaveBeenCalled()
        now.mockRestore()
    })

    it('preserves source and explicitly injected check times', () => {
        expect(normalizeGitStatus({ isGitRepo: true, lastCheckedAt: 123 }, {})?.lastCheckedAt).toBe(123)
        expect(normalizeGitStatus({ isGitRepo: true, lastCheckedAt: 123 }, {}, { lastCheckedAt: 456 })?.lastCheckedAt).toBe(456)
    })

    it('keeps submodules when only repoRoot/workspace evidence is present', () => {
        const git = normalizeGitStatus(
            {
                workspace: '/Users/x/adhdev',
                submodules: [{ path: 'oss', commit: 'abc' }],
            },
            {},
        )
        expect(git).toBeDefined()
        expect(git?.submodules).toHaveLength(1)
        // parentRepoRoot derived from status.workspace.
        expect(git?.submodules?.[0].repoPath).toBe('/Users/x/adhdev/oss')
    })

    it('derives parentRepoRoot from node.workspace when the git object lacks it', () => {
        const git = normalizeGitStatus(
            { isGitRepo: true, branch: 'main', submodules: [{ path: 'oss', commit: 'abc' }] },
            { workspace: '/Users/x/adhdev' },
        )
        expect(git?.submodules?.[0].repoPath).toBe('/Users/x/adhdev/oss')
    })

    it('returns undefined for an empty status', () => {
        expect(normalizeGitStatus({}, {})).toBeUndefined()
    })

    it('preserves daemonBuildBehind through reassembly (deploy-lag visibility)', () => {
        const daemonBuildBehind = {
            buildCommit: 'a'.repeat(40),
            buildCommitShort: 'aaaaaaa',
            head: 'b'.repeat(40),
            scope: 'oss',
            isDaemonAffecting: true,
        }
        const git = normalizeGitStatus({ isGitRepo: true, branch: 'main', daemonBuildBehind }, {})
        expect(git?.daemonBuildBehind).toEqual(daemonBuildBehind)
    })

    it('drops a non-object daemonBuildBehind instead of relaying garbage', () => {
        const git = normalizeGitStatus({ isGitRepo: true, branch: 'main', daemonBuildBehind: 'stale' }, {})
        expect(git?.daemonBuildBehind).toBeUndefined()
    })
})

describe('scoreGitStatusCandidate ordering', () => {
    it('scores a rich live status above a bare one', () => {
        const rich = normalizeGitStatus({ isGitRepo: true, branch: 'main', upstream: 'origin/main', upstreamStatus: 'fresh', headCommit: 'abc' }, {})
        const bare = normalizeGitStatus({ isGitRepo: true }, {})
        expect(scoreGitStatusCandidate(rich)).toBeGreaterThan(scoreGitStatusCandidate(bare))
    })

    it('scores undefined as -Infinity', () => {
        expect(scoreGitStatusCandidate(undefined)).toBe(Number.NEGATIVE_INFINITY)
    })
})

describe('pickBestTransitGitStatus', () => {
    it('does not invent a check time for an undated transit status', () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(9_999)
        const git = pickBestTransitGitStatus({ lastGit: { status: { isGitRepo: true, branch: 'main' } } })

        expect(git?.lastCheckedAt).toBeUndefined()
        expect(now).not.toHaveBeenCalled()
        now.mockRestore()
    })

    it('picks the richest of the four envelope slots', () => {
        const node = {
            // lastProbe.git.status is the richest; lastGit.status is bare.
            lastGit: { status: { isGitRepo: true } },
            lastProbe: {
                git: {
                    status: {
                        isGitRepo: true,
                        branch: 'main',
                        upstream: 'origin/main',
                        upstreamStatus: 'fresh',
                        headCommit: 'abc',
                        submodules: [{ path: 'oss', commit: 'def' }],
                    },
                },
            },
        }
        const git = pickBestTransitGitStatus(node)
        expect(git?.branch).toBe('main')
        expect(git?.submodules).toHaveLength(1)
    })

    it('reads the nested result.status slot', () => {
        const node = { lastGit: { result: { status: { isGitRepo: true, branch: 'dev' } } } }
        expect(pickBestTransitGitStatus(node)?.branch).toBe('dev')
    })

    it('returns undefined when no slot carries git evidence', () => {
        expect(pickBestTransitGitStatus({})).toBeUndefined()
    })
})
