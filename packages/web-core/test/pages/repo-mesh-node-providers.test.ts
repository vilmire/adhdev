import { describe, expect, it } from 'vitest'

import {
    buildProvidersByDaemonId,
    resolveNodeAvailableProviders,
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

    it('returns an empty list (never another machine) when the node has no daemon_id', () => {
        const map = buildProvidersByDaemonId(DAEMONS)
        const node = { id: 'n4', workspace: '/orphan' } as any
        expect(resolveNodeAvailableProviders(node, map)).toEqual([])
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
