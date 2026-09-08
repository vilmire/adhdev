import { describe, expect, it, vi } from 'vitest'
import { pickBestTransitGitStatus } from '@adhdev/mesh-shared'
import { buildInlineMeshTransitGitStatus } from '../../src/mesh/mesh-node-identity'

/**
 * Round-trip regression for the standalone (daemon-core) transit path. The router's
 * buildInlineMeshTransitGitStatus / normalizeInlineMeshGitStatus now delegate to
 * @adhdev/mesh-shared pickBestTransitGitStatus, so a transit-stripped node — git
 * object carrying ONLY repoRoot + a repoPath-less submodule — must keep its
 * submodule here exactly as the cloud (web-core) path does. This is the test that
 * would fail if the two transports ever drift again.
 */
describe('daemon-core mesh transit round-trip (shared normalizer)', () => {
    it('does not restamp an undated transit status at assembly time', () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(9_999)
        const git = buildInlineMeshTransitGitStatus({
            lastGit: { status: { isGitRepo: true, branch: 'main' } },
        })

        expect(git?.lastCheckedAt).toBeUndefined()
        expect(now).not.toHaveBeenCalled()
        now.mockRestore()
    })

    it('keeps a repoPath-less submodule on a node whose git carries only repoRoot', () => {
        const repoRoot = '/Users/x/adhdev'
        const node = {
            id: 'node_transit',
            workspace: repoRoot,
            lastGit: {
                status: {
                    // No branch/upstream/counters — only repoRoot + submodule survived transit.
                    repoRoot,
                    submodules: [
                        { path: 'oss', commit: 'c3c722f858bd0a01652ed7d9d5de25b27d233b8a', dirty: false, outOfSync: false },
                    ],
                },
            },
        }
        const git = pickBestTransitGitStatus(node)
        expect(git).toBeDefined()
        expect(git?.submodules).toHaveLength(1)
        expect(git?.submodules?.[0].path).toBe('oss')
        // parentRepoRoot derived from status.repoRoot hydrates repoPath.
        expect(git?.submodules?.[0].repoPath).toBe(`${repoRoot}/oss`)
    })

    it('picks the richest transit envelope slot', () => {
        const node = {
            lastGit: { status: { isGitRepo: true } },
            lastProbe: { git: { status: { isGitRepo: true, branch: 'main', upstream: 'origin/main', upstreamStatus: 'fresh', headCommit: 'abc' } } },
        }
        expect(pickBestTransitGitStatus(node)?.branch).toBe('main')
    })
})
