import { describe, expect, it, vi } from 'vitest'
import { handleResolveAction } from '../../src/commands/chat-commands.js'

describe('handleResolveAction for CLI approval state', () => {
  it('allows resolve_action when provider state exposes actionable approval buttons even if adapter status still says generating', async () => {
    const resolveModal = vi.fn()
    const adapter = {
      getStatus: () => ({
        status: 'generating',
        messages: [],
        activeModal: null,
      }),
      resolveModal,
      writeRaw: vi.fn(),
    }

    const result = await handleResolveAction({
      getProvider: () => ({ type: 'hermes-cli', category: 'cli' }),
      getCliAdapter: () => adapter as any,
      getCdp: () => null,
      getProviderScript: () => null,
      evaluateProviderScript: async () => null,
      currentSession: { transport: 'pty', providerType: 'hermes-cli', sessionId: 'sess-1' },
      currentProviderType: 'hermes-cli',
      currentManagerKey: undefined,
      agentStream: null,
      ctx: {
        instanceManager: {
          getInstance: () => ({
            getState: () => ({
              activeChat: {
                status: 'generating',
                activeModal: {
                  message: 'Dangerous command needs approval',
                  buttons: ['Allow once', 'Allow for this session', 'Add to permanent allowlist', 'Deny'],
                },
              },
            }),
          }),
        },
      },
    } as any, {
      targetSessionId: 'sess-1',
      agentType: 'hermes-cli',
      action: 'deny',
    })

    expect(result).toEqual({ success: true, buttonIndex: 3, button: 'Deny' })
    expect(resolveModal).toHaveBeenCalledWith(3)
  })

  it('uses parsed waiting_approval modal as a conservative fallback when surfaced status has no modal', async () => {
    const resolveModal = vi.fn()
    const adapter = {
      getStatus: () => ({
        status: 'idle',
        messages: [],
        activeModal: null,
      }),
      getScriptParsedStatus: () => ({
        status: 'waiting_approval',
        messages: [],
        activeModal: {
          message: 'Dangerous command needs approval',
          buttons: ['Allow once', 'Deny'],
        },
      }),
      resolveModal,
      writeRaw: vi.fn(),
    }

    const result = await handleResolveAction({
      getProvider: () => ({ type: 'hermes-cli', category: 'cli' }),
      getCliAdapter: () => adapter as any,
      getCdp: () => null,
      getProviderScript: () => null,
      evaluateProviderScript: async () => null,
      currentSession: { transport: 'pty', providerType: 'hermes-cli', sessionId: 'sess-1' },
      currentProviderType: 'hermes-cli',
      currentManagerKey: undefined,
      agentStream: null,
      ctx: { instanceManager: { getInstance: () => null } },
    } as any, {
      targetSessionId: 'sess-1',
      agentType: 'hermes-cli',
      action: 'deny',
    })

    expect(result).toEqual({ success: true, buttonIndex: 1, button: 'Deny' })
    expect(resolveModal).toHaveBeenCalledWith(1)
  })

  it('maps generic approve actions to the provider-positive button hints', async () => {
    const resolveModal = vi.fn()
    const adapter = {
      getStatus: () => ({
        status: 'waiting_approval',
        messages: [],
        activeModal: {
          message: 'Do you want to proceed?',
          buttons: ['Yes', "Yes, don't ask again for this command", 'No, and tell agy what to do differently'],
        },
      }),
      resolveModal,
      writeRaw: vi.fn(),
    }

    const result = await handleResolveAction({
      getProvider: () => ({ type: 'antigravity-cli', category: 'cli' }),
      getCliAdapter: () => adapter as any,
      getCdp: () => null,
      getProviderScript: () => null,
      evaluateProviderScript: async () => null,
      currentSession: { transport: 'pty', providerType: 'antigravity-cli', sessionId: 'sess-1' },
      currentProviderType: 'antigravity-cli',
      currentManagerKey: undefined,
      agentStream: null,
      ctx: { instanceManager: { getInstance: () => null } },
    } as any, {
      targetSessionId: 'sess-1',
      agentType: 'antigravity-cli',
      action: 'approve',
    })

    expect(result).toEqual({ success: true, buttonIndex: 0, button: 'Yes' })
    expect(resolveModal).toHaveBeenCalledWith(0)
  })

  it('maps generic approve to the visible positive choice when later choices are negative variants', async () => {
    const resolveModal = vi.fn()
    const adapter = {
      getStatus: () => ({
        status: 'waiting_approval',
        messages: [],
        activeModal: {
          message: 'Do you want to proceed?',
          buttons: ['Yes', 'No', 'No, and tell agy what to do differently', 'No, and stop asking for this command'],
        },
      }),
      resolveModal,
      writeRaw: vi.fn(),
    }

    const result = await handleResolveAction({
      getProvider: () => ({ type: 'antigravity-cli', category: 'cli', approvalPositiveHints: ['yes', 'continue'] }),
      getCliAdapter: () => adapter as any,
      getCdp: () => null,
      getProviderScript: () => null,
      evaluateProviderScript: async () => null,
      currentSession: { transport: 'pty', providerType: 'antigravity-cli', sessionId: 'sess-1' },
      currentProviderType: 'antigravity-cli',
      currentManagerKey: undefined,
      agentStream: null,
      ctx: { instanceManager: { getInstance: () => null } },
    } as any, {
      targetSessionId: 'sess-1',
      agentType: 'antigravity-cli',
      action: 'approve',
    })

    expect(result).toEqual({ success: true, buttonIndex: 0, button: 'Yes' })
    expect(resolveModal).toHaveBeenCalledWith(0)
  })

  it('fails closed instead of approving a non-approval prompt with no positive visible choice', async () => {
    const resolveModal = vi.fn()
    const adapter = {
      getStatus: () => ({
        status: 'waiting_approval',
        messages: [],
        activeModal: {
          message: "How's the CLI experience so far?",
          buttons: ['Good', 'Fine', 'Bad', 'Skip'],
        },
      }),
      resolveModal,
      writeRaw: vi.fn(),
    }

    const result = await handleResolveAction({
      getProvider: () => ({ type: 'antigravity-cli', category: 'cli', approvalPositiveHints: ['yes', 'continue'] }),
      getCliAdapter: () => adapter as any,
      getCdp: () => null,
      getProviderScript: () => null,
      evaluateProviderScript: async () => null,
      currentSession: { transport: 'pty', providerType: 'antigravity-cli', sessionId: 'sess-1' },
      currentProviderType: 'antigravity-cli',
      currentManagerKey: undefined,
      agentStream: null,
      ctx: { instanceManager: { getInstance: () => null } },
    } as any, {
      targetSessionId: 'sess-1',
      agentType: 'antigravity-cli',
      action: 'approve',
    })

    expect(result).toEqual({ success: false, error: 'Approval action did not match any visible button' })
    expect(resolveModal).not.toHaveBeenCalled()
  })

  it('does not treat a negative continue-without choice as approval', async () => {
    const resolveModal = vi.fn()
    const adapter = {
      getStatus: () => ({
        status: 'waiting_approval',
        messages: [],
        activeModal: {
          message: 'New MCP server found in this project: adhdev-mesh',
          buttons: [
            'Use this MCP server',
            'Use this and all future MCP servers in this project',
            'Continue without using this MCP server',
          ],
        },
      }),
      resolveModal,
      writeRaw: vi.fn(),
    }

    const result = await handleResolveAction({
      getProvider: () => ({
        type: 'claude-cli',
        category: 'cli',
        approvalPositiveHints: ['continue', 'use this mcp server', 'use this'],
      }),
      getCliAdapter: () => adapter as any,
      getCdp: () => null,
      getProviderScript: () => null,
      evaluateProviderScript: async () => null,
      currentSession: { transport: 'pty', providerType: 'claude-cli', sessionId: 'sess-1' },
      currentProviderType: 'claude-cli',
      currentManagerKey: undefined,
      agentStream: null,
      ctx: { instanceManager: { getInstance: () => null } },
    } as any, {
      targetSessionId: 'sess-1',
      agentType: 'claude-cli',
      action: 'approve',
    })

    expect(result).toEqual({ success: true, buttonIndex: 0, button: 'Use this MCP server' })
    expect(resolveModal).toHaveBeenCalledWith(0)
  })

  it('maps Claude Code Settings Warning approve to Continue instead of Fix with Claude', async () => {
    const resolveModal = vi.fn()
    const adapter = {
      getStatus: () => ({
        status: 'waiting_approval',
        messages: [],
        activeModal: {
          message: 'Settings Warning Claude Code detected project settings that may need review.',
          buttons: ['Fix with Claude', 'Continue'],
        },
      }),
      resolveModal,
      writeRaw: vi.fn(),
    }

    const result = await handleResolveAction({
      getProvider: () => ({
        type: 'claude-cli',
        category: 'cli',
        approvalPositiveHints: ['yes', 'allow once', 'approve', 'accept', 'use this mcp server', 'use this', 'trust', 'continue', 'run', 'proceed', 'confirm', 'allow', 'always allow'],
      }),
      getCliAdapter: () => adapter as any,
      getCdp: () => null,
      getProviderScript: () => null,
      evaluateProviderScript: async () => null,
      currentSession: { transport: 'pty', providerType: 'claude-cli', sessionId: 'sess-1' },
      currentProviderType: 'claude-cli',
      currentManagerKey: undefined,
      agentStream: null,
      ctx: { instanceManager: { getInstance: () => null } },
    } as any, {
      targetSessionId: 'sess-1',
      agentType: 'claude-cli',
      action: 'approve',
    })

    expect(result).toEqual({ success: true, buttonIndex: 1, button: 'Continue' })
    expect(resolveModal).toHaveBeenCalledWith(1)
  })

  it('does not map Claude Code Settings Warning reject to Fix with Claude', async () => {
    const resolveModal = vi.fn()
    const adapter = {
      getStatus: () => ({
        status: 'waiting_approval',
        messages: [],
        activeModal: {
          message: 'Settings Warning Claude Code detected project settings that may need review.',
          buttons: ['Fix with Claude', 'Continue'],
        },
      }),
      resolveModal,
      writeRaw: vi.fn(),
    }

    const result = await handleResolveAction({
      getProvider: () => ({
        type: 'claude-cli',
        category: 'cli',
        approvalPositiveHints: ['continue'],
      }),
      getCliAdapter: () => adapter as any,
      getCdp: () => null,
      getProviderScript: () => null,
      evaluateProviderScript: async () => null,
      currentSession: { transport: 'pty', providerType: 'claude-cli', sessionId: 'sess-1' },
      currentProviderType: 'claude-cli',
      currentManagerKey: undefined,
      agentStream: null,
      ctx: { instanceManager: { getInstance: () => null } },
    } as any, {
      targetSessionId: 'sess-1',
      agentType: 'claude-cli',
      action: 'reject',
    })

    expect(result).toEqual({ success: false, error: 'Approval action did not match any visible button' })
    expect(resolveModal).not.toHaveBeenCalled()
  })

  it('returns stale_prompt without calling resolveModal when adapter reports recently resolved', async () => {
    const resolveModal = vi.fn()
    const adapter = {
      getStatus: () => ({
        status: 'waiting_approval',
        messages: [],
        activeModal: {
          message: 'Do you want to proceed?',
          buttons: ['Yes', 'No'],
        },
      }),
      resolveModal,
      isApprovalRecentlyResolved: () => true,
      writeRaw: vi.fn(),
    }

    const result = await handleResolveAction({
      getProvider: () => ({ type: 'claude-cli', category: 'cli' }),
      getCliAdapter: () => adapter as any,
      getCdp: () => null,
      getProviderScript: () => null,
      evaluateProviderScript: async () => null,
      currentSession: { transport: 'pty', providerType: 'claude-cli', sessionId: 'sess-1' },
      currentProviderType: 'claude-cli',
      currentManagerKey: undefined,
      agentStream: null,
      ctx: { instanceManager: { getInstance: () => null } },
    } as any, {
      targetSessionId: 'sess-1',
      agentType: 'claude-cli',
      action: 'approve',
    })

    // Must not write a second key to PTY; result indicates stale prompt
    expect(result.success).toBe(true)
    expect((result as any).stalePrompt).toBe(true)
    expect(resolveModal).not.toHaveBeenCalled()
  })

  it('does not send a second approval key when called twice in rapid succession for same prompt', async () => {
    const resolveModal = vi.fn()
    let alreadyResolved = false
    const adapter = {
      getStatus: () => ({
        status: 'waiting_approval',
        messages: [],
        activeModal: {
          message: 'Allow npm run build?',
          buttons: ['Yes', 'No'],
        },
      }),
      resolveModal: vi.fn((_index: number) => {
        alreadyResolved = true
      }),
      isApprovalRecentlyResolved: () => alreadyResolved,
      writeRaw: vi.fn(),
    }

    const helpers = {
      getProvider: () => ({ type: 'claude-cli', category: 'cli' }),
      getCliAdapter: () => adapter as any,
      getCdp: () => null,
      getProviderScript: () => null,
      evaluateProviderScript: async () => null,
      currentSession: { transport: 'pty', providerType: 'claude-cli', sessionId: 'sess-2' },
      currentProviderType: 'claude-cli',
      currentManagerKey: undefined,
      agentStream: null,
      ctx: { instanceManager: { getInstance: () => null } },
    } as any
    const args = { targetSessionId: 'sess-2', agentType: 'claude-cli', action: 'approve' }

    const first = await handleResolveAction(helpers, args)
    const second = await handleResolveAction(helpers, args)

    expect(first.success).toBe(true)
    expect((first as any).stalePrompt).toBeUndefined()
    expect(adapter.resolveModal).toHaveBeenCalledTimes(1)

    expect(second.success).toBe(true)
    expect((second as any).stalePrompt).toBe(true)
    // resolveModal must not be called a second time
    expect(adapter.resolveModal).toHaveBeenCalledTimes(1)
  })

  // APPROVAL Defect-B (live re-probe race): the modal is gone because the worker already
  // resolved this approval (delegated auto-approve fired) just before the coordinator's
  // approve landed. That benign race must return a SOFT already_resolved, not a hard fail.
  it('returns soft already_resolved when the modal is gone but the adapter recently resolved it', async () => {
    const resolveModal = vi.fn()
    const adapter = {
      getStatus: () => ({ status: 'idle', messages: [], activeModal: null }),
      resolveModal,
      isApprovalRecentlyResolved: () => true,
      writeRaw: vi.fn(),
    }

    const result = await handleResolveAction({
      getProvider: () => ({ type: 'claude-cli', category: 'cli' }),
      getCliAdapter: () => adapter as any,
      getCdp: () => null,
      getProviderScript: () => null,
      evaluateProviderScript: async () => null,
      currentSession: { transport: 'pty', providerType: 'claude-cli', sessionId: 'sess-1' },
      currentProviderType: 'claude-cli',
      currentManagerKey: undefined,
      agentStream: null,
      ctx: { instanceManager: { getInstance: () => null } },
    } as any, {
      targetSessionId: 'sess-1',
      agentType: 'claude-cli',
      action: 'approve',
    })

    expect(result).toEqual({ success: true, alreadyResolved: true, status: 'already_resolved' })
    expect(resolveModal).not.toHaveBeenCalled()
  })

  it('still hard-fails Not in approval state when no modal and nothing was recently resolved', async () => {
    const resolveModal = vi.fn()
    const adapter = {
      getStatus: () => ({ status: 'idle', messages: [], activeModal: null }),
      resolveModal,
      isApprovalRecentlyResolved: () => false,
      writeRaw: vi.fn(),
    }

    const result = await handleResolveAction({
      getProvider: () => ({ type: 'claude-cli', category: 'cli' }),
      getCliAdapter: () => adapter as any,
      getCdp: () => null,
      getProviderScript: () => null,
      evaluateProviderScript: async () => null,
      currentSession: { transport: 'pty', providerType: 'claude-cli', sessionId: 'sess-1' },
      currentProviderType: 'claude-cli',
      currentManagerKey: undefined,
      agentStream: null,
      ctx: { instanceManager: { getInstance: () => null } },
    } as any, {
      targetSessionId: 'sess-1',
      agentType: 'claude-cli',
      action: 'approve',
    })

    expect(result).toEqual({ success: false, error: 'Not in approval state' })
    expect(resolveModal).not.toHaveBeenCalled()
  })

  it('fails closed when a deny/reject action maps to no negative-labeled button', async () => {
    // No button reads as a decline (no|deny|reject|cancel|skip|exit|stop / without / do not),
    // so a deny action must refuse rather than click an arbitrary affirmative. (A modal
    // whose decline IS spelled "Exit"/"Skip" is a legitimate match — see the cursor
    // decline coverage — so this fixture uses two affirmative-only choices.)
    const resolveModal = vi.fn()
    const adapter = {
      getStatus: () => ({
        status: 'waiting_approval',
        messages: [],
        activeModal: {
          message: 'Choose access level',
          buttons: ['Trust this workspace', 'Trust this folder'],
        },
      }),
      resolveModal,
      writeRaw: vi.fn(),
    }

    const result = await handleResolveAction({
      getProvider: () => ({ type: 'menu-cli', category: 'cli' }),
      getCliAdapter: () => adapter as any,
      getCdp: () => null,
      getProviderScript: () => null,
      evaluateProviderScript: async () => null,
      currentSession: { transport: 'pty', providerType: 'menu-cli', sessionId: 'sess-1' },
      currentProviderType: 'menu-cli',
      currentManagerKey: undefined,
      agentStream: null,
      ctx: {
        instanceManager: {
          getInstance: () => ({
            getState: () => ({
              activeChat: {
                status: 'waiting_approval',
                activeModal: {
                  message: 'Choose access level',
                  buttons: ['Trust this workspace', 'Trust this folder'],
                },
              },
            }),
          }),
        },
      },
    } as any, {
      targetSessionId: 'sess-1',
      agentType: 'menu-cli',
      action: 'deny',
    })

    expect(result).toEqual({ success: false, error: 'Approval action did not match any visible button' })
    expect(resolveModal).not.toHaveBeenCalled()
  })

  it('resolves a deny action to an "Exit" decline on a trust modal', async () => {
    // "Exit" is a canonical decline label (isNegativeApprovalLabel: no|deny|reject|
    // cancel|skip|exit|stop). Declining a "Choose access level" trust modal by pressing
    // "Exit" is the correct, least-surprising mapping — same lineage as cursor's "Skip"
    // decline (oss 2c487068). This is NOT clicking an arbitrary button.
    const resolveModal = vi.fn()
    const adapter = {
      getStatus: () => ({
        status: 'waiting_approval',
        messages: [],
        activeModal: {
          message: 'Choose access level',
          buttons: ['Trust this workspace', 'Exit'],
        },
      }),
      resolveModal,
      writeRaw: vi.fn(),
    }

    const result = await handleResolveAction({
      getProvider: () => ({ type: 'menu-cli', category: 'cli' }),
      getCliAdapter: () => adapter as any,
      getCdp: () => null,
      getProviderScript: () => null,
      evaluateProviderScript: async () => null,
      currentSession: { transport: 'pty', providerType: 'menu-cli', sessionId: 'sess-1' },
      currentProviderType: 'menu-cli',
      currentManagerKey: undefined,
      agentStream: null,
      ctx: {
        instanceManager: {
          getInstance: () => ({
            getState: () => ({
              activeChat: {
                status: 'waiting_approval',
                activeModal: {
                  message: 'Choose access level',
                  buttons: ['Trust this workspace', 'Exit'],
                },
              },
            }),
          }),
        },
      },
    } as any, {
      targetSessionId: 'sess-1',
      agentType: 'menu-cli',
      action: 'deny',
    })

    expect(result).toEqual({ success: true, buttonIndex: 1, button: 'Exit' })
    expect(resolveModal).toHaveBeenCalledWith(1)
  })
})
