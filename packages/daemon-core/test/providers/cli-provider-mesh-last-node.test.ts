import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// MESHID-DROP-ON-DETACH (Fix C): a coordinator-LAUNCHED worker session holds its mesh
// membership (meshNodeFor / meshNodeId / meshCoordinatorDaemonId) at the SESSION level,
// independent of any single task. detachMeshAssignment must clear ONLY the task-level
// marker (meshActiveTaskId) for such a session and PRESERVE the membership, so the NEXT
// task's completion still resolves a meshId (before this, the first completion stripped
// meshNodeFor and every later completion forwarded "meshId required").
//
// WTCLAIM (A) is still honoured: base-vs-worktree node isolation now comes from the
// PRESERVED active marker (meshNodeId) — isMeshOwnedDelegateSession's primary branch
// gates reuse on `sessionNodeId === nodeId` directly, so a detached BASE session is never
// auto-adopted for a worktree-targeted dispatch. A NON-launched session (a plain CLI
// session adopted by mesh_send_task --direct, launchedByCoordinator falsy) keeps the
// original full clear + sticky meshLastNodeId fallback.
describe('CliProviderInstance detach: launched-member membership vs ad-hoc clear', () => {
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

  it('detach on a LAUNCHED member clears only meshActiveTaskId and PRESERVES membership', () => {
    const instance = makeInstance({
      meshNodeFor: 'mesh-abc',
      meshNodeId: 'node_base',
      meshCoordinatorDaemonId: 'daemon_mach_coord',
      meshActiveTaskId: 'task-1',
      launchedByCoordinator: true,
    })
    instance.detachMeshAssignment()
    // Task-level marker is cleared so the next dispatch re-stamps a fresh taskId.
    expect(instance.settings.meshActiveTaskId).toBeUndefined()
    // Session-level membership survives so the NEXT completion still resolves meshId.
    expect(instance.settings.meshNodeFor).toBe('mesh-abc')
    expect(instance.settings.meshNodeId).toBe('node_base')
    expect(instance.settings.meshCoordinatorDaemonId).toBe('daemon_mach_coord')
    expect(instance.settings.launchedByCoordinator).toBe(true)
  })

  it('detach on a LAUNCHED member is a no-op when no task is active (idempotent)', () => {
    const instance = makeInstance({
      meshNodeFor: 'mesh-abc',
      meshNodeId: 'node_base',
      launchedByCoordinator: true,
    })
    instance.detachMeshAssignment()
    expect(instance.settings.meshNodeFor).toBe('mesh-abc')
    expect(instance.settings.meshNodeId).toBe('node_base')
  })

  it('detach on a NON-launched (ad-hoc) session clears the binding but PRESERVES meshLastNodeId', () => {
    const instance = makeInstance({
      meshNodeFor: 'mesh-abc',
      meshNodeId: 'node_base',
      meshActiveTaskId: 'task-1',
      // launchedByCoordinator absent → ad-hoc session adopted by a direct dispatch.
    })
    instance.detachMeshAssignment()
    expect(instance.settings.meshNodeFor).toBeUndefined()
    expect(instance.settings.meshNodeId).toBeUndefined()
    expect(instance.settings.meshActiveTaskId).toBeUndefined()
    // Sticky marker survives so same-node reuse is still recognizable.
    expect(instance.settings.meshLastNodeId).toBe('node_base')
  })

  it('detach on a NON-launched session keeps a pre-existing meshLastNodeId when meshNodeId was already absent', () => {
    const instance = makeInstance({
      meshActiveTaskId: 'task-2',
      meshLastNodeId: 'node_worktree',
    })
    instance.detachMeshAssignment()
    expect(instance.settings.meshActiveTaskId).toBeUndefined()
    expect(instance.settings.meshLastNodeId).toBe('node_worktree')
  })
})
