import { describe, expect, it } from 'vitest'
import { extractPendingEvents } from '../../src/mesh/mesh-remote-event-pull.js'

/**
 * PHASE 1 pullRemoteNodeQueues used to unwrap `{ events }` only at the top level.
 * A P2P dispatchMeshCommand result is often `{ result: { success, events } }` or
 * `{ payload: { events } }` — the same envelopes unwrapReadChatPayload already
 * walks. Missing that walk made a successful remote drain look empty.
 */
describe('extractPendingEvents — P2P envelope unwrap (M-MESH-INFRA-0829 5-d)', () => {
  const bootstrap = { event: 'worktree_bootstrap_complete', meshId: 'mesh_x', nodeId: 'node_wt' }

  it('reads a direct CommandResult `{ success, events }`', () => {
    expect(extractPendingEvents({ success: true, events: [bootstrap] })).toEqual([bootstrap])
  })

  it('walks `{ result: { events } }` (rpc_res inner result re-wrapped)', () => {
    expect(extractPendingEvents({ result: { success: true, events: [bootstrap] } })).toEqual([bootstrap])
  })

  it('walks `{ payload: { events } }`', () => {
    expect(extractPendingEvents({ payload: { events: [bootstrap] } })).toEqual([bootstrap])
  })

  it('walks `{ data: { events } }`', () => {
    expect(extractPendingEvents({ data: { events: [bootstrap] } })).toEqual([bootstrap])
  })

  it('accepts a bare events array', () => {
    expect(extractPendingEvents([bootstrap])).toEqual([bootstrap])
  })

  it('returns [] for an empty or unknown envelope (fail-closed, no throw)', () => {
    expect(extractPendingEvents(null)).toEqual([])
    expect(extractPendingEvents({ success: true })).toEqual([])
    expect(extractPendingEvents({ heldForBusyLocalCoordinator: true, events: [] })).toEqual([])
  })
})
