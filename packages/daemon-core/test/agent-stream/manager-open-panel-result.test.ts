import { describe, expect, it, vi } from 'vitest'
import { DaemonAgentStreamManager } from '../../src/agent-stream/manager.js'

describe('DaemonAgentStreamManager openSessionPanel', () => {
  it('does not report success when focusEditor returns an explicit failure result', async () => {
    const manager = new DaemonAgentStreamManager(() => {}, undefined, {
      get: () => ({
        parentSessionId: 'parent-1',
        transport: 'cdp-webview',
        providerType: 'cline',
      }),
      listChildren: () => [],
    } as any)

    const selectSession = vi.spyOn(manager, 'selectSession').mockResolvedValue(true)
    ;(manager as any).managedBySessionId.set('child-1', {
      adapter: {
        agentName: 'Cline',
        extensionId: 'cline.ext',
        focusEditor: vi.fn(async () => ({ focused: false, error: 'input missing' })),
      },
      runtimeSessionId: 'child-1',
      parentSessionId: 'parent-1',
      cdpSessionId: 'cdp-1',
      target: { targetId: 'target-1', extensionId: 'cline.ext', agentType: 'cline', url: 'https://example.test' },
      lastState: null,
      lastError: null,
      lastHiddenCheckTime: 0,
    })

    const cdp = {
      evaluateInSessionFrame: vi.fn(async () => null),
    } as any

    await expect(manager.openSessionPanel(cdp, 'child-1')).resolves.toBe(false)
    expect(selectSession).toHaveBeenCalledWith(cdp, 'child-1')
  })
})
