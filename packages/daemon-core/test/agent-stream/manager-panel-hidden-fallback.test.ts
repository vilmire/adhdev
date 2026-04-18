import { describe, expect, it } from 'vitest'
import { DaemonAgentStreamManager } from '../../src/agent-stream/manager.js'

describe('DaemonAgentStreamManager hidden session fallback', () => {
  it('does not ping-pong indefinitely when every discovered extension panel is hidden', async () => {
    let clineReads = 0
    let codexReads = 0

    const registry = {
      get: (sessionId: string) => ({
        parentSessionId: 'parent-1',
        transport: 'cdp-webview',
        providerType: sessionId === 'sess-cline' ? 'cline' : 'codex',
        cdpManagerKey: 'cursor',
      }),
      listChildren: () => ([
        { sessionId: 'sess-cline', transport: 'cdp-webview', providerType: 'cline' },
        { sessionId: 'sess-codex', transport: 'cdp-webview', providerType: 'codex' },
      ]),
    }

    const manager = new DaemonAgentStreamManager(() => {}, undefined, registry as any)
    ;(manager as any).adaptersByType.set('cline', {
      agentType: 'cline',
      agentName: 'Cline',
      extensionId: 'cline.ext',
      readChat: async () => {
        clineReads += 1
        return { agentType: 'cline', agentName: 'Cline', extensionId: 'cline.ext', status: 'panel_hidden', messages: [], inputContent: '' }
      },
    })
    ;(manager as any).adaptersByType.set('codex', {
      agentType: 'codex',
      agentName: 'Codex',
      extensionId: 'codex.ext',
      readChat: async () => {
        codexReads += 1
        return { agentType: 'codex', agentName: 'Codex', extensionId: 'codex.ext', status: 'panel_hidden', messages: [], inputContent: '' }
      },
    })

    const cdp = {
      discoverAgentWebviews: async () => ([
        { targetId: 'target-cline', extensionId: 'cline.ext', agentType: 'cline', url: 'https://cline.test' },
        { targetId: 'target-codex', extensionId: 'codex.ext', agentType: 'codex', url: 'https://codex.test' },
      ]),
      attachToAgent: async (target: { agentType: string }) => `cdp-${target.agentType}`,
      detachAgent: async () => undefined,
      evaluateInSessionFrame: async () => null,
    }

    await manager.setActiveSession(cdp as any, 'parent-1', 'sess-cline')

    const stream = await Promise.race([
      manager.collectActiveSession(cdp as any, 'parent-1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 200)),
    ])

    expect((stream as any)?.status).toBe('panel_hidden')
    expect(manager.getActiveSessionId('parent-1')).toBe('sess-cline')
    expect(clineReads).toBe(1)
    expect(codexReads).toBe(1)
  })

  it('returns the fallback session identity when a different visible agent becomes active', async () => {
    const registry = {
      get: (sessionId: string) => ({
        parentSessionId: 'parent-1',
        transport: 'cdp-webview',
        providerType: sessionId === 'sess-cline' ? 'cline' : 'codex',
        cdpManagerKey: 'cursor',
      }),
      listChildren: () => ([
        { sessionId: 'sess-cline', transport: 'cdp-webview', providerType: 'cline' },
        { sessionId: 'sess-codex', transport: 'cdp-webview', providerType: 'codex' },
      ]),
    }

    const manager = new DaemonAgentStreamManager(() => {}, undefined, registry as any)
    ;(manager as any).adaptersByType.set('cline', {
      agentType: 'cline',
      agentName: 'Cline',
      extensionId: 'cline.ext',
      readChat: async () => ({
        agentType: 'cline',
        agentName: 'Cline',
        extensionId: 'cline.ext',
        status: 'panel_hidden',
        messages: [],
        inputContent: '',
      }),
    })
    ;(manager as any).adaptersByType.set('codex', {
      agentType: 'codex',
      agentName: 'Codex',
      extensionId: 'codex.ext',
      readChat: async () => ({
        agentType: 'codex',
        agentName: 'Codex',
        extensionId: 'codex.ext',
        sessionId: 'provider-codex-thread',
        providerSessionId: 'provider-codex-thread',
        status: 'waiting_approval',
        messages: [],
        inputContent: '',
        activeModal: { message: 'Approve?', buttons: ['Approve'] },
      }),
    })

    const cdp = {
      discoverAgentWebviews: async () => ([
        { targetId: 'target-cline', extensionId: 'cline.ext', agentType: 'cline', url: 'https://cline.test' },
        { targetId: 'target-codex', extensionId: 'codex.ext', agentType: 'codex', url: 'https://codex.test' },
      ]),
      attachToAgent: async (target: { agentType: string }) => `cdp-${target.agentType}`,
      detachAgent: async () => undefined,
      evaluateInSessionFrame: async () => null,
    }

    await manager.setActiveSession(cdp as any, 'parent-1', 'sess-cline')
    const stream = await manager.collectActiveSession(cdp as any, 'parent-1')

    expect(stream?.status).toBe('waiting_approval')
    expect(stream?.sessionId).toBe('sess-codex')
    expect(stream?.providerSessionId).toBe('provider-codex-thread')
    expect(manager.getActiveSessionId('parent-1')).toBe('sess-codex')
  })
})
