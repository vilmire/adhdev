import { describe, expect, it } from 'vitest'
import {
  filterUserFacingChatMessages,
  isUserFacingChatMessage,
} from '../../src/providers/chat-message-normalization.js'

const message = (overrides: Record<string, any>) => ({
  role: 'assistant',
  content: 'content',
  ...overrides,
})

describe('chat message transcript visibility', () => {
  it('keeps ordinary user and assistant text visible', () => {
    expect(isUserFacingChatMessage(message({ role: 'user', content: 'hello' }) as any)).toBe(true)
    expect(isUserFacingChatMessage(message({ role: 'human', content: 'hello' }) as any)).toBe(true)
    expect(isUserFacingChatMessage(message({ role: 'assistant', kind: 'standard', content: 'answer' }) as any)).toBe(true)
  })

  it('hides non-standard runtime rows by default', () => {
    expect(isUserFacingChatMessage(message({ role: 'assistant', kind: 'tool', senderName: 'Tool' }) as any)).toBe(false)
    expect(isUserFacingChatMessage(message({ role: 'assistant', kind: 'terminal', senderName: 'Terminal' }) as any)).toBe(false)
    expect(isUserFacingChatMessage(message({ role: 'assistant', kind: 'thought' }) as any)).toBe(false)
    expect(isUserFacingChatMessage(message({ role: 'system', kind: 'system', senderName: 'System' }) as any)).toBe(false)
  })

  it('honors explicit user-facing metadata for intentional tool and terminal output', () => {
    expect(isUserFacingChatMessage(message({
      role: 'assistant',
      kind: 'terminal',
      content: 'visible build output',
      meta: { transcriptVisibility: 'visible' },
    }) as any)).toBe(true)

    expect(isUserFacingChatMessage(message({
      role: 'assistant',
      kind: 'tool',
      content: 'visible tool result',
      meta: { userFacing: true },
    }) as any)).toBe(true)

    expect(isUserFacingChatMessage(message({
      role: 'assistant',
      kind: 'terminal',
      content: 'visible command result',
      visibility: 'user',
    }) as any)).toBe(true)

    expect(isUserFacingChatMessage(message({
      role: 'assistant',
      kind: 'tool',
      content: 'visible provider-authored activity',
      transcriptVisibility: 'chat',
    }) as any)).toBe(true)
  })

  it('hides internal/debug/provider chrome even when the kind looks standard', () => {
    const rows = [
      message({ role: 'assistant', content: 'real answer' }),
      message({ role: 'assistant', content: '· 1 background terminal running · /ps to view…', source: 'runtime_status' }),
      message({ role: 'assistant', content: 'internal runtime activity', source: 'runtime_activity' }),
      message({ role: 'assistant', content: 'top-level internal transcript row', transcriptVisibility: 'internal' }),
      message({ role: 'assistant', content: 'thinking with medium effort', meta: { visibility: 'debug' } }),
      message({ role: 'assistant', content: '⚡ mcp_adhdev_mesh_mesh_read_chat', audience: 'trace' }),
      message({ role: 'assistant', content: 'provider title row', meta: { source: 'provider_chrome' } }),
      message({ role: 'assistant', content: 'internal row', meta: { isInternal: true } }),
    ] as any[]

    expect(filterUserFacingChatMessages(rows).map(row => row.content)).toEqual(['real answer'])
  })
})
