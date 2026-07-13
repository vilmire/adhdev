import { describe, expect, it } from 'vitest'
import { resolveNodeCapabilitySlots } from '../../src/mesh/mesh-node-slots.js'
import { recordInlineMeshDirectGitTruth } from '../../src/mesh/mesh-node-identity.js'
import { buildMeshSchedulingRuntime } from '../../src/mesh/mesh-scheduling-runtime.js'

// REMOTE-NODE-SLOT-CAP-CHIP fix, Direction B (unified mirror channel).
//
// The dashboard NODE cards render slot-cap chips from node.scheduling.providerRoles,
// which is populated by buildMeshSchedulingRuntime → resolveNodeCapabilitySlots. That
// only found slots on node.policy.slots, which is written ONLY to a node's OWN local
// meshes.json — the coordinator holds an empty join-time {} policy for a remote member,
// so remote slot-cap chips never rendered. Direction B mirrors each member's OWN
// resolved slots wholesale onto node.reportedMemberState over the git_status envelope,
// with EXPLICIT self-vs-remote precedence that avoids a precedence inversion:
//   - SELF/locally-owned node → local policy.slots authoritative (never mirrored).
//   - REMOTE mirrored node    → reportedMemberState.slots fills the empty local policy.

const baseGit = { isGitRepo: true, lastCheckedAt: 1_700_000_000_000 }

/** A capability slot that declares a per-provider parallelism cap (drives the chip). */
function cappedSlot(provider: string, maxParallel: number) {
  return { provider, maxParallel }
}

describe('Direction B — resolveNodeCapabilitySlots precedence', () => {
  it('(a) a REMOTE node with empty policy.slots resolves its slots from reportedMemberState.slots (the P2P mirror)', () => {
    const node: any = {
      id: 'node_remote',
      policy: {}, // coordinator's stale join-time empty policy for a remote member
      reportedMemberState: { slots: [cappedSlot('claude-cli', 8)] },
    }
    const slots = resolveNodeCapabilitySlots(node)
    expect(slots).toEqual([{ provider: 'claude-cli', maxParallel: 8 }])
  })

  it('(b) precedence — a SELF node prefers its local policy.slots over any mirror (no inversion)', () => {
    // Even if a reportedMemberState is somehow present, an explicit local policy.slots
    // is authoritative — the mirror may only ever FILL an empty local policy, never
    // shadow a populated one.
    const node: any = {
      id: 'node_self',
      policy: { slots: [cappedSlot('codex-cli', 3)] },
      reportedMemberState: { slots: [cappedSlot('claude-cli', 8)] },
    }
    const slots = resolveNodeCapabilitySlots(node)
    expect(slots).toEqual([{ provider: 'codex-cli', maxParallel: 3 }])
  })

  it('falls through to legacy-derived slots when neither local policy nor a mirror carries slots', () => {
    // No difficultyBrains configured in the test env → derive maps providerPriority to
    // bare (uncapped) slots. The point is the mirror does not clobber the legacy path.
    const node: any = { id: 'node_legacy', policy: { providerPriority: ['claude-cli'] } }
    const slots = resolveNodeCapabilitySlots(node)
    expect(slots.map(s => s.provider)).toEqual(['claude-cli'])
  })
})

describe('Direction B — recordInlineMeshDirectGitTruth ingest', () => {
  it('(a) ingests a unified reporterMemberState wholesale onto a REMOTE node (versions + build + slots)', () => {
    const node: any = { id: 'node_remote', userOverrides: {} }
    const reporter = recordInlineMeshDirectGitTruth(
      node,
      {
        ...baseGit,
        reporterMemberState: {
          providerVersions: { 'claude-cli': '1.2.3' },
          daemonBuildVersion: '0.9.82',
          slots: [cappedSlot('claude-cli', 8)],
          lastReportedAt: 1_700_000_000_500,
        },
      },
      'selected_coordinator_mesh_p2p_git',
    )
    // Legacy flat fields stay populated (back-compat) …
    expect(node.reportedProviderVersions).toEqual({ 'claude-cli': '1.2.3' })
    expect(node.reportedDaemonBuildVersion).toBe('0.9.82')
    // … and the unified mirror carries the slots that drive the chips.
    expect(node.reportedMemberState?.slots).toEqual([{ provider: 'claude-cli', maxParallel: 8 }])
    expect(node.reportedMemberState?.providerVersions).toEqual({ 'claude-cli': '1.2.3' })
    expect(node.reportedMemberState?.lastReportedAt).toBe(1_700_000_000_500)
    expect(reporter.reportedMemberState?.slots).toEqual([{ provider: 'claude-cli', maxParallel: 8 }])
  })

  it('(b) precedence — a SELF (local-source) node is NOT stamped with a reportedMemberState even when the envelope carries one', () => {
    // A self node owns its slots via local policy.slots; mirroring onto it would create
    // the very precedence inversion Direction B avoids. Ingest deliberately skips the
    // mirror for the local source, so the resolver always uses the self node's policy.
    const node: any = { id: 'node_self', userOverrides: {} }
    const reporter = recordInlineMeshDirectGitTruth(
      node,
      {
        ...baseGit,
        reporterMemberState: {
          providerVersions: { 'claude-cli': '3.2.57' },
          slots: [cappedSlot('claude-cli', 8)],
        },
      },
      'selected_coordinator_local_git',
    )
    expect(node.reportedMemberState).toBeUndefined()
    expect(reporter.reportedMemberState).toBeNull()
    // The flat version self-heal still applies to the self node.
    expect(node.reportedProviderVersions).toEqual({ 'claude-cli': '3.2.57' })
  })

  it('(c) legacy-only envelope: flat reporterProviderVersions with NO reporterMemberState still ingests and synthesizes the mirror', () => {
    // An older-daemon member that has not yet learned the unified envelope reports only
    // the flat fields. The coordinator must still ingest them without breaking, and
    // synthesize a reportedMemberState from them (slots simply absent until upgrade).
    const node: any = { id: 'node_remote_legacy', userOverrides: {} }
    const reporter = recordInlineMeshDirectGitTruth(
      node,
      {
        ...baseGit,
        reporterProviderVersions: { 'claude-cli': '1.0.0', 'codex-cli': '0.9.0' },
        reporterDaemonBuildVersion: '0.9.80',
      },
      'selected_coordinator_mesh_p2p_git',
    )
    expect(node.reportedProviderVersions).toEqual({ 'claude-cli': '1.0.0', 'codex-cli': '0.9.0' })
    expect(node.reportedDaemonBuildVersion).toBe('0.9.80')
    // Synthesized mirror carries versions/build but NO slots (none were reported).
    expect(node.reportedMemberState?.providerVersions).toEqual({ 'claude-cli': '1.0.0', 'codex-cli': '0.9.0' })
    expect(node.reportedMemberState?.daemonBuildVersion).toBe('0.9.80')
    expect(node.reportedMemberState?.slots).toBeUndefined()
    // …and the resolver still works (falls through to legacy derive, no crash).
    expect(() => resolveNodeCapabilitySlots(node)).not.toThrow()
    expect(reporter.reportedMemberState).not.toBeNull()
  })

  it('a fully v1 envelope (no reporter* fields at all) leaves a remote node untouched — no empty mirror stub', () => {
    const node: any = { id: 'node_remote_v1', userOverrides: {} }
    recordInlineMeshDirectGitTruth(node, { ...baseGit }, 'selected_coordinator_mesh_p2p_git')
    expect(node.reportedMemberState).toBeUndefined()
    expect(node.reportedProviderVersions).toBeUndefined()
  })
})

describe('Direction B — end-to-end: remote slot-cap chips reach the scheduling runtime', () => {
  it('(a) a remote node ingested from a unified envelope surfaces providerRoles chips via buildMeshSchedulingRuntime', () => {
    // The exact read-site the dashboard uses: mesh.scheduling.providerRoles comes from
    // buildMeshSchedulingRuntime → resolveNodeCapabilitySlots. Before the fix a remote
    // node (empty policy) produced no providerRoles; now the mirror drives it.
    const remoteNode: any = { id: 'node_remote', workspace: '/repo', daemonId: 'daemon_2', policy: {}, userOverrides: {} }
    recordInlineMeshDirectGitTruth(
      remoteNode,
      { ...baseGit, reporterMemberState: { slots: [cappedSlot('claude-cli', 8)] } },
      'selected_coordinator_mesh_p2p_git',
    )
    const runtime = buildMeshSchedulingRuntime({ id: 'mesh_1', nodes: [remoteNode], policy: {} } as any, [])
    const nodeRuntime = runtime.nodes.find(n => n.nodeId === 'node_remote')
    expect(nodeRuntime?.providerRoles).toEqual([
      { providerType: 'claude-cli', maxParallel: 8, activeAssigned: 0, capReached: false },
    ])
  })

  it('a remote node with only a v1 (no-slots) envelope surfaces no provider chips — parity with pre-fix behavior for old members', () => {
    const remoteNode: any = { id: 'node_old', workspace: '/repo', daemonId: 'daemon_3', policy: {}, userOverrides: {} }
    recordInlineMeshDirectGitTruth(remoteNode, { ...baseGit }, 'selected_coordinator_mesh_p2p_git')
    const runtime = buildMeshSchedulingRuntime({ id: 'mesh_1', nodes: [remoteNode], policy: {} } as any, [])
    const nodeRuntime = runtime.nodes.find(n => n.nodeId === 'node_old')
    expect(nodeRuntime?.providerRoles).toBeUndefined()
  })
})
