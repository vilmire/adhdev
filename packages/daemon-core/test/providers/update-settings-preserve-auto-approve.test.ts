import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import { IdeProviderInstance } from '../../src/providers/ide-provider-instance.js'
import { buildMeshWorkerRelayStamp } from '../../src/mesh/mesh-events-utils.js'
import { withMinimalSpec } from '../helpers/minimal-spec.js';

// A minimal CLI provider module: no _resolvedSpecPath / _resolvedProviderDir, so
// createCliAdapter routes through ProviderCliAdapter, which does NOT spawn a PTY at
// construction time. updateSettings only touches this.settings + monitor + adapter
// runtime settings, none of which require a live process — so we can exercise it
// without init()/spawn().
function makeCliProvider() {
  return {
    type: 'test-cli',
    category: 'cli',
    name: 'Test CLI',
    command: 'true',
  } as any
}

function makeIdeProvider() {
  return {
    type: 'test-ide',
    category: 'ide',
    name: 'Test IDE',
  } as any
}

describe('CliProviderInstance.updateSettings — launch-stamp preservation', () => {
  it('preserves an existing autoApprove:true across a partial mesh relay-stamp (no autoApprove)', () => {
    const inst = new CliProviderInstance(withMinimalSpec(makeCliProvider() as any) as any, '/repo/worktree-worker')
    // Launch-time stamp: delegated worker started with autoApprove on.
    inst.updateSettings({ autoApprove: true })

    // Coordinator re-dispatches → router.ts agent_command applies the relay stamp,
    // which carries ONLY mesh routing keys (no autoApprove).
    const stamp = buildMeshWorkerRelayStamp(
      inst.getState().settings as Record<string, unknown>,
      { meshId: 'mesh_remote', nodeId: 'node_worker', coordinatorDaemonId: 'daemon_coord' },
    )!
    expect(stamp.autoApprove).toBeUndefined()
    inst.updateSettings(stamp)

    const settings = inst.getState().settings
    // The bug: the stamp wiped autoApprove, dropping later approvals to a manual gate.
    expect(settings.autoApprove).toBe(true)
    // Mesh routing keys are now also present.
    expect(settings.meshNodeFor).toBe('mesh_remote')
    expect(settings.meshCoordinatorDaemonId).toBe('daemon_coord')
    expect(settings.launchedByCoordinator).toBe(true)
  })

  it('preserves autoApprove across a re-dispatch that re-stamps unchanged mesh context', () => {
    const inst = new CliProviderInstance(withMinimalSpec(makeCliProvider() as any) as any, '/repo/worktree-worker')
    inst.updateSettings({ autoApprove: true, meshNodeFor: 'mesh_remote', meshNodeId: 'node_worker', meshCoordinatorDaemonId: 'daemon_coord', launchedByCoordinator: true })

    // Second dispatch — the relay stamp is a no-op (fully relay-safe already), but even
    // a bare partial write must not wipe autoApprove.
    inst.updateSettings({ meshNodeFor: 'mesh_remote' })

    expect(inst.getState().settings.autoApprove).toBe(true)
  })

  it('applies an explicit autoApprove:false from a full dashboard-toggle settings object', () => {
    const inst = new CliProviderInstance(withMinimalSpec(makeCliProvider() as any) as any, '/repo/worktree-worker')
    inst.updateSettings({ autoApprove: true, meshNodeFor: 'mesh_remote' })

    // Dashboard toggle OFF → handleSetProviderSetting sends the FULL settings object
    // with autoApprove explicitly false. The explicit value must win over preservation.
    inst.updateSettings({ autoApprove: false, approvalAlert: true })

    const settings = inst.getState().settings
    expect(settings.autoApprove).toBe(false)
    // Pre-existing runtime mesh key is still preserved (not in the toggle payload).
    expect(settings.meshNodeFor).toBe('mesh_remote')
  })
})

describe('IdeProviderInstance.updateSettings — launch-stamp preservation', () => {
  it('preserves an existing autoApprove:true across a partial update', () => {
    const inst = new IdeProviderInstance(makeIdeProvider())
    inst.updateSettings({ autoApprove: true })
    inst.updateSettings({ meshNodeFor: 'mesh_remote', launchedByCoordinator: true })

    const settings = inst.getState().settings
    expect(settings.autoApprove).toBe(true)
    expect(settings.meshNodeFor).toBe('mesh_remote')
  })

  it('applies an explicit autoApprove:false from a full settings object', () => {
    const inst = new IdeProviderInstance(makeIdeProvider())
    inst.updateSettings({ autoApprove: true })
    inst.updateSettings({ autoApprove: false })

    expect(inst.getState().settings.autoApprove).toBe(false)
  })
})
