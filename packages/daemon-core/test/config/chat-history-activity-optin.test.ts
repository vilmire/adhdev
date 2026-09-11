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

/**
 * chat_history activity opt-in (activity supply wiring, lane ③).
 *
 * `readChatHistory`/`readProviderChatHistory` gained an `excludeActivity`
 * flag; the chat_history command passes `excludeActivity: !includeActivity`
 * so the SAME dashboard toggle drives the live tail and "Load older" pages.
 * The filter is applied BEFORE paging so offset/limit arithmetic operates in
 * the message space the caller receives.
 */
function writeMixedHistorySession(agentType: string, historySessionId: string) {
  const filePath = path.join(mockHomeDir, '.adhdev', 'history', agentType, `${historySessionId}_2026-04-17.jsonl`)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const rows = [
    { role: 'user', kind: 'standard', content: 'prose-1' },
    { role: 'assistant', kind: 'tool', content: 'tool-1' },
    { role: 'assistant', kind: 'thought', content: 'thought-1' },
    { role: 'assistant', kind: 'standard', content: 'prose-2' },
    { role: 'user', kind: 'standard', content: 'prose-3' },
    { role: 'assistant', kind: 'terminal', content: 'terminal-1' },
    { role: 'assistant', kind: 'standard', content: 'prose-4' },
  ]
  const lines = rows.map((row, index) => JSON.stringify({
    ts: new Date(1_700_000_000_000 + index * 1000).toISOString(),
    receivedAt: 1_700_000_000_000 + index * 1000,
    agent: agentType,
    historySessionId,
    sessionTitle: 'Mixed Session',
    ...row,
  }))
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf-8')
}

describe('chat-history activity opt-in', () => {
  beforeEach(() => {
    mockHomeDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-chat-history-activity-'))
    process.env.ADHDEV_CONFIG_DIR = path.join(mockHomeDir, '.adhdev')
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.ADHDEV_CONFIG_DIR
    if (mockHomeDir) fs.rmSync(mockHomeDir, { recursive: true, force: true })
    mockHomeDir = ''
  })

  it('excludeActivity drops tool/terminal/thought rows and pages in prose space', async () => {
    writeMixedHistorySession('hermes-cli', 'history-mixed')
    const { readChatHistory } = await import('../../src/config/chat-history.js')

    const page = readChatHistory('hermes-cli', 0, 30, 'history-mixed', 0, undefined, undefined, true)

    expect(page.messages.map(message => message.content)).toEqual(['prose-1', 'prose-2', 'prose-3', 'prose-4'])
    expect(page.hasMore).toBe(false)
  })

  it('default (no excludeActivity) keeps activity rows — legacy caller behavior unchanged', async () => {
    writeMixedHistorySession('hermes-cli', 'history-mixed')
    const { readChatHistory } = await import('../../src/config/chat-history.js')

    const page = readChatHistory('hermes-cli', 0, 30, 'history-mixed')

    expect(page.messages.map(message => message.content)).toEqual([
      'prose-1', 'tool-1', 'thought-1', 'prose-2', 'prose-3', 'terminal-1', 'prose-4',
    ])
  })

  it('bounded-tail cache keys the two projections separately (no cross-toggle bleed)', async () => {
    writeMixedHistorySession('hermes-cli', 'history-mixed')
    const { readChatHistory } = await import('../../src/config/chat-history.js')

    // Same (offset, limit, exclude) window, opposite activity projections —
    // both bounded-tail reads must return their own content, not the other's
    // cached page.
    const withActivity = readChatHistory('hermes-cli', 0, 5, 'history-mixed')
    const withoutActivity = readChatHistory('hermes-cli', 0, 5, 'history-mixed', 0, undefined, undefined, true)

    expect(withActivity.messages.some(message => message.kind === 'terminal' || message.kind === 'thought' || message.kind === 'tool')).toBe(true)
    expect(withoutActivity.messages.every(message => message.kind !== 'tool' && message.kind !== 'terminal' && message.kind !== 'thought')).toBe(true)
  })

  it('paging with excludeActivity slices in the filtered space (limit counts prose rows only)', async () => {
    writeMixedHistorySession('hermes-cli', 'history-mixed')
    const { readChatHistory } = await import('../../src/config/chat-history.js')

    const firstPage = readChatHistory('hermes-cli', 0, 2, 'history-mixed', 0, undefined, undefined, true)
    const secondPage = readChatHistory('hermes-cli', 2, 2, 'history-mixed', 0, undefined, undefined, true)

    expect(firstPage.messages.map(message => message.content)).toEqual(['prose-3', 'prose-4'])
    expect(firstPage.hasMore).toBe(true)
    expect(secondPage.messages.map(message => message.content)).toEqual(['prose-1', 'prose-2'])
  })
})
