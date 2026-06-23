import { describe, expect, it, vi } from 'vitest'

import { DaemonCliManager } from '../../src/commands/cli-manager.js'

// WTCLAIM (B): a mesh dispatch that named a node (meshContext.nodeId) but resolved
// no explicit session must be scoped to THAT node's session on the worker — never
// routed by findAdapter's provider-only fuzzy first-match. On a daemon hosting BOTH
// a base node and a cloned worktree node (same daemonId, same cliType), the fuzzy
// match could land a worktree-targeted task on the base session. The worker now
// resolves by bound meshNodeId / workspace and fails closed when nothing matches.

function makeAdapter(workingDir: string) {
  const sendMessage = vi.fn(async () => {})
  const adapter = {
    cliType: 'hermes-cli',
    cliName: 'Hermes Agent',
    workingDir,
    spawn: vi.fn(async () => {}),
    sendMessage,
    forceSendMessage: vi.fn(async () => {}),
    getStatus: vi.fn(() => ({ status: 'idle', activeModal: null, messages: [] })),
    getScriptParsedStatus: vi.fn(() => ({ status: 'idle', activeModal: null, messages: [] })),
    getPartialResponse: vi.fn(() => ''),
    shutdown: vi.fn(),
    cancel: vi.fn(),
    isProcessing: vi.fn(() => false),
    isReady: vi.fn(() => true),
    setOnStatusChange: vi.fn(),
  }
  return { adapter, sendMessage }
}

// Build a manager hosting two same-cliType sessions: a base node and a cloned
// worktree node, mirroring a single daemon (same daemonId) with both nodes live.
const WORKTREE_DIR = 'D:/gh/.adhdev-worktrees/adhdev/wt-1'

function createDualNodeManager(opts: {
  baseNodeId?: string
  worktreeNodeId?: string
  includeWorktree?: boolean
  // When true, the worktree session carries NO bound node id (detached) so only
  // the workspace signal can identify it.
  worktreeDetached?: boolean
} = {}) {
  const baseNodeId = opts.baseNodeId ?? 'node_base'
  const worktreeNodeId = opts.worktreeNodeId ?? 'node_worktree'
  const includeWorktree = opts.includeWorktree ?? true

  const base = makeAdapter('D:/gh/adhdev-cloud')
  const worktree = makeAdapter(WORKTREE_DIR)

  const settingsBySession: Record<string, Record<string, unknown>> = {
    'sess-base': { meshNodeFor: 'mesh-1', meshNodeId: baseNodeId },
  }
  if (includeWorktree) {
    settingsBySession['sess-worktree'] = opts.worktreeDetached
      ? { launchedByCoordinator: true } // detached: no meshNodeId/meshLastNodeId
      : { meshNodeFor: 'mesh-1', meshNodeId: worktreeNodeId }
  }

  const instanceManager = {
    getInstance: (key: string) => {
      const settings = settingsBySession[key]
      return settings ? { getState: () => ({ settings }) } : undefined
    },
    attachMeshAssignmentToInstance: vi.fn(() => true),
  }

  const manager = new DaemonCliManager({
    getServerConn: () => null,
    getP2p: () => null,
    onStatusChange: vi.fn(),
    removeAgentTracking: vi.fn(),
    getInstanceManager: () => instanceManager as any,
  }, {
    resolve: vi.fn(() => ({ type: 'hermes-cli', category: 'cli' })),
    getMeta: vi.fn(() => ({ type: 'hermes-cli', category: 'cli' })),
  } as any)

  // Insertion order: base first, so a provider-only fuzzy match would pick base.
  manager.adapters.set('sess-base', base.adapter as any)
  if (includeWorktree) manager.adapters.set('sess-worktree', worktree.adapter as any)

  return { manager, base, worktree, baseNodeId, worktreeNodeId }
}

describe('DaemonCliManager mesh node-scoped agent_command', () => {
  it('routes a worktree-targeted sessionless dispatch to the worktree session, NOT base (by meshNodeId)', async () => {
    const { manager, base, worktree, worktreeNodeId } = createDualNodeManager()

    const result = await manager.handleCliCommand('agent_command', {
      agentType: 'hermes-cli',
      cliType: 'hermes-cli',
      action: 'send_chat',
      message: 'worktree work',
      // No targetSessionId — the coordinator could not pre-resolve one.
      meshContext: { meshId: 'mesh-1', nodeId: worktreeNodeId },
    })

    expect(result).toMatchObject({ success: true })
    expect(worktree.sendMessage).toHaveBeenCalledWith('worktree work')
    expect(base.sendMessage).not.toHaveBeenCalled()
  })

  it('routes by node workspace when meshNodeId is absent (detached worktree session)', async () => {
    const { manager, base, worktree, worktreeNodeId } = createDualNodeManager({ worktreeDetached: true })

    const result = await manager.handleCliCommand('agent_command', {
      agentType: 'hermes-cli',
      cliType: 'hermes-cli',
      action: 'send_chat',
      message: 'worktree work via workspace',
      dir: WORKTREE_DIR,
      meshContext: { meshId: 'mesh-1', nodeId: worktreeNodeId },
    })

    expect(result).toMatchObject({ success: true })
    expect(worktree.sendMessage).toHaveBeenCalledWith('worktree work via workspace')
    expect(base.sendMessage).not.toHaveBeenCalled()
  })

  it('fails closed (no base auto-pick) when the worktree session is not present on this daemon', async () => {
    const { manager, base, worktreeNodeId } = createDualNodeManager({ includeWorktree: false })

    await expect(manager.handleCliCommand('agent_command', {
      agentType: 'hermes-cli',
      cliType: 'hermes-cli',
      action: 'send_chat',
      message: 'must NOT land on base',
      meshContext: { meshId: 'mesh-1', nodeId: worktreeNodeId },
    })).rejects.toThrow(/No mesh worker session bound to node/)

    expect(base.sendMessage).not.toHaveBeenCalled()
  })

  it('same-node dispatch still resolves the base session (no over-correction)', async () => {
    const { manager, base, worktree, baseNodeId } = createDualNodeManager()

    const result = await manager.handleCliCommand('agent_command', {
      agentType: 'hermes-cli',
      cliType: 'hermes-cli',
      action: 'send_chat',
      message: 'base work',
      meshContext: { meshId: 'mesh-1', nodeId: baseNodeId },
    })

    expect(result).toMatchObject({ success: true })
    expect(base.sendMessage).toHaveBeenCalledWith('base work')
    expect(worktree.sendMessage).not.toHaveBeenCalled()
  })

  it('an explicit targetSessionId is honored even with meshContext.nodeId present', async () => {
    const { manager, base, worktree, worktreeNodeId } = createDualNodeManager()

    const result = await manager.handleCliCommand('agent_command', {
      targetSessionId: 'sess-base',
      agentType: 'hermes-cli',
      cliType: 'hermes-cli',
      action: 'send_chat',
      message: 'explicit base',
      meshContext: { meshId: 'mesh-1', nodeId: worktreeNodeId },
    })

    expect(result).toMatchObject({ success: true })
    expect(base.sendMessage).toHaveBeenCalledWith('explicit base')
    expect(worktree.sendMessage).not.toHaveBeenCalled()
  })

  it('non-mesh sessionless dispatch keeps the provider fuzzy fallback (no regression)', async () => {
    // No meshContext at all → original findAdapter behavior (single-session fuzzy).
    const base = makeAdapter('D:/repo')
    const manager = new DaemonCliManager({
      getServerConn: () => null,
      getP2p: () => null,
      onStatusChange: vi.fn(),
      removeAgentTracking: vi.fn(),
      getInstanceManager: () => null,
    }, {
      resolve: vi.fn(() => ({ type: 'hermes-cli', category: 'cli' })),
      getMeta: vi.fn(() => ({ type: 'hermes-cli', category: 'cli' })),
    } as any)
    manager.adapters.set('sess-1', base.adapter as any)

    const result = await manager.handleCliCommand('agent_command', {
      agentType: 'hermes-cli',
      cliType: 'hermes-cli',
      action: 'send_chat',
      message: 'plain task',
    })

    expect(result).toMatchObject({ success: true })
    expect(base.sendMessage).toHaveBeenCalledWith('plain task')
  })
})
