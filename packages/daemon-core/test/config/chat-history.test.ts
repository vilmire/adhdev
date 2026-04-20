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

  it('rebuilds a polluted hermes saved-history session from the canonical ~/.hermes session file', async () => {
    const historySessionId = '20260420_095128_ae3acd'
    const pollutedPath = buildHistoryFilePath('hermes-cli', historySessionId, '2026-04-20')
    fs.mkdirSync(path.dirname(pollutedPath), { recursive: true })
    fs.writeFileSync(pollutedPath, [
      JSON.stringify({
        ts: new Date(1_700_000_000_000).toISOString(),
        receivedAt: 1_700_000_000_000,
        role: 'system',
        kind: 'session_start',
        content: '/workspaces/adhdev',
        agent: 'hermes-cli',
        historySessionId,
        workspace: '/workspaces/adhdev',
      }),
      JSON.stringify({
        ts: new Date(1_700_000_001_000).toISOString(),
        receivedAt: 1_700_000_001_000,
        role: 'user',
        kind: 'standard',
        content: 'duplicated prompt',
        agent: 'hermes-cli',
        historySessionId,
      }),
      JSON.stringify({
        ts: new Date(1_700_000_002_000).toISOString(),
        receivedAt: 1_700_000_002_000,
        role: 'assistant',
        kind: 'tool',
        content: 'duplicated tool',
        senderName: 'Tool',
        agent: 'hermes-cli',
        historySessionId,
      }),
      JSON.stringify({
        ts: new Date(1_700_000_003_000).toISOString(),
        receivedAt: 1_700_000_003_000,
        role: 'user',
        kind: 'standard',
        content: 'duplicated prompt',
        agent: 'hermes-cli',
        historySessionId,
      }),
    ].join('\n') + '\n', 'utf-8')

    const hermesDir = path.join(mockHomeDir, '.hermes', 'sessions')
    fs.mkdirSync(hermesDir, { recursive: true })
    fs.writeFileSync(path.join(hermesDir, `session_${historySessionId}.json`), JSON.stringify({
      session_id: historySessionId,
      session_start: '2026-04-20T09:52:10.792817',
      last_updated: '2026-04-20T09:54:51.287447',
      messages: [
        { role: 'user', content: 'canonical user prompt' },
        { role: 'assistant', content: 'canonical assistant reply' },
        { role: 'tool', content: 'canonical tool output' },
      ],
    }), 'utf-8')

    const { rebuildHermesSavedHistoryFromCanonicalSession, readChatHistory } = await import('../../src/config/chat-history.js')
    expect(rebuildHermesSavedHistoryFromCanonicalSession(historySessionId)).toBe(true)

    const rebuilt = readChatHistory('hermes-cli', 0, 20, historySessionId)
    expect(rebuilt.messages.map(message => ({ role: message.role, kind: message.kind, content: message.content }))).toEqual([
      { role: 'system', kind: 'session_start', content: '/workspaces/adhdev' },
      { role: 'user', kind: 'standard', content: 'canonical user prompt' },
      { role: 'assistant', kind: 'standard', content: 'canonical assistant reply' },
      { role: 'assistant', kind: 'tool', content: 'canonical tool output' },
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
  })

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

  it('skips invalid legacy Hermes saved-history filenames when listing resumable sessions', async () => {
    writeHistorySession('hermes-cli', '20260417_101010_alpha', 1)
    writeHistorySession('hermes-cli', 'vi', 3)
    const { listSavedHistorySessions } = await import('../../src/config/chat-history.js')

    const listed = listSavedHistorySessions('hermes-cli')
    expect(listed.sessions.map(session => session.historySessionId)).toEqual(['20260417_101010_alpha'])
  })
})
