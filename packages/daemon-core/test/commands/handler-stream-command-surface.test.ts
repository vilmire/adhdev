import { describe, expect, it, vi } from 'vitest'
import { DaemonCommandHandler } from '../../src/commands/handler.js'

describe('DaemonCommandHandler stream command surface', () => {
  it('keeps select_session and open_panel but drops the legacy focus_session command', async () => {
    const selectSession = vi.fn(async () => true)
    const openSessionPanel = vi.fn(async () => true)
    const handler = new DaemonCommandHandler({
      cdpManagers: new Map([['ide:test', { isConnected: true } as any]]),
      ideType: 'ide:test',
      adapters: new Map(),
      sessionRegistry: {
        get(sessionId: string) {
          if (sessionId !== 'child-1') return undefined
          return {
            sessionId,
            providerType: 'claude-code-vscode',
            cdpManagerKey: 'ide:test',
          }
        },
      } as any,
    })
    handler.setAgentStreamManager({
      selectSession,
      openSessionPanel,
      focusSession: vi.fn(async () => true),
    } as any)

    await expect(handler.handle('select_session', { targetSessionId: 'child-1' })).resolves.toEqual({ success: true })
    await expect(handler.handle('open_panel', { targetSessionId: 'child-1' })).resolves.toEqual({ success: true })
    await expect(handler.handle('focus_session', {})).resolves.toEqual({
      success: false,
      error: 'Unknown command: focus_session',
    })

    expect(selectSession).toHaveBeenCalledTimes(1)
    expect(openSessionPanel).toHaveBeenCalledTimes(1)
  })
})
