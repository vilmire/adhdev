// @vitest-environment jsdom
//
// "다른 머신 연결" card + per-node peer link badge (standalone multi-machine
// mesh, design 2026-10-07 §4.6). Driven through the real component's only
// seam — the injected sendDaemonCommand — and asserting the commands it sends
// and what it renders from the replies.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18next from 'i18next'
import type { RepoMeshNodeStatus, RepoMeshStatus } from '@adhdev/daemon-core'

import MeshMachinePairingCard, {
    MESH_PAIRING_COPY,
    MeshNodePeerLinkBadge,
    collectPairedMembers,
    peerLinkBadgeModel,
    readNodePeerLink,
    resolveHostAddressCandidates,
    type MeshPairingCopyKey,
} from '../../src/components/MeshGraph/MeshMachinePairingCard'
import { getMeshGraphTheme } from '../../src/components/MeshGraph/meshGraphTheme'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const meshTheme = getMeshGraphTheme('dark')
const SELF = 'standalone_mach_host'

/** Resolves a card label exactly as the component does (catalog key or Korean default). */
function copy(key: MeshPairingCopyKey, opts?: Record<string, unknown>): string {
    return String(i18next.t(`mesh.pairing.${key}`, { defaultValue: MESH_PAIRING_COPY[key], ...opts }))
}

function node(overrides: Partial<RepoMeshNodeStatus> & Record<string, unknown> = {}): RepoMeshNodeStatus {
    return {
        nodeId: 'node-1',
        machineLabel: 'host-mac',
        workspace: '/w/repo',
        health: 'online',
        providers: [],
        activeSessions: [],
        ...overrides,
    } as RepoMeshNodeStatus
}

function meshStatus(nodes: RepoMeshNodeStatus[]): RepoMeshStatus {
    return { meshId: 'mesh-1', nodes } as unknown as RepoMeshStatus
}

type Reply = (args: any) => unknown

function makeSend(replies: Record<string, Reply>) {
    const calls: Array<{ type: string; args: any }> = []
    const send = vi.fn(async (_id: string, type: string, args?: any) => {
        calls.push({ type, args })
        const reply = replies[type]
        if (!reply) return { success: false, error: `unexpected ${type}` }
        return reply(args)
    })
    return { send, calls }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
})

afterEach(() => {
    act(() => root.unmount())
    container.remove()
})

async function flush() {
    for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() })
}

async function render(status: RepoMeshStatus, send: ReturnType<typeof makeSend>['send']) {
    await act(async () => {
        root.render(<MeshMachinePairingCard meshTheme={meshTheme} status={status} daemonId={SELF} meshId="mesh-1" sendDaemonCommand={send} />)
    })
    await flush()
}

function q(testId: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${testId}"]`)
}

async function click(el: Element | null) {
    expect(el).toBeTruthy()
    await act(async () => { (el as HTMLElement).click() })
    await flush()
}

async function typeInto(el: Element | null, value: string) {
    expect(el).toBeTruthy()
    const input = el as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
        setter.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
    })
}

function memberTab(): Element | null {
    return container.querySelector('#mesh-pairing-tab-member')
}

const HOST_INFO = {
    success: true,
    meshId: 'mesh-1',
    meshHost: { role: 'host', pairing: { status: 'not_configured' } },
}

describe('MeshMachinePairingCard — host tab', () => {
    it('shows the code, expiry and address after create_mesh_host_pairing_token', async () => {
        const { send, calls } = makeSend({
            get_mesh_host_pairing: () => ({ ...HOST_INFO, addressCandidates: ['100.64.0.2:3847'] }),
            create_mesh_host_pairing_token: () => ({ success: true, token: 'PAIR-CODE-123', tokenId: 'tok_1', expiresAt: '2026-10-07T10:10:00.000Z' }),
        })
        await render(meshStatus([node({ daemonId: SELF })]), send)

        expect(q('mesh-pairing-host')).toBeTruthy()
        expect(q('mesh-pairing-code')).toBeNull()
        expect(container.textContent).toContain(copy('title'))

        await click(q('mesh-pairing-create'))

        expect(calls.map(c => c.type)).toEqual(['get_mesh_host_pairing', 'create_mesh_host_pairing_token'])
        expect(calls[1].args).toEqual({ meshId: 'mesh-1' })
        expect(q('mesh-pairing-code')?.textContent).toBe('PAIR-CODE-123')
        expect(q('mesh-pairing-address')?.textContent).toBe('100.64.0.2:3847')
        const expected = copy('expiresAt', { time: new Date('2026-10-07T10:10:00.000Z').toLocaleString() })
        expect(q('mesh-pairing-expiry')?.textContent).toBe(expected)
    })

    it('shows the daemon-reported address candidates before a code is created', async () => {
        const { send } = makeSend({
            get_mesh_host_pairing: () => ({ ...HOST_INFO, addressCandidates: ['100.64.0.2:3847', '192.168.1.5:3847'] }),
        })
        await render(meshStatus([]), send)
        expect(q('mesh-pairing-address-candidates')?.textContent).toContain('100.64.0.2:3847 · 192.168.1.5:3847')
        expect(q('mesh-pairing-loopback-warning')).toBeNull()
    })

    it('warns to restart with --host 0.0.0.0 when the daemon is loopback-only', async () => {
        const { send } = makeSend({
            get_mesh_host_pairing: () => ({ ...HOST_INFO, addressCandidates: [], bindWarning: 'loopback_only' }),
            create_mesh_host_pairing_token: () => ({ success: true, token: 'X', expiresAt: '2026-10-07T10:10:00.000Z' }),
        })
        await render(meshStatus([]), send)
        expect(q('mesh-pairing-loopback-warning')?.textContent).toBe(copy('loopbackWarning'))
        expect(q('mesh-pairing-loopback-warning')?.textContent).toContain('--host 0.0.0.0')
        await click(q('mesh-pairing-create'))
        expect(q('mesh-pairing-address')).toBeNull()
    })

    it('falls back to the LAN/Tailscale instruction when no address is known (loopback dashboard)', async () => {
        const { send } = makeSend({
            get_mesh_host_pairing: () => HOST_INFO,
            create_mesh_host_pairing_token: () => ({ success: true, token: 'X', expiresAt: '2026-10-07T10:10:00.000Z' }),
        })
        await render(meshStatus([]), send)
        await click(q('mesh-pairing-create'))
        expect(q('mesh-pairing-address')).toBeNull()
        expect(q('mesh-pairing-address-hint')?.textContent).toContain('Tailscale')
    })

    it('shows the daemon error when code creation fails, without a code box', async () => {
        const { send } = makeSend({
            get_mesh_host_pairing: () => HOST_INFO,
            create_mesh_host_pairing_token: () => ({ success: false, code: 'mesh_host_pairing_token_invalid', error: 'mesh is a member' }),
        })
        await render(meshStatus([]), send)
        await click(q('mesh-pairing-create'))
        expect(q('mesh-pairing-code-box')).toBeNull()
        expect(q('mesh-pairing-create-error')?.textContent).toBe('mesh is a member')
    })

    it('lists paired members with their link badge and revokes through revoke_mesh_peer', async () => {
        const { send, calls } = makeSend({
            get_mesh_host_pairing: () => HOST_INFO,
            revoke_mesh_peer: () => ({ success: true }),
        })
        await render(meshStatus([
            node({ nodeId: 'n-host', daemonId: SELF }),
            node({ nodeId: 'n-win', daemonId: 'standalone_mach_win', machineLabel: 'win-box', role: 'member', connection: { state: 'connected' } }),
        ]), send)

        const rows = container.querySelectorAll('[data-testid="mesh-pairing-member"]')
        expect(rows).toHaveLength(1)
        expect(rows[0].querySelector('[data-peer-link]')?.getAttribute('data-peer-link')).toBe('connected')

        await click(q('mesh-pairing-revoke'))
        expect(calls.some(c => c.type === 'revoke_mesh_peer')).toBe(false)
        await click(q('mesh-pairing-revoke-confirm'))
        expect(calls.find(c => c.type === 'revoke_mesh_peer')?.args).toEqual({ meshId: 'mesh-1', peerDaemonId: 'standalone_mach_win' })
    })
})

describe('MeshMachinePairingCard — member tab', () => {
    it('configures then joins, and shows the host with a connected badge once peer state arrives', async () => {
        const { send, calls } = makeSend({
            get_mesh_host_pairing: () => HOST_INFO,
            configure_mesh_host_pairing: () => ({ success: true }),
            join_mesh_host_pairing: () => ({ success: true, code: 'mesh_host_join_applied', transport: 'ws', meshHost: { role: 'member', hostDaemonId: 'standalone_mach_host_b' } }),
        })
        await render(meshStatus([]), send)
        await click(memberTab())
        await typeInto(q('mesh-pairing-address-input'), '100.64.0.2:3847')
        await typeInto(q('mesh-pairing-code-input'), 'PAIR-CODE-123')
        await click(q('mesh-pairing-join'))

        const sent = calls.filter(c => c.type !== 'get_mesh_host_pairing')
        expect(sent.map(c => c.type)).toEqual(['configure_mesh_host_pairing', 'join_mesh_host_pairing'])
        expect(sent[0].args).toEqual({ meshId: 'mesh-1', hostAddress: '100.64.0.2:3847', token: 'PAIR-CODE-123' })
        expect(sent[1].args).toEqual({ meshId: 'mesh-1', token: 'PAIR-CODE-123' })

        const success = q('mesh-pairing-join-success')
        expect(success?.textContent).toContain(copy('joined', { host: 'standalone_mach_host_b' }))
        // No peer state yet → waiting, no badge.
        expect(success?.querySelector('[data-peer-link]')).toBeNull()
        expect(success?.textContent).toContain(copy('waitingLink'))

        // The host node's link state arrives on the next mesh_status.
        await render(meshStatus([node({ nodeId: 'n-host-b', daemonId: 'standalone_mach_host_b', connection: { state: 'connected' } })]), send)
        await click(memberTab())
        expect(q('mesh-pairing-join-success')?.querySelector('[data-peer-link]')?.getAttribute('data-peer-link')).toBe('connected')
    })

    it('shows the daemon error text verbatim when the host rejects the join', async () => {
        const { send, calls } = makeSend({
            get_mesh_host_pairing: () => HOST_INFO,
            configure_mesh_host_pairing: () => ({ success: true }),
            join_mesh_host_pairing: () => ({ success: false, code: 'mesh_host_join_rejected', error: 'invalid pairing token' }),
        })
        await render(meshStatus([]), send)
        await click(memberTab())
        await typeInto(q('mesh-pairing-address-input'), '10.0.0.5:3847')
        await typeInto(q('mesh-pairing-code-input'), 'WRONG')
        await click(q('mesh-pairing-join'))

        expect(q('mesh-pairing-join-success')).toBeNull()
        expect(q('mesh-pairing-join-error')?.textContent).toBe('invalid pairing token')
        expect(calls.map(c => c.type)).toContain('join_mesh_host_pairing')
    })

    it('stops after a failed configure and shows its error (no join attempt)', async () => {
        const { send, calls } = makeSend({
            get_mesh_host_pairing: () => HOST_INFO,
            configure_mesh_host_pairing: () => ({ success: false, code: 'mesh_host_pairing_invalid', error: 'hostAddress must be host:port' }),
        })
        await render(meshStatus([]), send)
        await click(memberTab())
        await typeInto(q('mesh-pairing-address-input'), 'nonsense')
        await typeInto(q('mesh-pairing-code-input'), 'C')
        await click(q('mesh-pairing-join'))
        expect(q('mesh-pairing-join-error')?.textContent).toBe('hostAddress must be host:port')
        expect(calls.map(c => c.type)).not.toContain('join_mesh_host_pairing')
    })

    it('surfaces a thrown transport error', async () => {
        const { send } = makeSend({
            get_mesh_host_pairing: () => HOST_INFO,
            configure_mesh_host_pairing: () => { throw new Error('daemon unreachable') },
        })
        await render(meshStatus([]), send)
        await click(memberTab())
        await typeInto(q('mesh-pairing-address-input'), 'h:1')
        await typeInto(q('mesh-pairing-code-input'), 'C')
        await click(q('mesh-pairing-join'))
        expect(q('mesh-pairing-join-error')?.textContent).toBe('daemon unreachable')
    })

    it('opens on the member tab when this daemon is already a member', async () => {
        const { send } = makeSend({
            get_mesh_host_pairing: () => ({ success: true, hostAddress: '10.0.0.9:3847', meshHost: { role: 'member', hostDaemonId: 'h', pairing: { status: 'paired' } } }),
        })
        await render(meshStatus([]), send)
        expect(q('mesh-pairing-member-tab')).toBeTruthy()
        expect(container.textContent).toContain(copy('pairedTo', { address: '10.0.0.9:3847' }))
    })

    it('renders nothing without a command seam', async () => {
        await act(async () => {
            root.render(<MeshMachinePairingCard meshTheme={meshTheme} status={meshStatus([])} daemonId={null} meshId="mesh-1" sendDaemonCommand={null} />)
        })
        expect(q('mesh-pairing-card')).toBeNull()
    })
})

describe('peer link badge', () => {
    it.each([
        ['connected', 'connected', 'peerConnected'],
        ['connecting', 'reconnecting', 'peerReconnecting'],
        ['disconnected', 'disconnected', 'peerDisconnected'],
        ['failed', 'disconnected', 'peerDisconnected'],
        ['closed', 'disconnected', 'peerDisconnected'],
    ] as const)('maps %s → %s', async (state, kind, labelKey) => {
        expect(peerLinkBadgeModel({ state })?.kind).toBe(kind)
        await act(async () => {
            root.render(<MeshNodePeerLinkBadge meshTheme={meshTheme} node={node({ connection: { state, lastConnectedAt: Date.now() - 60_000, lastFailureCode: 'PEER_NOT_CONNECTED' } })} />)
        })
        const badge = container.querySelector('[data-peer-link]')
        expect(badge?.getAttribute('data-peer-link')).toBe(kind)
        expect(badge?.textContent).toContain(copy(labelKey))
    })

    it('renders no badge when node.connection is absent, self, unknown or malformed', async () => {
        expect(readNodePeerLink(node())).toBeNull()
        expect(readNodePeerLink(node({ connection: { state: 'weird' } }))).toBeNull()
        expect(readNodePeerLink(node({ connection: { state: 'self', transport: 'local' } }))).toBeNull()
        expect(readNodePeerLink(node({ connection: { state: 'unknown', reported: false } }))).toBeNull()
        // The legacy `node.peer` field is not read.
        expect(readNodePeerLink(node({ peer: { state: 'connected' } }))).toBeNull()
        expect(peerLinkBadgeModel(null)).toBeNull()
        await act(async () => {
            root.render(<MeshNodePeerLinkBadge meshTheme={meshTheme} node={node()} />)
        })
        expect(container.querySelector('[data-peer-link]')).toBeNull()
        expect(container.innerHTML).toBe('')
    })
})

describe('pure helpers', () => {
    it('collectPairedMembers keeps remote members once per daemon and skips self', () => {
        const members = collectPairedMembers(meshStatus([
            node({ nodeId: 'a', daemonId: SELF, role: 'member' }),
            node({ nodeId: 'b', daemonId: 'standalone_mach_win', role: 'member' }),
            node({ nodeId: 'c', daemonId: 'standalone_mach_win', role: 'member' }),
            node({ nodeId: 'd', daemonId: 'standalone_mach_linux', connection: { state: 'connecting' } }),
            node({ nodeId: 'e', daemonId: 'standalone_mach_other' }),
        ]), SELF)
        expect(members.map(n => n.nodeId)).toEqual(['b', 'd'])
    })

    it('resolveHostAddressCandidates prefers daemon addresses, else a non-loopback dashboard host', () => {
        expect(resolveHostAddressCandidates({ lanAddresses: ['192.168.0.3:3847'] }, { hostname: '10.0.0.1', host: '10.0.0.1:3847' })).toEqual(['192.168.0.3:3847'])
        expect(resolveHostAddressCandidates({}, { hostname: '100.64.0.2', host: '100.64.0.2:3847' })).toEqual(['100.64.0.2:3847'])
        expect(resolveHostAddressCandidates({}, { hostname: '127.0.0.1', host: '127.0.0.1:3847' })).toEqual([])
        expect(resolveHostAddressCandidates({}, { hostname: 'localhost', host: 'localhost:3847' })).toEqual([])
        // A loopback-only daemon gets no fallback even on a LAN-opened page.
        expect(resolveHostAddressCandidates({ addressCandidates: [], bindWarning: 'loopback_only' }, { hostname: '10.0.0.1', host: '10.0.0.1:3847' })).toEqual([])
    })
})
