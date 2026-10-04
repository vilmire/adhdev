// The aggregate mesh_status cache is invalidated by queue mutations only, so a
// quiet mesh served the nodeFacts bundle it was built with (a 39-hour-old quota
// reading on the standalone dashboard, 2026-10-05). A cache hit now takes the
// node record's facts whenever they are newer.
import { describe, expect, it } from 'vitest'
import { overlayFreshNodeFacts } from '../../src/commands/router-aggregate-status.js'

const snapshot = (reportedAt: number) => ({
  success: true,
  nodes: [{ id: 'node_a', nodeId: 'node_a', daemonBuildVersion: '1.0.67', nodeFacts: { reportedAt, quota: { 'claude-cli': { status: 'ok', weekly: { usedPercent: 10 } } } } }],
})

describe('overlayFreshNodeFacts', () => {
  it('replaces held facts with a newer node record bundle', () => {
    const mesh = { nodes: [{ id: 'node_a', reportedDaemonBuildVersion: '1.0.70', nodeFacts: { reportedAt: 2_000, quota: { 'claude-cli': { status: 'ok', weekly: { usedPercent: 55 } } } } }] }
    const out = overlayFreshNodeFacts(snapshot(1_000), mesh)
    expect(out.nodes[0].nodeFacts.reportedAt).toBe(2_000)
    expect(out.nodes[0].nodeFacts.quota['claude-cli'].weekly.usedPercent).toBe(55)
    expect(out.nodes[0].daemonBuildVersion).toBe('1.0.70')
  })

  it('keeps the held facts when the record is not newer, returning the same snapshot', () => {
    const held = snapshot(3_000)
    const mesh = { nodes: [{ id: 'node_a', nodeFacts: { reportedAt: 2_000 } }] }
    expect(overlayFreshNodeFacts(held, mesh)).toBe(held)
  })

  it('leaves nodes without a record or without facts untouched', () => {
    const held = snapshot(1_000)
    expect(overlayFreshNodeFacts(held, { nodes: [{ id: 'node_other', nodeFacts: { reportedAt: 9_000 } }] })).toBe(held)
    expect(overlayFreshNodeFacts(held, { nodes: [{ id: 'node_a' }] })).toBe(held)
    expect(overlayFreshNodeFacts(held, undefined)).toBe(held)
  })
})
