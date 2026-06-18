import { describe, expect, it } from 'vitest'
import {
    resolveSessionMeshId,
    resolveSessionMeshNodeId,
    joinMeshNodeForSession,
    type SessionInfoConversation,
} from '../../../src/components/dashboard/session-info-data'

function conv(partial: Partial<SessionInfoConversation>): SessionInfoConversation {
    return partial as SessionInfoConversation
}

describe('resolveSessionMeshId', () => {
    it('prefers coordinator.meshId for a coordinator session', () => {
        expect(resolveSessionMeshId(conv({ coordinator: { meshId: 'mesh_a', role: 'coordinator' } }))).toBe('mesh_a')
    })

    it('falls back to settings.meshNodeFor for a worker session', () => {
        expect(resolveSessionMeshId(conv({ settings: { meshNodeFor: 'mesh_b' } }))).toBe('mesh_b')
    })

    it('falls back to settings.meshCoordinatorFor', () => {
        expect(resolveSessionMeshId(conv({ settings: { meshCoordinatorFor: 'mesh_c' } }))).toBe('mesh_c')
    })

    it('returns null for a non-mesh session', () => {
        expect(resolveSessionMeshId(conv({ settings: {} }))).toBeNull()
        expect(resolveSessionMeshId(undefined)).toBeNull()
    })

    it('ignores blank / non-string values', () => {
        expect(resolveSessionMeshId(conv({ settings: { meshNodeFor: '   ' } }))).toBeNull()
        expect(resolveSessionMeshId(conv({ settings: { meshNodeFor: 123 as any } }))).toBeNull()
    })
})

describe('resolveSessionMeshNodeId', () => {
    it('reads settings.meshNodeId', () => {
        expect(resolveSessionMeshNodeId(conv({ settings: { meshNodeId: 'node_7' } }))).toBe('node_7')
    })

    it('falls back to settings.nodeId', () => {
        expect(resolveSessionMeshNodeId(conv({ settings: { nodeId: 'node_8' } }))).toBe('node_8')
    })

    it('returns null when no node stamp exists', () => {
        expect(resolveSessionMeshNodeId(conv({ settings: {} }))).toBeNull()
        expect(resolveSessionMeshNodeId(undefined)).toBeNull()
    })
})

describe('joinMeshNodeForSession', () => {
    const meshStatusResponse = {
        success: true,
        result: {
            success: true,
            meshId: 'mesh_a',
            meshName: 'ADHDev',
            repoIdentity: 'github.com/x/y',
            refreshedAt: '2026-06-18T00:00:00.000Z',
            nodes: [
                {
                    nodeId: 'node_worker',
                    machineLabel: 'node_worker',
                    workspace: '/Users/x/ws',
                    repoRoot: '/Users/x/ws',
                    daemonId: 'daemon_w',
                    role: 'member',
                    machineStatus: 'online',
                    health: 'online',
                    isLocalWorktree: true,
                    worktreeBranch: 'feat/x',
                    launchReady: true,
                    providers: ['claude-cli', 'codex-cli'],
                    providerPriority: ['claude-cli'],
                    activeSessions: [],
                    connection: { state: 'connected', transport: 'direct', source: 'mesh_peer_status', rttMs: 42 },
                    git: {
                        isGitRepo: true,
                        workspace: '/Users/x/ws',
                        repoRoot: '/Users/x/ws',
                        branch: 'feat/x',
                        upstream: 'origin/feat/x',
                        upstreamStatus: 'fresh',
                        headCommit: 'abcdef1234567890',
                        ahead: 1,
                        behind: 2,
                        dirty: true,
                        staged: 0, modified: 0, untracked: 0, deleted: 0, renamed: 0,
                        hasConflicts: false,
                        lastCheckedAt: Date.parse('2026-06-18T00:00:00.000Z'),
                    },
                },
            ],
            queue: { tasks: [], summary: { active: 0, historical: 0, counts: {}, activeCounts: {}, historicalCounts: {} } },
            ledger: { entries: [], summary: { recentFailures: 0, taskCompleted: 0, taskFailed: 0, sessionLaunched: 0 } },
        },
    }

    it('joins the matching node and trims it to JoinedMeshNode', () => {
        const node = joinMeshNodeForSession(meshStatusResponse, 'node_worker')
        expect(node).toMatchObject({
            nodeId: 'node_worker',
            workspace: '/Users/x/ws',
            daemonId: 'daemon_w',
            machineStatus: 'online',
            isLocalWorktree: true,
            worktreeBranch: 'feat/x',
            launchReady: true,
            providers: ['claude-cli', 'codex-cli'],
            providerPriority: ['claude-cli'],
        })
        expect(node?.git).toMatchObject({ branch: 'feat/x', headCommit: 'abcdef1234567890', ahead: 1, behind: 2, dirty: true, upstream: 'origin/feat/x' })
        expect(node?.connection).toMatchObject({ transport: 'direct', state: 'connected', rttMs: 42 })
    })

    it('returns null when no node id is given', () => {
        expect(joinMeshNodeForSession(meshStatusResponse, null)).toBeNull()
    })

    it('returns null when the stamped node id is not in the mesh (removed / stale stamp)', () => {
        expect(joinMeshNodeForSession(meshStatusResponse, 'node_gone')).toBeNull()
    })

    it('returns null for an empty / non-mesh response', () => {
        expect(joinMeshNodeForSession(null, 'node_worker')).toBeNull()
        expect(joinMeshNodeForSession({ success: true, result: { success: true, nodes: [] } }, 'node_worker')).toBeNull()
    })
})
