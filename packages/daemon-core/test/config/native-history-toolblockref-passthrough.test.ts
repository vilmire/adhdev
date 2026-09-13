/**
 * (TOOL-EXPAND) toolBlockRef must survive the native-history normalizer.
 *
 * This is the hop the earlier round of activeChat fixes missed. Measured on a
 * live rc.24 daemon debug bundle (Mac, sourceMtimeMs non-zero so the mtime:0
 * guard was not in play):
 *
 *   .cli.debugSnapshot.messages            tool 57, truncated 31, toolBlockRef 31/31
 *   .instanceState.activeChat.messagesTail tool  7, truncated  1, toolBlockRef  0
 *
 * The two differ because they reach native history by DIFFERENT routes. The
 * adapter's debug snapshot calls `executeNativeHistory` directly and sees the
 * parser's output verbatim. Everything that feeds `activeChat.messages` instead
 * goes through the provider-loader-wired reader script:
 *
 *   readProviderChatHistory
 *     -> buildNativeHistoryReadResult
 *       -> callProviderNativeHistoryRead
 *         -> normalizeProviderNativeHistoryRecords   <-- the drop
 *           -> pageHistoryRecords -> sanitizeHistoryMessage
 *
 * `normalizeProviderNativeHistoryRecords` builds each record from an explicit
 * field literal and then re-attaches a named allow-list of extras
 * (providerUnitKey / bubbleId / sequence / _turnKey / bubbleState). It never
 * listed `toolBlockRef`, so the ref died here — BEFORE the activeChat and
 * persisted-tail remaps that the previous fix corrected. Those remaps can only
 * carry what they are handed, which is why fixing them alone left the live
 * projection at 0 refs.
 *
 * These tests drive the REAL exported read path rather than a mirror of the
 * remap, so deleting the passthrough makes them red.
 */

import * as fs from 'fs'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let mockHomeDir = ''

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => mockHomeDir }
})

const REF = { sourceMtimeMs: 1_789_320_245_057, recordIndex: 12, blockIndex: 3 }

/** A native reader script shaped like the provider-loader wiring of executeNativeHistory. */
function readerReturning(messages: unknown[]) {
  return {
    readNativeHistory: () => ({
      messages,
      sourcePath: '/tmp/ws/native.jsonl',
      sourceMtimeMs: REF.sourceMtimeMs,
      providerSessionId: 'sess-1',
    }),
  }
}

const CANONICAL = { format: 'jsonl', scripts: { readSession: 'readNativeHistory' } }

async function readNative(messages: unknown[]) {
  const { readProviderChatHistory } = await import('../../src/config/chat-history.js')
  return readProviderChatHistory('claude-cli', {
    canonicalHistory: CANONICAL as never,
    historySessionId: 'sess-1',
    workspace: '/tmp/ws',
    offset: 0,
    limit: 30,
    scripts: readerReturning(messages) as never,
  })
}

describe('(TOOL-EXPAND) native-history normalizer carries toolBlockRef', () => {
  beforeEach(() => {
    mockHomeDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-toolblockref-passthrough-'))
    process.env.ADHDEV_CONFIG_DIR = path.join(mockHomeDir, '.adhdev')
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.ADHDEV_CONFIG_DIR
    if (mockHomeDir) fs.rmSync(mockHomeDir, { recursive: true, force: true })
    mockHomeDir = ''
  })

  it('keeps the ref on a truncated tool bubble read through readProviderChatHistory', async () => {
    const result = await readNative([
      { role: 'user', content: 'run the build', kind: 'standard', receivedAt: 1_700_000_000_000 },
      { role: 'assistant', content: '↘ (truncated output)', kind: 'tool', receivedAt: 1_700_000_001_000, toolBlockRef: REF },
    ])

    expect(result.source).toBe('provider-native')
    const tool = result.messages.find((message) => message.kind === 'tool') as Record<string, unknown> | undefined
    expect(tool?.toolBlockRef).toEqual(REF)
  })

  it('reproduces the live bundle ratio — every truncated tool bubble keeps its ref', async () => {
    // The bundle's shape in miniature: prose bubbles interleaved with truncated
    // tool bubbles. The defect showed as in-refs > 0, out-refs === 0.
    const input = Array.from({ length: 10 }, (_, index) => (
      index % 2 === 0
        ? { role: 'assistant', content: `prose-${index}`, kind: 'standard', receivedAt: 1_700_000_000_000 + index }
        : {
            role: 'assistant',
            content: `↘ tool-${index} (truncated)`,
            kind: 'tool',
            receivedAt: 1_700_000_000_000 + index,
            toolBlockRef: { ...REF, recordIndex: index },
          }
    ))

    const inRefs = input.filter((message) => 'toolBlockRef' in message).length
    const result = await readNative(input)
    const outRefs = result.messages.filter((message) => (message as Record<string, unknown>).toolBlockRef).length

    expect(inRefs).toBe(5)
    expect(outRefs).toBe(inRefs)
  })

  it('does not invent an undefined toolBlockRef key on prose bubbles', async () => {
    const result = await readNative([
      { role: 'assistant', content: 'done', kind: 'standard', receivedAt: 1_700_000_000_000 },
    ])

    expect(Object.keys(result.messages[0] as object)).not.toContain('toolBlockRef')
  })

  it('holds the content boundary — the ref is re-read as exactly three integers', async () => {
    // A producer that smuggles a path or a text field into the ref must not get
    // it across this hop: toolBlockRef is allowed on the activeChat/P2P lane
    // precisely because it is content-free.
    const result = await readNative([
      {
        role: 'assistant',
        content: '↘ (truncated output)',
        kind: 'tool',
        receivedAt: 1_700_000_000_000,
        toolBlockRef: { ...REF, sourcePath: '/home/user/secret.jsonl', preview: 'leaked text' },
      },
    ])

    const ref = (result.messages[0] as Record<string, any>).toolBlockRef
    expect(Object.keys(ref).sort()).toEqual(['blockIndex', 'recordIndex', 'sourceMtimeMs'])
    for (const value of Object.values(ref)) expect(typeof value).toBe('number')
  })

  it('drops a malformed ref rather than passing a partial address downstream', async () => {
    // `expand_tool_block` cannot resolve a ref missing an index, and a bubble
    // carrying one would render an expand control that always fails.
    const result = await readNative([
      { role: 'assistant', content: '↘ (truncated output)', kind: 'tool', receivedAt: 1_700_000_000_000, toolBlockRef: { sourceMtimeMs: REF.sourceMtimeMs } },
    ])

    expect(Object.keys(result.messages[0] as object)).not.toContain('toolBlockRef')
  })

  it('keeps the bubble identity fields it already carried', async () => {
    // Regression fence for the neighbouring A2.3 passthrough: the ref addition
    // must not disturb the identity allow-list that was already correct here.
    const result = await readNative([
      {
        role: 'assistant',
        content: '↘ (truncated output)',
        kind: 'tool',
        receivedAt: 1_700_000_000_000,
        toolBlockRef: REF,
        providerUnitKey: 'u1',
        bubbleId: 'b1',
        sequence: 1,
        _turnKey: 'turn:0',
        bubbleState: 'final',
      },
    ])

    const message = result.messages[0] as Record<string, unknown>
    expect(message.providerUnitKey).toBe('u1')
    expect(message.bubbleId).toBe('b1')
    expect(message.sequence).toBe(1)
    expect(message._turnKey).toBe('turn:0')
    expect(message.bubbleState).toBe('final')
    expect(message.toolBlockRef).toEqual(REF)
  })
})
