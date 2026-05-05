import { describe, expect, it } from 'vitest'
import { buildSessionEntries } from '../../src/status/builders.js'

describe('buildSessionEntries status merge', () => {
  it('keeps activeChat status ahead of stale top-level idle status', () => {
    const sessions = buildSessionEntries([
      {
        category: 'cli',
        type: 'hermes-cli',
        name: 'Hermes Agent',
        instanceId: 'cli-active-chat',
        status: 'idle',
        workspace: '/repo',
        mode: 'chat',
        activeChat: {
          id: 'chat-1',
          title: 'Hermes Agent',
          status: 'generating',
          messages: [],
          activeModal: null,
        },
      } as any,
    ], new Map(), { profile: 'live' })

    expect(sessions[0]?.status).toBe('generating')
  })

  it('keeps active top-level CLI status ahead of stale activeChat idle status', () => {
    const sessions = buildSessionEntries([
      {
        category: 'cli',
        type: 'hermes-cli',
        name: 'Hermes Agent',
        instanceId: 'cli-top-level-active',
        status: 'generating',
        workspace: '/repo',
        mode: 'chat',
        activeChat: {
          id: 'chat-1',
          title: 'Hermes Agent',
          status: 'idle',
          messages: [],
          activeModal: null,
        },
      } as any,
    ], new Map(), { profile: 'live' })

    expect(sessions[0]?.status).toBe('generating')
  })

  it('keeps approval modal status ahead of stale top-level idle status', () => {
    const sessions = buildSessionEntries([
      {
        category: 'cli',
        type: 'hermes-cli',
        name: 'Hermes Agent',
        instanceId: 'cli-approval',
        status: 'idle',
        workspace: '/repo',
        mode: 'chat',
        activeChat: {
          id: 'chat-1',
          title: 'Hermes Agent',
          status: 'idle',
          messages: [],
          activeModal: { message: 'approve?', buttons: ['Yes'] },
        },
      } as any,
    ], new Map(), { profile: 'full' })

    expect(sessions[0]?.status).toBe('waiting_approval')
  })
})
