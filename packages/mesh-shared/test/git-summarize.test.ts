import { describe, expect, it } from 'vitest'
import { summarizeGitShape } from '../src/git-summarize'

describe('summarizeGitShape', () => {
    it('returns null for an empty record', () => {
        expect(summarizeGitShape({})).toBeNull()
        expect(summarizeGitShape(null)).toBeNull()
    })

    it('truncates head + submodule commit SHAs to 12 chars', () => {
        const out = summarizeGitShape({
            isGitRepo: true,
            workspace: '/Users/x/adhdev',
            repoRoot: '/Users/x/adhdev',
            branch: 'main',
            headCommit: '710e11de1234567890abcdef',
            submodules: [{ path: 'oss', commit: 'c3c722f858bd0a01652ed7d9d5de25b27d233b8a', dirty: false, outOfSync: false }],
        })
        expect(out?.headCommit).toBe('710e11de1234')
        expect((out?.submodules as any[])[0].commit).toBe('c3c722f858bd')
        expect(out?.submoduleCount).toBe(1)
    })

    it('reads snake_case repo_root and counts submodules', () => {
        const out = summarizeGitShape({
            isGitRepo: true,
            repo_root: '/Users/x/adhdev',
            submodules: [
                { path: 'oss', commit: 'a', outOfSync: true },
                { path: 'adhdev-providers', commit: 'b' },
            ],
        })
        expect(out?.repoRoot).toBe('/Users/x/adhdev')
        expect(out?.submoduleCount).toBe(2)
        expect((out?.submodules as any[])[0].outOfSync).toBe(true)
    })
})
