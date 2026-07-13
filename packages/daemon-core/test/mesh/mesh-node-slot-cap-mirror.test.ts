import { describe, expect, it } from 'vitest'
import { resolveNodeCapabilitySlots } from '../../src/mesh/mesh-node-slots.js'
import { recordInlineMeshDirectGitTruth } from '../../src/mesh/mesh-node-identity.js'
import { buildMeshSchedulingRuntime } from '../../src/mesh/mesh-scheduling-runtime.js'

// REMOTE-NODE-SLOTS-COORDINATOR-LOCAL fix.
//
// The dashboard NODE cards render slot-cap chips from node.scheduling.providerRoles,
// which is populated by buildMeshSchedulingRuntime → resolveNodeCapabilitySlots.
// The coordinator's local meshes.json owns policy.slots for EVERY node in the mesh
// (self AND remote members — a remote member's mesh config lives on the coordinator;
// its own on-disk meshes.json is empty). So slots resolve directly from the
// coordinator's locally-owned node.policy.slots for ALL nodes, with no remote
// reporter round-trip. Provider VERSIONS + daemon BUILD are per-machine runtime facts
// (e.g. a member has claude-cli@2.1.168 while the coordinator has @2.1.170) and STAY
// reported via reportedMemberState — only the dead slots round-trip was removed.

const baseGit = { isGitRepo: true, lastCheckedAt: 1_700_000_000_000 }

/** A capability slot that declares a per-provider parallelism cap (drives the chip). */
function cappedSlot(provider: string, maxParallel: number) {
  return { provider, maxParallel }
}

describe('coordinator-owned slots — resolveNodeCapabilitySlots reads policy.slots for all nodes', () => {
  it('(a) a REMOTE node with NO reported state resolves its slots from the coordinator-owned policy.slots', () => {
    // The coordinator owns this remote member's policy.slots locally (its meshes.json
    // node record). No reportedMemberState is present or needed — slots are not reported.
    const node: any = {
      id: 'node_remote',
      policy: { slots: [cappedSlot('antigravity-cli', 2), cappedSlot('hermes-cli', 2)] },
      reportedMemberState: null,
    }
    const slots = resolveNodeCapabilitySlots(node)
    expect(slots).toEqual([
      { provider: 'antigravity-cli', maxParallel: 2 },
      { provider: 'hermes-cli', maxParallel: 2 },
    ])
  })

  it('(b) a SELF node reads its local policy.slots (unchanged — no regression, no double-count)', () => {
    const node: any = {
      id: 'node_self',
      policy: { slots: [cappedSlot('codex-cli', 3)] },
    }
    const slots = resolveNodeCapabilitySlots(node)
    expect(slots).toEqual([{ provider: 'codex-cli', maxParallel: 3 }])
  })

  it('(c) a stray reportedMemberState.slots is IGNORED — the reporter no longer supplies slots', () => {
    // Even if some legacy/foreign envelope stamped a reportedMemberState with slots,
    // the resolver never consults it; policy.slots (coordinator-owned) is authoritative.
    const node: any = {
      id: 'node_remote',
      policy: { slots: [cappedSlot('codex-cli', 3)] },
      reportedMemberState: { slots: [cappedSlot('claude-cli', 8)] } as any,
    }
    const slots = resolveNodeCapabilitySlots(node)
    expect(slots).toEqual([{ provider: 'codex-cli', maxParallel: 3 }])
  })

  it('falls through to legacy-derived slots when policy carries no explicit slots', () => {
    // No difficultyBrains configured in the test env → derive maps providerPriority to
    // bare (uncapped) slots.
    const node: any = { id: 'node_legacy', policy: { providerPriority: ['claude-cli'] } }
    const slots = resolveNodeCapabilitySlots(node)
    expect(slots.map(s => s.provider)).toEqual(['claude-cli'])
  })
})

describe('version/build report channel stays intact — recordInlineMeshDirectGitTruth ingest', () => {
  it('(a) ingests a reporterMemberState (versions + build) onto a REMOTE node — the blue version chips', () => {
    const node: any = { id: 'node_remote', userOverrides: {} }
    const reporter = recordInlineMeshDirectGitTruth(
      node,
      {
        ...baseGit,
        reporterMemberState: {
          providerVersions: { 'claude-cli': '1.2.3' },
          daemonBuildVersion: '0.9.82',
          lastReportedAt: 1_700_000_000_500,
        },
      },
      'selected_coordinator_mesh_p2p_git',
    )
    // Flat fields (feed RepoMeshNodeStatus.providerVersions) …
    expect(node.reportedProviderVersions).toEqual({ 'claude-cli': '1.2.3' })
    expect(node.reportedDaemonBuildVersion).toBe('0.9.82')
    // … and the unified mirror carries versions/build (NOT slots).
    expect(node.reportedMemberState?.providerVersions).toEqual({ 'claude-cli': '1.2.3' })
    expect(node.reportedMemberState?.daemonBuildVersion).toBe('0.9.82')
    expect(node.reportedMemberState?.lastReportedAt).toBe(1_700_000_000_500)
    expect((node.reportedMemberState as any)?.slots).toBeUndefined()
    expect(reporter.reportedMemberState?.providerVersions).toEqual({ 'claude-cli': '1.2.3' })
  })

  it('(b) a stray slots field on the reported envelope is dropped — slots are never ingested from the reporter', () => {
    const node: any = { id: 'node_remote', userOverrides: {} }
    recordInlineMeshDirectGitTruth(
      node,
      {
        ...baseGit,
        reporterMemberState: {
          providerVersions: { 'claude-cli': '1.2.3' },
          slots: [cappedSlot('claude-cli', 8)],
        } as any,
      },
      'selected_coordinator_mesh_p2p_git',
    )
    expect(node.reportedProviderVersions).toEqual({ 'claude-cli': '1.2.3' })
    expect((node.reportedMemberState as any)?.slots).toBeUndefined()
  })

  it('(c) a SELF (local-source) node is NOT stamped with a reportedMemberState, but its flat version self-heal still applies', () => {
    const node: any = { id: 'node_self', userOverrides: {} }
    const reporter = recordInlineMeshDirectGitTruth(
      node,
      {
        ...baseGit,
        reporterMemberState: { providerVersions: { 'claude-cli': '3.2.57' } },
      },
      'selected_coordinator_local_git',
    )
    expect(node.reportedMemberState).toBeUndefined()
    expect(reporter.reportedMemberState).toBeNull()
    expect(node.reportedProviderVersions).toEqual({ 'claude-cli': '3.2.57' })
  })

  it('(d) legacy-only envelope: flat reporterProviderVersions with NO reporterMemberState still ingests and synthesizes the version mirror', () => {
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
    expect(node.reportedMemberState?.providerVersions).toEqual({ 'claude-cli': '1.0.0', 'codex-cli': '0.9.0' })
    expect(node.reportedMemberState?.daemonBuildVersion).toBe('0.9.80')
    expect(reporter.reportedMemberState).not.toBeNull()
  })

  it('a fully v1 envelope (no reporter* fields at all) leaves a remote node untouched — no empty mirror stub', () => {
    const node: any = { id: 'node_remote_v1', userOverrides: {} }
    recordInlineMeshDirectGitTruth(node, { ...baseGit }, 'selected_coordinator_mesh_p2p_git')
    expect(node.reportedMemberState).toBeUndefined()
    expect(node.reportedProviderVersions).toBeUndefined()
  })
})

describe('end-to-end: remote slot-cap chips + scheduling.providerRoles from coordinator-owned policy.slots', () => {
  it('(a) a REMOTE node (reportedMemberState=null) surfaces providerRoles chips from policy.slots via buildMeshSchedulingRuntime', () => {
    // The exact read-site the dashboard uses: mesh.scheduling.providerRoles comes from
    // buildMeshSchedulingRuntime → resolveNodeCapabilitySlots. A remote node with NO
    // reported state but coordinator-owned policy.slots now produces non-null chips.
    const remoteNode: any = {
      id: 'node_remote',
      workspace: '/repo',
      daemonId: 'daemon_2',
      policy: { slots: [cappedSlot('antigravity-cli', 2), cappedSlot('hermes-cli', 2)] },
      reportedMemberState: null,
      userOverrides: {},
    }
    const runtime = buildMeshSchedulingRuntime({ id: 'mesh_1', nodes: [remoteNode], policy: {} } as any, [])
    const nodeRuntime = runtime.nodes.find(n => n.nodeId === 'node_remote')
    expect(nodeRuntime?.providerRoles).toEqual([
      { providerType: 'antigravity-cli', maxParallel: 2, activeAssigned: 0, capReached: false },
      { providerType: 'hermes-cli', maxParallel: 2, activeAssigned: 0, capReached: false },
    ])
  })

  it('a remote node with an empty policy (no slots, no legacy priority) surfaces no provider chips', () => {
    const remoteNode: any = { id: 'node_old', workspace: '/repo', daemonId: 'daemon_3', policy: {}, userOverrides: {} }
    const runtime = buildMeshSchedulingRuntime({ id: 'mesh_1', nodes: [remoteNode], policy: {} } as any, [])
    const nodeRuntime = runtime.nodes.find(n => n.nodeId === 'node_old')
    expect(nodeRuntime?.providerRoles).toBeUndefined()
  })
})
