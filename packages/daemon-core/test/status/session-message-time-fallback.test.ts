import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildStatusSnapshot, getSessionCompletionMarker, getLastDisplayMessage } from '../../src/status/snapshot.js'
import { markSessionSeen } from '../../src/config/recent-activity.js'
import { saveState } from '../../src/config/state-store.js'
import {
  classifyHotChatSessionsForSubscriptionFlush,
  DEFAULT_CHAT_TAIL_RECENT_MESSAGE_GRACE_MS,
} from '../../src/status/chat-tail-hot-sessions.js'

describe('status snapshot message time fallbacks', () => {
  const originalConfigDir = process.env.ADHDEV_CONFIG_DIR

  afterEach(() => {
    if (process.env.ADHDEV_CONFIG_DIR && process.env.ADHDEV_CONFIG_DIR !== originalConfigDir) {
      fs.rmSync(process.env.ADHDEV_CONFIG_DIR, { recursive: true, force: true })
    }
    if (originalConfigDir === undefined) {
      delete process.env.ADHDEV_CONFIG_DIR
    } else {
      process.env.ADHDEV_CONFIG_DIR = originalConfigDir
    }
  })

  it('preserves machine provider activation fields in availableProviders', () => {
    const lastDetection = {
      ok: true,
      stage: 'detection' as const,
      checkedAt: '2026-04-26T11:35:42.036Z',
      command: 'hermes',
      path: '/opt/homebrew/bin/hermes',
      message: 'Provider command detected',
    }
    const snapshot = buildStatusSnapshot({
      allStates: [],
      cdpManagers: new Map(),
      providerLoader: {
        getAvailableProviderInfos: () => [
          {
            type: 'hermes-cli',
            displayName: 'Hermes Agent',
            icon: '⚕',
            category: 'cli',
            installed: true,
            detectedPath: '/opt/homebrew/bin/hermes',
            enabled: true,
            machineStatus: 'detected',
            lastDetection,
          },
        ],
        getAll: () => [],
      },
      detectedIdes: [],
      instanceId: 'daemon-1',
      version: '0.0.0-test',
      timestamp: 1,
      profile: 'full',
    })

    expect(snapshot.availableProviders).toEqual([
      expect.objectContaining({
        type: 'hermes-cli',
        category: 'cli',
        installed: true,
        detectedPath: '/opt/homebrew/bin/hermes',
        enabled: true,
        machineStatus: 'detected',
        lastDetection,
      }),
    ])
  })

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

  // getLastDisplayMessage is the source of truth the cloud coordinator reads from a LOCAL
  // mesh worktree session's hosted instance to stamp the inbox preview (coordinator == worker).
  // It must return the LATEST assistant reply, not stick on the dispatched user task.
  it('getLastDisplayMessage returns the trailing assistant reply over an earlier user task', () => {
    const last = getLastDisplayMessage({
      activeChat: {
        messages: [
          { role: 'user', content: 'dispatched task: fix the mesh inbox', timestamp: 10 },
          { role: 'assistant', content: 'Done — inbox preview now reflects the reply.', timestamp: 20 },
        ],
      },
    } as any)
    expect(last?.role).toBe('assistant')
    expect(last?.preview).toBe('Done — inbox preview now reflects the reply.')
    expect(last?.receivedAt).toBe(20)
  })

  it('getLastDisplayMessage returns null when no displayable message exists (genuinely remote — no local transcript)', () => {
    expect(getLastDisplayMessage({ activeChat: { messages: [] } } as any)).toBe(null)
    expect(getLastDisplayMessage({ activeChat: null } as any)).toBe(null)
    // System-only transcript yields nothing to surface.
    expect(getLastDisplayMessage({
      activeChat: { messages: [{ role: 'system', content: 'boot', timestamp: 1 }] },
    } as any)).toBe(null)
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

  it('clears Claude native unread state when a newer runtime-key read marker exists', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-claude-native-read-'))
    process.env.ADHDEV_CONFIG_DIR = configDir
    const runtimeSessionId = '330164ef-b511-48ef-8f69-fed95f9cd626'
    const providerSessionId = 'f2e2db91-79a1-49e4-b9bf-26a3c5fb6774'
    const staleProviderMarker = `turn:claude-cli:native-turn:${providerSessionId}:0`
    const freshRuntimeMarker = `turn:claude-cli:native-turn:${providerSessionId}:1`
    const initialState = {
      recentActivity: [],
      savedProviderSessions: [],
      sessionReads: {},
      sessionReadMarkers: {},
      sessionNotificationDismissals: {},
      sessionNotificationUnreadOverrides: {},
    }
    const staleProviderRead = markSessionSeen(initialState, runtimeSessionId, 100, staleProviderMarker, providerSessionId)
    saveState(markSessionSeen(staleProviderRead, runtimeSessionId, 200, freshRuntimeMarker))

    const snapshot = buildStatusSnapshot({
      instanceId: 'daemon-1',
      version: '0.9.82',
      allStates: [
        {
          instanceId: runtimeSessionId,
          type: 'claude-cli',
          name: 'Claude Code',
          category: 'cli',
          status: 'idle',
          activeChat: {
            id: 'chat-1',
            title: 'Claude Code',
            status: 'idle',
            messages: [
              {
                role: 'user',
                content: 'smoke prompt',
                receivedAt: 100,
                providerUnitKey: `claude-cli:native:${providerSessionId}:0:user:standard:d5b905ac`,
                bubbleId: `bubble:claude-cli:native:${providerSessionId}:0:user:standard:d5b905ac`,
                _turnKey: `claude-cli:native-turn:${providerSessionId}:0`,
              },
              {
                role: 'assistant',
                content: 'smoke answer',
                receivedAt: 200,
                providerUnitKey: `claude-cli:native:${providerSessionId}:1:assistant:standard:4e5c0b9a`,
                bubbleId: `bubble:claude-cli:native:${providerSessionId}:1:assistant:standard:4e5c0b9a`,
                _turnKey: `claude-cli:native-turn:${providerSessionId}:1`,
              },
            ],
            activeModal: null,
          },
          lastUpdated: 200,
          workspace: '/repo',
          providerSessionId,
        } as any,
      ],
      cdpManagers: new Map(),
      providerLoader: {
        getAll: () => [],
      },
      detectedIdes: [],
      profile: 'live',
    })

    const session = snapshot.sessions.find((entry) => entry.id === runtimeSessionId)
    expect(session?.completionMarker).toBe(freshRuntimeMarker)
    expect(session?.seenCompletionMarker).toBe(freshRuntimeMarker)
    expect(session?.unread).toBe(false)
    expect(session?.inboxBucket).toBe('idle')
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
