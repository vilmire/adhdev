import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@adhdev/daemon-core'
import {
  CHAT_ACTIVITY_VISIBILITY_STORAGE_KEY,
  classifyChatMessageForDisplay,
  collapseAdjacentDuplicateChatMessages,
  filterChatActivityMessages,
  filterChatMessagesForDefaultTranscript,
  mergeChatAndActivityMessages,
  readChatActivityVisiblePreference,
  writeChatActivityVisiblePreference,
} from '../../../src/components/dashboard/chat-activity-visibility'

function message(partial: Partial<ChatMessage> & Record<string, unknown>): ChatMessage {
  return partial as ChatMessage
}

describe('chat activity visibility presenter', () => {
  it('keeps ordinary user and assistant prose in the default chat surface', () => {
    const messages = [
      message({ role: 'user', content: 'hello' }),
      message({ role: 'assistant', content: 'final answer' }),
    ]

    expect(messages.map((item) => classifyChatMessageForDisplay(item).surface)).toEqual(['chat', 'chat'])
    expect(filterChatMessagesForDefaultTranscript(messages)).toHaveLength(2)
    expect(filterChatActivityMessages(messages)).toHaveLength(0)
  })

  it('classifies tool, terminal, and runtime rows as activity using structure, not content strings', () => {
    const messages = [
      message({ role: 'assistant', kind: 'tool', content: 'arbitrary payload alpha' }),
      message({ role: 'assistant', kind: 'terminal', content: 'arbitrary payload beta' }),
      message({ role: 'assistant', content: 'arbitrary payload gamma', meta: { source: 'runtime_activity', transcriptVisibility: 'internal', audience: 'debug', isInternal: true } }),
    ]

    expect(filterChatMessagesForDefaultTranscript(messages)).toEqual([])
    expect(filterChatActivityMessages(messages)).toHaveLength(3)
    expect(classifyChatMessageForDisplay(messages[2]).label).toBe('Runtime')
  })

  it('keeps explicitly user-facing tool output in the default chat surface', () => {
    const visibleTool = message({
      role: 'assistant',
      kind: 'tool',
      content: 'visible tool result',
      meta: { transcriptVisibility: 'visible', userFacing: true },
    })

    expect(classifyChatMessageForDisplay(visibleTool).surface).toBe('chat')
    expect(filterChatMessagesForDefaultTranscript([visibleTool])).toEqual([visibleTool])
    expect(filterChatActivityMessages([visibleTool])).toEqual([])
  })

  it('persists the activity preference through a storage-like interface', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    }

    expect(readChatActivityVisiblePreference(storage)).toBe(false)
    writeChatActivityVisiblePreference(true, storage)
    expect(values.get(CHAT_ACTIVITY_VISIBILITY_STORAGE_KEY)).toBe('1')
    expect(readChatActivityVisiblePreference(storage)).toBe(true)
    writeChatActivityVisiblePreference(false, storage)
    expect(values.get(CHAT_ACTIVITY_VISIBILITY_STORAGE_KEY)).toBe('0')
    expect(readChatActivityVisiblePreference(storage)).toBe(false)
  })

  it('merges activity rows by timestamp and index only when the opt-in is enabled', () => {
    const chat = [message({ role: 'assistant', content: 'answer', receivedAt: 20, index: 2 })]
    const activity = [message({ role: 'assistant', kind: 'tool', content: 'tool', receivedAt: 10, index: 1 })]

    expect(mergeChatAndActivityMessages(chat, activity, false)).toEqual(chat)
    expect(mergeChatAndActivityMessages(chat, activity, true).map((item) => item.content)).toEqual(['tool', 'answer'])
  })

  it('collapses back-to-back identical bubbles at the history↔live seam (ANTIGRAVITY-REPLICA-DUP)', () => {
    // A replica pane concatenates paged history + live tail; both carry the same
    // finalized assistant answers (no stable id to dedup on), so the seam renders
    // each answer twice in a row. Collapse only the adjacent duplicate.
    const messages = [
      message({ role: 'user', content: 'You are one independent member of a mesh' }),
      message({ role: 'assistant', content: "I'll investigate the git status." }),
      message({ role: 'assistant', content: "I'll investigate the git status." }),
      message({ role: 'assistant', content: 'The picture is clear.' }),
      message({ role: 'assistant', content: 'The picture is clear.' }),
    ]
    expect(collapseAdjacentDuplicateChatMessages(messages).map((m) => m.content)).toEqual([
      'You are one independent member of a mesh',
      "I'll investigate the git status.",
      'The picture is clear.',
    ])
  })

  it('preserves NON-adjacent identical bubbles (does not global-dedup)', () => {
    // The same content recurring later in the conversation is a legitimate repeat,
    // not a seam duplicate — only immediate back-to-back repeats collapse.
    const messages = [
      message({ role: 'assistant', content: 'running command' }),
      message({ role: 'user', content: 'again please' }),
      message({ role: 'assistant', content: 'running command' }),
    ]
    expect(collapseAdjacentDuplicateChatMessages(messages).map((m) => m.content)).toEqual([
      'running command',
      'again please',
      'running command',
    ])
  })

  it('never collapses empty-content activity placeholders into each other', () => {
    const messages = [
      message({ role: 'assistant', content: '' }),
      message({ role: 'assistant', content: '' }),
    ]
    expect(collapseAdjacentDuplicateChatMessages(messages)).toHaveLength(2)
  })
})
