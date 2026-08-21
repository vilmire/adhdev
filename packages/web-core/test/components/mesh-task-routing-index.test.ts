/**
 * Regression tests for the task -> routing-decision join that powers the model /
 * origin observability on the mesh Tasks tab.
 *
 * The shapes asserted here mirror what daemon-core's `recordTaskDispatchedLedger()`
 * (oss/packages/daemon-core/src/mesh/mesh-queue-assignment.ts) actually writes onto
 * `task_dispatched` payloads — notably `skippedCandidatesOmitted` /
 * `intraNodeLosersOmitted`, whose names an earlier UI type got wrong, which made the
 * "+N more" affordance permanently unreachable.
 */

import { describe, expect, it } from 'vitest'
import type { RepoMeshLedgerEntryStatus, RepoMeshStatus } from '@adhdev/daemon-core'
import {
    buildTaskRoutingIndex,
    formatExecutionProfile,
    ledgerEntryTaskId,
    readTaskRouting,
} from '../../src/components/MeshGraph/taskRoutingIndex'

function entry(partial: Partial<RepoMeshLedgerEntryStatus> & { payload: Record<string, unknown> }): RepoMeshLedgerEntryStatus {
    return {
        id: partial.id ?? 'led_1',
        meshId: partial.meshId ?? 'mesh_1',
        timestamp: partial.timestamp ?? '2026-08-21T10:00:00.000Z',
        kind: partial.kind ?? 'task_dispatched',
        ...partial,
    } as RepoMeshLedgerEntryStatus
}

function statusWith(entries: RepoMeshLedgerEntryStatus[]): RepoMeshStatus {
    return { ledger: { entries } } as unknown as RepoMeshStatus
}

const ROUTING = {
    source: 'queue',
    selectedNodeId: 'node_abc',
    transport: 'remote',
    resolvedProviderType: 'claude-cli',
    resolvedModel: 'opus',
    resolvedThinkingLevel: 'high',
    fitnessScore: 42,
    reason: 'best slot fitness',
}

describe('ledgerEntryTaskId', () => {
    it('prefers the promoted top-level taskId', () => {
        const e = entry({ taskId: 'task_base', payload: { taskId: 'task_payload' } } as any)
        expect(ledgerEntryTaskId(e)).toBe('task_base')
    })

    it('falls back to payload.taskId for legacy rows that never carried the base field', () => {
        expect(ledgerEntryTaskId(entry({ payload: { taskId: 'task_payload' } }))).toBe('task_payload')
    })

    it('returns undefined when neither is present', () => {
        expect(ledgerEntryTaskId(entry({ payload: {} }))).toBeUndefined()
    })
})

describe('readTaskRouting', () => {
    it('projects the execution profile and origin', () => {
        const routing = readTaskRouting(entry({ payload: { taskId: 't1', routingDecision: ROUTING } }))
        expect(routing).toMatchObject({
            providerType: 'claude-cli',
            model: 'opus',
            thinkingLevel: 'high',
            source: 'queue',
            transport: 'remote',
            fitnessScore: 42,
        })
    })

    it('returns null when the entry carries no routingDecision', () => {
        expect(readTaskRouting(entry({ payload: { taskId: 't1' } }))).toBeNull()
    })

    it('adds daemon-side omitted counts back into the totals', () => {
        // The daemon truncates the arrays and reports the remainder separately; the
        // folded detail must report the TRUE total, not the truncated array length.
        const routing = readTaskRouting(entry({
            payload: {
                taskId: 't1',
                routingDecision: {
                    ...ROUTING,
                    skippedCandidates: [{ nodeId: 'n1' }, { nodeId: 'n2' }],
                    skippedCandidatesOmitted: 3,
                    intraNodeLosers: [{ providerType: 'kimi' }],
                    intraNodeLosersOmitted: 4,
                },
            },
        }))
        expect(routing?.skippedCount).toBe(5)
        expect(routing?.intraNodeLoserCount).toBe(5)
    })

    it('leaves counts undefined when nothing was skipped', () => {
        const routing = readTaskRouting(entry({ payload: { taskId: 't1', routingDecision: ROUTING } }))
        expect(routing?.skippedCount).toBeUndefined()
        expect(routing?.intraNodeLoserCount).toBeUndefined()
    })
})

describe('buildTaskRoutingIndex', () => {
    it('indexes task_dispatched entries by task id', () => {
        const index = buildTaskRoutingIndex(statusWith([
            entry({ id: 'l1', payload: { taskId: 't1', routingDecision: ROUTING } }),
        ]))
        expect(index.get('t1')?.model).toBe('opus')
    })

    it('ignores ledger kinds other than task_dispatched', () => {
        const index = buildTaskRoutingIndex(statusWith([
            entry({ id: 'l1', kind: 'task_completed', payload: { taskId: 't1', routingDecision: ROUTING } }),
        ]))
        expect(index.size).toBe(0)
    })

    it('keeps the LATEST dispatch when a task was requeued, regardless of array order', () => {
        // Requeued tasks have several task_dispatched rows; the row the UI reports on is
        // the most recent run. Entries are not guaranteed to arrive in timestamp order.
        const index = buildTaskRoutingIndex(statusWith([
            entry({
                id: 'l2',
                timestamp: '2026-08-21T12:00:00.000Z',
                payload: { taskId: 't1', routingDecision: { ...ROUTING, resolvedModel: 'sonnet' } },
            }),
            entry({
                id: 'l1',
                timestamp: '2026-08-21T09:00:00.000Z',
                payload: { taskId: 't1', routingDecision: { ...ROUTING, resolvedModel: 'opus' } },
            }),
        ]))
        expect(index.get('t1')?.model).toBe('sonnet')
    })

    it('tolerates a missing / malformed ledger without throwing', () => {
        expect(buildTaskRoutingIndex(undefined).size).toBe(0)
        expect(buildTaskRoutingIndex(null).size).toBe(0)
        expect(buildTaskRoutingIndex({} as RepoMeshStatus).size).toBe(0)
        expect(buildTaskRoutingIndex(statusWith([
            entry({ payload: { taskId: 't1', routingDecision: 'not-an-object' } }),
        ])).size).toBe(0)
    })
})

describe('formatExecutionProfile', () => {
    it('joins provider, model and thinking level', () => {
        expect(formatExecutionProfile({ providerType: 'claude-cli', model: 'opus', thinkingLevel: 'high' }))
            .toBe('claude-cli · opus · high')
    })

    it('skips absent parts instead of leaving separators', () => {
        expect(formatExecutionProfile({ providerType: 'kimi' })).toBe('kimi')
        expect(formatExecutionProfile({ model: 'opus', thinkingLevel: 'low' })).toBe('opus · low')
        expect(formatExecutionProfile(null)).toBe('')
    })
})
