/**
 * mesh_status_view / mesh_dispatch_route (data-path audit 2026-09-29 P1-6): a
 * tool asks the coordinator ONE question and the coordinator composes the
 * answer from its own commands in-process — no member is ever read — and the
 * routing decision for a direct dispatch is the daemon's, not the tool's.
 */
import { describe, expect, it, vi } from 'vitest'
import { composeMeshStatusView, decideDispatchRoute, decideNodeRoutes, meshStatusViewHandlers } from '../../src/commands/high-family/mesh-status-view'

function fakeExecute(calls: string[]) {
  return vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    calls.push(cmd)
    switch (cmd) {
      case 'get_mesh': return { success: true, mesh: { id: args.meshId, nodes: [
        { id: 'n_local', daemonId: 'daemon_self', workspace: '/here', relatedRepos: [{ workspace: '/here-related' }] },
        { id: 'n_remote', daemonId: 'daemon_peer', workspace: '/there', relatedRepos: [{ workspace: '/there-related' }] },
      ] } }
      case 'mesh_status': return { success: true, meshId: args.meshId, nodeRuntimeHeld: true, nodes: [
        { nodeId: 'n_local', activeSessionDetails: [{ sessionId: 's1' }], git: { headCommit: 'a' } },
        { nodeId: 'n_remote', activeSessionDetails: [], heldRuntime: { source: 'member_push', sessions: [] }, git: { headCommit: 'b' } },
      ] }
      case 'get_status_metadata': return { success: true, status: { instanceId: 'daemon_self', sessions: [] } }
      case 'mission_list_query': return { success: true, missions: [{ id: 'm1' }] }
      case 'task_stats_query': return { success: true, missions: { m1: { tasks: 1 } } }
      case 'git_status': return { success: true, status: { workspace: args.workspace } }
      default: return { success: true }
    }
  })
}

describe('mesh_status_view — the coordinator composes, in-process', () => {
  it('answers every input of the tool from its own commands; no mesh relay, no member read', async () => {
    const calls: string[] = []
    const execute = fakeExecute(calls)
    const view = await composeMeshStatusView(execute, {
      meshId: 'mesh_v', compact: false, refresh: true,
      pendingEvents: { coordinatorDaemonId: 'daemon_self' },
      toolCall: { tool: 'mesh_status', callerRole: 'coordinator' },
    }, { isLocalNode: (n: any) => String(n.workspace).startsWith('/here') })
    expect(new Set(calls)).toEqual(new Set([
      'tool_call_record', 'get_mesh', 'mesh_status', 'get_status_metadata', 'recovery_context_query',
      'active_work_query', 'mission_list_query', 'task_stats_query', 'get_pending_mesh_events', 'git_status',
    ]))
    // The held node section only (the dashboard's view), refresh = nudge, never a probe.
    expect(execute.mock.calls.find((c) => c[0] === 'mesh_status')![1]).toEqual({ meshId: 'mesh_v', sections: ['nodes'], refresh: true })
    // Active work reads the HELD node sessions.
    const activeWork = execute.mock.calls.find((c) => c[0] === 'active_work_query')![1] as any
    expect(activeWork.nodes.map((n: any) => n.nodeId)).toEqual(['n_local', 'n_remote'])
    // Related-repo git only for checkouts on this machine.
    expect(execute.mock.calls.filter((c) => c[0] === 'git_status').map((c) => (c[1] as any).workspace)).toEqual(['/here-related'])
    expect(Object.keys(view.relatedRepoGit as object)).toEqual(['/here-related'])
    expect((view.missions as any).stats.missions.m1).toEqual({ tasks: 1 })
  })

  it('a failing part is reported as its own failed result; the rest still answers', async () => {
    const view = await composeMeshStatusView(async (cmd) => {
      if (cmd === 'recovery_context_query') throw new Error('boom')
      if (cmd === 'get_mesh') return { success: true, mesh: { nodes: [{ id: 'n1' }] } }
      return { success: true }
    }, { meshId: 'm' })
    expect(view.recovery).toEqual({ success: false, error: 'boom' })
    expect(view.status).toEqual({ success: true })
    expect(view.pendingEvents).toBeUndefined()
    expect(view.toolCall).toBeUndefined()
  })
})

describe('mesh_dispatch_route — the daemon decides', () => {
  const self = { localDaemonId: 'daemon_self', localMachineId: 'mach_self', hasMeshTransport: true, workspaceExists: (p: string) => p === '/here' }
  it('this daemon\'s node and a checkout on this machine are local; another daemon\'s node is remote', () => {
    expect(decideDispatchRoute({ id: 'a', daemonId: 'daemon_self', workspace: '/x' }, self)).toMatchObject({ route: 'local' })
    expect(decideDispatchRoute({ id: 'b', daemonId: 'daemon_peer', workspace: '/here' }, self)).toMatchObject({ route: 'local', ownerDaemonId: 'daemon_peer' })
    expect(decideDispatchRoute({ id: 'c', daemonId: 'daemon_peer', workspace: '/there' }, self)).toEqual({ route: 'remote', ownerDaemonId: 'daemon_peer', reason: 'owned_by_another_daemon' })
    expect(decideDispatchRoute({ id: 'd', workspace: '/there' }, self)).toMatchObject({ route: 'local' })
  })
  it('another daemon\'s node without a mesh channel is unreachable (never sent in-process)', () => {
    expect(decideDispatchRoute({ id: 'c', daemonId: 'daemon_peer', workspace: '/there' }, { ...self, hasMeshTransport: false })).toMatchObject({ route: 'unreachable' })
  })
})

describe('mesh_node_route — one call, the daemon decides every node', () => {
  const self = { localDaemonId: 'daemon_self', localMachineId: 'mach_self', hasMeshTransport: true, workspaceExists: (p: string) => p === '/here' }
  it('routes the roster (roster record wins) plus described nodes the roster lacks', () => {
    const roster = [
      { id: 'n_local', daemonId: 'daemon_self', workspace: '/x' },
      { id: 'n_remote', daemonId: 'daemon_peer', workspace: '/there' },
    ]
    const described = [
      // A stale client view of a rostered node — the roster record decides.
      { id: 'n_remote', daemonId: 'daemon_self', workspace: '/x' },
      // A clone another tool process just made.
      { id: 'n_clone', daemonId: 'daemon_peer', workspace: '/here' },
    ]
    expect(decideNodeRoutes(roster, described, self)).toEqual({
      n_local: { route: 'local', reason: 'served_by_this_daemon' },
      n_remote: { route: 'remote', ownerDaemonId: 'daemon_peer', reason: 'owned_by_another_daemon' },
      n_clone: { route: 'local', ownerDaemonId: 'daemon_peer', reason: 'checkout_on_this_machine' },
    })
    expect(Object.keys(decideNodeRoutes(roster, described, self, new Set(['n_remote'])))).toEqual(['n_remote'])
  })

  it('the command answers from the roster and refuses a caller attached to another daemon', async () => {
    const ctx: any = {
      deps: { statusInstanceId: 'daemon_self', dispatchMeshCommand: vi.fn() },
      getMeshForCommand: async () => ({ mesh: { id: 'm', nodes: [{ id: 'n_remote', daemonId: 'daemon_peer', workspace: '/definitely/not/here' }] } }),
    }
    const answer: any = await meshStatusViewHandlers.mesh_node_route!(ctx, { meshId: 'm', callerDaemonId: 'daemon_self' })
    expect(answer).toMatchObject({ success: true, routes: { n_remote: { route: 'remote', ownerDaemonId: 'daemon_peer' } } })
    // No member was contacted to decide.
    expect(ctx.deps.dispatchMeshCommand).not.toHaveBeenCalled()
    const wrong: any = await meshStatusViewHandlers.mesh_node_route!(ctx, { meshId: 'm', callerDaemonId: 'daemon_other' })
    expect(wrong).toMatchObject({ success: false, code: 'mesh_node_route_wrong_daemon' })
  })
})
