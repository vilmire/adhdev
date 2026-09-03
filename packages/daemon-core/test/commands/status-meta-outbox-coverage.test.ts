// Stage 5, 5a-3 — the coverage diagnostics wiring into get_status_metadata.
//
// mesh-turn-outbox-coverage-diagnostics.test.ts proves the arithmetic against
// a real outbox + real redrive counters. This file proves the OTHER half of
// the "computed but nobody reads it right" failure mode that 5a-1 called out:
// that the computed value actually reaches `get_status_metadata`, under the
// SAME key discipline (always present, never widened past counts/percent) the
// sibling seqscribe/beacon/outbox fields already use.

import { describe, expect, it } from 'vitest'
import { statusMetaHandlers } from '../../src/commands/low-family/status-meta.js'
import {
    __resetTerminalRedriveForTests,
    consumeRedriveEntry,
} from '../../src/mesh/mesh-terminal-redrive.js'
import { __resetTurnLedgerMetricsForTests } from '../../src/mesh/mesh-turn-ledger.js'

/** Minimal deps for buildStatusSnapshot — the snapshot itself is not under test. */
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

describe('get_status_metadata — redrive coverage (Stage 5, 5a-3)', () => {
    it('is always present, reading zero counters and null percent on an untouched daemon', async () => {
        __resetTerminalRedriveForTests()
        __resetTurnLedgerMetricsForTests()

        const result: any = await statusMetaHandlers.get_status_metadata({ deps: baseDeps() }, {})

        expect('outboxRedriveCoverage' in result).toBe(true)
        expect(result.outboxRedriveCoverage.redriveInjected).toBe(0)
        expect(result.outboxRedriveCoverage.outboxDelivered).toBe(0)
        // null, not 0 — nothing has been delivered yet, which is not the same
        // as "redrive is failing to cover what the outbox delivered".
        expect(result.outboxRedriveCoverage.coveragePercent).toBeNull()
    })

    it('tracks redrive injections that happened before this call, across meshes', async () => {
        __resetTerminalRedriveForTests()
        __resetTurnLedgerMetricsForTests()

        // Two meshes, each with one redrive injection but no outbox delivery
        // in THIS process — isolates the reader from needing a live outbox
        // row (that combination is covered by the real-store suite).
        consumeRedriveEntry('mesh_status_meta_cov_a', {
            id: 'entry-a',
            ledgerKind: 'task_completed',
            taskId: 'task-a',
            payload: { taskId: 'task-a', event: 'agent:generating_completed' },
        })
        consumeRedriveEntry('mesh_status_meta_cov_b', {
            id: 'entry-b',
            ledgerKind: 'task_completed',
            taskId: 'task-b',
            payload: { taskId: 'task-b', event: 'agent:generating_completed' },
        })

        const result: any = await statusMetaHandlers.get_status_metadata({ deps: baseDeps() }, {})
        expect(result.outboxRedriveCoverage.redriveInjected).toBe(2)

        __resetTerminalRedriveForTests()
    })

    it('exposes only integer counts and a numeric-or-null percent — no identifiers', async () => {
        __resetTerminalRedriveForTests()
        __resetTurnLedgerMetricsForTests()

        const result: any = await statusMetaHandlers.get_status_metadata({ deps: baseDeps() }, {})
        const coverage = result.outboxRedriveCoverage

        // Stage 5a-4: quarantinedMeshCount / quarantineSkipsTotal joined this
        // key set — both are plain aggregate integers (no meshId), same
        // content-boundary discipline as the three original fields.
        // Stage 5a-3 rework: the set-join fields (coveredTerminals /
        // uncoveredTerminals / fullyCovered / joinTruncated) joined too. All
        // remain counts+booleans — the task ids the join reads never escape
        // readRedriveCoverageDiagnostics.
        expect(Object.keys(coverage).sort()).toEqual([
            'coveragePercent',
            'coveredTerminals',
            'fullyCovered',
            'joinTruncated',
            'outboxDelivered',
            'quarantineSkipsTotal',
            'quarantinedMeshCount',
            'redriveInjected',
            'uncoveredTerminals',
        ])
        expect(Number.isInteger(coverage.redriveInjected)).toBe(true)
        expect(Number.isInteger(coverage.outboxDelivered)).toBe(true)
        expect(coverage.coveragePercent === null || typeof coverage.coveragePercent === 'number').toBe(true)
        expect(Number.isInteger(coverage.quarantinedMeshCount)).toBe(true)
        expect(Number.isInteger(coverage.quarantineSkipsTotal)).toBe(true)
    })
})
