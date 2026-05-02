import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildChatDebugBundleClipboardText, buildChatDebugBundleToastMessage, buildChatFrontendDebugSnapshot, copyChatDebugBundleTextToClipboard, recordControlsToggleDebugGesture } from '../../../src/components/dashboard/chat-debug-bundle'

describe('chat frontend debug bundle helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('builds a bounded frontend snapshot for the active conversation', () => {
    const snapshot = buildChatFrontendDebugSnapshot({
      activeConv: {
        routeId: 'daemon_1',
        sessionId: 'session_1',
        providerSessionId: 'ps_1',
        transport: 'pty',
        agentName: 'Hermes',
        agentType: 'hermes',
        status: 'generating',
        title: 'Task',
        messages: Array.from({ length: 8 }, (_, index) => ({ role: 'assistant', content: `message ${index}` } as any)),
        workspaceName: 'workspace',
        displayPrimary: 'Hermes',
        displaySecondary: 'workspace',
        streamSource: 'native',
        tabKey: 'tab_1',
        hostIdeType: 'cursor',
        connectionState: 'connected',
      } as any,
      visibleMessages: Array.from({ length: 8 }, (_, index) => ({ role: 'assistant', content: `visible ${index}` } as any)),
      actionLogs: [
        { routeId: 'tab_1', text: 'log 1', timestamp: 1 },
        { routeId: 'other', text: 'ignore', timestamp: 2 },
      ],
      controls: [{ id: 'model', label: 'Model', type: 'select' } as any],
      controlValues: { model: 'sonnet' },
      visibleBarControlCount: 1,
      chatTailState: {
        hasMoreHistory: true,
        historyError: 'older page failed',
        historyMessages: [{ role: 'user', content: 'old' }],
      },
      ui: {
        controlsVisible: true,
        visibleLiveCount: 5,
        hiddenLiveCount: 3,
        isInputActive: true,
        isVisible: true,
      },
      now: 123,
      locationHref: 'https://adhf.dev/dashboard?token=[REDACTED]',
    })

    expect(snapshot.activeConversation).toMatchObject({
      sessionId: 'session_1',
      providerSessionId: 'ps_1',
      transport: 'pty',
      status: 'generating',
    })
    expect(snapshot.messageCounts).toEqual({ live: 8, visible: 8, history: 1, hiddenLive: 3 })
    expect(snapshot.visibleMessagesTail).toHaveLength(5)
    expect(JSON.stringify(snapshot)).not.toContain('secret-token-1234567890')
    expect(snapshot.actionLogsTail).toHaveLength(1)
  })

  it('fires the hidden gesture only after ten toggles in the time window', () => {
    let state = undefined
    let firedAt: number | null = null
    for (let index = 0; index < 9; index += 1) {
      const result = recordControlsToggleDebugGesture(state, 1000 + index * 100)
      state = result.state
      expect(result.shouldCollect).toBe(false)
    }

    const fired = recordControlsToggleDebugGesture(state, 1900)
    state = fired.state
    firedAt = fired.shouldCollect ? 1900 : null

    expect(firedAt).toBe(1900)
    expect(state.count).toBe(0)
  })

  it('formats daemon-file delivery as a small locator instead of the full bundle body', () => {
    const text = buildChatDebugBundleClipboardText({
      delivery: 'daemon_file',
      bundleId: 'chat-debug-20260430T123456Z-session_1-abcd1234',
      savedPath: '/Users/test/.adhdev/debug-bundles/chat/chat-debug-20260430T123456Z-session_1-abcd1234.json',
      sizeBytes: 12345,
      summary: { targetSessionId: 'session_1', providerType: 'hermes', transport: 'pty' },
    })

    expect(text).toContain('ADHDev Chat Debug Bundle saved on daemon')
    expect(text).toContain('chat-debug-20260430T123456Z-session_1-abcd1234')
    expect(text).toContain('/Users/test/.adhdev/debug-bundles/chat/chat-debug-20260430T123456Z-session_1-abcd1234.json')
    expect(text).not.toContain('```json')
  })

  it('builds a user-facing sent signal message for daemon-file delivery', () => {
    const message = buildChatDebugBundleToastMessage({
      delivery: 'daemon_file',
      bundleId: 'chat-debug-20260430T123456Z-session_1-abcd1234',
      savedPath: '/Users/test/.adhdev/debug-bundles/chat/chat-debug-20260430T123456Z-session_1-abcd1234.json',
    })

    expect(message).toContain('Chat debug signal sent')
    expect(message).toContain('chat-debug-20260430T123456Z-session_1-abcd1234')
    expect(message).toContain('locator copied')
  })

  it('falls back to a manual locator prompt when clipboard copy paths fail', async () => {
    const prompt = vi.fn()
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', undefined)
    vi.stubGlobal('window', { prompt })

    const status = await copyChatDebugBundleTextToClipboard('bundleId: chat-debug-123')

    expect(status).toBe('manual')
    expect(prompt).toHaveBeenCalledWith('Copy ADHDev chat debug locator:', 'bundleId: chat-debug-123')
    expect(buildChatDebugBundleToastMessage({ delivery: 'daemon_file', bundleId: 'chat-debug-123' }, { locatorCopyStatus: status }))
      .toContain('locator shown for manual copy')
  })
})
