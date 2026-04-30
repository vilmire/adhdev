import { describe, expect, it, vi } from 'vitest'
import { handleGetChatDebugBundle, sanitizeDebugBundleValue } from '../../src/commands/chat-commands.js'
import { DaemonCommandHandler } from '../../src/commands/handler.js'

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
      getPartialResponse: vi.fn(() => ['partial ', 'sk', '-test-secret-1234567890'].join('')),
      getDebugSnapshot: vi.fn(() => ({
        terminalScreenText: 'visible screen ' + 'api_' + 'key=abc123456789',
        accumulatedTail: 'tail ' + 'Authorization: ' + 'Bearer ' + 'secret-token-1234567890',
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
        url: 'https://adhf.dev/dashboard?debug=1',
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
        line: 'Authorization: ' + 'Bearer ' + 'secret-token-1234567890',
        url: 'https://example.com?a=1&' + 'api_' + 'key=secret-token-1234567890',
      },
    })
    const serialized = JSON.stringify(sanitized)
    expect(serialized).toContain('[REDACTED')
    expect(serialized).not.toContain('secret-token-1234567890')
  })

  it('fails instead of returning a partial bundle when the target session is missing', async () => {
    const handler = new DaemonCommandHandler({
      cdpManagers: new Map(),
      ideType: 'standalone',
      adapters: new Map([['hermes-cli', { cliType: 'hermes-cli' } as any]]),
      sessionRegistry: { get: () => undefined } as any,
      providerLoader: {
        resolve: () => ({ type: 'hermes-cli', name: 'Hermes Agent', category: 'cli' }),
      } as any,
    })

    await expect(handler.handle('get_chat_debug_bundle', {
      agentType: 'hermes-cli',
      targetSessionId: 'missing-session',
    })).resolves.toMatchObject({
      success: false,
      error: 'Live session not found for targetSessionId: missing-session',
    })
  })

  it('fails instead of returning a partial bundle when no target session is provided', async () => {
    const handler = new DaemonCommandHandler({
      cdpManagers: new Map(),
      ideType: 'standalone',
      adapters: new Map([['hermes-cli', { cliType: 'hermes-cli' } as any]]),
      sessionRegistry: { get: () => undefined } as any,
      providerLoader: {
        resolve: () => ({ type: 'hermes-cli', name: 'Hermes Agent', category: 'cli' }),
      } as any,
    })

    await expect(handler.handle('get_chat_debug_bundle', {
      agentType: 'hermes-cli',
    })).resolves.toMatchObject({
      success: false,
      error: 'No targetSessionId specified — cannot route command',
    })
  })
})
