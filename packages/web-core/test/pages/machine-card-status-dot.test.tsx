// Machine card = ONE status dot + (only when actionable) one chip
// (UI simplification 2026-09-27). The card used to stack a P2P badge, a
// Direct/Relay chip, two "Sync delayed" badges and a pulsing dot; now the dot
// carries the state (Online / Connecting / Connection failed / Offline) with
// the details in its tooltip, "Slow link" appears only for a relayed link, and
// a direct link shows nothing extra.
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import React from 'react'
import type { DaemonData } from '../../src/types'

vi.mock('react-router-dom', async () => {
    const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
    return { ...actual, useNavigate: () => () => {} }
})

const daemonCtx = {
    ides: [] as DaemonData[],
    initialLoaded: true,
    connectionStates: {} as Record<string, string>,
    connectionTransports: {} as Record<string, string>,
    connectionRetryStatuses: {} as Record<string, { blocked?: boolean }>,
    retryConnection: () => {},
}

vi.mock('../../src/compat', () => ({
    useDaemons: () => daemonCtx,
    dashboardWS: { send: () => {}, on: () => {}, off: () => {} },
}))
vi.mock('../../src/hooks/useDaemonMetadataLoader', () => ({ useDaemonMetadataLoader: () => async () => {} }))
vi.mock('../../src/hooks/useDaemonMachineRuntimeLoader', () => ({ useDaemonMachineRuntimeLoader: () => async () => {} }))
vi.mock('../../src/hooks/useDaemonMachineRuntimeSubscription', () => ({ useDaemonMachineRuntimeSubscription: () => {} }))

function machine(id: string, overrides: Partial<DaemonData> = {}): DaemonData {
    return {
        id,
        instanceId: id,
        type: 'adhdev-daemon',
        status: 'online',
        machine: { hostname: id, platform: 'darwin', cpus: 8, totalMem: 16 * 1024 ** 3 },
        p2p: { available: true, state: 'connected', peers: 2, screenshotActive: false },
        ...overrides,
    } as DaemonData
}

async function render(entries: DaemonData[], states: Record<string, string>, transports: Record<string, string>, retry: Record<string, { blocked?: boolean }> = {}) {
    daemonCtx.ides = entries
    daemonCtx.connectionStates = states
    daemonCtx.connectionTransports = transports
    daemonCtx.connectionRetryStatuses = retry
    const { default: MachinesPage } = await import('../../src/pages/Machines')
    return renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(MachinesPage)))
}

const count = (html: string, needle: string) => html.split(needle).length - 1

describe('machine card — one status dot, one actionable chip', () => {
    it('a healthy direct machine shows only the green dot: no P2P badge, no Direct chip', async () => {
        const html = await render([machine('daemon_a')], { daemon_a: 'connected' }, { daemon_a: 'direct' })
        expect(count(html, 'data-testid="machine-status-dot"')).toBe(1)
        expect(html).toContain('data-status="online"')
        expect(html).not.toContain('>P2P<')
        expect(html).not.toContain('Slow link')
        expect(html).not.toMatch(/>\s*direct\s*</i)
        // Details are one hover away: the dot's tooltip names the link type.
        expect(html).toContain('Direct connection')
    })

    it('a relayed link gets exactly one "Slow link" chip (its explanation in the tooltip)', async () => {
        const html = await render([machine('daemon_b')], { daemon_b: 'connected' }, { daemon_b: 'relay' })
        expect(count(html, 'Slow link')).toBe(1)
        expect(html).toContain('Connected through a relay server')
        expect(html).toContain('data-status="online"')
    })

    it('connecting shows the dot state, not a second "Connecting…" banner', async () => {
        const html = await render([machine('daemon_c')], { daemon_c: 'connecting' }, {})
        expect(html).toContain('data-status="connecting"')
        // Only the dot: its aria-label + its tooltip's accessible description.
        expect(count(html, 'Connecting…')).toBe(2)
        expect(html).not.toContain('Connecting...')
    })

    it('a parked connection is "failed" and keeps its Reconnect action', async () => {
        const html = await render([machine('daemon_d')], { daemon_d: 'failed' }, {}, { daemon_d: { blocked: true } })
        expect(html).toContain('data-status="failed"')
        expect(html).toContain('Reconnect')
    })

    it('runtime stats not reported yet read "—", not a sentence', async () => {
        const html = await render([machine('daemon_e', { machine: { hostname: 'e', platform: 'linux', cpus: 4, totalMem: 8 * 1024 ** 3 } } as any)], { daemon_e: 'connected' }, {})
        expect(html).not.toContain('Runtime polling')
        expect(html).toContain('—')
    })
})
