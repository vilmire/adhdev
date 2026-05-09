import { describe, expect, it } from 'vitest'
import { buildSessionEntries } from '../../src/status/builders.js'

describe('buildSessionEntries message input support', () => {
  it('exposes text-only message input for CLI sessions by default', () => {
    const sessions = buildSessionEntries([
      {
        category: 'cli',
        type: 'hermes-cli',
        name: 'Hermes Agent',
        instanceId: 'cli-1',
        status: 'idle',
        workspace: '/repo',
        mode: 'chat',
        activeChat: null,
      } as any,
    ], new Map(), { profile: 'full' })

    expect(sessions[0]?.messageInput).toEqual({
      text: true,
      multipart: false,
      mediaTypes: ['text'],
      strategies: [],
    })
  })

  it('exposes effective ACP message input without native video', () => {
    const sessions = buildSessionEntries([
      {
        category: 'acp',
        type: 'acp-test',
        name: 'ACP Test',
        instanceId: 'acp-1',
        status: 'idle',
        workspace: '/repo',
        mode: 'chat',
        activeChat: null,
        messageInput: {
          text: true,
          multipart: true,
          mediaTypes: ['text', 'image', 'audio', 'resource', 'video'],
          strategies: [
            { mediaType: 'image', strategies: ['native_acp', 'resource_link', 'text_fallback'], native: true, degradation: ['resource_link', 'text_fallback'] },
            { mediaType: 'audio', strategies: ['native_acp', 'resource_link', 'text_fallback'], native: true, degradation: ['resource_link', 'text_fallback'] },
            { mediaType: 'video', strategies: ['resource_link', 'text_fallback'], native: false, degradation: ['resource_link', 'text_fallback'] },
          ],
        },
      } as any,
    ], new Map(), { profile: 'full' })

    expect(sessions[0]?.messageInput?.strategies.find((entry) => entry.mediaType === 'video')?.strategies)
      .not.toContain('native_acp')
  })
})
