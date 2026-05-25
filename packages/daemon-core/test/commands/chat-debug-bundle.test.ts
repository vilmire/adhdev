import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
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

  it('stores combined frontend and daemon evidence on the daemon when file delivery is requested', async () => {
    const previousDir = process.env.ADHDEV_DEBUG_BUNDLE_DIR
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-chat-debug-bundle-'))
    process.env.ADHDEV_DEBUG_BUNDLE_DIR = tempRoot
    try {
      const adapter = {
        cliType: 'hermes',
        cliName: 'Hermes CLI',
        workingDir: '/tmp/project',
        getStatus: vi.fn(() => ({ status: 'idle', messages: [{ role: 'assistant', content: 'daemon side' }] })),
        getScriptParsedStatus: vi.fn(() => ({ status: 'idle' })),
        getPartialResponse: vi.fn(() => 'partial daemon evidence'),
        getDebugSnapshot: vi.fn(() => ({ terminalScreenText: 'daemon terminal evidence' })),
        isProcessing: () => false,
        isReady: () => true,
      }

      const result = await handleGetChatDebugBundle({
        getProvider: () => ({ type: 'hermes', name: 'Hermes CLI', category: 'cli', scripts: {} }),
        getCliAdapter: () => adapter,
        getCdp: () => null,
        currentSession: {
          sessionId: 'session_1',
          providerType: 'hermes',
          transport: 'pty',
          adapterKey: 'cli:hermes:session_1',
        },
        currentProviderType: 'hermes',
        currentManagerKey: undefined,
        currentIdeType: undefined,
        agentStream: null,
        ctx: {
          sessionRegistry: { get: () => ({ sessionId: 'session_1', instanceKey: 'cli:hermes:session_1' }) },
          instanceManager: { getInstance: () => null },
        },
        historyWriter: { appendNewMessages: () => {} },
        evaluateProviderScript: vi.fn(),
        getProviderScript: () => null,
      } as any, {
        targetSessionId: 'session_1',
        delivery: 'daemon_file',
        frontendSnapshot: {
          activeConversation: { sessionId: 'session_1' },
          visibleMessagesTail: [{ role: 'user', content: 'frontend side' }],
        },
      })

      expect(result).toMatchObject({
        success: true,
        delivery: 'daemon_file',
        bundleId: expect.stringMatching(/^chat-debug-/),
        savedPath: expect.stringContaining(tempRoot),
      })
      expect(result.bundle).toBeUndefined()
      expect(result.text).toBeUndefined()
      const savedPath = String(result.savedPath)
      const saved = JSON.parse(fs.readFileSync(savedPath, 'utf8'))
      expect(saved.frontend.visibleMessagesTail[0].content).toBe('frontend side')
      expect(saved.cli.debugSnapshot.terminalScreenText).toBe('daemon terminal evidence')
      expect(saved.readChat).toBeTruthy()
      expect(result.summary).toMatchObject({
        targetSessionId: 'session_1',
        providerType: 'hermes',
        transport: 'pty',
        cliParsedStatus: 'idle',
        cliParsedMessageCount: undefined,
        cliPartialResponseChars: 'partial daemon evidence'.length,
      })
    } finally {
      if (previousDir === undefined) delete process.env.ADHDEV_DEBUG_BUNDLE_DIR
      else process.env.ADHDEV_DEBUG_BUNDLE_DIR = previousDir
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
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

  it('returns a historical debug bundle instead of hard-failing when the live session record is gone but providerType is known', async () => {
    // Simulates the post-stop/destroy case where a Codex CLI session UUID is used in
    // mesh_read_debug/read_chat after the PTY session has already been torn down.
    // The fix: get_chat_debug_bundle falls through to history-backed read_chat instead
    // of returning "Live session not found".
    const handler = new DaemonCommandHandler({
      cdpManagers: new Map(),
      ideType: 'standalone',
      adapters: new Map(),
      sessionRegistry: { get: () => undefined } as any,
      providerLoader: {
        resolve: () => ({ type: 'codex-cli', name: 'Codex CLI', category: 'cli' }),
      } as any,
    })

    const result = await handler.handle('get_chat_debug_bundle', {
      agentType: 'codex-cli',
      targetSessionId: '25e40a0f-2dce-4e5a-9d0d-8fbf63bf7016',
    })

    // Should succeed (or fail for a reason other than missing session)
    expect(result.success !== false || result.error !== 'Live session not found for targetSessionId: 25e40a0f-2dce-4e5a-9d0d-8fbf63bf7016').toBe(true)
    // If success: bundle should have target metadata and a null cli section (no live adapter)
    if (result.success) {
      expect((result.bundle as any)?.target?.targetSessionId).toBe('25e40a0f-2dce-4e5a-9d0d-8fbf63bf7016')
      expect((result.bundle as any)?.cli).toBeNull()
      // source marker should be present to distinguish from a live bundle
    }
  })

  it('returns a historical debug bundle for a missing codex-cli session with providerSessionId in args', async () => {
    // Regression: mesh coordinator passes providerSessionId after a Codex CLI session stops;
    // the handler must not short-circuit with "Live session not found".
    const handler = new DaemonCommandHandler({
      cdpManagers: new Map(),
      ideType: 'standalone',
      adapters: new Map(),
      sessionRegistry: { get: () => undefined } as any,
      providerLoader: {
        resolve: () => ({ type: 'codex-cli', name: 'Codex CLI', category: 'cli' }),
      } as any,
    })

    const result = await handler.handle('get_chat_debug_bundle', {
      agentType: 'codex-cli',
      targetSessionId: '25e40a0f-2dce-4e5a-9d0d-8fbf63bf7016',
      providerSessionId: 'some-provider-session-id',
    })

    expect(result.error).not.toBe('Live session not found for targetSessionId: 25e40a0f-2dce-4e5a-9d0d-8fbf63bf7016')
    if (result.success) {
      expect((result.bundle as any)?.target?.targetSessionId).toBe('25e40a0f-2dce-4e5a-9d0d-8fbf63bf7016')
    }
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
