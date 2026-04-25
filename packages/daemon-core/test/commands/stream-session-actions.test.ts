import { describe, expect, it, vi } from 'vitest'
import { handleOpenPanel, handlePtyInput, handlePtyResize, handleSelectSession } from '../../src/commands/stream-commands.js'

describe('stream session action commands', () => {
  it('select_session activates the target stream session without routing through focusSession', async () => {
    const selectSession = vi.fn(async () => true)
    const focusSession = vi.fn(async () => true)
    const cdp = { name: 'cdp' }

    const result = await handleSelectSession({
      agentStream: { selectSession, focusSession },
      getCdp: () => cdp,
      currentSession: undefined,
    } as any, {
      targetSessionId: 'child-1',
    })

    expect(result).toEqual({ success: true })
    expect(selectSession).toHaveBeenCalledWith(cdp, 'child-1')
    expect(focusSession).not.toHaveBeenCalled()
  })

  it('open_panel delegates to explicit panel reveal handling instead of focus_session', async () => {
    const openSessionPanel = vi.fn(async () => true)
    const focusSession = vi.fn(async () => true)
    const cdp = { name: 'cdp' }

    const result = await handleOpenPanel({
      agentStream: { openSessionPanel, focusSession },
      getCdp: () => cdp,
      currentSession: undefined,
    } as any, {
      targetSessionId: 'child-2',
    })

    expect(result).toEqual({ success: true })
    expect(openSessionPanel).toHaveBeenCalledWith(cdp, 'child-2')
    expect(focusSession).not.toHaveBeenCalled()
  })

  it('open_panel falls back to provider scripts for native IDE sessions with explicit openPanel support', async () => {
    const cdp = {
      isConnected: true,
      evaluate: vi
        .fn(async (_script: string) => JSON.stringify({ opened: true, visible: true }))
        .mockImplementationOnce(async (_script: string) => JSON.stringify({ opened: true, visible: true }))
        .mockImplementationOnce(async (_script: string) => JSON.stringify({ focused: true })),
    }
    const providerLoader = {
      resolve: vi.fn(() => ({
        type: 'cursor',
        name: 'Cursor',
        category: 'ide',
        scripts: {
          openPanel: () => '(() => JSON.stringify({ opened: true, visible: true }))()',
          focusEditor: () => '(() => JSON.stringify({ focused: true }))()',
        },
      })),
    }

    const result = await handleOpenPanel({
      agentStream: null,
      getCdp: () => cdp,
      currentManagerKey: 'ide:test',
      currentIdeType: 'ide:test',
      currentProviderType: 'cursor',
      currentSession: {
        sessionId: 'ide-1',
        providerType: 'cursor',
        cdpManagerKey: 'ide:test',
        transport: 'cdp-page',
      },
      ctx: {
        providerLoader,
      },
      getCliAdapter: () => null,
    } as any, {
      targetSessionId: 'ide-1',
    })

    expect(result).toMatchObject({ success: true })
    expect(providerLoader.resolve).toHaveBeenCalledWith('cursor')
    expect(cdp.evaluate).toHaveBeenCalledTimes(2)
  })

  it('pty_input allows direct terminal intervention even when the CLI session is currently in chat mode', async () => {
    const writeRaw = vi.fn()
    const result = await handlePtyInput({
      getCliAdapter: vi.fn(() => ({ writeRaw })),
      ctx: { instanceManager: { getInstance: () => ({ category: 'cli', getPresentationMode: () => 'chat' }) } },
    } as any, {
      targetSessionId: 'cli-1',
      data: 'x',
    })

    expect(result).toEqual({ success: true })
    expect(writeRaw).toHaveBeenCalledWith('x')
  })

  it('pty_resize is temporarily disabled even when the CLI session is in chat mode', () => {
    const resize = vi.fn()
    const result = handlePtyResize({
      getCliAdapter: vi.fn(() => ({ resize })),
      ctx: { instanceManager: { getInstance: () => ({ category: 'cli', getPresentationMode: () => 'chat' }) } },
    } as any, {
      targetSessionId: 'cli-1',
      cols: 100,
      rows: 30,
    })

    expect(result).toEqual({ success: false, error: 'PTY resize temporarily disabled', code: 'PTY_RESIZE_DISABLED' })
    expect(resize).not.toHaveBeenCalled()
  })
})
