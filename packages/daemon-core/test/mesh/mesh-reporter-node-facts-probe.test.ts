import { describe, expect, it, vi } from 'vitest'
import { probeRemoteMeshGitStatusWithRetry, recordInlineMeshDirectGitTruth } from '../../src/mesh/mesh-node-identity.js'

// REMOTE-NODE-FACTS-PROPAGATION: the member daemon stamps its self-built
// reporterNodeFacts bundle onto the git_status result envelope (git-commands.ts
// buildLocalNodeFacts). probeRemoteMeshGitStatus must re-attach that bundle onto
// the returned git object — alongside reporterPlatform / reporterProviderVersions
// / reporterMemberState — or recordInlineMeshDirectGitTruth reads
// git.reporterNodeFacts as undefined and the node.nodeFacts stamp never happens
// for REMOTE nodes (local nodes are unaffected: their facts are built locally).
// This test pins the full path: envelope → probe → git object → node stamp.

const REPORTED_FACTS = {
  schemaVersion: 1,
  reportedAt: 1_700_000_000_000,
  machineNickname: 'remote-box',
  providerVersions: { 'claude-cli': '2.0.0' },
  daemonBuild: { commitShort: 'abc1234', version: '1.2.3' },
  quotas: [
    {
      provider: 'claude-cli',
      status: 'ok',
      session: { usedPercent: 42, windowMinutes: 300, resetsAt: null },
      weekly: null,
      updatedAt: 1_699_999_999_000,
      error: null,
    },
  ],
}

describe('probeRemoteMeshGitStatus propagates reporterNodeFacts', () => {
  it('preserves the envelope reporterNodeFacts bundle on the returned git object', async () => {
    const dispatchMeshCommand = vi.fn(async () => ({
      status: { isGitRepo: true, branch: 'main' },
      reporterNodeFacts: REPORTED_FACTS,
    }))

    const git = await probeRemoteMeshGitStatusWithRetry({
      dispatchMeshCommand,
      daemonId: 'daemon_mach_remote',
      workspace: '/w',
      timeoutMs: 5_000,
      // Report the peer as connected so the probe actually dispatches.
      getConnection: () => ({ state: 'connected' }),
    })

    expect(git).toMatchObject({ isGitRepo: true, branch: 'main' })
    // The bundle must ride through OPAQUELY — normalized, never rebuilt
    // field-by-field (mesh-shared MeshNodeFacts bundle rule).
    expect(git?.reporterNodeFacts).toMatchObject(REPORTED_FACTS)
  })

  it('drops an unusable reporterNodeFacts bundle rather than attaching garbage', async () => {
    const dispatchMeshCommand = vi.fn(async () => ({
      status: { isGitRepo: true, branch: 'main' },
      // Missing schemaVersion / reportedAt — normalizeMeshNodeFacts must reject it.
      reporterNodeFacts: { quotas: [] },
    }))

    const git = await probeRemoteMeshGitStatusWithRetry({
      dispatchMeshCommand,
      daemonId: 'daemon_mach_remote',
      workspace: '/w',
      timeoutMs: 5_000,
      getConnection: () => ({ state: 'connected' }),
    })

    expect(git).toMatchObject({ isGitRepo: true })
    expect(git?.reporterNodeFacts).toBeUndefined()
  })

  it('carries the probed bundle through to the consumer node.nodeFacts stamp', async () => {
    const dispatchMeshCommand = vi.fn(async () => ({
      status: { isGitRepo: true, branch: 'main' },
      reporterNodeFacts: REPORTED_FACTS,
    }))

    const git = await probeRemoteMeshGitStatusWithRetry({
      dispatchMeshCommand,
      daemonId: 'daemon_mach_remote',
      workspace: '/w',
      timeoutMs: 5_000,
      getConnection: () => ({ state: 'connected' }),
    })
    expect(git).not.toBeNull()

    const node: Record<string, unknown> = {}
    const result = recordInlineMeshDirectGitTruth(node, git!, 'selected_coordinator_mesh_p2p_git')

    expect(node.nodeFacts).toMatchObject(REPORTED_FACTS)
    expect(result.nodeFacts).toMatchObject(REPORTED_FACTS)
  })
})
