import { describe, expect, it } from 'vitest'
import {
    hasGitStatusEvidence,
    normalizeGitStatus,
    pickBestTransitGitStatus,
    readGitSubmodules,
    scoreGitStatusCandidate,
} from '../src/git-normalize'

describe('readGitSubmodules', () => {
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
