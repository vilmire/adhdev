import { describe, expect, it } from 'vitest'

import { summarizeMeshSessionRecord } from '../../src/mesh/mesh-node-identity'

/**
 * MCP-usage-audit item 3: the session's mesh_status / mesh_list_nodes entry
 * (`summarizeMeshSessionRecord`) must carry `workerMcp: { delivered, reason? }`
 * whenever `launchCli` (cli-manager.ts) stamped a delivery outcome onto the
 * session's `meta` at launch time — and must omit the key entirely for any
 * session that never went through that path (an ordinary user launch, or one
 * launched before this field existed).
 */
describe('summarizeMeshSessionRecord — workerMcp delivery projection', () => {
  it('omits workerMcp entirely when meta carries no delivery stamp', () => {
    const summary = summarizeMeshSessionRecord({ meta: {} })
    expect(summary).not.toHaveProperty('workerMcp')
  })

  it('omits workerMcp for a record with no meta at all', () => {
    const summary = summarizeMeshSessionRecord({})
    expect(summary).not.toHaveProperty('workerMcp')
  })

  it('projects delivered:true with no reason', () => {
    const summary = summarizeMeshSessionRecord({ meta: { workerMcpDelivered: true } })
    expect(summary.workerMcp).toEqual({ delivered: true })
  })

  it('projects delivered:false with a valid reason code', () => {
    const summary = summarizeMeshSessionRecord({
      meta: { workerMcpDelivered: false, workerMcpDeliveryReason: 'private_home_failed' },
    })
    expect(summary.workerMcp).toEqual({ delivered: false, reason: 'private_home_failed' })
  })

  it('drops an unrecognized reason string rather than leaking stale/foreign vocabulary', () => {
    const summary = summarizeMeshSessionRecord({
      meta: { workerMcpDelivered: false, workerMcpDeliveryReason: 'some_future_value_this_build_does_not_know' },
    })
    expect(summary.workerMcp).toEqual({ delivered: false })
  })

  it('ignores a reason with no accompanying delivered flag (delivered is the presence signal)', () => {
    const summary = summarizeMeshSessionRecord({
      meta: { workerMcpDeliveryReason: 'private_home_failed' },
    })
    expect(summary).not.toHaveProperty('workerMcp')
  })
})
