import { describe, expect, it, vi } from 'vitest'
import { handleProviderScript } from '../../src/commands/stream-commands.js'

describe('handleProviderScript claude-code-vscode IDE-level control routing', () => {
  function createHelpers(params: {
    scriptName: string
    sessionFrameResult: string
    mainPageResult: string
  }) {
    const provider = {
      type: 'claude-code-vscode',
      category: 'extension',
      scripts: {
        [params.scriptName]: () => '(() => "ok")()'
      },
    }

    const evaluateInSessionFrame = vi.fn(async () => params.sessionFrameResult)
    const evaluate = vi.fn(async () => params.mainPageResult)
    const setActiveSession = vi.fn(async () => undefined)
    const syncActiveSession = vi.fn(async () => undefined)
    const sendEvent = vi.fn()

    const helpers: any = {
      currentSession: {
        sessionId: 'child-1',
        providerType: 'claude-code-vscode',
        parentSessionId: 'parent-1',
      },
      currentProviderType: 'claude-code-vscode',
      currentManagerKey: 'ide:test',
      currentIdeType: 'ide:test',
      agentStream: {
        setActiveSession,
        syncActiveSession,
        getManagedSession: vi.fn(() => ({ cdpSessionId: 'frame-1' })),
      },
      ctx: {
        providerLoader: {
          resolve: vi.fn(() => provider),
        },
        sessionRegistry: {
          get: vi.fn((sessionId: string) => sessionId === 'child-1'
            ? {
                sessionId,
                instanceKey: 'child-1',
                transport: 'cdp-webview',
                providerType: 'claude-code-vscode',
              }
            : undefined),
        },
        instanceManager: {
          sendEvent,
        },
      },
      getCdp: vi.fn(() => ({
        isConnected: true,
        evaluateInSessionFrame,
        evaluate,
      })),
      getProvider: vi.fn(),
      getProviderScript: vi.fn(),
      evaluateProviderScript: vi.fn(),
      getCliAdapter: vi.fn(() => null),
      historyWriter: {},
    }

    return { helpers, evaluateInSessionFrame, evaluate, setActiveSession, syncActiveSession, sendEvent }
  }

  it('falls back to the IDE main page for listModels when the session frame reports not found', async () => {
    const { helpers, evaluateInSessionFrame, evaluate, setActiveSession, syncActiveSession, sendEvent } = createHelpers({
      scriptName: 'listModels',
      sessionFrameResult: JSON.stringify({ ok: false, error: 'model selector not found' }),
      mainPageResult: JSON.stringify({
        options: [{ value: 'Claude Sonnet 4.6 (Thinking)', label: 'Claude Sonnet 4.6 (Thinking)' }],
        currentValue: 'Claude Sonnet 4.6 (Thinking)',
      }),
    })

    const result = await handleProviderScript(helpers, {
      targetSessionId: 'child-1',
      scriptName: 'listModels',
    })

    expect(setActiveSession).toHaveBeenCalledWith(expect.anything(), 'parent-1', 'child-1')
    expect(syncActiveSession).toHaveBeenCalledWith(expect.anything(), 'parent-1')
    expect(evaluateInSessionFrame).toHaveBeenCalledTimes(1)
    expect(evaluate).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      success: true,
      options: [{ value: 'Claude Sonnet 4.6 (Thinking)', label: 'Claude Sonnet 4.6 (Thinking)' }],
      currentValue: 'Claude Sonnet 4.6 (Thinking)',
      controlResult: {
        options: [{ value: 'Claude Sonnet 4.6 (Thinking)', label: 'Claude Sonnet 4.6 (Thinking)' }],
        currentValue: 'Claude Sonnet 4.6 (Thinking)',
      },
    })
    expect(sendEvent).toHaveBeenCalledWith('child-1', 'provider_state_patch', expect.objectContaining({
      currentValue: 'Claude Sonnet 4.6 (Thinking)',
      extensionType: 'claude-code-vscode',
    }))
  })

  it('keeps requestUsage on the session-frame path instead of falling back to the IDE main page', async () => {
    const { helpers, evaluateInSessionFrame, evaluate } = createHelpers({
      scriptName: 'requestUsage',
      sessionFrameResult: JSON.stringify({
        ok: true,
        effects: [{
          type: 'message',
          persist: true,
          message: {
            role: 'system',
            senderName: 'Usage',
            content: 'Usage\nPro',
            kind: 'system',
          },
        }],
      }),
      mainPageResult: JSON.stringify({ ok: false, error: 'should not hit main page' }),
    })

    const result = await handleProviderScript(helpers, {
      targetSessionId: 'child-1',
      scriptName: 'requestUsage',
    })

    expect(evaluateInSessionFrame).toHaveBeenCalledTimes(1)
    expect(evaluate).toHaveBeenCalledTimes(0)
    expect(result).toMatchObject({
      success: true,
      ok: true,
      controlResult: {
        ok: true,
        effects: [{
          type: 'message',
          persist: true,
          message: {
            role: 'system',
            senderName: 'Usage',
            content: 'Usage\nPro',
            kind: 'system',
          },
        }],
      },
    })
  })
})
