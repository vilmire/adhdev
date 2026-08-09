import { describe, expect, it } from 'vitest'

import {
    buildProvidersByDaemonId,
    resolveNodeAvailableProviders,
    deriveNodeCapabilityTags,
    collectMeshProviderInventory,
} from '../../src/pages/repo-mesh/node-providers'

function cliProvider(type: string) {
    return { type, category: 'cli', machineStatus: 'detected', displayName: type }
}

// A two-machine mesh: a local daemon (claude/codex) at index 1 and a remote daemon
// (antigravity/hermes) at index 0. daemons[0] is the remote — the exact shape that
// previously leaked remote providers into a local node's panel.
const LOCAL_DAEMON = {
    id: 'daemon_local',
    availableProviders: [cliProvider('claude-cli'), cliProvider('codex-cli')],
} as any

const REMOTE_DAEMON = {
    id: 'daemon_remote',
    availableProviders: [cliProvider('antigravity-cli'), cliProvider('hermes-cli')],
} as any

const DAEMONS = [REMOTE_DAEMON, LOCAL_DAEMON] as any[]

describe('repo-mesh node provider resolution (per-daemon)', () => {
    it('keys each node to its own daemon, not daemons[0]', () => {
        const map = buildProvidersByDaemonId(DAEMONS)

        const localNode = { id: 'n1', workspace: '/local', daemon_id: 'daemon_local' } as any
        const remoteNode = { id: 'n2', workspace: '/remote', daemon_id: 'daemon_remote' } as any

        const localProviders = resolveNodeAvailableProviders(localNode, map).map(p => p.type)
        const remoteProviders = resolveNodeAvailableProviders(remoteNode, map).map(p => p.type)

        // The local node must show its own daemon's providers — NOT the remote's.
        expect(localProviders).toEqual(['claude-cli', 'codex-cli'])
        expect(localProviders).not.toContain('antigravity-cli')
        expect(localProviders).not.toContain('hermes-cli')

        // And the remote node shows the remote daemon's providers.
        expect(remoteProviders).toEqual(['antigravity-cli', 'hermes-cli'])
    })

    it('supports the camelCase daemonId field as well as daemon_id', () => {
        const map = buildProvidersByDaemonId(DAEMONS)
        const node = { id: 'n3', workspace: '/local', daemonId: 'daemon_local' } as any
        expect(resolveNodeAvailableProviders(node, map).map(p => p.type)).toEqual(['claude-cli', 'codex-cli'])
    })

    it('returns an empty list (never another machine) when an unbound node sees MULTIPLE daemons', () => {
        // With >1 daemon we cannot guess which machine an unbound node belongs to,
        // so we must fail closed rather than leak an arbitrary machine's providers.
        const map = buildProvidersByDaemonId(DAEMONS)
        const node = { id: 'n4', workspace: '/orphan' } as any
        expect(resolveNodeAvailableProviders(node, map)).toEqual([])
    })

    it('falls back to the sole daemon for an unbound node in a single-daemon (standalone) mesh', () => {
        // Standalone nodes carry no daemon_id and there is exactly one local
        // daemon. Failing closed here made every detected provider render as
        // "not on this machine". With one unambiguous daemon we use its providers.
        const map = buildProvidersByDaemonId([LOCAL_DAEMON])
        const node = { id: 'n_standalone', workspace: '/Users/dev/app' } as any
        expect(resolveNodeAvailableProviders(node, map).map(p => p.type)).toEqual(['claude-cli', 'codex-cli'])
    })

    it('returns an empty list when the node references a disconnected daemon', () => {
        const map = buildProvidersByDaemonId(DAEMONS)
        const node = { id: 'n5', workspace: '/gone', daemon_id: 'daemon_offline' } as any
        expect(resolveNodeAvailableProviders(node, map)).toEqual([])
    })

    it('skips daemons without an id when building the map', () => {
        const map = buildProvidersByDaemonId([{ availableProviders: [cliProvider('x-cli')] } as any, LOCAL_DAEMON])
        expect(map.has('daemon_local')).toBe(true)
        expect([...map.keys()]).toEqual(['daemon_local'])
    })
})

describe('deriveNodeCapabilityTags', () => {
    it('derives os/arch/provider auto tags in order, custom tags first', () => {
        const node = {
            id: 'n1', workspace: '/w',
            reportedPlatform: 'darwin', reportedArch: 'arm64',
            policy: { providerPriority: ['claude-cli', 'codex-cli'] },
            capabilities: ['test-runner', 'gpu'],
        } as any
        const tags = deriveNodeCapabilityTags(node)
        // EVERY provider is tagged, not just providerPriority[0]. Showing only the
        // first was worse than showing none: RESERVED_PREFIXES blocks typing
        // `provider=` by hand, so this list is the operator's only way to learn which
        // provider= values are valid for required_tags.
        expect(tags.map(t => t.tag)).toEqual([
            'test-runner', 'gpu', 'os=darwin', 'arch=arm64',
            'provider=claude-cli', 'provider=codex-cli',
        ])
        // custom vs auto flags
        expect(tags.filter(t => t.custom).map(t => t.tag)).toEqual(['test-runner', 'gpu'])
        expect(tags.filter(t => !t.custom).map(t => t.tag)).toEqual([
            'os=darwin', 'arch=arm64', 'provider=claude-cli', 'provider=codex-cli',
        ])
    })

    it('prefers userOverrides platform/arch over reported (matches daemon precedence)', () => {
        const node = {
            id: 'n2', workspace: '/w',
            reportedPlatform: 'darwin', reportedArch: 'arm64',
            userOverrides: { platform: 'win32', arch: 'x64' },
        } as any
        const tags = deriveNodeCapabilityTags(node).map(t => t.tag)
        expect(tags).toContain('os=win32')
        expect(tags).toContain('arch=x64')
        expect(tags).not.toContain('os=darwin')
    })

    it('adds worktree=<branch> only for a worktree node', () => {
        const wt = { id: 'n3', workspace: '/w', isLocalWorktree: true, worktreeBranch: 'feat/x' } as any
        expect(deriveNodeCapabilityTags(wt).map(t => t.tag)).toContain('worktree=feat/x')
        const plain = { id: 'n4', workspace: '/w', worktreeBranch: 'feat/x' } as any
        expect(deriveNodeCapabilityTags(plain).map(t => t.tag)).not.toContain('worktree=feat/x')
    })

    it('omits absent fields and never emits the internal converge= tag', () => {
        const node = { id: 'n5', workspace: '/w', reportedPlatform: 'linux' } as any
        const tags = deriveNodeCapabilityTags(node).map(t => t.tag)
        expect(tags).toEqual(['os=linux'])
        expect(tags.some(t => t.startsWith('converge='))).toBe(false)
    })
})

describe('provider= tags mirror the daemon (slots first, then providerPriority)', () => {
    // ★ The second half of the defect: the UI never read policy.slots at all. `slots`
    // is the modern, coordinator-owned surface that routing actually matches against,
    // so a provider configured ONLY as a slot was invisible in the UI forever even
    // though the daemon tagged and routed to it. A providerPriority-only fixture
    // cannot catch this — this case is its only evidence.
    it('tags a provider that exists ONLY in policy.slots', () => {
        const node = {
            id: 'n_slots', workspace: '/w',
            policy: {
                slots: [
                    { provider: 'claude-cli', model: 'opus', difficulty: ['difficult'] },
                    { provider: 'kimi', model: 'kimi-code/k3', difficulty: ['difficult'] },
                ],
            },
        } as any
        const tags = deriveNodeCapabilityTags(node).map(t => t.tag)
        expect(tags).toContain('provider=claude-cli')
        expect(tags).toContain('provider=kimi') // ← invisible before the fix
    })

    it('orders slots before providerPriority and de-duplicates across both', () => {
        const node = {
            id: 'n_both', workspace: '/w',
            policy: {
                slots: [{ provider: 'kimi' }, { provider: 'claude-cli' }],
                providerPriority: ['claude-cli', 'codex-cli'],
            },
        } as any
        const providerTags = deriveNodeCapabilityTags(node)
            .map(t => t.tag).filter(t => t.startsWith('provider='))
        // slots order first; claude-cli appears once despite being in both lists.
        expect(providerTags).toEqual(['provider=kimi', 'provider=claude-cli', 'provider=codex-cli'])
    })

    it('drops slot entries with no usable provider', () => {
        const node = {
            id: 'n_bad', workspace: '/w',
            policy: { slots: [{ provider: '  ' }, { model: 'opus' }, { provider: 'kimi' }] },
        } as any
        const providerTags = deriveNodeCapabilityTags(node)
            .map(t => t.tag).filter(t => t.startsWith('provider='))
        expect(providerTags).toEqual(['provider=kimi'])
    })

    it('de-duplicates a custom tag that collides with a derived one (as the daemon does)', () => {
        const node = {
            id: 'n_dup', workspace: '/w',
            reportedPlatform: 'linux',
            capabilities: ['os=linux'],
            policy: { providerPriority: ['kimi'] },
        } as any
        const tags = deriveNodeCapabilityTags(node).map(t => t.tag)
        expect(tags.filter(t => t === 'os=linux')).toHaveLength(1)
        expect(tags).toEqual(['os=linux', 'provider=kimi'])
    })
})

describe('collectMeshProviderInventory (mesh-wide union)', () => {
    // Two nodes on DIFFERENT machines with DIFFERENT providers, plus a daemon that
    // belongs to no node of this mesh. A single-node fixture would pass even with the
    // old coordinator-only read, and without the outside daemon nothing proves scoping.
    const OUTSIDE_DAEMON = {
        id: 'daemon_other_mesh',
        availableProviders: [cliProvider('cursor-cli')],
    } as any

    const MESH_NODES = [
        { id: 'n_local', workspace: '/w', daemon_id: 'daemon_local' },
        { id: 'n_remote', workspace: '/w2', daemon_id: 'daemon_remote' },
    ] as any[]

    it('unions providers across the mesh\'s nodes', () => {
        const inv = collectMeshProviderInventory(MESH_NODES, [...DAEMONS, OUTSIDE_DAEMON])
        expect(inv.providers.map(p => p.type)).toEqual([
            'antigravity-cli', 'claude-cli', 'codex-cli', 'hermes-cli',
        ])
        expect(inv.reportedNodeCount).toBe(2)
        expect(inv.unreportedNodeCount).toBe(0)
    })

    it('★ never includes a daemon that belongs to no node of this mesh', () => {
        const inv = collectMeshProviderInventory(MESH_NODES, [...DAEMONS, OUTSIDE_DAEMON])
        // cursor-cli is installed on another machine entirely — this mesh cannot
        // launch it, so offering it as configurable would be a false claim.
        expect(inv.providers.map(p => p.type)).not.toContain('cursor-cli')
    })

    it('★ counts a not-yet-reported node instead of treating it as "none"', () => {
        const nodes = [
            { id: 'n_local', workspace: '/w', daemon_id: 'daemon_local' },
            // Bound to a daemon that has not reported an inventory (offline, or P2P /
            // get_status_metadata still in flight) — NOT the same as "has nothing".
            { id: 'n_pending', workspace: '/w2', daemon_id: 'daemon_not_connected' },
        ] as any[]
        const inv = collectMeshProviderInventory(nodes, DAEMONS)
        expect(inv.providers.map(p => p.type)).toEqual(['claude-cli', 'codex-cli'])
        expect(inv.reportedNodeCount).toBe(1)
        expect(inv.unreportedNodeCount).toBe(1)
    })

    it('reports every node as unreported when no daemon has an inventory', () => {
        const inv = collectMeshProviderInventory(MESH_NODES, [])
        expect(inv.providers).toEqual([])
        expect(inv.reportedNodeCount).toBe(0)
        expect(inv.unreportedNodeCount).toBe(2)
    })

    it('resolves an unbound node against a sole daemon (standalone shape)', () => {
        const nodes = [{ id: 'n_standalone', workspace: '/w' }] as any[]
        const inv = collectMeshProviderInventory(nodes, [LOCAL_DAEMON])
        expect(inv.providers.map(p => p.type)).toEqual(['claude-cli', 'codex-cli'])
        expect(inv.unreportedNodeCount).toBe(0)
    })

    it('de-duplicates a provider installed on both machines', () => {
        const shared = { id: 'daemon_remote', availableProviders: [cliProvider('claude-cli')] } as any
        const inv = collectMeshProviderInventory(MESH_NODES, [LOCAL_DAEMON, shared])
        expect(inv.providers.map(p => p.type)).toEqual(['claude-cli', 'codex-cli'])
    })
})
