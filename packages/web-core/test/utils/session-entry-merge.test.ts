import { describe, expect, it } from 'vitest'
import type { SessionEntry } from '@adhdev/daemon-core'
import {
  mergeActiveChatData,
  mergeSessionEntryChildren,
  mergeSessionEntrySummary,
  type ExistingSessionLike,
} from '../../src/utils/session-entry-merge'

function createSession(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id: 'session-1',
    parentId: null,
    providerType: 'claude-code-vscode',
    providerName: 'Claude Code (VS Code)',
    kind: 'agent',
    transport: 'cdp-webview',
    status: 'idle',
    title: 'Claude Code (VS Code)',
    workspace: '/repo',
    activeChat: {
      id: 'chat-1',
      title: 'Claude Code (VS Code)',
      status: 'idle',
      messages: [],
      activeModal: null,
    },
    capabilities: ['read_chat'],
    ...overrides,
  }
}

describe('session entry merge helpers', () => {
  it('preserves existing provider casing and title when sparse incoming metadata omits them', () => {
    const existing: ExistingSessionLike = {
      providerName: 'Claude Code (VS Code)',
      workspace: '/repo',
      activeChat: {
        id: 'chat-1',
        title: 'Claude Code (VS Code)',
        status: 'idle',
        messages: [],
        activeModal: null,
      } as any,
    }

    const merged = mergeSessionEntrySummary(createSession({
      providerName: undefined,
      title: undefined,
    }), existing)

    expect(merged).toMatchObject({
      providerName: 'Claude Code (VS Code)',
      title: 'Claude Code (VS Code)',
    })
  })

  it('preserves existing active chat transcript and approval modal when incoming sparse update omits transcript bodies', () => {
    const merged = mergeSessionEntrySummary(createSession({
      status: 'waiting_approval',
      activeChat: {
        id: 'chat-1',
        title: 'Claude Code (VS Code)',
        status: 'waiting_approval',
        activeModal: null,
      } as any,
    }), {
      activeChat: {
        id: 'chat-1',
        title: 'Claude Code (VS Code)',
        status: 'waiting_approval',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'world' },
        ],
        activeModal: {
          message: 'Approve?',
          buttons: ['Allow once', 'Deny'],
        },
      } as any,
    })

    expect(merged.activeChat?.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ])
    expect(merged.activeChat?.activeModal).toEqual({
      message: 'Approve?',
      buttons: ['Allow once', 'Deny'],
    })
  })

  it('preserves completion markers across sparse session merges', () => {
    const merged = mergeSessionEntrySummary(createSession({
      completionMarker: undefined,
      seenCompletionMarker: undefined,
    }), {
      completionMarker: 'id:msg_7',
      seenCompletionMarker: 'id:msg_1',
    })

    expect(merged).toMatchObject({
      completionMarker: 'id:msg_7',
      seenCompletionMarker: 'id:msg_1',
    })
  })

  it('preserves the existing transcript when an incoming metadata update omits messages entirely', () => {
    const merged = mergeActiveChatData(
      {
        id: 'chat-1',
        title: 'Claude Code (VS Code)',
        status: 'idle',
        activeModal: null,
      } as any,
      {
        id: 'chat-1',
        title: 'Claude Code (VS Code)',
        status: 'generating',
        messages: [
          { role: 'user', content: 'hello', id: 'msg-user-1', receivedAt: 1000 },
          { role: 'assistant', content: 'world', id: 'msg-assistant-1', receivedAt: 2000 },
        ],
        activeModal: null,
      } as any,
    )

    expect(merged?.messages).toEqual([
      { role: 'user', content: 'hello', id: 'msg-user-1', receivedAt: 1000 },
      { role: 'assistant', content: 'world', id: 'msg-assistant-1', receivedAt: 2000 },
    ])
  })

  it('uses the incoming transcript as-is when the incoming update explicitly provides messages', () => {
    const fullTail = `Intro\n${'x'.repeat(5200)}\nTAIL_MARKER_VISIBLE`
    const truncatedTail = `Intro\n${'x'.repeat(5000)}`

    const merged = mergeActiveChatData(
      {
        id: 'chat-1',
        title: 'Claude Code (VS Code)',
        status: 'generating',
        messages: [
          { role: 'user', content: 'show me the full output', id: 'msg-user-1', receivedAt: 1000 },
          { role: 'assistant', content: truncatedTail, id: 'msg-assistant-1', receivedAt: 2000 },
        ],
        activeModal: null,
      } as any,
      {
        id: 'chat-1',
        title: 'Claude Code (VS Code)',
        status: 'generating',
        messages: [
          { role: 'user', content: 'show me the full output', id: 'msg-user-1', receivedAt: 1000 },
          { role: 'assistant', content: fullTail, id: 'msg-assistant-1', receivedAt: 2000 },
        ],
        activeModal: null,
      } as any,
    )

    expect(String(merged?.messages?.[1]?.content || '')).toBe(truncatedTail)
  })

  it('allows an explicit empty incoming transcript to clear previous messages', () => {
    const merged = mergeActiveChatData(
      {
        id: 'chat-1',
        title: 'Claude Code (VS Code)',
        status: 'idle',
        messages: [],
        activeModal: null,
      } as any,
      {
        id: 'chat-1',
        title: 'Claude Code (VS Code)',
        status: 'idle',
        messages: [
          { role: 'assistant', content: 'old message', id: 'msg-old-1', receivedAt: 1000 },
        ],
        activeModal: null,
      } as any,
    )

    expect(merged?.messages).toEqual([])
  })

  it('keeps the existing transcript when an approval-state snapshot reports an empty modal-only transcript', () => {
    const merged = mergeActiveChatData(
      {
        id: 'chat-1',
        title: 'Claude Code (VS Code)',
        status: 'waiting_approval',
        messages: [],
        activeModal: {
          message: 'Allow command?',
          buttons: ['Allow once', 'Deny'],
        },
      } as any,
      {
        id: 'chat-1',
        title: 'Claude Code (VS Code)',
        status: 'generating',
        messages: [
          { role: 'user', content: 'run tests', id: 'msg-user-1', receivedAt: 1000 },
          { role: 'assistant', content: 'I need approval', id: 'msg-assistant-1', receivedAt: 2000 },
        ],
        activeModal: null,
      } as any,
    )

    expect(merged?.messages).toEqual([
      { role: 'user', content: 'run tests', id: 'msg-user-1', receivedAt: 1000 },
      { role: 'assistant', content: 'I need approval', id: 'msg-assistant-1', receivedAt: 2000 },
    ])
    expect(merged?.activeModal).toEqual({
      message: 'Allow command?',
      buttons: ['Allow once', 'Deny'],
    })
  })

  it('merges child session arrays through the same sparse-preserving contract', () => {
    const merged = mergeSessionEntryChildren(
      [createSession()],
      [createSession({ providerName: undefined, title: undefined })],
    )

    expect(merged).toHaveLength(1)
    expect(merged?.[0]).toMatchObject({
      providerName: 'Claude Code (VS Code)',
      title: 'Claude Code (VS Code)',
    })
  })
})
