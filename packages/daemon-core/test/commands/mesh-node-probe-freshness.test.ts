import { describe, expect, it } from 'vitest'

import {
  buildMeshNodeDataFreshness,
  buildMeshNodeProbeFreshness,
} from '../../src/mesh/mesh-node-identity'

// UNIFICATION GATE: the coordinator-facing mesh_status (mcp-server `meshStatus`)
// no longer hand-reconstructs the dataFreshness INPUT inline — it routes every
// live-probe node through this single canonical daemon-core adapter. That is what
// keeps the marker from drifting between the two mesh_status surfaces (the rc.371
// regression where dataFreshness was wired on the daemon aggregate but null on
// every coordinator node). These tests pin the adapter's classification contract so
// a change to it is caught at the canonical source, not only via the integration
// test on the consuming surface.

const FIXED_NOW = 1_700_000_000_000
const now = () => FIXED_NOW

describe('buildMeshNodeProbeFreshness', () => {
  it('classifies a same-machine coordinator node as self', () => {
    const f = buildMeshNodeProbeFreshness({
      git: { isGitRepo: true, branch: 'main' },
      liveTruthProbed: true,
      isSelfNode: true,
      daemonId: 'daemon-A',
      now,
    })
    expect(f).toEqual({
      dataSource: 'self', probeOk: true, reachable: true,
      directPeerTruthSatisfied: true, projection: 'live_or_absent',
      lastProbeAt: null, ageMs: null, staleness: 'fresh',
    })
  })

  it('classifies a reachable peer whose fresh probe returned as live', () => {
    const f = buildMeshNodeProbeFreshness({
      git: { isGitRepo: true, branch: 'main' },
      liveTruthProbed: true,
      isSelfNode: false,
      daemonId: 'daemon-B',
      now,
    })
    expect(f.dataSource).toBe('live')
    expect(f.probeOk).toBe(true)
    expect(f.reachable).toBe(true)
    expect(f.staleness).toBe('fresh')
  })

  it('classifies a configured peer whose probe threw as unreachable', () => {
    const f = buildMeshNodeProbeFreshness({
      git: undefined,
      liveTruthProbed: false,
      isSelfNode: false,
      daemonId: 'daemon-C',
      now,
    })
    expect(f.dataSource).toBe('unreachable')
    expect(f.probeOk).toBe(false)
    expect(f.reachable).toBe(false)
  })

  it('classifies a node with no daemonId whose probe threw as unconfigured (not mislabeled unreachable)', () => {
    const f = buildMeshNodeProbeFreshness({
      git: undefined,
      liveTruthProbed: false,
      isSelfNode: false,
      daemonId: undefined,
      now,
    })
    expect(f.dataSource).toBe('unconfigured')
    expect(f.reachable).toBe(null)
  })

  it('produces the same shape the coordinator surface previously built inline', () => {
    // Regression pin: equivalence with the pre-unification inline reconstruction
    // (synthetic { git, connection: { state: connected }, MESH_NODE_LIVE_TRUTH_MARKER }
    // + directTruthUnavailable: !live && !!daemonId). Drift here means the two
    // mesh_status surfaces have diverged again.
    const live = buildMeshNodeProbeFreshness({
      git: { isGitRepo: true, branch: 'main' },
      liveTruthProbed: true,
      isSelfNode: false,
      daemonId: 'daemon-B',
      now,
    })
    expect(Object.keys(live).sort()).toEqual(
      [
        'ageMs',
        'dataSource',
        'directPeerTruthSatisfied',
        'lastProbeAt',
        'probeOk',
        'projection',
        'reachable',
        'staleness',
      ],
    )
  })

  it('marks held metadata cached and aged when direct peer authority is unsatisfied', () => {
    const checkedAt = new Date(FIXED_NOW - 360_000).toISOString()
    const freshness = buildMeshNodeDataFreshness({
      status: {
        git: { isGitRepo: true, branch: 'main' },
        connection: {
          state: 'failed',
          directPeerTruthSatisfied: false,
          authority: 'cached_terminal_diagnostic',
        },
      },
      node: { lastGit: { checkedAt } },
      isSelfNode: false,
      daemonId: 'daemon-remote',
      liveTruthProbed: false,
      directTruthUnavailable: true,
      now,
    })
    expect(freshness).toEqual(expect.objectContaining({
      dataSource: 'cached',
      projection: 'cached',
      directPeerTruthSatisfied: false,
      reachable: false,
      ageMs: 360_000,
      staleness: 'stale',
    }))
  })
})
