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


function readSavedHistoryLines(agentType: string, historySessionId: string): Array<{ role: string; kind?: string; content: string }> {
  const dir = path.join(mockHomeDir, '.adhdev', 'history', agentType)
  if (!fs.existsSync(dir)) return []
  const prefix = `${historySessionId}_`
  const file = fs.readdirSync(dir).find((entry) => entry.startsWith(prefix) && entry.endsWith('.jsonl'))
  if (!file) return []
  return fs.readFileSync(path.join(dir, file), 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map((entry) => ({ role: entry.role, kind: entry.kind, content: entry.content }))
}

function persistedHistory(instance: any): Array<{ role: string; kind?: string; content: string }> {
  return (instance.lastPersistedHistoryMessages || [])
    .map((entry: any) => ({ role: entry.role, kind: entry.kind, content: entry.content }))
}

function providerNativeHistoryScripts(readMessages: (input: any) => Array<Record<string, unknown>> | null) {
  return {
    readNativeHistory: (input: any) => {
      const messages = readMessages(input)
      if (!messages) return null
      return { messages, sourcePath: '/provider/native/session.jsonl', sourceMtimeMs: 1_800_000_000_000 }
    },
  }
}

describe('CliProviderInstance canonical Hermes saved-history sync', () => {
  it('keeps provider-native history format dispatch out of the live CLI lifecycle shell', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'providers', 'cli-provider-instance.ts'), 'utf-8')

    expect(source).not.toMatch(/canonicalHistory\.format\s*===/)
    expect(source).not.toMatch(/rebuild(?:Hermes|Claude|Codex)SavedHistory/)
    expect(source).not.toMatch(/resolveCodexSessionTranscriptPath/)
  })

  beforeEach(() => {
    mockHomeDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-cli-provider-canonical-history-'))
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (mockHomeDir) fs.rmSync(mockHomeDir, { recursive: true, force: true })
    mockHomeDir = ''
  })

  it('prefers provider-owned native history over parsed synthetic terminal/tool history for hermes saved-history', async () => {
    const historySessionId = '20260422_002711_293d9a'

    const { CliProviderInstance } = await import('../../src/providers/cli-provider-instance.js')
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
      scripts: providerNativeHistoryScripts(() => [
        { role: 'user', kind: 'standard', content: 'canonical user prompt', receivedAt: 1_800_000_001_000 },
        { role: 'assistant', kind: 'standard', content: 'canonical assistant reply', receivedAt: 1_800_000_002_000 },
        { role: 'assistant', kind: 'tool', content: 'canonical tool output', receivedAt: 1_800_000_003_000 },
      ]),
    } as any, '/workspaces/adhdev', [], 'runtime-1', undefined, {
      providerSessionId: historySessionId,
      launchMode: 'resume',
    }) as any

    instance.historyWriter = {
      appendNewMessages: vi.fn(),
      compactHistorySession: vi.fn(),
      seedSessionHistory: vi.fn(),
      appendSystemMarker: vi.fn(),
      promoteHistorySession: vi.fn(),
      writeSessionStart: vi.fn(),
    }
    instance.adapter = {
      getStatus: () => ({ status: 'idle', activeModal: null, messages: [] }),
      getScriptParsedStatus: () => ({
        status: 'idle',
        title: 'Hermes Agent',
        messages: [
          { role: 'user', kind: 'standard', content: 'synthetic user prompt', receivedAt: 1000 },
          { role: 'assistant', kind: 'terminal', senderName: 'Terminal', content: '$ which adhdev', receivedAt: 2000 },
          { role: 'assistant', kind: 'tool', senderName: 'Tool', content: 'find daemon-*.log', receivedAt: 3000 },
        ],
      }),
      getRuntimeMetadata: () => null,
      seedCommittedMessages: vi.fn(),
    }

    instance.getState()

    expect(instance.historyWriter.appendNewMessages).not.toHaveBeenCalled()
    expect(readSavedHistoryLines('hermes-cli', historySessionId)).toEqual([])
    expect(persistedHistory(instance)).toEqual([
      { role: 'user', kind: 'standard', content: 'canonical user prompt' },
      { role: 'assistant', kind: 'standard', content: 'canonical assistant reply' },
      { role: 'assistant', kind: 'tool', content: 'canonical tool output' },
    ])
  })

  it('prefers provider-owned native history over parsed synthetic terminal chatter for claude saved-history', async () => {
    const workspace = '/workspaces/adhdev'
    const historySessionId = '12345678-1234-4234-9234-1234567890ab'

    const { CliProviderInstance } = await import('../../src/providers/cli-provider-instance.js')
    const instance = new CliProviderInstance({
      type: 'claude-cli',
      name: 'Claude Code',
      category: 'cli',
      spawn: { command: 'claude', args: [] },
      nativeHistory: {
        format: 'claude-provider-native',
        watchPath: '~/.claude/projects/{{workspace}}/{{sessionId}}.jsonl',
        scripts: { readSession: 'readNativeHistory', listSessions: 'listNativeHistory' },
      },
      scripts: providerNativeHistoryScripts(() => [
        { role: 'system', kind: 'session_start', content: workspace, receivedAt: 1_800_000_000_000 },
        { role: 'user', kind: 'standard', content: 'native claude user prompt', receivedAt: 1_800_000_001_000 },
        { role: 'assistant', kind: 'tool', content: 'Bash: pwd', receivedAt: 1_800_000_002_000 },
        { role: 'assistant', kind: 'tool', content: '/workspaces/adhdev', receivedAt: 1_800_000_003_000 },
        { role: 'assistant', kind: 'standard', content: 'native claude assistant reply', receivedAt: 1_800_000_004_000 },
      ]),
    } as any, workspace, [], 'runtime-1', undefined, {
      providerSessionId: historySessionId,
      launchMode: 'resume',
    }) as any

    instance.historyWriter = {
      appendNewMessages: vi.fn(),
      compactHistorySession: vi.fn(),
      seedSessionHistory: vi.fn(),
      appendSystemMarker: vi.fn(),
      promoteHistorySession: vi.fn(),
      writeSessionStart: vi.fn(),
    }
    instance.adapter = {
      getStatus: () => ({ status: 'idle', activeModal: null, messages: [] }),
      getScriptParsedStatus: () => ({
        status: 'idle',
        title: 'Claude Code',
        messages: [
          { role: 'user', kind: 'standard', content: 'synthetic claude user', receivedAt: 1000 },
          { role: 'assistant', kind: 'tool', senderName: 'Tool', content: 'synthetic claude tool', receivedAt: 2000 },
        ],
      }),
      getRuntimeMetadata: () => null,
      seedCommittedMessages: vi.fn(),
    }

    instance.getState()

    expect(instance.historyWriter.appendNewMessages).not.toHaveBeenCalled()
    expect(readSavedHistoryLines('claude-cli', historySessionId)).toEqual([])
    expect(persistedHistory(instance)).toEqual([
      { role: 'system', kind: 'session_start', content: workspace },
      { role: 'user', kind: 'standard', content: 'native claude user prompt' },
      { role: 'assistant', kind: 'tool', content: 'Bash: pwd' },
      { role: 'assistant', kind: 'tool', content: '/workspaces/adhdev' },
      { role: 'assistant', kind: 'standard', content: 'native claude assistant reply' },
    ])
  })

  it('prefers provider-owned native history over parsed synthetic terminal chatter for codex saved-history', async () => {
    const workspace = '/workspaces/adhdev'
    const historySessionId = '019dd4b3-bea7-74a0-a5ca-e894370e9c94'

    const { CliProviderInstance } = await import('../../src/providers/cli-provider-instance.js')
    const instance = new CliProviderInstance({
      type: 'codex-cli',
      name: 'Codex CLI',
      category: 'cli',
      spawn: { command: 'codex', args: [] },
      nativeHistory: {
        format: 'codex-provider-native',
        watchPath: '~/.codex/sessions/**/*.jsonl',
        scripts: { readSession: 'readNativeHistory', listSessions: 'listNativeHistory' },
      },
      scripts: providerNativeHistoryScripts(() => [
        { role: 'system', kind: 'session_start', content: workspace, receivedAt: 1_800_000_000_000 },
        { role: 'user', kind: 'standard', content: 'native codex user prompt', receivedAt: 1_800_000_001_000 },
        { role: 'assistant', kind: 'tool', content: 'exec_command: pwd', receivedAt: 1_800_000_002_000 },
        { role: 'assistant', kind: 'tool', content: '/workspaces/adhdev', receivedAt: 1_800_000_003_000 },
        { role: 'assistant', kind: 'standard', content: 'native codex assistant reply', receivedAt: 1_800_000_004_000 },
      ]),
    } as any, workspace, [], 'runtime-1', undefined, {
      providerSessionId: historySessionId,
      launchMode: 'resume',
    }) as any

    instance.historyWriter = {
      appendNewMessages: vi.fn(),
      compactHistorySession: vi.fn(),
      seedSessionHistory: vi.fn(),
      appendSystemMarker: vi.fn(),
      promoteHistorySession: vi.fn(),
      writeSessionStart: vi.fn(),
    }
    instance.adapter = {
      getStatus: () => ({ status: 'idle', activeModal: null, messages: [] }),
      getScriptParsedStatus: () => ({
        status: 'idle',
        title: 'Codex CLI',
        messages: [
          { role: 'user', kind: 'standard', content: 'synthetic codex user', receivedAt: 1000 },
          { role: 'assistant', kind: 'tool', senderName: 'Tool', content: 'synthetic codex tool', receivedAt: 2000 },
        ],
      }),
      getRuntimeMetadata: () => null,
      seedCommittedMessages: vi.fn(),
    }

    instance.getState()

    expect(instance.historyWriter.appendNewMessages).not.toHaveBeenCalled()
    expect(readSavedHistoryLines('codex-cli', historySessionId)).toEqual([])
    expect(persistedHistory(instance)).toEqual([
      { role: 'system', kind: 'session_start', content: workspace },
      { role: 'user', kind: 'standard', content: 'native codex user prompt' },
      { role: 'assistant', kind: 'tool', content: 'exec_command: pwd' },
      { role: 'assistant', kind: 'tool', content: '/workspaces/adhdev' },
      { role: 'assistant', kind: 'standard', content: 'native codex assistant reply' },
    ])
  })

  it('throttles native-source history reads on repeated status ticks', async () => {
    const workspace = '/workspaces/adhdev'
    const historySessionId = '019dd4b3-bea7-74a0-a5ca-e894370e9c94'
    let nativeMessages = [
      { role: 'system', kind: 'session_start', content: workspace, receivedAt: 1_800_000_000_000 },
      { role: 'user', kind: 'standard', content: 'native codex throttled user', receivedAt: 1_800_000_001_000 },
    ]
    const { CliProviderInstance } = await import('../../src/providers/cli-provider-instance.js')
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
      scripts: providerNativeHistoryScripts(() => nativeMessages),
    } as any, workspace, [], 'runtime-1', undefined, {
      providerSessionId: historySessionId,
      launchMode: 'resume',
    }) as any

    instance.historyWriter = {
      appendNewMessages: vi.fn(),
      compactHistorySession: vi.fn(),
      seedSessionHistory: vi.fn(),
      appendSystemMarker: vi.fn(),
      promoteHistorySession: vi.fn(),
      writeSessionStart: vi.fn(),
    }
    instance.adapter = {
      getStatus: () => ({ status: 'idle', activeModal: null, messages: [] }),
      getScriptParsedStatus: () => ({
        status: 'idle',
        title: 'Codex CLI',
        messages: [{ role: 'user', kind: 'standard', content: 'synthetic codex user', receivedAt: 1000 }],
      }),
      getRuntimeMetadata: () => null,
      seedCommittedMessages: vi.fn(),
    }

    instance.getState()
    expect(persistedHistory(instance)).toEqual([
      { role: 'system', kind: 'session_start', content: workspace },
      { role: 'user', kind: 'standard', content: 'native codex throttled user' },
    ])

    nativeMessages = [
      { role: 'system', kind: 'session_start', content: workspace, receivedAt: 1_800_000_000_000 },
      { role: 'user', kind: 'standard', content: 'native codex updated user', receivedAt: 1_800_000_002_000 },
    ]
    instance.getState()
    expect(persistedHistory(instance)).toEqual([
      { role: 'system', kind: 'session_start', content: workspace },
      { role: 'user', kind: 'standard', content: 'native codex throttled user' },
    ])

    instance.lastNativeSourceCanonicalCheckAt = 0
    instance.getState()
    expect(persistedHistory(instance)).toEqual([
      { role: 'system', kind: 'session_start', content: workspace },
      { role: 'user', kind: 'standard', content: 'native codex updated user' },
    ])
    expect(instance.historyWriter.appendNewMessages).not.toHaveBeenCalled()
  })

  it('does not materialize synthetic mirror history when native-source history is temporarily unavailable', async () => {
    const workspace = '/workspaces/adhdev'
    const historySessionId = '019dd4b3-bea7-74a0-a5ca-e894370e9c94'

    const { CliProviderInstance } = await import('../../src/providers/cli-provider-instance.js')
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
      scripts: providerNativeHistoryScripts(() => null),
    } as any, workspace, [], 'runtime-1', undefined, {
      providerSessionId: historySessionId,
      launchMode: 'resume',
    }) as any

    instance.historyWriter = {
      appendNewMessages: vi.fn(),
      compactHistorySession: vi.fn(),
      seedSessionHistory: vi.fn(),
      appendSystemMarker: vi.fn(),
      promoteHistorySession: vi.fn(),
      writeSessionStart: vi.fn(),
    }
    instance.adapter = {
      getStatus: () => ({ status: 'idle', activeModal: null, messages: [] }),
      getScriptParsedStatus: () => ({
        status: 'idle',
        title: 'Codex CLI',
        messages: [{ role: 'user', kind: 'standard', content: 'synthetic codex user', receivedAt: 1000 }],
      }),
      getRuntimeMetadata: () => null,
      seedCommittedMessages: vi.fn(),
    }

    instance.getState()

    expect(instance.historyWriter.appendNewMessages).not.toHaveBeenCalled()
    expect(readSavedHistoryLines('codex-cli', historySessionId)).toEqual([])
  })

  it('seeds the full provider-owned transcript instead of truncating resume history to 200 messages', async () => {
    const historySessionId = '20260422_002711_293d9a'
    const canonicalMessages = Array.from({ length: 333 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `canonical message ${index + 1}`,
    }))

    const { CliProviderInstance } = await import('../../src/providers/cli-provider-instance.js')
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
      scripts: providerNativeHistoryScripts(() => canonicalMessages.map((message, index) => ({
        role: message.role,
        kind: 'standard',
        content: message.content,
        receivedAt: 1_800_000_000_000 + index,
      }))),
    } as any, '/workspaces/adhdev', [], 'runtime-1', undefined, {
      providerSessionId: historySessionId,
      launchMode: 'resume',
    }) as any

    instance.historyWriter = {
      appendNewMessages: vi.fn(),
      compactHistorySession: vi.fn(),
      seedSessionHistory: vi.fn(),
      appendSystemMarker: vi.fn(),
      promoteHistorySession: vi.fn(),
      writeSessionStart: vi.fn(),
    }
    instance.adapter = {
      getStatus: () => ({ status: 'idle', activeModal: null, messages: [] }),
      getScriptParsedStatus: () => ({
        status: 'idle',
        title: 'Hermes Agent',
        messages: [],
      }),
      getRuntimeMetadata: () => null,
      seedCommittedMessages: vi.fn(),
    }

    instance.restorePersistedHistoryFromCurrentSession()

    const seededHistory = vi.mocked(instance.historyWriter.seedSessionHistory).mock.calls[0]?.[1]
    expect(Array.isArray(seededHistory)).toBe(true)
    expect(seededHistory).toHaveLength(333)
    expect(String(seededHistory?.[0]?.content || '')).toBe('canonical message 1')
    expect(String(seededHistory?.[332]?.content || '')).toBe('canonical message 333')

    expect(instance.adapter.seedCommittedMessages).not.toHaveBeenCalled()
  })
})
