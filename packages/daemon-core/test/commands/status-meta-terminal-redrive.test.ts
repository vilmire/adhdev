// The terminal-redrive health diagnostics wiring into get_status_metadata.
//
// This file proves the "computed but nobody reads it right" half of the failure
// mode that 5a-1 called out: that the computed value actually reaches
// `get_status_metadata`, under the SAME key discipline (always present, never
// widened past counts) the sibling seqscribe/beacon fields already use.
//
// ★ Stage 5c-1 rewrote it, along with the surface it reads. It used to assert
// the `outboxRedriveCoverage` key produced by the redrive-vs-outbox subset join.
// That join's DENOMINATOR was `mesh_turn_outbox`, which 5c-1 dropped, so the
// coverage fields (outboxDelivered / coveredTerminals / uncoveredTerminals /
// coveragePercent / fullyCovered / joinTruncated) are gone rather than carried
// forward as permanent nulls — see mesh-terminal-redrive-diagnostics.ts.
//
// What survives, and why it matters MORE than before: the quarantine counters
// and the injection total describe the redrive leg's own health, and after 5c-1
// that leg is the sole path by which a coordinator-bound terminal notification
// is re-armed. `quarantinedMeshCount` is the successor to the deleted outbox's
// `failed` park.

import { describe, expect, it, vi } from 'vitest'
import { statusMetaHandlers } from '../../src/commands/low-family/status-meta.js'
import {
    __resetTerminalRedriveForTests,
    consumeRedriveEntry,
    QUARANTINE_FAILURE_THRESHOLD,
} from '../../src/mesh/mesh-terminal-redrive.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
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

describe('get_status_metadata — terminal redrive health', () => {
    it('is always present, reading zero counters on an untouched daemon', async () => {
        __resetTerminalRedriveForTests()
        __resetTurnLedgerMetricsForTests()

        const result: any = await statusMetaHandlers.get_status_metadata({ deps: baseDeps() }, {})

        // Always-present, like the sibling seqscribe/beacon keys: an absent key
        // and a zeroed one must stay distinguishable, so a daemon that never
        // re-armed anything is not confused with an older build that cannot
        // report at all.
        expect('terminalRedrive' in result).toBe(true)
        expect(result.terminalRedrive.redriveInjected).toBe(0)
        expect(result.terminalRedrive.quarantinedMeshCount).toBe(0)
        expect(result.terminalRedrive.quarantineSkipsTotal).toBe(0)
    })

    it('tracks redrive injections that happened before this call, across meshes', async () => {
        __resetTerminalRedriveForTests()
        __resetTurnLedgerMetricsForTests()

        consumeRedriveEntry('mesh_status_meta_redrive_a', {
            id: 'entry-a',
            ledgerKind: 'task_completed',
            taskId: 'task-a',
            payload: { taskId: 'task-a', event: 'agent:generating_completed' },
        })
        consumeRedriveEntry('mesh_status_meta_redrive_b', {
            id: 'entry-b',
            ledgerKind: 'task_completed',
            taskId: 'task-b',
            payload: { taskId: 'task-b', event: 'agent:generating_completed' },
        })

        const result: any = await statusMetaHandlers.get_status_metadata({ deps: baseDeps() }, {})
        // Summed across meshes — a per-mesh counter would leak the mesh axis onto
        // this surface, which the content boundary below forbids.
        expect(result.terminalRedrive.redriveInjected).toBe(2)

        __resetTerminalRedriveForTests()
    })

    // ★ Stage 5c-2. The deleted `turn ledger — durable outbox / restart delivery`
    // block asserted that a row exhausting its retry budget PARKED as `failed`
    // observably — i.e. that a permanently undeliverable terminal became visible
    // rather than vanishing. 5c-1 removed the `failed` park along with the table
    // and named `quarantinedMeshCount` its successor, so that invariant is owed
    // here, restated against the redrive leg.
    //
    // ★ Why this belongs on THIS surface and not in the redrive suite. The
    // sibling mesh-terminal-redrive.test.ts already proves the quarantine TRIPS
    // (isMeshQuarantined flips). That is the mechanism, not the guarantee: a
    // quarantine that trips but never reaches an operator-visible field is
    // exactly the silent permanent failure the outbox block existed to forbid.
    // The two halves — reachable, and reported — must both be asserted, and only
    // one of them is visible from the module's own unit surface.
    it('reports a tripped quarantine on the health surface — a permanently failing leg is never silent', async () => {
        __resetTerminalRedriveForTests()
        __resetTurnLedgerMetricsForTests()

        const meshId = 'mesh_status_meta_quarantine'
        const entry = (n: number) => ({
            id: `entry-q-${n}`,
            ledgerKind: 'task_completed',
            taskId: `task-q-${n}`,
            payload: { taskId: `task-q-${n}`, event: 'agent:generating_completed' },
        })

        // Drive REAL consecutive failures until the leg quarantines. The store is
        // made to throw rather than the module state being poked directly — a
        // hand-set flag would prove the getter reads a field, not that a failing
        // leg actually reaches this surface.
        const store = MeshRuntimeStore.getInstance()
        const spy = vi.spyOn(store, 'insertPendingEvent')
            .mockImplementation(() => { throw new Error('simulated persist failure') })
        try {
            for (let i = 0; i < QUARANTINE_FAILURE_THRESHOLD; i++) {
                expect(() => consumeRedriveEntry(meshId, entry(i))).toThrow()
            }
            // One more entry arrives while quarantined: skip-and-advance, counted.
            expect(consumeRedriveEntry(meshId, entry(99))).toBe('quarantined')
        } finally {
            spy.mockRestore()
        }

        const result: any = await statusMetaHandlers.get_status_metadata({ deps: baseDeps() }, {})

        expect(
            result.terminalRedrive.quarantinedMeshCount,
            'a quarantined mesh must be visible on the health surface',
        ).toBe(1)
        expect(
            result.terminalRedrive.quarantineSkipsTotal,
            'terminals shed while quarantined must be counted, not silently dropped',
        ).toBeGreaterThan(0)
        // Nothing was ever queued, so the success counter must NOT have moved —
        // otherwise a fully failing leg would read as healthy on this surface.
        expect(result.terminalRedrive.redriveInjected).toBe(0)

        __resetTerminalRedriveForTests()
    })

    it('exposes only integer counts — no identifiers', async () => {
        __resetTerminalRedriveForTests()
        __resetTurnLedgerMetricsForTests()

        const result: any = await statusMetaHandlers.get_status_metadata({ deps: baseDeps() }, {})
        const redrive = result.terminalRedrive

        // ★ The exact key set, asserted as a whole rather than field-by-field.
        // That is what makes this a content-boundary test and not just a shape
        // check: a future field carrying a meshId or taskId onto this surface
        // reds here, whereas per-field assertions would silently admit it.
        expect(Object.keys(redrive).sort()).toEqual([
            'quarantineSkipsTotal',
            'quarantinedMeshCount',
            'redriveInjected',
        ])
        expect(Number.isInteger(redrive.redriveInjected)).toBe(true)
        expect(Number.isInteger(redrive.quarantinedMeshCount)).toBe(true)
        expect(Number.isInteger(redrive.quarantineSkipsTotal)).toBe(true)
    })
})
