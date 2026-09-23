// The coordinator-notice delivery health wiring into get_status_metadata
// (wiring-unification C7-4, C-W3). Successor of status-meta-terminal-redrive:
// the Stage 5a redrive (and its quarantine) is gone — the turn.deliver cursor
// IS redelivery — so the surface reports the turn cursors' outcome counters.
// Same key discipline as the sibling seqscribe/beacon keys: always present
// (null = no turn ledger booted, distinguishable from an older build that
// cannot report at all), integer counters only, never an identifier.

import { afterEach, describe, expect, it } from 'vitest'
import { statusMetaHandlers } from '../../src/commands/low-family/status-meta.js'
import { bindMeshNoticeRuntime, createTurnDeliverCounters, type MeshNoticeRuntime } from '../../src/mesh/turn-ledger/deliver.js'

function baseDeps(extra: Record<string, unknown> = {}) {
    return {
        instanceManager: { collectAllStates: () => [] },
        cdpManagers: new Map(),
        providerLoader: {
            getAll: () => [],
            getAvailableProviderInfos: () => [],
            getChannelStalenessSnapshot: () => null,
        },
        detectedIdes: { value: [] },
        statusInstanceId: 'daemon_test',
        statusVersion: '1.2.3',
        ...extra,
    } as any
}

function runtimeWith(counters = createTurnDeliverCounters()): MeshNoticeRuntime {
    return {
        notify: () => ({ eventId: 'x', queued: true }),
        readNotices: () => [],
        controlNotices: () => ({ notices: [], take: () => false }),
        retract: () => 0,
        hasUndelivered: () => false,
        hasLiveCliCoordinator: () => false,
        isSelfDaemon: () => true,
        replicationPending: () => false,
        counters: () => ({ ...counters }),
    }
}

afterEach(() => bindMeshNoticeRuntime(null))

describe('get_status_metadata — turn delivery health', () => {
    it('is always present: null before the turn ledger boots', async () => {
        const result: any = await statusMetaHandlers.get_status_metadata({ deps: baseDeps() }, {})
        expect('turnDelivery' in result).toBe(true)
        expect(result.turnDelivery).toBeNull()
        expect('terminalRedrive' in result).toBe(false)
    })

    it('reports the live counters once bound', async () => {
        const counters = createTurnDeliverCounters()
        counters.delivered = 3
        counters.deferred = 2
        counters.escalated = 1
        bindMeshNoticeRuntime(runtimeWith(counters))
        const result: any = await statusMetaHandlers.get_status_metadata({ deps: baseDeps() }, {})
        expect(result.turnDelivery).toMatchObject({ delivered: 3, deferred: 2, escalated: 1 })
    })

    it('exposes only integer counts — no identifiers', async () => {
        bindMeshNoticeRuntime(runtimeWith())
        const result: any = await statusMetaHandlers.get_status_metadata({ deps: baseDeps() }, {})
        // The exact key set, asserted as a whole: a future field carrying a meshId
        // or taskId onto this surface reds here.
        expect(Object.keys(result.turnDelivery).sort()).toEqual(Object.keys(createTurnDeliverCounters()).sort())
        for (const value of Object.values(result.turnDelivery)) expect(Number.isInteger(value)).toBe(true)
    })
})
