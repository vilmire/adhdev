import { describe, expect, it } from 'vitest'
import { buildChatFrontendDebugSnapshot, recordControlsToggleDebugGesture } from '../../../src/components/dashboard/chat-debug-bundle'

describe('chat frontend debug bundle helpers', () => {
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
      locationHref: 'https://adhf.dev/dashboard?token=secret-token-1234567890',
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
})
