import { describe, expect, it } from 'vitest'
import {
  isMeshNodeFreshEnoughToLaunch,
  isMeshNodeHealthLaunchable,
} from '../../src/mesh/mesh-node-identity.js'

// FIX 1 — launch FRESHNESS gate. The health gate (isMeshNodeHealthLaunchable /
// deriveMeshNodeHealthFromGit) reports a clean-tree node that is `behind` its upstream as
// 'online', so without a distinct freshness axis a STALE node wins auto-launch fitness
// routing and runs a fresh worker against out-of-date code. isMeshNodeFreshEnoughToLaunch is
// that axis: it blocks ONLY on git telemetry that PROVES staleness (behind > maxBehind, or a
// submodule out of sync), and passes whenever telemetry is absent (never block on missing
// data — preserving the online/unknown-pass philosophy).

describe('isMeshNodeFreshEnoughToLaunch — launch freshness gate', () => {
  it('blocks a clean-tree node that is behind its upstream (default maxBehind=0)', () => {
    const node = { git: { isGitRepo: true, branch: 'main', behind: 3, ahead: 0 } }
    // The HEALTH gate is satisfied — this is exactly the gap the freshness gate closes.
    expect(isMeshNodeHealthLaunchable(node)).toBe(true)
    expect(isMeshNodeFreshEnoughToLaunch(node)).toBe(false)
  })

  it('passes a node whose branch is up to date (behind=0)', () => {
    const node = { git: { isGitRepo: true, branch: 'main', behind: 0, ahead: 0 } }
    expect(isMeshNodeFreshEnoughToLaunch(node)).toBe(true)
  })

  it('passes a node within a non-default maxBehind tolerance and blocks beyond it', () => {
    const node = { git: { isGitRepo: true, branch: 'main', behind: 2 } }
    expect(isMeshNodeFreshEnoughToLaunch(node, { maxBehind: 2 })).toBe(true)
    expect(isMeshNodeFreshEnoughToLaunch(node, { maxBehind: 1 })).toBe(false)
  })

  it('passes when git telemetry is entirely absent (never blocks on missing data)', () => {
    expect(isMeshNodeFreshEnoughToLaunch({})).toBe(true)
    expect(isMeshNodeFreshEnoughToLaunch({ status: 'online' })).toBe(true)
    // No behind datum reported → treat as fresh (do not infer staleness from absence).
    expect(isMeshNodeFreshEnoughToLaunch({ git: { isGitRepo: true, branch: 'main' } })).toBe(true)
  })

  it('blocks a node with an out-of-sync submodule even when behind=0', () => {
    const node = {
      git: {
        isGitRepo: true,
        branch: 'main',
        behind: 0,
        submodules: [{ name: 'oss', outOfSync: true }],
      },
    }
    expect(isMeshNodeFreshEnoughToLaunch(node)).toBe(false)
  })

  it('reads git telemetry from cachedStatus.git when node.git is absent', () => {
    const node = { cachedStatus: { git: { isGitRepo: true, branch: 'main', behind: 5 } } }
    expect(isMeshNodeFreshEnoughToLaunch(node)).toBe(false)
  })

  it('does not additionally block a non-repo node (leaves that to the health gate)', () => {
    // isGitRepo=false resolves to 'degraded' at the health gate, which already blocks; the
    // freshness gate has nothing to add and must not double-report.
    const node = { git: { isGitRepo: false } }
    expect(isMeshNodeFreshEnoughToLaunch(node)).toBe(true)
    expect(isMeshNodeHealthLaunchable(node)).toBe(false)
  })
})
