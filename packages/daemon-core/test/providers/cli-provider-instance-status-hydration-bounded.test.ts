import * as fs from 'fs'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let mockHomeDir = ''

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => mockHomeDir,
  }
})

function makeWriterStub() {
  return {
    appendNewMessages: vi.fn(),
    compactHistorySession: vi.fn(),
    seedSessionHistory: vi.fn(),
    appendSystemMarker: vi.fn(),
    promoteHistorySession: vi.fn(),
    writeSessionStart: vi.fn(),
  }
}

function makeIdleAdapterStub() {
  return {
    getStatus: () => ({ status: 'idle', activeModal: null, messages: [] }),
    getScriptParsedStatus: () => ({ status: 'idle', title: 'Agent', messages: [] }),
    getRuntimeMetadata: () => null,
    seedCommittedMessages: vi.fn(),
  }
}

const UNBOUNDED = Number.MAX_SAFE_INTEGER

describe('CliProviderInstance status-snapshot hydration is bounded (cold N-session path)', () => {
  beforeEach(() => {
    mockHomeDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-cli-status-hydration-'))
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (mockHomeDir) fs.rmSync(mockHomeDir, { recursive: true, force: true })
    mockHomeDir = ''
  })

  it('native-source: getState hydration reads a bounded tail, never the full transcript', async () => {
    const chatHistory = await import('../../src/config/chat-history.js')
    const readProviderSpy = vi.spyOn(chatHistory, 'readProviderChatHistory')

    const { CliProviderInstance } = await import('../../src/providers/cli-provider-instance.js')
    const historySessionId = '019dd4b3-bea7-74a0-a5ca-e894370e9c94'
    const instance = new CliProviderInstance({
      type: 'codex-cli',
      name: 'Codex CLI',
      category: 'cli',
      spawn: { command: 'codex', args: [] },
      nativeHistory: {
        format: 'codex-provider-native',
        watchPath: '~/.codex/sessions/**/*.jsonl',
        mode: 'native-source',
        scripts: { readSession: 'readNativeHistory', listSessions: 'listNativeHistory' },
      },
      scripts: {
        readNativeHistory: () => ({
          sourcePath: '/provider/native/session.jsonl',
          sourceMtimeMs: 1_800_000_000_000,
          messages: [
            { role: 'user', kind: 'standard', content: 'native user', receivedAt: 1_800_000_001_000 },
            { role: 'assistant', kind: 'standard', content: 'native assistant', receivedAt: 1_800_000_002_000 },
          ],
        }),
      },
    } as any, '/workspaces/adhdev', [], 'runtime-1', undefined, {
      providerSessionId: historySessionId,
      launchMode: 'resume',
    }) as any

    instance.historyWriter = makeWriterStub()
    instance.adapter = makeIdleAdapterStub()

    instance.getState()

    expect(readProviderSpy).toHaveBeenCalled()
    for (const call of readProviderSpy.mock.calls) {
      const opts = call[1] as { limit?: number }
      expect(opts.limit).toBeLessThanOrEqual(1_000)
      expect(opts.limit).not.toBe(UNBOUNDED)
    }
  })

  it('materialized-mirror: getState hydration reads a bounded tail, never MAX_SAFE_INTEGER', async () => {
    const chatHistory = await import('../../src/config/chat-history.js')
    // materializeProviderNativeHistory must succeed so the mirror read runs.
    vi.spyOn(chatHistory, 'materializeProviderNativeHistory').mockReturnValue(true)
    const readChatSpy = vi.spyOn(chatHistory, 'readChatHistory')

    const { CliProviderInstance } = await import('../../src/providers/cli-provider-instance.js')
    const historySessionId = '12345678-1234-4234-9234-1234567890ab'
    const instance = new CliProviderInstance({
      type: 'claude-cli',
      name: 'Claude Code',
      category: 'cli',
      spawn: { command: 'claude', args: [] },
      nativeHistory: {
        format: 'claude-provider-native',
        watchPath: '~/.claude/projects/{{workspace}}/{{sessionId}}.jsonl',
        mode: 'materialized-mirror',
        scripts: { readSession: 'readNativeHistory', listSessions: 'listNativeHistory' },
      },
      scripts: { readNativeHistory: () => null },
    } as any, '/workspaces/adhdev', [], 'runtime-1', undefined, {
      providerSessionId: historySessionId,
      launchMode: 'resume',
    }) as any

    instance.historyWriter = makeWriterStub()
    instance.adapter = makeIdleAdapterStub()

    instance.getState()

    expect(readChatSpy).toHaveBeenCalled()
    for (const call of readChatSpy.mock.calls) {
      const limit = call[2] as number
      expect(limit).toBeLessThanOrEqual(1_000)
      expect(limit).not.toBe(UNBOUNDED)
    }
  })

  it('N resume sessions: no getState triggers a single unbounded full transcript read', async () => {
    const chatHistory = await import('../../src/config/chat-history.js')
    const readProviderSpy = vi.spyOn(chatHistory, 'readProviderChatHistory')
    const readChatSpy = vi.spyOn(chatHistory, 'readChatHistory')

    const { CliProviderInstance } = await import('../../src/providers/cli-provider-instance.js')

    const sessionCount = 5
    const instances = Array.from({ length: sessionCount }, (_, i) => {
      const inst = new CliProviderInstance({
        type: 'codex-cli',
        name: 'Codex CLI',
        category: 'cli',
        spawn: { command: 'codex', args: [] },
        nativeHistory: {
          format: 'codex-provider-native',
          watchPath: '~/.codex/sessions/**/*.jsonl',
          mode: 'native-source',
          scripts: { readSession: 'readNativeHistory', listSessions: 'listNativeHistory' },
        },
        scripts: {
          readNativeHistory: () => ({
            sourcePath: `/provider/native/session-${i}.jsonl`,
            sourceMtimeMs: 1_800_000_000_000,
            messages: [{ role: 'user', kind: 'standard', content: `s${i} user`, receivedAt: 1_800_000_001_000 }],
          }),
        },
      } as any, `/workspaces/s${i}`, [], `runtime-${i}`, undefined, {
        providerSessionId: `session-${i}`,
        launchMode: 'resume',
      }) as any
      inst.historyWriter = makeWriterStub()
      inst.adapter = makeIdleAdapterStub()
      return inst
    })

    // Simulate the initial status report collecting state from every session.
    for (const inst of instances) inst.getState()

    const allCalls = [
      ...readProviderSpy.mock.calls.map((c) => (c[1] as { limit?: number }).limit),
      ...readChatSpy.mock.calls.map((c) => c[2] as number),
    ]
    expect(allCalls.length).toBeGreaterThan(0)
    expect(allCalls.every((limit) => limit !== UNBOUNDED)).toBe(true)
  })

  it('restore (once-per-resume) still hydrates the full transcript via full:true', async () => {
    const chatHistory = await import('../../src/config/chat-history.js')
    const readProviderSpy = vi.spyOn(chatHistory, 'readProviderChatHistory')

    const { CliProviderInstance } = await import('../../src/providers/cli-provider-instance.js')
    const historySessionId = '20260422_002711_293d9a'
    const instance = new CliProviderInstance({
      type: 'hermes-cli',
      name: 'Hermes Agent',
      category: 'cli',
      spawn: { command: 'hermes', args: [] },
      nativeHistory: {
        format: 'hermes-provider-native',
        watchPath: '~/.hermes/sessions/session_{{sessionId}}.json',
        scripts: { readSession: 'readNativeHistory', listSessions: 'listNativeHistory' },
      },
      scripts: {
        readNativeHistory: () => ({
          sourcePath: '/provider/native/session.jsonl',
          sourceMtimeMs: 1_800_000_000_000,
          messages: Array.from({ length: 333 }, (_, i) => ({
            role: i % 2 === 0 ? 'user' : 'assistant',
            kind: 'standard',
            content: `m${i + 1}`,
            receivedAt: 1_800_000_000_000 + i,
          })),
        }),
      },
    } as any, '/workspaces/adhdev', [], 'runtime-1', undefined, {
      providerSessionId: historySessionId,
      launchMode: 'resume',
    }) as any

    instance.historyWriter = makeWriterStub()
    instance.adapter = makeIdleAdapterStub()

    instance.restorePersistedHistoryFromCurrentSession()

    // At least one call during restore must request the full transcript so
    // seedSessionHistory can prime dedup state across the whole conversation.
    const sawUnbounded = readProviderSpy.mock.calls.some((c) => (c[1] as { limit?: number }).limit === UNBOUNDED)
    expect(sawUnbounded).toBe(true)
    // And the full transcript was seeded (not truncated to the bounded window).
    const seeded = vi.mocked(instance.historyWriter.seedSessionHistory).mock.calls[0]?.[1]
    expect(Array.isArray(seeded)).toBe(true)
    expect(seeded).toHaveLength(333)
  })
})
