import { describe, expect, it } from 'vitest'
import { buildStatusSnapshot, getSessionCompletionMarker } from '../../src/status/snapshot.js'
import {
  classifyHotChatSessionsForSubscriptionFlush,
  DEFAULT_CHAT_TAIL_RECENT_MESSAGE_GRACE_MS,
} from '../../src/status/chat-tail-hot-sessions.js'

describe('status snapshot message time fallbacks', () => {
  it('uses message timestamp when receivedAt is missing for lastMessageAt', () => {
    const ts = 1_717_000_000_000
    const snapshot = buildStatusSnapshot({
      allStates: [
        {
          category: 'cli',
          instanceId: 'cli-1',
          type: 'hermes-cli',
          name: 'Hermes',
          providerSessionId: 'provider-1',
          workspace: '/tmp',
          status: 'idle',
          mode: 'chat',
          resume: false,
          lastUpdated: ts,
          activeChat: {
            title: 'Test',
            status: 'idle',
            messages: [
              {
                role: 'assistant',
                content: 'ASTEROID',
                timestamp: ts,
              },
            ],
          },
        } as any,
      ],
      cdpManagers: new Map(),
      providerLoader: {
        getAll: () => [],
      },
      detectedIdes: [],
      instanceId: 'daemon-1',
      version: '0.0.0-test',
      timestamp: ts,
      profile: 'full',
    })

    const session = snapshot.sessions.find((entry) => entry.id === 'cli-1')
    expect(session?.lastMessageAt).toBe(ts)
    expect(session?.lastMessageRole).toBe('assistant')
  })

  it('falls back to timestamp for completion markers when ids are missing', () => {
    const ts = 1_717_000_000_123
    expect(getSessionCompletionMarker({
      activeChat: {
        messages: [
          {
            role: 'assistant',
            content: 'done',
            timestamp: ts,
          },
        ],
      },
    } as any)).toBe(`ts:${ts}`)
  })

  it('keeps timestamp-only idle completions hot long enough to flush the live chat tail', () => {
    const ts = 1_717_000_000_456
    const now = ts + (DEFAULT_CHAT_TAIL_RECENT_MESSAGE_GRACE_MS - 250)
    const snapshot = buildStatusSnapshot({
      allStates: [
        {
          category: 'cli',
          instanceId: 'cli-1',
          type: 'hermes-cli',
          name: 'Hermes',
          providerSessionId: 'provider-1',
          workspace: '/tmp',
          status: 'idle',
          mode: 'chat',
          resume: false,
          lastUpdated: ts,
          activeChat: {
            title: 'Test',
            status: 'idle',
            messages: [
              {
                role: 'assistant',
                content: 'DONE',
                timestamp: ts,
              },
            ],
          },
        } as any,
      ],
      cdpManagers: new Map(),
      providerLoader: {
        getAll: () => [],
      },
      detectedIdes: [],
      instanceId: 'daemon-1',
      version: '0.0.0-test',
      timestamp: now,
      profile: 'live',
    })

    const hotSessions = classifyHotChatSessionsForSubscriptionFlush(snapshot.sessions, new Set(), { now })

    expect(Array.from(hotSessions.active)).toEqual(['cli-1'])
    expect(Array.from(hotSessions.finalizing)).toEqual([])
    expect(snapshot.sessions.find((entry) => entry.id === 'cli-1')?.lastMessageAt).toBe(ts)
  })

  it('includes completion markers in live snapshots so web auto-read can observe unseen task completions', () => {
    const snapshot = buildStatusSnapshot({
      instanceId: 'daemon-1',
      version: '0.8.82',
      allStates: [
        {
          instanceId: 'cli-1',
          type: 'hermes-cli',
          name: 'Hermes Agent',
          category: 'cli',
          status: 'idle',
          activeChat: {
            id: 'chat-1',
            title: 'Hermes Agent',
            status: 'idle',
            messages: [
              { role: 'user', content: 'hello', timestamp: 10, receivedAt: 10, id: 'msg_0', index: 0 },
              { role: 'assistant', content: 'done', timestamp: 20, receivedAt: 20, id: 'msg_1', index: 1 },
            ],
            activeModal: null,
          },
          lastUpdated: 20,
          workspace: '/repo',
          providerSessionId: 'provider-1',
        } as any,
      ],
      cdpManagers: new Map(),
      profile: 'live',
    })

    const session = snapshot.sessions.find((entry) => entry.id === 'cli-1')
    expect(session?.completionMarker).toBe('id:msg_1')
    expect(session?.seenCompletionMarker).toBe('')
    expect(session?.unread).toBe(true)
    expect(session?.inboxBucket).toBe('task_complete')
  })

  it('carries runtime recovery metadata into live snapshots so restored stopped sessions are excluded from hot polling', () => {
    const ts = 1_717_000_100_000
    const now = ts + (DEFAULT_CHAT_TAIL_RECENT_MESSAGE_GRACE_MS - 250)
    const snapshot = buildStatusSnapshot({
      allStates: [
        {
          category: 'cli',
          instanceId: 'cli-recovery',
          type: 'hermes-cli',
          name: 'Hermes',
          providerSessionId: 'provider-recovery',
          workspace: '/tmp',
          status: 'idle',
          mode: 'chat',
          resume: false,
          lastUpdated: ts,
          runtime: {
            runtimeId: 'runtime-recovery',
            runtimeKey: 'hermes-cli-tmp',
            displayName: 'hermes-cli @ tmp',
            workspaceLabel: 'tmp',
            lifecycle: 'stopped',
            restoredFromStorage: true,
            recoveryState: 'orphan_snapshot',
          },
          activeChat: {
            title: 'Recovered',
            status: 'idle',
            messages: [
              {
                role: 'assistant',
                content: 'RECOVERED',
                timestamp: ts,
              },
            ],
          },
        } as any,
      ],
      cdpManagers: new Map(),
      providerLoader: {
        getAll: () => [],
      },
      detectedIdes: [],
      instanceId: 'daemon-1',
      version: '0.0.0-test',
      timestamp: now,
      profile: 'live',
    })

    const session = snapshot.sessions.find((entry) => entry.id === 'cli-recovery')
    const hotSessions = classifyHotChatSessionsForSubscriptionFlush(snapshot.sessions, new Set(['cli-recovery']), { now })

    expect(session?.runtimeLifecycle).toBe('stopped')
    expect(session?.runtimeRestoredFromStorage).toBe(true)
    expect(session?.runtimeRecoveryState).toBe('orphan_snapshot')
    expect(Array.from(hotSessions.active)).toEqual([])
    expect(Array.from(hotSessions.finalizing)).toEqual([])
  })
})
