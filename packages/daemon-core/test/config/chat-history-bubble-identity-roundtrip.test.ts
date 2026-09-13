/**
 * (BUBBLE-IDENTITY) `appendNewMessages` -> `readChatHistory` round trip.
 *
 * The incremental-append writer is the ONLY hop between a PTY-parsed tail and
 * the on-disk JSONL, and read-back is a passthrough (JSON.parse ->
 * sanitizeHistoryMessage spreads `...message`). So an identity field the writer
 * omits is unrecoverable: every downstream activeChat / persisted-tail remap
 * only carries what it is handed, and the bubble falls back to an index-derived
 * React key that renumbers as the tail grows.
 *
 * Revert the `...carryBubbleIdentity(msg)` spread in `appendNewMessages` and the
 * first test here goes red on all five identity fields.
 *
 * The second test pins the deliberate exclusion: `toolBlockRef` is sealed by
 * `sourceMtimeMs`, and `expandToolBlock` fails closed with `source_changed` when
 * the seal no longer matches — so persisting it would render an expand control
 * that is guaranteed dead after the source file is next touched.
 */

import * as fs from 'fs'
import * as os from 'os'
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

describe('chat history bubble-identity round trip', () => {
  beforeEach(() => {
    mockHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-history-identity-'))
    vi.resetModules()
  })

  afterEach(() => {
    fs.rmSync(mockHomeDir, { recursive: true, force: true })
  })

  it('persists the producer-minted bubble identity across an append/read round trip', async () => {
    const { ChatHistoryWriter, readChatHistory } = await import('../../src/config/chat-history.js')
    const historySessionId = 'identity-roundtrip-session'
    const writer = new ChatHistoryWriter()

    writer.appendNewMessages(
      'hermes-cli',
      [{
        role: 'assistant',
        content: 'answer with identity',
        receivedAt: 1_800_000_000_000,
        kind: 'standard',
        providerUnitKey: 'unit-42',
        bubbleId: 'bubble-42',
        sequence: 7,
        _turnKey: 'turn-3',
        bubbleState: 'complete',
      }],
      'Identity Session',
      undefined,
      historySessionId,
    )

    const restored = readChatHistory('hermes-cli', 0, 30, historySessionId)
    const message = restored.messages.find(m => m.content === 'answer with identity')

    expect(message).toBeDefined()
    expect(message).toMatchObject({
      providerUnitKey: 'unit-42',
      bubbleId: 'bubble-42',
      sequence: 7,
      _turnKey: 'turn-3',
      bubbleState: 'complete',
    })
  })

  it('does not add undefined identity keys to a bubble that never carried them', async () => {
    const { ChatHistoryWriter, readChatHistory } = await import('../../src/config/chat-history.js')
    const historySessionId = 'identity-absent-session'
    const writer = new ChatHistoryWriter()

    writer.appendNewMessages(
      'hermes-cli',
      [{ role: 'user', content: 'plain prose bubble', receivedAt: 1_800_000_001_000 }],
      'Identity Session',
      undefined,
      historySessionId,
    )

    const restored = readChatHistory('hermes-cli', 0, 30, historySessionId)
    const message = restored.messages.find(m => m.content === 'plain prose bubble') as Record<string, unknown>

    expect(message).toBeDefined()
    for (const field of ['providerUnitKey', 'bubbleId', 'sequence', '_turnKey', 'bubbleState']) {
      expect(Object.prototype.hasOwnProperty.call(message, field)).toBe(false)
    }
  })

  it('never persists a toolBlockRef, whose mtime seal cannot survive the write', async () => {
    const { ChatHistoryWriter, readChatHistory } = await import('../../src/config/chat-history.js')
    const historySessionId = 'identity-toolref-session'
    const writer = new ChatHistoryWriter()

    writer.appendNewMessages(
      'hermes-cli',
      [{
        role: 'assistant',
        content: '↗ Bash: some truncated command',
        receivedAt: 1_800_000_002_000,
        kind: 'tool',
        bubbleId: 'bubble-tool-1',
        // Deliberately supplied by the caller; the writer must drop it.
        toolBlockRef: { sourceMtimeMs: 1_700_000_000_000, recordIndex: 3, blockIndex: 1 },
      } as any],
      'Identity Session',
      undefined,
      historySessionId,
    )

    const restored = readChatHistory('hermes-cli', 0, 30, historySessionId)
    const message = restored.messages.find(m => m.kind === 'tool') as Record<string, unknown>

    expect(message).toBeDefined()
    // Identity still rides through...
    expect(message.bubbleId).toBe('bubble-tool-1')
    // ...but the mtime-sealed ref does not.
    expect(Object.prototype.hasOwnProperty.call(message, 'toolBlockRef')).toBe(false)
  })
})
