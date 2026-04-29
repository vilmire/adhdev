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

function writeCanonicalHermesSession(historySessionId: string, messages: Array<{ role: string; content: string }>) {
  const hermesDir = path.join(mockHomeDir, '.hermes', 'sessions')
  fs.mkdirSync(hermesDir, { recursive: true })
  fs.writeFileSync(path.join(hermesDir, `session_${historySessionId}.json`), JSON.stringify({
    session_id: historySessionId,
    session_start: '2026-04-22T00:27:56.853373',
    last_updated: '2026-04-22T00:29:27.545265',
    messages,
  }), 'utf-8')
}

function writeCanonicalClaudeProjectSession(workspace: string, historySessionId: string, lines: unknown[]) {
  const projectDir = path.join(mockHomeDir, '.claude', 'projects', workspace.replace(/[\\/]/g, '-'))
  fs.mkdirSync(projectDir, { recursive: true })
  fs.writeFileSync(
    path.join(projectDir, `${historySessionId}.jsonl`),
    `${lines.map(line => JSON.stringify(line)).join('\n')}\n`,
    'utf-8',
  )
}

function writeCanonicalCodexSession(historySessionId: string, lines: unknown[]) {
  const sessionDir = path.join(mockHomeDir, '.codex', 'sessions', '2026', '04', '29')
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(
    path.join(sessionDir, `rollout-2026-04-29T00-27-22-${historySessionId}.jsonl`),
    `${lines.map(line => JSON.stringify(line)).join('\n')}\n`,
    'utf-8',
  )
}

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

describe('CliProviderInstance canonical Hermes saved-history sync', () => {
  beforeEach(() => {
    mockHomeDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-cli-provider-canonical-history-'))
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (mockHomeDir) fs.rmSync(mockHomeDir, { recursive: true, force: true })
    mockHomeDir = ''
  })

  it('prefers canonical ~/.hermes session history over parsed synthetic terminal/tool history for hermes saved-history', async () => {
    const historySessionId = '20260422_002711_293d9a'
    writeCanonicalHermesSession(historySessionId, [
      { role: 'user', content: 'canonical user prompt' },
      { role: 'assistant', content: 'canonical assistant reply' },
      { role: 'tool', content: 'canonical tool output' },
    ])

    const { CliProviderInstance } = await import('../../src/providers/cli-provider-instance.js')
    const instance = new CliProviderInstance({
      type: 'hermes-cli',
      name: 'Hermes Agent',
      category: 'cli',
      spawn: { command: 'hermes', args: [] },
      canonicalHistory: {
        format: 'hermes-json',
        watchPath: '~/.hermes/sessions/session_{{sessionId}}.json',
      },
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

  it('prefers canonical ~/.claude project history over parsed synthetic terminal chatter for claude saved-history', async () => {
    const workspace = '/workspaces/adhdev'
    const historySessionId = '12345678-1234-4234-9234-1234567890ab'
    writeCanonicalClaudeProjectSession(workspace, historySessionId, [
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'native claude user prompt' }] },
        timestamp: '2026-04-22T08:34:55.724Z',
        sessionId: historySessionId,
        cwd: workspace,
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pwd' } }] },
        timestamp: '2026-04-22T08:35:00.848Z',
        sessionId: historySessionId,
        cwd: workspace,
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: '/workspaces/adhdev' }], is_error: false }] },
        timestamp: '2026-04-22T08:35:01.026Z',
        sessionId: historySessionId,
        cwd: workspace,
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'native claude assistant reply' }] },
        timestamp: '2026-04-22T08:35:02.105Z',
        sessionId: historySessionId,
        cwd: workspace,
      },
    ])

    const { CliProviderInstance } = await import('../../src/providers/cli-provider-instance.js')
    const instance = new CliProviderInstance({
      type: 'claude-cli',
      name: 'Claude Code',
      category: 'cli',
      spawn: { command: 'claude', args: [] },
      canonicalHistory: {
        format: 'claude-jsonl',
        watchPath: '~/.claude/projects/{{workspace}}/{{sessionId}}.jsonl',
      },
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

  it('prefers canonical ~/.codex rollout history over parsed synthetic terminal chatter for codex saved-history', async () => {
    const workspace = '/workspaces/adhdev'
    const historySessionId = '019dd4b3-bea7-74a0-a5ca-e894370e9c94'
    writeCanonicalCodexSession(historySessionId, [
      {
        type: 'session_meta',
        timestamp: '2026-04-28T15:27:24.859Z',
        payload: { id: historySessionId, cwd: workspace, timestamp: '2026-04-28T15:27:24.859Z' },
      },
      {
        type: 'response_item',
        timestamp: '2026-04-28T15:27:25.000Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'native codex user prompt' }] },
      },
      {
        type: 'response_item',
        timestamp: '2026-04-28T15:27:26.000Z',
        payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'pwd' }), call_id: 'call_pwd' },
      },
      {
        type: 'response_item',
        timestamp: '2026-04-28T15:27:27.000Z',
        payload: { type: 'function_call_output', call_id: 'call_pwd', output: '/workspaces/adhdev' },
      },
      {
        type: 'response_item',
        timestamp: '2026-04-28T15:27:28.000Z',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'native codex assistant reply' }] },
      },
    ])

    const { CliProviderInstance } = await import('../../src/providers/cli-provider-instance.js')
    const instance = new CliProviderInstance({
      type: 'codex-cli',
      name: 'Codex CLI',
      category: 'cli',
      spawn: { command: 'codex', args: [] },
      canonicalHistory: {
        format: 'codex-jsonl',
        watchPath: '~/.codex/sessions/**/*.jsonl',
      },
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

  it('seeds the full canonical Hermes transcript instead of truncating resume history to 200 messages', async () => {
    const historySessionId = '20260422_002711_293d9a'
    const canonicalMessages = Array.from({ length: 333 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `canonical message ${index + 1}`,
    }))
    writeCanonicalHermesSession(historySessionId, canonicalMessages)

    const { CliProviderInstance } = await import('../../src/providers/cli-provider-instance.js')
    const instance = new CliProviderInstance({
      type: 'hermes-cli',
      name: 'Hermes Agent',
      category: 'cli',
      spawn: { command: 'hermes', args: [] },
      canonicalHistory: {
        format: 'hermes-json',
        watchPath: '~/.hermes/sessions/session_{{sessionId}}.json',
      },
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

    const seededCommitted = vi.mocked(instance.adapter.seedCommittedMessages).mock.calls[0]?.[0]
    expect(Array.isArray(seededCommitted)).toBe(true)
    expect(seededCommitted).toHaveLength(333)
    expect(String(seededCommitted?.[332]?.content || '')).toBe('canonical message 333')
  })
})
