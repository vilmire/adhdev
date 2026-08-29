import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import React from 'react'
import type { BeaconDiagnosticsSummary } from '@adhdev/daemon-core'
import type { DaemonData } from '../../src/types'

vi.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string, params?: Record<string, unknown>) => {
            if (key === 'machine.card.beacon.soleCopyTooltip') {
                return `sole:${params?.entries}:${params?.count}`
            }
            return key
        },
    }),
}))

vi.mock('react-router-dom', async () => {
    const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
    return { ...actual, useNavigate: () => () => {} }
})

const daemonCtx = {
    ides: [] as DaemonData[],
    initialLoaded: true,
    connectionStates: {},
    connectionTransports: {},
    connectionRetryStatuses: {},
}

vi.mock('../../src/compat', () => ({
    useDaemons: () => daemonCtx,
    dashboardWS: { send: () => {}, on: () => {}, off: () => {} },
}))
vi.mock('../../src/hooks/useDaemonMetadataLoader', () => ({
    useDaemonMetadataLoader: () => async () => {},
}))
vi.mock('../../src/hooks/useDaemonMachineRuntimeLoader', () => ({
    useDaemonMachineRuntimeLoader: () => async () => {},
}))
vi.mock('../../src/hooks/useDaemonMachineRuntimeSubscription', () => ({
    useDaemonMachineRuntimeSubscription: () => {},
}))

function beacon(entries: number, topics: number): BeaconDiagnosticsSummary {
    return {
        node: `writer-${entries}`,
        peers: [],
        maxBehind: 0,
        soleCopy: Array.from({ length: topics }, (_, index) => ({
            topic: `mesh.mesh_${index}.events`,
            writer: `writer-${entries}-${index}`,
            localSeq: entries,
            bestPeerSeq: 0,
            unreplicated: index === 0 ? entries : 0,
            verdict: 'sole-copy' as const,
        })),
        truncated: 0,
        soleCopyDeferred: false,
        topicScope: [],
        boardAt: new Date().toISOString(),
        keyStaleAdvisory: [],
    }
}

function machine(id: string, instanceId: string, diagnostics: BeaconDiagnosticsSummary): DaemonData {
    return {
        id,
        instanceId,
        type: 'adhdev-daemon',
        status: 'online',
        machine: { hostname: id, platform: 'darwin' },
        beacon: diagnostics,
    }
}

async function renderMachines(entries: DaemonData[]): Promise<string> {
    daemonCtx.ides = entries
    const { default: MachinesPage } = await import('../../src/pages/Machines')
    return renderToStaticMarkup(
        React.createElement(MemoryRouter, null, React.createElement(MachinesPage)),
    )
}

function occurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1
}

describe('machines page — per-machine Beacon diagnostic source', () => {
    it('renders different sole-copy diagnostics on their matching machine cards', async () => {
        const html = await renderMachines([
            machine('daemon_mach_alpha', 'daemon_mach_alpha', beacon(7, 1)),
            machine('daemon_mach_beta', 'daemon_mach_beta', beacon(19, 2)),
        ])

        expect(html).toContain('title="sole:7:1"')
        expect(html).toContain('title="sole:19:2"')
        expect(occurrences(html, 'data-testid="beacon-sole-copy-badge"')).toBe(2)
    })

    it('does not repeat one coordinator-local diagnostic on cards whose payload identity does not match', async () => {
        const coordinatorId = 'daemon_mach_coordinator'
        const coordinatorBeacon = beacon(431, 4)
        const html = await renderMachines([
            machine(coordinatorId, coordinatorId, coordinatorBeacon),
            machine('daemon_mach_remote_a', coordinatorId, coordinatorBeacon),
            machine('daemon_mach_remote_b', coordinatorId, coordinatorBeacon),
            machine('daemon_mach_remote_c', coordinatorId, coordinatorBeacon),
        ])

        expect(occurrences(html, 'title="sole:431:4"')).toBe(1)
        expect(occurrences(html, 'data-testid="beacon-sole-copy-badge"')).toBe(1)
    })
})
