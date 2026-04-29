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

function writeHermesSession(historySessionId: string) {
  const dir = path.join(mockHomeDir, '.hermes', 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `session_${historySessionId}.json`), JSON.stringify({
    session_id: historySessionId,
    session_start: '2026-04-29T01:02:03.000Z',
    messages: [
      { role: 'user', content: 'native hermes adapter user' },
      { role: 'assistant', content: 'native hermes adapter assistant' },
      { role: 'tool', content: 'native hermes adapter tool' },
    ],
  }), 'utf-8')
}

function writeClaudeSession(workspace: string, historySessionId: string) {
  const dir = path.join(mockHomeDir, '.claude', 'projects', workspace.replace(/[\\/]/g, '-'))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${historySessionId}.jsonl`), [
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'native claude adapter user' }] },
      timestamp: '2026-04-29T02:00:00.000Z',
      sessionId: historySessionId,
      cwd: workspace,
    }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pwd' } }] },
      timestamp: '2026-04-29T02:00:01.000Z',
      sessionId: historySessionId,
      cwd: workspace,
    }),
  ].join('\n') + '\n', 'utf-8')
}

function writeCodexSession(workspace: string, historySessionId: string) {
  const dir = path.join(mockHomeDir, '.codex', 'sessions', '2026', '04', '29')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `rollout-2026-04-29T00-27-22-${historySessionId}.jsonl`), [
    JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-04-29T03:00:00.000Z',
      payload: { id: historySessionId, cwd: workspace, timestamp: '2026-04-29T03:00:00.000Z' },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-04-29T03:00:01.000Z',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'native codex adapter user' }] },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-04-29T03:00:02.000Z',
      payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'pwd' }) },
    }),
  ].join('\n') + '\n', 'utf-8')
}

describe('native history adapter registry', () => {
  beforeEach(() => {
    mockHomeDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-native-history-'))
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (mockHomeDir) fs.rmSync(mockHomeDir, { recursive: true, force: true })
    mockHomeDir = ''
  })

  it('dispatches native history reads by canonicalHistory format', async () => {
    const workspace = '/workspaces/adhdev'
    const hermesSessionId = '20260429_010203_adapter'
    const claudeSessionId = '12345678-1234-4234-9234-1234567890ab'
    const codexSessionId = '019dd4b3-bea7-74a0-a5ca-e894370e9c94'
    writeHermesSession(hermesSessionId)
    writeClaudeSession(workspace, claudeSessionId)
    writeCodexSession(workspace, codexSessionId)

    const { getNativeHistoryAdapter } = await import('../../src/config/native-history/registry.js')

    expect(getNativeHistoryAdapter('hermes-json')?.readMessages({ sessionId: hermesSessionId })?.map(message => message.content)).toEqual([
      'native hermes adapter user',
      'native hermes adapter assistant',
      'native hermes adapter tool',
    ])
    expect(getNativeHistoryAdapter('claude-jsonl')?.readMessages({ sessionId: claudeSessionId, workspace })?.map(message => message.content)).toEqual([
      workspace,
      'native claude adapter user',
      'Bash: pwd',
    ])
    expect(getNativeHistoryAdapter('codex-jsonl')?.readMessages({ sessionId: codexSessionId, workspace })?.map(message => message.content)).toEqual([
      workspace,
      'native codex adapter user',
      'exec_command: pwd',
    ])
  })

  it('rejects unsafe native history session ids before resolving paths', async () => {
    const escapedRoot = path.join(mockHomeDir, 'escaped')
    fs.mkdirSync(escapedRoot, { recursive: true })
    fs.writeFileSync(path.join(escapedRoot, 'session_evil.json'), JSON.stringify({ messages: [{ role: 'user', content: 'escaped hermes' }] }), 'utf-8')

    const { getNativeHistoryAdapter } = await import('../../src/config/native-history/registry.js')

    expect(getNativeHistoryAdapter('hermes-json')?.resolveSession({ sessionId: '../escaped/evil' })).toBeNull()
    expect(getNativeHistoryAdapter('hermes-json')?.readMessages({ sessionId: '../escaped/evil' })).toBeNull()
    expect(getNativeHistoryAdapter('claude-jsonl')?.resolveSession({ sessionId: '../escaped/evil' })).toBeNull()
    expect(getNativeHistoryAdapter('claude-jsonl')?.readMessages({ sessionId: '../escaped/evil' })).toBeNull()
    expect(getNativeHistoryAdapter('codex-jsonl')?.resolveSession({ sessionId: '../escaped/evil' })).toBeNull()
  })

  it('reads the exact listed native source ref instead of re-resolving duplicate Codex session ids', async () => {
    const workspace = '/workspaces/adhdev'
    const historySessionId = '219dd4b3-bea7-74a0-a5ca-e894370e9c94'
    const olderDir = path.join(mockHomeDir, '.codex', 'sessions', '2026', '04', '28')
    const newerDir = path.join(mockHomeDir, '.codex', 'sessions', '2026', '04', '29')
    fs.mkdirSync(olderDir, { recursive: true })
    fs.mkdirSync(newerDir, { recursive: true })
    const olderPath = path.join(olderDir, `rollout-2026-04-28T00-27-22-${historySessionId}.jsonl`)
    const newerPath = path.join(newerDir, `rollout-2026-04-29T00-27-22-${historySessionId}.jsonl`)
    const writeCodexLines = (filePath: string, day: string, content: string) => fs.writeFileSync(filePath, [
      JSON.stringify({ type: 'session_meta', timestamp: `${day}T03:00:00.000Z`, payload: { id: historySessionId, cwd: workspace, timestamp: `${day}T03:00:00.000Z` } }),
      JSON.stringify({ type: 'response_item', timestamp: `${day}T03:00:01.000Z`, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] } }),
    ].join('\n') + '\n', 'utf-8')
    writeCodexLines(olderPath, '2026-04-28', 'older exact ref answer')
    writeCodexLines(newerPath, '2026-04-29', 'newer exact ref answer')

    const { getNativeHistoryAdapter } = await import('../../src/config/native-history/registry.js')
    const adapter = getNativeHistoryAdapter('codex-jsonl')
    const refs = adapter?.listSessionRefs().filter(ref => ref.sessionId === historySessionId) || []
    const olderRef = refs.find(ref => ref.sourcePath === olderPath)
    const newerRef = refs.find(ref => ref.sourcePath === newerPath)

    expect(olderRef).toBeTruthy()
    expect(newerRef).toBeTruthy()
    expect(adapter?.readSessionRef(olderRef!)?.map(message => message.content)).toEqual([workspace, 'older exact ref answer'])
    expect(adapter?.readSessionRef(newerRef!)?.map(message => message.content)).toEqual([workspace, 'newer exact ref answer'])
  })
})
