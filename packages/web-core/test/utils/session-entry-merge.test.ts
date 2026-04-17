import { describe, expect, it } from 'vitest'
import type { SessionEntry } from '@adhdev/daemon-core'
import {
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

  it('preserves existing active chat transcript and approval modal when incoming sparse update omits them', () => {
    const merged = mergeSessionEntrySummary(createSession({
      status: 'waiting_approval',
      activeChat: {
        id: 'chat-1',
        title: 'Claude Code (VS Code)',
        status: 'waiting_approval',
        messages: [],
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
