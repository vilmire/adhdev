import { describe, expect, it, vi } from 'vitest'
import { handleGetChatDebugBundle, sanitizeDebugBundleValue } from '../../src/commands/chat-commands.js'

describe('chat debug bundle', () => {
  it('builds a routed CLI debug bundle with sanitized parser and terminal snapshot data', async () => {
    const adapter = {
      cliType: 'hermes',
      cliName: 'Hermes CLI',
      workingDir: '/tmp/project',
      getStatus: vi.fn(() => ({
        status: 'generating',
        messages: [{ role: 'assistant', content: 'hello' }],
        activeModal: { message: 'Approve?', buttons: ['Yes', 'No'] },
      })),
      getScriptParsedStatus: vi.fn(() => ({
        status: 'generating',
        messages: [{ role: 'assistant', content: 'parsed' }],
        providerSessionId: 'ps_123',
      })),
      getPartialResponse: vi.fn(() => 'partial sk-test-secret-token-1234567890'),
      getDebugSnapshot: vi.fn(() => ({
        terminalScreenText: 'visible screen api_key=abc123456789',
        accumulatedTail: 'tail Authorization: Bearer secret-token-1234567890',
        traceEntries: [{ stage: 'parse', payload: { token: 'secret-token-1234567890' } }],
      })),
      isProcessing: () => true,
      isReady: () => true,
    }

    const result = await handleGetChatDebugBundle({
      getProvider: () => ({
        type: 'hermes',
        name: 'Hermes CLI',
        category: 'cli',
        controls: [{ id: 'model', label: 'Model', type: 'select', options: ['a'] }],
        scripts: { parseOutput: () => ({}) },
      }),
      getCliAdapter: () => adapter,
      getCdp: () => null,
      currentSession: {
        sessionId: 'session_1',
        providerType: 'hermes',
        transport: 'pty',
        adapterKey: 'cli:hermes:session_1',
        workspace: '/tmp/project',
      },
      currentProviderType: 'hermes',
      currentManagerKey: undefined,
      currentIdeType: undefined,
      agentStream: null,
      ctx: {
        sessionRegistry: { get: () => ({ instanceKey: 'cli:hermes:session_1' }) },
        instanceManager: {
          getInstance: () => ({
            getState: () => ({
              type: 'hermes',
              category: 'cli',
              status: 'generating',
              providerSessionId: 'ps_123',
              activeChat: { messages: [{ role: 'assistant', content: 'state' }] },
            }),
          }),
        },
      },
      historyWriter: { appendNewMessages: () => {} },
      evaluateProviderScript: vi.fn(),
      getProviderScript: () => null,
    } as any, {
      targetSessionId: 'session_1',
      frontendSnapshot: {
        url: 'https://adhf.dev/dashboard?token=secret-token-1234567890',
        messagesTail: [{ content: 'ui' }],
      },
    })

    expect(result.success).toBe(true)
    expect(result.bundle).toMatchObject({
      version: 1,
      target: { targetSessionId: 'session_1', providerType: 'hermes', transport: 'pty' },
      provider: { type: 'hermes', category: 'cli' },
      cli: { cliType: 'hermes', status: 'generating', ready: true, processing: true },
    })
    const serialized = JSON.stringify(result.bundle)
    expect(serialized).toContain('terminalScreenText')
    expect(serialized).toContain('[REDACTED')
    expect(serialized).not.toContain('secret-token-1234567890')
    expect(serialized).not.toContain('abc123456789')
    expect(result.text).toContain('ADHDev Chat Debug Bundle')
  })

  it('redacts secret-looking object fields and inline credentials recursively', () => {
    const sanitized = sanitizeDebugBundleValue({
      token: 'secret-token-1234567890',
      nested: {
        line: 'Authorization: Bearer secret-token-1234567890',
        url: 'https://example.com?a=1&api_key=secret-token-1234567890',
      },
    })
    const serialized = JSON.stringify(sanitized)
    expect(serialized).toContain('[REDACTED')
    expect(serialized).not.toContain('secret-token-1234567890')
  })
})
