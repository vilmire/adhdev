import { describe, expect, it } from 'vitest'
import type { MagiPanel } from '@adhdev/mesh-shared'
import { resolveMagiPanel, type MagiResolveNode } from '../../src/utils/magi-panel-resolve'

/**
 * Pure resolvability + coupling logic backing MagiPanelManager's badges. The
 * coupling rule mirrors magi-activity.ts (MagiGroupActivity.coupled): a panel is
 * coupled when it collapses to <2 distinct providers OR <2 distinct nodes. The
 * daemon returns raw definitions only (buildMagiFanoutPlan lives in mcp-server),
 * so resolvability is derived here against the live mesh node list.
 */
const NODES: MagiResolveNode[] = [
    { nodeId: 'node_a', providers: ['claude-cli', 'codex-cli'] },
    { nodeId: 'node_b', providers: ['gemini-cli'] },
    // providers not reported yet → falls back to providerPriority
    { nodeId: 'node_c', providers: [], providerPriority: ['hermes-cli'] },
]

function panel(members: MagiPanel['members'], extra: Partial<MagiPanel> = {}): MagiPanel {
    return { members, ...extra }
}

describe('resolveMagiPanel — member availability', () => {
    it('marks a pinned node+provider available, and resolves matchingNodeIds', () => {
        const res = resolveMagiPanel(panel([{ provider: 'claude-cli', nodeId: 'node_a' }]), NODES)
        expect(res.members[0].availability).toBe('available')
        expect(res.members[0].matchingNodeIds).toEqual(['node_a'])
    })

    it('marks node_missing when the pinned node is absent from the live mesh', () => {
        const res = resolveMagiPanel(panel([{ provider: 'claude-cli', nodeId: 'ghost' }]), NODES)
        expect(res.members[0].availability).toBe('node_missing')
    })

    it('marks provider_unavailable when the pinned node lacks the provider', () => {
        const res = resolveMagiPanel(panel([{ provider: 'gemini-cli', nodeId: 'node_a' }]), NODES)
        expect(res.members[0].availability).toBe('provider_unavailable')
    })

    it('resolves a tag-routed member against any node offering the provider', () => {
        const res = resolveMagiPanel(panel([{ provider: 'gemini-cli', capabilityTags: ['os=linux'] }]), NODES)
        expect(res.members[0].availability).toBe('available')
        expect(res.members[0].matchingNodeIds).toEqual(['node_b'])
    })

    it('falls back to providerPriority when a node has not reported installed providers', () => {
        const res = resolveMagiPanel(panel([{ provider: 'hermes-cli', nodeId: 'node_c' }]), NODES)
        expect(res.members[0].availability).toBe('available')
    })

    it('marks provider_unavailable for a tag-routed provider no node offers', () => {
        const res = resolveMagiPanel(panel([{ provider: 'nonesuch' }]), NODES)
        expect(res.members[0].availability).toBe('provider_unavailable')
    })

    it('reports unknown for every member when the live mesh is empty', () => {
        const res = resolveMagiPanel(panel([{ provider: 'claude-cli', nodeId: 'node_a' }]), [])
        expect(res.members[0].availability).toBe('unknown')
        expect(res.meshEmpty).toBe(true)
    })
})

describe('resolveMagiPanel — replica counts', () => {
    it('uses member.n, then panel.defaultN, then 1', () => {
        const res = resolveMagiPanel(panel(
            [
                { provider: 'claude-cli', nodeId: 'node_a', n: 3 },
                { provider: 'gemini-cli', nodeId: 'node_b' }, // → defaultN
            ],
            { defaultN: 2 },
        ), NODES)
        expect(res.members[0].replicas).toBe(3)
        expect(res.members[1].replicas).toBe(2)
        expect(res.totalReplicas).toBe(5)
    })

    it('defaults to 1 replica when neither member.n nor defaultN is set', () => {
        const res = resolveMagiPanel(panel([{ provider: 'claude-cli', nodeId: 'node_a' }]), NODES)
        expect(res.members[0].replicas).toBe(1)
    })
})

describe('resolveMagiPanel — coupling (independence) — same rule as magi-activity', () => {
    it('is coupled with a single provider', () => {
        const res = resolveMagiPanel(panel([
            { provider: 'claude-cli', nodeId: 'node_a' },
            { provider: 'claude-cli', nodeId: 'node_a' },
        ]), NODES)
        expect(res.distinctProviders).toBe(1)
        expect(res.coupled).toBe(true)
    })

    it('is coupled when ≥2 providers all resolve to a single machine', () => {
        const res = resolveMagiPanel(panel([
            { provider: 'claude-cli', nodeId: 'node_a' },
            { provider: 'codex-cli', nodeId: 'node_a' },
        ]), NODES)
        expect(res.distinctProviders).toBe(2)
        expect(res.distinctNodes).toBe(1)
        expect(res.coupled).toBe(true)
    })

    it('is independent with ≥2 providers across ≥2 machines', () => {
        const res = resolveMagiPanel(panel([
            { provider: 'claude-cli', nodeId: 'node_a' },
            { provider: 'gemini-cli', nodeId: 'node_b' },
        ]), NODES)
        expect(res.distinctProviders).toBe(2)
        expect(res.distinctNodes).toBe(2)
        expect(res.coupled).toBe(false)
        expect(res.hasUnresolvable).toBe(false)
    })

    it('assesses coupling from declared pins when the mesh is offline', () => {
        const res = resolveMagiPanel(panel([
            { provider: 'claude-cli', nodeId: 'node_a' },
            { provider: 'gemini-cli', nodeId: 'node_b' },
        ]), [])
        // declaration spans 2 providers × 2 pinned nodes → independent even offline
        expect(res.distinctProviders).toBe(2)
        expect(res.distinctNodes).toBe(2)
        expect(res.coupled).toBe(false)
    })

    it('flags hasUnresolvable when any member fails to resolve', () => {
        const res = resolveMagiPanel(panel([
            { provider: 'claude-cli', nodeId: 'node_a' },
            { provider: 'claude-cli', nodeId: 'ghost' },
        ]), NODES)
        expect(res.hasUnresolvable).toBe(true)
    })
})
