import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// WTCLAIM (A): a coordinator-launched session that completes a task is detached
// (detachMeshAssignment clears meshNodeFor/meshNodeId/meshActiveTaskId) but stays
// idle and coordinator-owned. On a daemon hosting BOTH a base node and a cloned
// worktree node (same daemonId), a later worktree-targeted sessionless dispatch
// must NOT auto-adopt a detached BASE session. detachMeshAssignment now preserves
// a sticky meshLastNodeId so ownership can be re-checked against the served node.
describe('CliProviderInstance mesh last-node sticky marker', () => {
  function makeInstance(settings: Record<string, any>) {
    const instance = Object.create(CliProviderInstance.prototype) as any
    instance.instanceId = 'sess-instance-1'
    instance.type = 'claude-code'
    instance.workingDir = '/work/repo'
    instance.settings = settings
    instance.adapter = { updateRuntimeSettings() {} }
    return instance
  }

  it('attach stamps both the active (meshNodeId) and sticky (meshLastNodeId) node id', () => {
    const instance = makeInstance({})
    instance.attachMeshAssignment({ meshId: 'mesh-abc', nodeId: 'node_base', taskId: 'task-1' })
    expect(instance.settings.meshNodeId).toBe('node_base')
    expect(instance.settings.meshLastNodeId).toBe('node_base')
  })

  it('detach clears the active binding but PRESERVES meshLastNodeId', () => {
    const instance = makeInstance({
      meshNodeFor: 'mesh-abc',
      meshNodeId: 'node_base',
      meshActiveTaskId: 'task-1',
      launchedByCoordinator: true,
    })
    instance.detachMeshAssignment()
    expect(instance.settings.meshNodeFor).toBeUndefined()
    expect(instance.settings.meshNodeId).toBeUndefined()
    expect(instance.settings.meshActiveTaskId).toBeUndefined()
    // Sticky marker survives so same-node reuse is still recognizable.
    expect(instance.settings.meshLastNodeId).toBe('node_base')
    // Coordinator ownership marker is untouched (unchanged behavior).
    expect(instance.settings.launchedByCoordinator).toBe(true)
  })

  it('detach keeps a pre-existing meshLastNodeId when the active meshNodeId was already absent', () => {
    const instance = makeInstance({
      meshActiveTaskId: 'task-2',
      meshLastNodeId: 'node_worktree',
      launchedByCoordinator: true,
    })
    instance.detachMeshAssignment()
    expect(instance.settings.meshActiveTaskId).toBeUndefined()
    expect(instance.settings.meshLastNodeId).toBe('node_worktree')
  })
})
