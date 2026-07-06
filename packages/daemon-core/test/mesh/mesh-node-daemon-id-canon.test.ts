import { describe, expect, it } from 'vitest'
import { readMeshNodeDaemonId } from '../../src/mesh/mesh-node-identity.js'

// CANON-IDENTITY regression (MESHQUEUE-LOCAL-DISPATCH-HANDLECLICOMMAND): the mesh queue
// dispatch guard in mesh-queue-assignment.ts routes remote-vs-local off this helper. A
// remote node whose daemonId arrives in a non-top-level-camelCase serialization form must
// still resolve, otherwise the remote-dispatch block is skipped and execution falls through
// to the LOCAL cliManager.handleCliCommand path (which has no adapter for the remote session
// → 'Cannot read properties of undefined (reading handleCliCommand)').
describe('readMeshNodeDaemonId — serialization-form absorption', () => {
  it('reads the top-level camelCase form (local/self node — no regression)', () => {
    expect(readMeshNodeDaemonId({ daemonId: 'daemon_mach_abc' })).toBe('daemon_mach_abc')
  })

  it('reads the snake_case top-level form', () => {
    expect(readMeshNodeDaemonId({ daemon_id: 'daemon_mach_abc' })).toBe('daemon_mach_abc')
  })

  it('reads a nested machine.daemonId form', () => {
    expect(readMeshNodeDaemonId({ machine: { daemonId: 'daemon_mach_abc' } })).toBe('daemon_mach_abc')
  })

  it('reads a deep lastProbe.machine.daemon_id form', () => {
    expect(
      readMeshNodeDaemonId({ lastProbe: { machine: { daemon_id: 'daemon_mach_abc' } } }),
    ).toBe('daemon_mach_abc')
  })

  it('returns undefined when no daemon id is present in any form', () => {
    expect(readMeshNodeDaemonId({ nodeId: 'node_x', workspace: '/tmp/x' })).toBeUndefined()
  })
})
