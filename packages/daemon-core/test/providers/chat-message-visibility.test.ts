import { describe, expect, it } from 'vitest'
import {
  classifyChatMessageVisibility,
  filterActivityChatMessages,
  filterChatMessagesByVisibility,
  filterInternalChatMessages,
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
      message({ role: 'assistant', content: 'status-only row', source: 'runtime_status' }),
      message({ role: 'assistant', content: 'internal runtime activity', source: 'runtime_activity' }),
      message({ role: 'assistant', content: 'top-level internal transcript row', transcriptVisibility: 'internal' }),
      message({ role: 'assistant', content: 'reasoning progress', meta: { visibility: 'debug' } }),
      message({ role: 'assistant', content: 'tool trace row', audience: 'trace' }),
      message({ role: 'assistant', content: 'provider title row', meta: { source: 'provider_chrome' } }),
      message({ role: 'assistant', content: 'internal row', meta: { isInternal: true } }),
    ] as any[]

    expect(filterUserFacingChatMessages(rows).map(row => row.content)).toEqual(['real answer'])
  })

  it('classifies shared transcript surfaces for chat, activity, and internal consumers', () => {
    const rows = [
      message({ id: 'chat-user', role: 'user', content: 'prompt' }),
      message({ id: 'chat-answer', role: 'assistant', content: 'final answer' }),
      message({ id: 'runtime-standard', role: 'assistant', kind: 'standard', content: 'progress state', source: 'runtime_activity' }),
      message({ id: 'tool-call', role: 'assistant', kind: 'tool', content: 'tool payload' }),
      message({ id: 'terminal-command', role: 'assistant', kind: 'standard', content: 'command payload', meta: { source: 'terminal_command' } }),
      message({ id: 'control-row', role: 'assistant', kind: 'standard', content: 'control payload', source: 'control' }),
    ] as any[]

    expect(rows.map(row => [row.id, classifyChatMessageVisibility(row).surface])).toEqual([
      ['chat-user', 'chat'],
      ['chat-answer', 'chat'],
      ['runtime-standard', 'activity'],
      ['tool-call', 'activity'],
      ['terminal-command', 'activity'],
      ['control-row', 'internal'],
    ])
    expect(filterChatMessagesByVisibility(rows, 'chat').map(row => row.id)).toEqual(['chat-user', 'chat-answer'])
    expect(filterActivityChatMessages(rows).map(row => row.id)).toEqual(['runtime-standard', 'tool-call', 'terminal-command'])
    expect(filterInternalChatMessages(rows).map(row => row.id)).toEqual(['control-row'])
  })

  it('allows explicit positive markers to make tool and terminal activity user-facing', () => {
    const rows = [
      message({ id: 'default-terminal', role: 'assistant', kind: 'terminal', content: 'default hidden terminal' }),
      message({ id: 'visible-terminal', role: 'assistant', kind: 'terminal', content: 'visible terminal', source: 'terminal_command', visibility: 'user' }),
      message({ id: 'visible-tool', role: 'assistant', kind: 'tool', content: 'visible tool', meta: { userFacing: true } }),
      message({ id: 'visible-source', role: 'assistant', kind: 'standard', content: 'visible source row', source: 'tool_call', audience: 'chat' }),
    ] as any[]

    expect(filterUserFacingChatMessages(rows).map(row => row.id)).toEqual(['visible-terminal', 'visible-tool', 'visible-source'])
  })
})
