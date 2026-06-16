import * as fs from 'fs'
import * as path from 'path'
import { pathToFileURL } from 'url'
import { spawn } from 'child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let mockHomeDir = ''

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => mockHomeDir,
  }
})

function buildHistoryFilePath(agentType: string, historySessionId: string, date = '2026-04-17') {
  return path.join(mockHomeDir, '.adhdev', 'history', agentType, `${historySessionId}_${date}.jsonl`)
}

function writeHistorySession(agentType: string, historySessionId: string, count: number) {
  const filePath = buildHistoryFilePath(agentType, historySessionId)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const lines = Array.from({ length: count }, (_, index) => JSON.stringify({
    ts: new Date(1_700_000_000_000 + index * 1000).toISOString(),
    receivedAt: 1_700_000_000_000 + index * 1000,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `msg-${index + 1}`,
    agent: agentType,
    historySessionId,
    sessionTitle: 'History Session',
  }))
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf-8')
  return filePath
}

// Write a single session split across multiple daily JSONL files so the
// bounded-tail read path has to span more than one file to satisfy the window.
function writeHistorySessionAcrossDates(
  agentType: string,
  historySessionId: string,
  perFileCounts: Array<{ date: string; count: number }>,
) {
  let globalIndex = 0
  for (const { date, count } of perFileCounts) {
    const filePath = buildHistoryFilePath(agentType, historySessionId, date)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const lines = Array.from({ length: count }, () => {
      const index = globalIndex++
      return JSON.stringify({
        ts: new Date(1_700_000_000_000 + index * 1000).toISOString(),
        receivedAt: 1_700_000_000_000 + index * 1000,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `msg-${index + 1}`,
        agent: agentType,
        historySessionId,
        sessionTitle: 'History Session',
      })
    })
    fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf-8')
  }
  return globalIndex
}

function buildHistoryIndexPath(agentType: string) {
  return path.join(mockHomeDir, '.adhdev', 'history', agentType, '.saved-history-index.json')
}

function findHistoryFilePath(agentType: string, historySessionId: string) {
  const dir = path.join(mockHomeDir, '.adhdev', 'history', agentType)
  const prefix = `${historySessionId}_`
  const match = fs.readdirSync(dir).find(file => file.startsWith(prefix) && file.endsWith('.jsonl'))
  if (!match) throw new Error(`History file not found for ${historySessionId}`)
  return path.join(dir, match)
}

function buildHistoryIndexLockPath(agentType: string) {
  return `${buildHistoryIndexPath(agentType)}.lock`
}

function writeSavedHistoryIndex(agentType: string, files: Record<string, unknown>) {
  const filePath = buildHistoryIndexPath(agentType)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, files }), 'utf-8')
}

function spawnHistoryWriterProcess(historySessionId: string, workspace: string, messages: Array<{ role: 'user' | 'assistant'; content: string; receivedAt: number }>) {
  const chatHistoryModuleUrl = pathToFileURL(path.resolve(__dirname, '../../src/config/chat-history.ts')).href
  const script = `
    const mod = (await import(${JSON.stringify(chatHistoryModuleUrl)})).default;
    const writer = new mod.ChatHistoryWriter();
    writer.writeSessionStart('hermes-cli', ${JSON.stringify(historySessionId)}, ${JSON.stringify(workspace)});
    writer.appendNewMessages('hermes-cli', ${JSON.stringify(messages)}, 'History Session', undefined, ${JSON.stringify(historySessionId)});
  `
  return spawn(process.execPath, ['--input-type=module', '--import', 'tsx', '--eval', script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: mockHomeDir },
    stdio: 'pipe',
  })
}

function waitForChild(child: ReturnType<typeof spawn>): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stderr }))
  })
}

describe('chat-history config helpers', () => {
  it('keeps provider-specific native history adapters out of daemon-core', () => {
    const nativeHistoryDir = path.join(process.cwd(), 'src', 'config', 'native-history')
    const sourceFiles = fs.existsSync(nativeHistoryDir)
      ? fs.readdirSync(nativeHistoryDir).filter(file => file.endsWith('.ts'))
      : []
    const chatHistorySource = fs.readFileSync(path.join(process.cwd(), 'src', 'config', 'chat-history.ts'), 'utf-8')

    expect(sourceFiles).toEqual([])
    expect(chatHistorySource).not.toMatch(/getNativeHistoryAdapter|rebuild(?:Hermes|Claude|Codex)SavedHistory|hermes-json|claude-jsonl|codex-jsonl/)
  })

  beforeEach(() => {
    mockHomeDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-chat-history-'))
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (mockHomeDir) fs.rmSync(mockHomeDir, { recursive: true, force: true })
    mockHomeDir = ''
  })

  it('pages older history from the bottom of the saved transcript instead of restarting from the oldest messages', async () => {
    writeHistorySession('hermes-cli', 'history-1', 100)
    const { readChatHistory } = await import('../../src/config/chat-history.js')

    const firstPage = readChatHistory('hermes-cli', 0, 30, 'history-1', 50)
    const secondPage = readChatHistory('hermes-cli', 30, 30, 'history-1', 50)

    expect(firstPage.messages.map(message => message.content)).toEqual(
      Array.from({ length: 30 }, (_, index) => `msg-${index + 21}`),
    )
    expect(firstPage.hasMore).toBe(true)
    expect(secondPage.messages.map(message => message.content)).toEqual(
      Array.from({ length: 20 }, (_, index) => `msg-${index + 1}`),
    )
    expect(secondPage.hasMore).toBe(false)
  })

  it('clamps malformed numeric pagination values instead of returning an empty history page', async () => {
    writeHistorySession('hermes-cli', 'history-1', 10)
    const { readChatHistory } = await import('../../src/config/chat-history.js')

    const page = readChatHistory('hermes-cli', Number.NaN as any, Number.NaN as any, 'history-1', Number.NaN as any)

    expect(page.messages.map(message => message.content)).toEqual(
      Array.from({ length: 10 }, (_, index) => `msg-${index + 1}`),
    )
    expect(page.hasMore).toBe(false)
  })

  it('invalidates persisted session aggregates when the raw history file is newer than the index', async () => {
    const filePath = writeHistorySession('hermes-cli', '20260417_030305_theta', 2)
    const { listSavedHistorySessions } = await import('../../src/config/chat-history.js')

    const first = listSavedHistorySessions('hermes-cli')
    expect(first.sessions[0]).toMatchObject({ historySessionId: '20260417_030305_theta', messageCount: 2 })

    await new Promise(resolve => setTimeout(resolve, 20))
    fs.appendFileSync(filePath, `${JSON.stringify({
      ts: new Date(1_700_000_034_000).toISOString(),
      receivedAt: 1_700_000_034_000,
      role: 'assistant',
      content: 'theta-late',
      agent: 'hermes-cli',
      historySessionId: '20260417_030305_theta',
      sessionTitle: 'Theta Session',
    })}\n`, 'utf-8')

    vi.resetModules()
    const reloaded = await import('../../src/config/chat-history.js')
    const second = reloaded.listSavedHistorySessions('hermes-cli')
    expect(second.sessions[0]).toMatchObject({
      historySessionId: '20260417_030305_theta',
      messageCount: 3,
      preview: 'theta-late',
    })
  })

  it('drops the persisted index after compaction rewrites history files', async () => {
    const { ChatHistoryWriter, listSavedHistorySessions } = await import('../../src/config/chat-history.js')
    const writer = new ChatHistoryWriter()
    writer.writeSessionStart('hermes-cli', '20260417_030306_lambda', '/workspaces/lambda')
    writer.appendNewMessages(
      'hermes-cli',
      [
        { role: 'user', content: 'dup', receivedAt: 1_700_000_035_000 },
        { role: 'assistant', content: 'dup-reply', receivedAt: 1_700_000_036_000 },
        { role: 'assistant', content: 'dup-reply', receivedAt: 1_700_000_036_000 },
      ],
      'Lambda Session',
      undefined,
      '20260417_030306_lambda',
    )
    expect(listSavedHistorySessions('hermes-cli').sessions[0]).toMatchObject({ historySessionId: '20260417_030306_lambda' })
    expect(fs.existsSync(buildHistoryIndexPath('hermes-cli'))).toBe(true)

    writer.compactHistorySession('hermes-cli', '20260417_030306_lambda')
    expect(fs.existsSync(buildHistoryIndexPath('hermes-cli'))).toBe(false)
  })

  it('uses provider-owned native history scripts without daemon format adapters', async () => {
    const historySessionId = 'provider-owned-session'
    const { listProviderHistorySessions, materializeProviderNativeHistory, readChatHistory, readProviderChatHistory } = await import('../../src/config/chat-history.js')
    const canonicalHistory = {
      format: 'opaque-provider-native-format',
      mode: 'native-source' as const,
      scripts: { readSession: 'readNativeHistory', listSessions: 'listNativeHistory' },
    }
    const scripts = {
      readNativeHistory: (input: any) => ({
        sourcePath: '/provider/native/session.jsonl',
        sourceMtimeMs: 1_800_000_000_000,
        messages: [
          { role: 'system', kind: 'session_start', content: input.workspace, receivedAt: 1_800_000_000_000, workspace: input.workspace },
          { role: 'user', content: 'script native user', receivedAt: 1_800_000_001_000 },
          { role: 'assistant', kind: 'tool', senderName: 'Tool', content: 'script native tool', receivedAt: 1_800_000_002_000 },
          { role: 'assistant', content: 'script native assistant', receivedAt: 1_800_000_003_000 },
        ],
      }),
      listNativeHistory: () => ({
        sessions: [{
          historySessionId,
          messageCount: 3,
          firstMessageAt: 1_800_000_001_000,
          lastMessageAt: 1_800_000_003_000,
          preview: 'script native assistant',
          workspace: '/workspaces/provider-owned',
          sourcePath: '/provider/native/session.jsonl',
          sourceMtimeMs: 1_800_000_000_000,
        }],
      }),
    }

    const read = readProviderChatHistory('opaque-cli', {
      canonicalHistory,
      scripts,
      historySessionId,
      workspace: '/workspaces/provider-owned',
      offset: 0,
      limit: 20,
    })
    expect(read).toMatchObject({ source: 'provider-native', sourcePath: '/provider/native/session.jsonl', sourceMtimeMs: 1_800_000_000_000 })
    expect(read.messages.map(message => ({ role: message.role, kind: message.kind, content: message.content }))).toEqual([
      { role: 'system', kind: 'session_start', content: '/workspaces/provider-owned' },
      { role: 'user', kind: 'standard', content: 'script native user' },
      { role: 'assistant', kind: 'tool', content: 'script native tool' },
      { role: 'assistant', kind: 'standard', content: 'script native assistant' },
    ])

    const listed = listProviderHistorySessions('opaque-cli', { canonicalHistory, scripts, offset: 0, limit: 20 })
    expect(listed).toMatchObject({ source: 'provider-native', hasMore: false })
    expect(listed.sessions).toEqual([expect.objectContaining({
      historySessionId,
      preview: 'script native assistant',
      sourcePath: '/provider/native/session.jsonl',
    })])

    expect(materializeProviderNativeHistory('opaque-cli', { ...canonicalHistory, mode: 'materialized-mirror' }, historySessionId, '/workspaces/provider-owned', scripts)).toBe(true)
    expect(readChatHistory('opaque-cli', 0, 20, historySessionId).messages.map(message => message.content)).toEqual([
      '/workspaces/provider-owned',
      'script native user',
      'script native tool',
      'script native assistant',
    ])
  })

  it('allows provider-native history reads to resolve by workspace before a session id is known', async () => {
    const { readProviderChatHistory } = await import('../../src/config/chat-history.js')
    const canonicalHistory = {
      format: 'opaque-provider-native-format',
      mode: 'native-source' as const,
      scripts: { readSession: 'readNativeHistory', listSessions: 'listNativeHistory' },
    }
    const scripts = {
      readNativeHistory: vi.fn((input: any) => ({
        sourcePath: '/provider/native/workspace-session.jsonl',
        sourceMtimeMs: 1_800_000_010_000,
        messages: [
          { role: 'system', kind: 'session_start', content: input.workspace, receivedAt: 1_800_000_010_000, workspace: input.workspace, historySessionId: 'resolved-native-session' },
          { role: 'assistant', content: 'native assistant from workspace lookup', receivedAt: 1_800_000_011_000, historySessionId: 'resolved-native-session' },
        ],
      })),
      listNativeHistory: vi.fn(),
    }

    const read = readProviderChatHistory('opaque-cli', {
      canonicalHistory,
      scripts,
      workspace: '/workspaces/provider-owned',
      offset: 0,
      limit: 20,
    })

    expect(scripts.readNativeHistory).toHaveBeenCalledWith(expect.objectContaining({
      historySessionId: '',
      sessionId: '',
      workspace: '/workspaces/provider-owned',
    }))
    expect(read).toMatchObject({ source: 'provider-native', sourcePath: '/provider/native/workspace-session.jsonl' })
    expect(read.messages.map(message => message.content)).toEqual([
      '/workspaces/provider-owned',
      'native assistant from workspace lookup',
    ])
  })

  it('persists session-level saved-history aggregates inside the on-disk index', async () => {
    const { ChatHistoryWriter } = await import('../../src/config/chat-history.js')
    const writer = new ChatHistoryWriter()
    writer.writeSessionStart('hermes-cli', '20260417_030304_eta', '/workspaces/eta')
    writer.appendNewMessages(
      'hermes-cli',
      [
        { role: 'user', content: 'eta-user', receivedAt: 1_700_000_032_000 },
        { role: 'assistant', content: 'eta-assistant', receivedAt: 1_700_000_033_000 },
      ],
      'Eta Session',
      undefined,
      '20260417_030304_eta',
    )

    const persisted = JSON.parse(fs.readFileSync(buildHistoryIndexPath('hermes-cli'), 'utf-8')) as {
      sessions?: Record<string, { historySessionId: string; messageCount: number; workspace?: string; preview?: string }>
    }
    expect(persisted.sessions?.['20260417_030304_eta']).toMatchObject({
      historySessionId: '20260417_030304_eta',
      messageCount: 2,
      workspace: '/workspaces/eta',
      preview: 'eta-assistant',
    })
  })

  it('exposes a rollup threshold helper for oversized saved-history sessions', async () => {
    const { shouldScheduleSavedHistoryRollup } = await import('../../src/config/chat-history.js')
    expect(shouldScheduleSavedHistoryRollup(1024)).toBe(false)
    expect(shouldScheduleSavedHistoryRollup(20 * 1024 * 1024)).toBe(true)
  })

  it('merges saved-history index updates after an existing writer lock is released', async () => {
    const lockPath = buildHistoryIndexLockPath('hermes-cli')
    fs.mkdirSync(lockPath, { recursive: true })

    const child = spawnHistoryWriterProcess('20260417_050505_epsilon', '/workspaces/epsilon', [
      { role: 'user', content: 'from-child', receivedAt: 1_700_000_040_000 },
      { role: 'assistant', content: 'child-reply', receivedAt: 1_700_000_041_000 },
    ])

    await new Promise(resolve => setTimeout(resolve, 100))
    writeSavedHistoryIndex('hermes-cli', {
      '20260417_060606_zeta_2026-04-17.jsonl': {
        signature: '20260417_060606_zeta_2026-04-17.jsonl:123:1700000000',
        summary: {
          file: '20260417_060606_zeta_2026-04-17.jsonl',
          historySessionId: '20260417_060606_zeta',
          messageCount: 1,
          firstMessageAt: 1_700_000_042_000,
          lastMessageAt: 1_700_000_042_000,
          sessionTitle: 'Existing Session',
          preview: 'existing-preview',
          workspace: '/workspaces/zeta',
        },
      },
    })
    fs.rmSync(lockPath, { recursive: true, force: true })

    const result = await waitForChild(child)
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')

    const persisted = JSON.parse(fs.readFileSync(buildHistoryIndexPath('hermes-cli'), 'utf-8')) as { files: Record<string, unknown> }
    const persistedKeys = Object.keys(persisted.files).sort()
    expect(persistedKeys).toContain('20260417_060606_zeta_2026-04-17.jsonl')
    expect(persistedKeys.some(key => key.startsWith('20260417_050505_epsilon_') && key.endsWith('.jsonl'))).toBe(true)
  }, 60000)

  it('updates the saved-history index during append writes so first open after reload stays fast', async () => {
    const { ChatHistoryWriter } = await import('../../src/config/chat-history.js')
    const writer = new ChatHistoryWriter()
    writer.writeSessionStart('hermes-cli', '20260417_040404_delta', '/workspaces/adhdev')
    writer.appendNewMessages(
      'hermes-cli',
      [
        { role: 'user', content: 'hello', receivedAt: 1_700_000_030_000 },
        { role: 'assistant', content: 'world', receivedAt: 1_700_000_031_000 },
      ],
      'History Session',
      undefined,
      '20260417_040404_delta',
    )

    expect(fs.existsSync(buildHistoryIndexPath('hermes-cli'))).toBe(true)

    vi.resetModules()
    const filePath = findHistoryFilePath('hermes-cli', '20260417_040404_delta')
    fs.chmodSync(filePath, 0o000)
    try {
      const reloaded = await import('../../src/config/chat-history.js')
      const listed = reloaded.listSavedHistorySessions('hermes-cli')
      expect(listed.sessions[0]).toMatchObject({
        historySessionId: '20260417_040404_delta',
        messageCount: 2,
        workspace: '/workspaces/adhdev',
        preview: 'world',
      })
    } finally {
      fs.chmodSync(filePath, 0o600)
    }
  })

  it('persists a saved-history index and reuses it across module reloads', async () => {
    const filePath = writeHistorySession('hermes-cli', '20260417_030303_gamma', 2)
    const { listSavedHistorySessions } = await import('../../src/config/chat-history.js')

    const first = listSavedHistorySessions('hermes-cli')
    expect(first.sessions[0]).toMatchObject({ historySessionId: '20260417_030303_gamma', messageCount: 2 })
    expect(fs.existsSync(buildHistoryIndexPath('hermes-cli'))).toBe(true)

    vi.resetModules()
    fs.chmodSync(filePath, 0o000)
    try {
      const reloaded = await import('../../src/config/chat-history.js')
      const second = reloaded.listSavedHistorySessions('hermes-cli')
      expect(second.sessions[0]).toMatchObject({ historySessionId: '20260417_030303_gamma', messageCount: 2 })
    } finally {
      fs.chmodSync(filePath, 0o600)
    }
  })

  it('reuses cached saved-session summaries until a history file changes', async () => {
    const filePath = writeHistorySession('hermes-cli', '20260417_010101_alpha', 2)
    const { listSavedHistorySessions } = await import('../../src/config/chat-history.js')

    const first = listSavedHistorySessions('hermes-cli')
    expect(first.sessions[0]).toMatchObject({ historySessionId: '20260417_010101_alpha', messageCount: 2 })

    fs.chmodSync(filePath, 0o000)
    const second = listSavedHistorySessions('hermes-cli')
    expect(second.sessions[0]).toMatchObject({ historySessionId: '20260417_010101_alpha', messageCount: 2 })

    fs.chmodSync(filePath, 0o600)
    fs.appendFileSync(filePath, `${JSON.stringify({
      ts: new Date(1_700_000_010_000).toISOString(),
      receivedAt: 1_700_000_010_000,
      role: 'assistant',
      content: 'msg-3',
      agent: 'hermes-cli',
      historySessionId: '20260417_010101_alpha',
      sessionTitle: 'History Session',
    })}\n`, 'utf-8')

    const third = listSavedHistorySessions('hermes-cli')
    expect(third.sessions[0]).toMatchObject({ historySessionId: '20260417_010101_alpha', messageCount: 3 })
  })

  it('reuses unchanged file summaries when another saved-history file changes', async () => {
    const firstFilePath = writeHistorySession('hermes-cli', '20260417_101010_alpha', 2)
    const secondFilePath = writeHistorySession('hermes-cli', '20260417_202020_beta', 1)
    const { listSavedHistorySessions } = await import('../../src/config/chat-history.js')

    const first = listSavedHistorySessions('hermes-cli')
    expect(first.sessions.map(session => session.historySessionId).sort()).toEqual([
      '20260417_101010_alpha',
      '20260417_202020_beta',
    ])

    fs.chmodSync(firstFilePath, 0o000)
    fs.appendFileSync(secondFilePath, `${JSON.stringify({
      ts: new Date(1_700_000_020_000).toISOString(),
      receivedAt: 1_700_000_020_000,
      role: 'assistant',
      content: 'msg-2',
      agent: 'hermes-cli',
      historySessionId: '20260417_202020_beta',
      sessionTitle: 'History Session',
    })}\n`, 'utf-8')

    const second = listSavedHistorySessions('hermes-cli')
    expect(second.sessions).toHaveLength(2)
    expect(second.sessions.find(session => session.historySessionId === '20260417_101010_alpha')).toMatchObject({
      messageCount: 2,
    })
    expect(second.sessions.find(session => session.historySessionId === '20260417_202020_beta')).toMatchObject({
      messageCount: 2,
    })
  })

  it('bounded-tail read returns the same last-N messages as a full read+slice across multiple history files', async () => {
    // 5 daily files, 250 messages total — the bounded path must span files.
    const total = writeHistorySessionAcrossDates('hermes-cli', 'history-multi', [
      { date: '2026-04-13', count: 50 },
      { date: '2026-04-14', count: 50 },
      { date: '2026-04-15', count: 50 },
      { date: '2026-04-16', count: 50 },
      { date: '2026-04-17', count: 50 },
    ])
    expect(total).toBe(250)
    const { readChatHistory } = await import('../../src/config/chat-history.js')

    // Full read (large limit triggers the unbounded path) then slice the tail.
    const full = readChatHistory('hermes-cli', 0, Number.MAX_SAFE_INTEGER, 'history-multi')
    expect(full.messages).toHaveLength(250)

    for (const tail of [1, 30, 60, 200]) {
      const bounded = readChatHistory('hermes-cli', 0, tail, 'history-multi')
      const expected = full.messages.slice(-tail)
      expect(bounded.messages.map(m => m.content)).toEqual(expected.map(m => m.content))
      expect(bounded.hasMore).toBe(tail < 250)
    }

    // Equivalence must also hold with an excludeRecentCount window (older-page reads).
    const boundedExclude = readChatHistory('hermes-cli', 0, 30, 'history-multi', 40)
    const fullExcludeEnd = full.messages.length - 40
    const expectedExclude = full.messages.slice(Math.max(0, fullExcludeEnd - 30), fullExcludeEnd)
    expect(boundedExclude.messages.map(m => m.content)).toEqual(expectedExclude.map(m => m.content))
  })

  it('serves an unchanged bounded-tail read from cache and refreshes it after an append', async () => {
    const filePath = writeHistorySession('hermes-cli', 'history-cache', 80)
    const { readChatHistory } = await import('../../src/config/chat-history.js')

    const first = readChatHistory('hermes-cli', 0, 30, 'history-cache')
    expect(first.messages.map(m => m.content)).toEqual(
      Array.from({ length: 30 }, (_, i) => `msg-${i + 51}`),
    )

    // Make the file unreadable: a cache HIT must still return the same tail
    // without touching disk content.
    fs.chmodSync(filePath, 0o000)
    const cached = readChatHistory('hermes-cli', 0, 30, 'history-cache')
    fs.chmodSync(filePath, 0o600)
    expect(cached.messages.map(m => m.content)).toEqual(first.messages.map(m => m.content))

    // Appending changes the size+mtime signature, so the next read must refresh.
    fs.appendFileSync(filePath, `${JSON.stringify({
      ts: new Date(1_700_000_000_000 + 80 * 1000).toISOString(),
      receivedAt: 1_700_000_000_000 + 80 * 1000,
      role: 'user',
      content: 'msg-81',
      agent: 'hermes-cli',
      historySessionId: 'history-cache',
      sessionTitle: 'History Session',
    })}\n`, 'utf-8')

    const refreshed = readChatHistory('hermes-cli', 0, 30, 'history-cache')
    expect(refreshed.messages[refreshed.messages.length - 1].content).toBe('msg-81')
    expect(refreshed.messages.map(m => m.content)).toEqual(
      Array.from({ length: 30 }, (_, i) => `msg-${i + 52}`),
    )
  })

  // Build a single daily file whose JSON content per line is padded so the file
  // comfortably exceeds the reverse-seek small-file threshold (64KB), forcing the
  // byte-level reverse tail-seek path rather than a full readFileSync.
  function writeLargeSingleDaySession(agentType: string, historySessionId: string, count: number, padBytes = 600) {
    const filePath = buildHistoryFilePath(agentType, historySessionId)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const lines = Array.from({ length: count }, (_, index) => JSON.stringify({
      ts: new Date(1_700_000_000_000 + index * 1000).toISOString(),
      receivedAt: 1_700_000_000_000 + index * 1000,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `msg-${index + 1}-${'x'.repeat(padBytes)}`,
      agent: agentType,
      historySessionId,
      sessionTitle: 'History Session',
    }))
    fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf-8')
    return filePath
  }

  it('reverse-seeks the tail of a large single-day file and returns exactly the newest N', async () => {
    const count = 400
    const filePath = writeLargeSingleDaySession('hermes-cli', 'history-big', count)
    expect(fs.statSync(filePath).size).toBeGreaterThan(64 * 1024)
    const { readChatHistory } = await import('../../src/config/chat-history.js')

    for (const tail of [1, 30, 60]) {
      const bounded = readChatHistory('hermes-cli', 0, tail, 'history-big')
      expect(bounded.messages.map(m => m.content)).toEqual(
        Array.from({ length: tail }, (_, i) => `msg-${count - tail + i + 1}-${'x'.repeat(600)}`),
      )
      // Older messages remain inside this same large file, so hasMore is true.
      expect(bounded.hasMore).toBe(true)
    }
  })

  it('refreshes the bounded tail incrementally after an append without losing prior records', async () => {
    const count = 400
    const filePath = writeLargeSingleDaySession('hermes-cli', 'history-grow', count)
    const { readChatHistory } = await import('../../src/config/chat-history.js')

    const first = readChatHistory('hermes-cli', 0, 30, 'history-grow')
    expect(first.messages[first.messages.length - 1].content).toBe(`msg-${count}-${'x'.repeat(600)}`)

    // Append two new records (append-only growth) and ensure the next tail window
    // includes the new records while still retaining the prior ones.
    for (const idx of [count, count + 1]) {
      fs.appendFileSync(filePath, `${JSON.stringify({
        ts: new Date(1_700_000_000_000 + idx * 1000).toISOString(),
        receivedAt: 1_700_000_000_000 + idx * 1000,
        role: idx % 2 === 0 ? 'user' : 'assistant',
        content: `msg-${idx + 1}-${'x'.repeat(600)}`,
        agent: 'hermes-cli',
        historySessionId: 'history-grow',
        sessionTitle: 'History Session',
      })}\n`, 'utf-8')
    }

    const refreshed = readChatHistory('hermes-cli', 0, 30, 'history-grow')
    expect(refreshed.messages.map(m => m.content)).toEqual(
      Array.from({ length: 30 }, (_, i) => `msg-${count - 28 + i + 1}-${'x'.repeat(600)}`),
    )
    // The newest two appended records are present.
    expect(refreshed.messages.map(m => m.content)).toContain(`msg-${count + 1}-${'x'.repeat(600)}`)
    expect(refreshed.messages.map(m => m.content)).toContain(`msg-${count + 2}-${'x'.repeat(600)}`)
  })

  it('preserves multibyte UTF-8 content across reverse-seek chunk boundaries', async () => {
    const filePath = buildHistoryFilePath('hermes-cli', 'history-utf8')
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    // Each line carries multibyte chars and is padded so the file spans multiple
    // 64KB reverse-read chunks, exercising the chunk-boundary stitching.
    const count = 300
    const lines = Array.from({ length: count }, (_, index) => JSON.stringify({
      ts: new Date(1_700_000_000_000 + index * 1000).toISOString(),
      receivedAt: 1_700_000_000_000 + index * 1000,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `메시지-${index + 1}-日本語-😀-${'가'.repeat(400)}`,
      agent: 'hermes-cli',
      historySessionId: 'history-utf8',
      sessionTitle: 'History Session',
    }))
    fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf-8')
    expect(fs.statSync(filePath).size).toBeGreaterThan(64 * 1024)
    const { readChatHistory } = await import('../../src/config/chat-history.js')

    const bounded = readChatHistory('hermes-cli', 0, 30, 'history-utf8')
    expect(bounded.messages.map(m => m.content)).toEqual(
      Array.from({ length: 30 }, (_, i) => `메시지-${count - 30 + i + 1}-日本語-😀-${'가'.repeat(400)}`),
    )
  })

  it('handles small, empty, and unterminated-final-line files on the bounded path', async () => {
    const { readChatHistory } = await import('../../src/config/chat-history.js')

    // Empty file.
    const emptyPath = buildHistoryFilePath('hermes-cli', 'history-empty')
    fs.mkdirSync(path.dirname(emptyPath), { recursive: true })
    fs.writeFileSync(emptyPath, '', 'utf-8')
    expect(readChatHistory('hermes-cli', 0, 30, 'history-empty').messages).toEqual([])

    // Small file (well under the reverse-seek threshold) with a trailing partial
    // line that has no terminating newline — it must still be parsed.
    const smallPath = buildHistoryFilePath('hermes-cli', 'history-small')
    const a = JSON.stringify({ ts: new Date(1_700_000_000_000).toISOString(), receivedAt: 1_700_000_000_000, role: 'user', content: 'small-1', agent: 'hermes-cli', historySessionId: 'history-small', sessionTitle: 'S' })
    const b = JSON.stringify({ ts: new Date(1_700_000_001_000).toISOString(), receivedAt: 1_700_000_001_000, role: 'assistant', content: 'small-2', agent: 'hermes-cli', historySessionId: 'history-small', sessionTitle: 'S' })
    fs.writeFileSync(smallPath, `${a}\n${b}`, 'utf-8') // no trailing newline
    const small = readChatHistory('hermes-cli', 0, 30, 'history-small')
    expect(small.messages.map(m => m.content)).toEqual(['small-1', 'small-2'])
    expect(small.hasMore).toBe(false)
  })

  it('lists all non-empty saved-history sessions regardless of provider-specific ID format', async () => {
    writeHistorySession('hermes-cli', '20260417_101010_alpha', 1)
    writeHistorySession('hermes-cli', 'vi', 3)
    const { listSavedHistorySessions } = await import('../../src/config/chat-history.js')

    const listed = listSavedHistorySessions('hermes-cli')
    // Session ID format validation is the responsibility of the provider's sessionIdPattern,
    // not the history store. Both sessions are returned; callers filter by pattern if needed.
    expect(listed.sessions.map(session => session.historySessionId).sort()).toEqual(['20260417_101010_alpha', 'vi'])
  })
})
