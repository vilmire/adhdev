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

  it('fails closed when action mapping cannot identify a matching button', async () => {
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

    expect(result).toEqual({ success: false, error: 'Approval action did not match any visible button' })
    expect(resolveModal).not.toHaveBeenCalled()
  })
})
