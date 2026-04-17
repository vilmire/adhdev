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

  it('reuses cached saved-session summaries until a history file changes', async () => {
    const filePath = writeHistorySession('hermes-cli', 'history-1', 2)
    const { listSavedHistorySessions } = await import('../../src/config/chat-history.js')

    const first = listSavedHistorySessions('hermes-cli')
    expect(first.sessions[0]).toMatchObject({ historySessionId: 'history-1', messageCount: 2 })

    fs.chmodSync(filePath, 0o000)
    const second = listSavedHistorySessions('hermes-cli')
    expect(second.sessions[0]).toMatchObject({ historySessionId: 'history-1', messageCount: 2 })

    fs.chmodSync(filePath, 0o600)
    fs.appendFileSync(filePath, `${JSON.stringify({
      ts: new Date(1_700_000_010_000).toISOString(),
      receivedAt: 1_700_000_010_000,
      role: 'assistant',
      content: 'msg-3',
      agent: 'hermes-cli',
      historySessionId: 'history-1',
      sessionTitle: 'History Session',
    })}\n`, 'utf-8')

    const third = listSavedHistorySessions('hermes-cli')
    expect(third.sessions[0]).toMatchObject({ historySessionId: 'history-1', messageCount: 3 })
  })
})
