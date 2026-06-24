import { describe, expect, it } from 'vitest'

import { evaluateReadChatNodeWorkspaceScope, handleReadChat } from '../../src/commands/chat-commands.js'

describe('evaluateReadChatNodeWorkspaceScope', () => {
  it('blocks a confirmed cross-worktree read (session workspace ≠ requested node workspace)', () => {
    const verdict = evaluateReadChatNodeWorkspaceScope({
      targetSessionId: 's-A',
      intendedWorkspace: 'D:\\gh\\wt\\fix-B',
      sessionWorkspace: 'D:\\gh\\wt\\fix-A',
    })
    expect(verdict.scoped).toBe(true)
  })

  it('allows a same-workspace read regardless of separator/case skew (no false block)', () => {
    const verdict = evaluateReadChatNodeWorkspaceScope({
      targetSessionId: 's-A',
      intendedWorkspace: 'D:\\GH\\WT\\FIX-A\\',
      sessionWorkspace: 'D:/gh/wt/fix-A',
    })
    expect(verdict.scoped).toBe(false)
  })

  it('does not block when either workspace is unknown (conservative WTCLAIM rule)', () => {
    expect(evaluateReadChatNodeWorkspaceScope({ targetSessionId: 's-A', intendedWorkspace: 'D:\\gh\\wt\\fix-A', sessionWorkspace: '' }).scoped).toBe(false)
    expect(evaluateReadChatNodeWorkspaceScope({ targetSessionId: 's-A', intendedWorkspace: '', sessionWorkspace: 'D:\\gh\\wt\\fix-A' }).scoped).toBe(false)
    expect(evaluateReadChatNodeWorkspaceScope({ targetSessionId: '', intendedWorkspace: 'D:\\a', sessionWorkspace: 'D:\\b' }).scoped).toBe(false)
  })
})

function helpersWithSessionWorkspace(sessionId: string, workspace: string) {
  return {
    getCdp: () => null,
    getProvider: () => undefined,
    getProviderScript: () => null,
    evaluateProviderScript: async () => null,
    getCliAdapter: () => null,
    currentManagerKey: undefined,
    currentIdeType: undefined,
    currentProviderType: undefined,
    currentSession: undefined,
    agentStream: null,
    ctx: {
      instanceManager: { getInstance: () => null },
      sessionRegistry: {
        get: (id: string) => id === sessionId
          ? { sessionId, providerType: 'codex-cli', transport: 'pty', workspace }
          : undefined,
      },
    },
    historyWriter: { appendNewMessages: () => {} },
  }
}

describe('handleReadChat node workspace scope guard', () => {
  it('refuses a cross-worktree transcript when the session lives in another workspace', async () => {
    // The coordinator scoped the read to worktree B, but session s-A actually lives
    // in worktree A on the same physical daemon. Returning A's transcript (or
    // splicing sibling worktree turns) is the exact bug this guards.
    const result = await handleReadChat(helpersWithSessionWorkspace('s-A', 'D:\\gh\\wt\\fix-A') as any, {
      targetSessionId: 's-A',
      workspace: 'D:\\gh\\wt\\fix-B',
      tailLimit: 20,
    })
    expect(result.success).toBe(false)
    expect((result as any).code).toBe('read_chat_session_node_scope_mismatch')
  })

  it('does not block when the requested node workspace matches the session workspace', async () => {
    const result = await handleReadChat(helpersWithSessionWorkspace('s-A', 'D:\\gh\\wt\\fix-A') as any, {
      targetSessionId: 's-A',
      workspace: 'D:/gh/wt/fix-A',
      tailLimit: 20,
    })
    expect((result as any).code).not.toBe('read_chat_session_node_scope_mismatch')
  })

  it('does not block a base-node read that passes no node workspace (regression guard)', async () => {
    const result = await handleReadChat(helpersWithSessionWorkspace('s-base', 'D:\\gh\\base') as any, {
      targetSessionId: 's-base',
      tailLimit: 20,
    })
    expect((result as any).code).not.toBe('read_chat_session_node_scope_mismatch')
  })
})
