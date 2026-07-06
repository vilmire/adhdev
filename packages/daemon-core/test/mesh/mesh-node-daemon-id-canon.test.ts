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

  // resolveAutoLaunchTarget in mesh-queue-assignment.ts guards remote auto-launch on
  // `if (!daemonId) return skip('remote_auto_launch_unsupported')`. The helper must return a
  // falsy value ONLY when the node truly has no daemon id, and a truthy value for any
  // serialization form — otherwise a remote node in a non-camelCase form is wrongly skipped.
  it('resolves a truthy daemonId for a remote node in a nested-only form (auto-launch guard)', () => {
    const remoteNode = { machine: { daemon_id: 'daemon_mach_remote' }, workspace: 'D:/gh/x' }
    expect(readMeshNodeDaemonId(remoteNode)).toBeTruthy()
    expect(readMeshNodeDaemonId(remoteNode)).toBe('daemon_mach_remote')
  })

  it('returns falsy (undefined) for a node with no daemon id — auto-launch skip stays correct', () => {
    expect(readMeshNodeDaemonId({ workspace: '/tmp/x' })).toBeFalsy()
  })
})
