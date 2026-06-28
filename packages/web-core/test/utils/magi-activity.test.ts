import { describe, expect, it } from 'vitest'
import { extractMagiActivity, MAGI_SYNTHESIS_WIRING_GAP } from '../../src/utils/magi-activity'

// A mesh_status payload after one mesh_magi_review fan-out: a `MAGI:` mission,
// three replica tasks sharing a consensusGroupId across two providers / two
// machines, plus the magi dispatch ledger entries. Mirrors the daemon-core
// high-family mesh_status producer shape (queue.tasks carry consensusGroupId /
// missionId in the persisted entry even though the typed projection omits them).
function magiMeshStatus() {
    return {
        meshId: 'mesh_1',
        meshName: 'ADHDev',
        repoIdentity: 'github.com/vilmire/adhdev',
        refreshedAt: '2026-06-28T00:00:00Z',
        nodes: [],
        missions: [
            {
                id: 'mission_magi_1',
                meshId: 'mesh_1',
                title: 'MAGI: Is the refinery preflight a no-op on clean branches?',
                goal: 'Cross-verify (read-only) across panel \'default\': ...',
                status: 'active',
                tasks: { total: 3, pending: 1, assigned: 1, completed: 1, failed: 0, cancelled: 0 },
            },
            {
                id: 'mission_plain',
                meshId: 'mesh_1',
                title: 'Land DASHBOARD branch',
                goal: 'merge',
                status: 'active',
                tasks: { total: 1, pending: 0, assigned: 0, completed: 1, failed: 0, cancelled: 0 },
            },
        ],
        queue: {
            tasks: [
                {
                    id: 'task_a', meshId: 'mesh_1', message: 'q', status: 'completed',
                    readonly: true, taskMode: 'live_debug_readonly',
                    missionId: 'mission_magi_1', consensusGroupId: 'magi_abc',
                    assignedNodeId: 'node_mac', assignedProviderType: 'claude-cli',
                },
                {
                    id: 'task_b', meshId: 'mesh_1', message: 'q', status: 'assigned',
                    readonly: true, missionId: 'mission_magi_1', consensusGroupId: 'magi_abc',
                    assignedNodeId: 'node_win', assignedProviderType: 'codex-cli',
                },
                {
                    id: 'task_c', meshId: 'mesh_1', message: 'q', status: 'pending',
                    readonly: true, missionId: 'mission_magi_1', consensusGroupId: 'magi_abc',
                    targetNodeId: 'node_win', requiredTags: ['provider=codex-cli', 'os=win32'],
                },
                // A non-MAGI task must be ignored (no consensusGroupId).
                { id: 'task_plain', meshId: 'mesh_1', message: 'x', status: 'pending', missionId: 'mission_plain' },
            ],
            summary: { active: 2, historical: 1 },
        },
        ledger: {
            entries: [
                { id: 'l1', meshId: 'mesh_1', timestamp: '2026-06-28T00:00:01Z', kind: 'task_dispatched', nodeId: 'node_win', providerType: 'codex-cli', payload: { source: 'magi', taskId: 'task_b', missionId: 'mission_magi_1', consensusGroupId: 'magi_abc' } },
                { id: 'l2', meshId: 'mesh_1', timestamp: '2026-06-28T00:00:02Z', kind: 'task_dispatched', nodeId: 'node_x', providerType: 'gemini-cli', payload: { source: 'normal', taskId: 'task_plain' } },
                { id: 'l3', meshId: 'mesh_1', timestamp: '2026-06-28T00:00:03Z', kind: 'magi_replica_enqueue_failed', payload: { consensusGroupId: 'magi_abc', missionId: 'mission_magi_1', provider: 'hermes-cli', error: 'no node satisfies tags' } },
            ],
            summary: { recentFailures: 0 },
        },
    }
}

describe('extractMagiActivity', () => {
    it('groups replica tasks by consensusGroupId and derives the question + progress', () => {
        const summary = extractMagiActivity(magiMeshStatus())
        expect(summary.totalGroups).toBe(1)
        expect(summary.activeGroups).toBe(1)
        const group = summary.groups[0]
        expect(group.consensusGroupId).toBe('magi_abc')
        expect(group.missionId).toBe('mission_magi_1')
        expect(group.question).toBe('Is the refinery preflight a no-op on clean branches?')
        expect(group.replicaCount).toBe(3)
        expect(group.counts).toEqual({ pending: 1, assigned: 1, completed: 1, failed: 0, cancelled: 0 })
        expect(group.progress).toBeCloseTo(1 / 3)
        expect(group.terminal).toBe(false)
        expect(group.source).toBe('queue')
    })

    it('resolves provider/node per replica (assigned first, else requiredTags/targetNode) and independence', () => {
        const group = extractMagiActivity(magiMeshStatus()).groups[0]
        const byId = Object.fromEntries(group.replicas.map(r => [r.taskId, r]))
        expect(byId.task_a).toMatchObject({ provider: 'claude-cli', nodeId: 'node_mac', readonly: true, terminal: true })
        expect(byId.task_b).toMatchObject({ provider: 'codex-cli', nodeId: 'node_win', terminal: false })
        // task_c is pending/unassigned — provider from requiredTags, node from targetNodeId.
        expect(byId.task_c).toMatchObject({ provider: 'codex-cli', nodeId: 'node_win', terminal: false })
        // 2 providers (claude-cli, codex-cli) × 2 nodes (node_mac, node_win) → independent.
        expect(group.distinctProviders).toBe(2)
        expect(group.distinctNodes).toBe(2)
        expect(group.coupled).toBe(false)
    })

    it('flags a single-provider/single-machine group as source-coupled', () => {
        const status = magiMeshStatus()
        for (const task of status.queue.tasks) {
            if ((task as any).consensusGroupId) {
                ;(task as any).assignedProviderType = 'claude-cli'
                ;(task as any).assignedNodeId = 'node_mac'
                ;(task as any).requiredTags = ['provider=claude-cli']
                ;(task as any).targetNodeId = 'node_mac'
            }
        }
        const group = extractMagiActivity(status).groups[0]
        expect(group.distinctProviders).toBe(1)
        expect(group.distinctNodes).toBe(1)
        expect(group.coupled).toBe(true)
    })

    it('surfaces only MAGI ledger events (magi dispatch + magi_* kinds), ignoring normal dispatches', () => {
        const summary = extractMagiActivity(magiMeshStatus())
        const kinds = summary.ledgerEvents.map(e => e.id)
        expect(kinds).toEqual(['l1', 'l3'])
        const enqueueFail = summary.ledgerEvents.find(e => e.kind === 'magi_replica_enqueue_failed')
        expect(enqueueFail).toMatchObject({ consensusGroupId: 'magi_abc', detail: 'no node satisfies tags', provider: 'hermes-cli' })
    })

    it('folds in a MAGI mission whose replicas have aged out of the queue tail (mission-only group)', () => {
        const status = magiMeshStatus()
        status.queue.tasks = status.queue.tasks.filter(t => !(t as any).consensusGroupId)
        const summary = extractMagiActivity(status)
        expect(summary.totalGroups).toBe(1)
        const group = summary.groups[0]
        expect(group.source).toBe('mission')
        expect(group.consensusGroupId).toBe('mission:mission_magi_1')
        expect(group.replicas).toHaveLength(0)
        expect(group.replicaCount).toBe(3)
        expect(group.counts.completed).toBe(1)
        expect(group.progress).toBeCloseTo(1 / 3)
    })

    it('marks a completed MAGI run terminal and sorts active groups first', () => {
        const status = magiMeshStatus()
        // Close the live group's replicas + add a second, still-active group.
        for (const t of status.queue.tasks) if ((t as any).consensusGroupId) (t as any).status = 'completed'
        status.queue.tasks.push(
            { id: 't2a', meshId: 'mesh_1', message: 'q', status: 'pending', consensusGroupId: 'magi_xyz', assignedProviderType: 'claude-cli', assignedNodeId: 'n1' } as any,
            { id: 't2b', meshId: 'mesh_1', message: 'q', status: 'pending', consensusGroupId: 'magi_xyz', assignedProviderType: 'codex-cli', assignedNodeId: 'n2' } as any,
        )
        const summary = extractMagiActivity(status)
        expect(summary.totalGroups).toBe(2)
        // Active group sorts before the terminal one.
        expect(summary.groups[0].terminal).toBe(false)
        expect(summary.groups[0].consensusGroupId).toBe('magi_xyz')
        expect(summary.groups[1].terminal).toBe(true)
    })

    it('always reports the synthesis/panels wiring gap as unreachable', () => {
        const summary = extractMagiActivity(magiMeshStatus())
        expect(summary.synthesisReachable).toBe(false)
        expect(summary.panelsReachable).toBe(false)
        expect(summary.wiringGap).toBe(MAGI_SYNTHESIS_WIRING_GAP)
    })

    it('unwraps wrapped transport payloads (result / result.status) and tolerates empty input', () => {
        const status = magiMeshStatus()
        expect(extractMagiActivity({ success: true, result: status }).totalGroups).toBe(1)
        expect(extractMagiActivity({ success: true, result: { status } }).totalGroups).toBe(1)
        const empty = extractMagiActivity(undefined)
        expect(empty.totalGroups).toBe(0)
        expect(empty.groups).toEqual([])
        expect(empty.ledgerEvents).toEqual([])
        expect(empty.synthesisReachable).toBe(false)
    })
})
