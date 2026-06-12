import { describe, expect, it, vi } from 'vitest'

import { DaemonCommandRouter } from '../../src/commands/router'

/**
 * Regression tests for the mesh command self-dial guard.
 *
 * Mesh node configs can carry a daemonId in a legacy format (64-hex hash) that
 * does not match the receiving daemon's runtime identity (daemon_mach_*).
 * Without the _meshDirectDispatch guard, a daemon receiving a node-scoped
 * command over the mesh relay would treat its own node as "remote" and
 * re-forward the command to itself over P2P, killing the live connection.
 *
 * Contract: a command carrying _meshDirectDispatch must NEVER be re-forwarded
 * via dispatchMeshCommand — it executes locally, exactly like git_status.
 */

function createRouter(dispatchMeshCommand: ReturnType<typeof vi.fn>) {
  return new DaemonCommandRouter({
    commandHandler: { handle: vi.fn(async () => ({ success: false })) } as any,
    cliManager: { handleCliCommand: vi.fn(async () => ({ success: true })) } as any,
    cdpManagers: new Map(),
    providerLoader: { resolve: vi.fn(() => null), getMeta: vi.fn(() => null) } as any,
    instanceManager: {
      collectAllStates: () => [],
      listInstanceIds: () => [],
      getInstance: () => null,
    } as any,
    detectedIdes: { value: [] },
    sessionRegistry: {} as any,
    sessionHostControl: { listSessions: vi.fn(async () => []) } as any,
    packageName: 'adhdev',
    statusVersion: '0.9.82',
    statusInstanceId: 'daemon_mach_self',
    dispatchMeshCommand: dispatchMeshCommand as any,
  })
}

function buildInlineMesh(nodeDaemonId: string) {
  return {
    id: 'mesh_guard_test',
    name: 'Guard Test Mesh',
    repoIdentity: 'example/repo',
    nodes: [{
      id: 'node-target',
      workspace: '/tmp/adhdev-guard-test-not-a-repo',
      repoRoot: '/tmp/adhdev-guard-test-not-a-repo',
      daemonId: nodeDaemonId,
      policy: {},
      isLocalWorktree: true,
    }],
    policy: {},
    coordinator: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

describe('mesh command _meshDirectDispatch self-dial guard', () => {
  it('fast_forward_mesh_node forwards to the owning daemon once, marking the hop', async () => {
    const dispatchMeshCommand = vi.fn(async () => ({ success: true, forwarded: true }))
    const router = createRouter(dispatchMeshCommand)
    const inlineMesh = buildInlineMesh('legacy64hexdaemonidthatdoesnotmatchruntimeidentity')

    const result: any = await router.execute('fast_forward_mesh_node', {
      meshId: inlineMesh.id,
      nodeId: 'node-target',
      inlineMesh,
    })

    expect(dispatchMeshCommand).toHaveBeenCalledTimes(1)
    const [targetDaemonId, command, forwardedArgs] = dispatchMeshCommand.mock.calls[0]
    expect(targetDaemonId).toBe('legacy64hexdaemonidthatdoesnotmatchruntimeidentity')
    expect(command).toBe('fast_forward_mesh_node')
    expect((forwardedArgs as any)._meshDirectDispatch).toBe(true)
    expect(result).toMatchObject({ success: true, forwarded: true })
  })

  it('fast_forward_mesh_node with _meshDirectDispatch executes locally even when daemonId mismatches', async () => {
    const dispatchMeshCommand = vi.fn(async () => ({ success: true, forwarded: true }))
    const router = createRouter(dispatchMeshCommand)
    const inlineMesh = buildInlineMesh('legacy64hexdaemonidthatdoesnotmatchruntimeidentity')

    const result: any = await router.execute('fast_forward_mesh_node', {
      meshId: inlineMesh.id,
      nodeId: 'node-target',
      inlineMesh,
      _meshDirectDispatch: true,
    })

    expect(dispatchMeshCommand).not.toHaveBeenCalled()
    // Local execution on a non-repo workspace fails safely — the contract under
    // test is only that the command never re-forwards over P2P.
    expect(result).toBeDefined()
    expect(result.forwarded).toBeUndefined()
  })

  it('clone_mesh_node with _meshDirectDispatch executes locally even when daemonId mismatches', async () => {
    const dispatchMeshCommand = vi.fn(async () => ({ success: true, forwarded: true }))
    const router = createRouter(dispatchMeshCommand)
    const inlineMesh = buildInlineMesh('legacy64hexdaemonidthatdoesnotmatchruntimeidentity')

    const result: any = await router.execute('clone_mesh_node', {
      meshId: inlineMesh.id,
      sourceNodeId: 'node-target',
      branch: 'test/guard',
      inlineMesh,
      _meshDirectDispatch: true,
    })

    expect(dispatchMeshCommand).not.toHaveBeenCalled()
    expect(result).toBeDefined()
    expect(result.forwarded).toBeUndefined()
  })

  it('retry_mesh_node_bootstrap with _meshDirectDispatch executes locally even when daemonId mismatches', async () => {
    const dispatchMeshCommand = vi.fn(async () => ({ success: true, forwarded: true }))
    const router = createRouter(dispatchMeshCommand)
    const inlineMesh = buildInlineMesh('legacy64hexdaemonidthatdoesnotmatchruntimeidentity')

    const result: any = await router.execute('retry_mesh_node_bootstrap', {
      meshId: inlineMesh.id,
      nodeId: 'node-target',
      inlineMesh,
      _meshDirectDispatch: true,
    })

    expect(dispatchMeshCommand).not.toHaveBeenCalled()
    expect(result).toBeDefined()
    expect(result.forwarded).toBeUndefined()
  })
})
