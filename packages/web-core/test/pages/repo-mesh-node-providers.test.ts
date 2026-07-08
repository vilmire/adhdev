import { describe, expect, it } from 'vitest'

import {
    buildProvidersByDaemonId,
    resolveNodeAvailableProviders,
    deriveNodeCapabilityTags,
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
        expect(tags.map(t => t.tag)).toEqual(['test-runner', 'gpu', 'os=darwin', 'arch=arm64', 'provider=claude-cli'])
        // custom vs auto flags
        expect(tags.filter(t => t.custom).map(t => t.tag)).toEqual(['test-runner', 'gpu'])
        expect(tags.filter(t => !t.custom).map(t => t.tag)).toEqual(['os=darwin', 'arch=arm64', 'provider=claude-cli'])
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
