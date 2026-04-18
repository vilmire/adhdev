import { describe, expect, it, vi } from 'vitest'
import { handleProviderScript } from '../../src/commands/stream-commands.js'

describe('handleProviderScript target-session routing', () => {
  it('prefers the explicit target session provider over the current parent session', async () => {
    const evaluateInSessionFrame = vi.fn(async () => JSON.stringify({ options: [{ value: 'opus', label: 'opus' }], currentValue: 'opus' }))
    const evaluate = vi.fn(async () => JSON.stringify({ options: [], currentValue: '' }))
    const setActiveSession = vi.fn(async () => undefined)
    const syncActiveSession = vi.fn(async () => undefined)

    const helpers: any = {
      currentSession: {
        sessionId: 'parent-ide',
        providerType: 'antigravity',
        parentSessionId: null,
        cdpManagerKey: 'antigravity',
      },
      currentProviderType: 'antigravity',
      currentManagerKey: 'antigravity',
      agentStream: {
        setActiveSession,
        syncActiveSession,
        getManagedSession: vi.fn(() => ({ cdpSessionId: 'frame-claude' })),
      },
      ctx: {
        providerLoader: {
          resolve: vi.fn((type: string) => {
            if (type !== 'claude-code-vscode') return null
            return {
              type: 'claude-code-vscode',
              category: 'extension',
              scripts: {
                listModels: () => '(() => "ok")()',
              },
            }
          }),
        },
        sessionRegistry: {
          get: vi.fn((sessionId: string) => {
            if (sessionId === 'claude-child') {
              return {
                sessionId,
                parentSessionId: 'parent-ide',
                providerType: 'claude-code-vscode',
                transport: 'cdp-webview',
                cdpManagerKey: 'antigravity',
                instanceKey: 'ide:antigravity',
              }
            }
            if (sessionId === 'parent-ide') {
              return {
                sessionId,
                parentSessionId: null,
                providerType: 'antigravity',
                transport: 'cdp-page',
                cdpManagerKey: 'antigravity',
                instanceKey: 'ide:antigravity',
              }
            }
            return undefined
          }),
        },
        instanceManager: {
          sendEvent: vi.fn(),
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

    const result = await handleProviderScript(helpers, {
      targetSessionId: 'claude-child',
      scriptName: 'listModels',
    })

    expect(helpers.ctx.providerLoader.resolve).toHaveBeenCalledWith('claude-code-vscode')
    expect(setActiveSession).toHaveBeenCalledWith(expect.anything(), 'parent-ide', 'claude-child')
    expect(syncActiveSession).toHaveBeenCalledWith(expect.anything(), 'parent-ide')
    expect(result).toMatchObject({
      success: true,
      currentValue: 'opus',
      controlResult: {
        currentValue: 'opus',
        options: [{ value: 'opus', label: 'opus' }],
      },
    })
  })
})
