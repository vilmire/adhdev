import { describe, expect, it, vi } from 'vitest'
import {
  applyCliViewModeOverrides,
  getCliViewModeForSession,
  isExpectedCliViewModeTransportError,
  shouldRetainOptimisticCliViewModeOverrideOnError,
  reconcileCliViewModeOverrides,
  switchCliConversationViewModeOptimistically,
  type CliViewModeOverrideMap,
} from '../../../src/components/dashboard/cliViewModeOverrides'
import type { ActiveConversation } from '../../../src/components/dashboard/types'
import type { DaemonData } from '../../../src/types'

function createEntry(overrides: Partial<DaemonData> = {}): DaemonData {
  return {
    id: 'machine-1:cli:cli-1',
    sessionId: 'cli-1',
    daemonId: 'machine-1',
    type: 'hermes-cli',
    agentType: 'hermes-cli',
    transport: 'pty',
    mode: 'chat',
    status: 'idle',
    cliName: 'Hermes Agent',
    workspace: '/repo',
    activeChat: { id: 'chat-1', title: 'Hermes Agent', status: 'idle', messages: [], activeModal: null },
    timestamp: 1,
    ...overrides,
  }
}

function createConversation(overrides: Partial<ActiveConversation> = {}): ActiveConversation {
  return {
    routeId: 'machine-1:cli:cli-1',
    daemonId: 'machine-1',
    sessionId: 'cli-1',
    transport: 'pty',
    mode: 'chat',
    agentName: 'Hermes Agent',
    agentType: 'hermes-cli',
    status: 'idle',
    title: 'Hermes Agent',
    messages: [],
    workspaceName: '/repo',
    displayPrimary: 'Hermes Agent',
    displaySecondary: 'machine-1',
    streamSource: 'native',
    tabKey: 'tab-1',
    ...overrides,
  }
}

function createOverrideHarness(initial: CliViewModeOverrideMap = {}) {
  let overrides = { ...initial }
  return {
    read: () => overrides,
    set: (update: CliViewModeOverrideMap | ((prev: CliViewModeOverrideMap) => CliViewModeOverrideMap)) => {
      overrides = typeof update === 'function'
        ? update(overrides)
        : update
    },
  }
}

describe('cliViewModeOverrides', () => {
  it('applies optimistic mode overrides to top-level cli entries', () => {
    const entry = createEntry()
    const next = applyCliViewModeOverrides([entry], { 'cli-1': 'terminal' })
    expect(next[0]).toMatchObject({ sessionId: 'cli-1', mode: 'terminal' })
    expect(next[0]).not.toBe(entry)
  })

  it('applies optimistic mode overrides to child cli sessions', () => {
    const parent = createEntry({
      id: 'machine-1:ide:cursor-1',
      sessionId: 'cursor-1',
      transport: 'cdp-page',
      type: 'cursor',
      agentType: undefined,
      mode: 'chat',
      childSessions: [{
        id: 'cli-child',
        parentId: 'cursor-1',
        providerType: 'hermes-cli',
        providerName: 'Hermes Agent',
        kind: 'agent',
        transport: 'pty',
        status: 'idle',
        title: 'Hermes Agent',
        workspace: '/repo',
        activeChat: null,
        capabilities: [],
        mode: 'chat',
      } as any],
    })
    const next = applyCliViewModeOverrides([parent], { 'cli-child': 'terminal' })
    expect(next[0].childSessions?.[0]).toMatchObject({ id: 'cli-child', mode: 'terminal' })
  })

  it('reads the latest cli mode for a session from top-level and child entries', () => {
    const entries = applyCliViewModeOverrides([
      createEntry(),
      createEntry({
        id: 'machine-1:ide:cursor-1',
        sessionId: 'cursor-1',
        transport: 'cdp-page',
        type: 'cursor',
        agentType: undefined,
        childSessions: [{
          id: 'cli-child',
          parentId: 'cursor-1',
          providerType: 'hermes-cli',
          providerName: 'Hermes Agent',
          kind: 'agent',
          transport: 'pty',
          status: 'idle',
          title: 'Hermes Agent',
          workspace: '/repo',
          activeChat: null,
          capabilities: [],
          mode: 'chat',
        } as any],
      }),
    ], { 'cli-1': 'terminal', 'cli-child': 'terminal' })

    expect(getCliViewModeForSession(entries, 'cli-1')).toBe('terminal')
    expect(getCliViewModeForSession(entries, 'cli-child')).toBe('terminal')
    expect(getCliViewModeForSession(entries, 'missing')).toBeNull()
  })

  it('keeps an optimistic override when the server temporarily has no session mode for that id', () => {
    const next = reconcileCliViewModeOverrides({ 'cli-1': 'chat' }, [])
    expect(next).toEqual({ 'cli-1': 'chat' })
  })

  it('clears an optimistic override once the server reports the same mode', () => {
    const next = reconcileCliViewModeOverrides({ 'cli-1': 'chat' }, [createEntry({ mode: 'chat' })])
    expect(next).toEqual({})
  })

  it('treats CLI view-mode timeout/not-connected errors as expected transport issues', () => {
    expect(isExpectedCliViewModeTransportError(new Error('P2P command timeout (30s)'))).toBe(true)
    expect(isExpectedCliViewModeTransportError(new Error('P2P not connected'))).toBe(true)
    expect(isExpectedCliViewModeTransportError(new Error('P2P channel not open'))).toBe(true)
    expect(isExpectedCliViewModeTransportError(new Error('something else'))).toBe(false)
  })

  it('keeps the optimistic override only when the command may have applied before the transport failed', () => {
    expect(shouldRetainOptimisticCliViewModeOverrideOnError(new Error('P2P command timeout (30s)'))).toBe(true)
    expect(shouldRetainOptimisticCliViewModeOverrideOnError(new Error('P2P data channel closed'))).toBe(true)
    expect(shouldRetainOptimisticCliViewModeOverrideOnError(new Error('P2P receiver stopped'))).toBe(true)
    expect(shouldRetainOptimisticCliViewModeOverrideOnError(new Error('P2P not connected'))).toBe(false)
    expect(shouldRetainOptimisticCliViewModeOverrideOnError(new Error('P2P channel not open'))).toBe(false)
  })

  it('applies an optimistic override immediately when switching a CLI conversation view mode', async () => {
    const overrides = createOverrideHarness()
    const sendDaemonCommand = vi.fn().mockResolvedValue({ ok: true })

    await switchCliConversationViewModeOptimistically({
      conversation: createConversation(),
      mode: 'terminal',
      ides: [createEntry()],
      sendDaemonCommand,
      setCliViewModeOverrides: overrides.set,
    })

    expect(overrides.read()).toEqual({ 'cli-1': 'terminal' })
    expect(sendDaemonCommand).toHaveBeenCalledWith('machine-1', 'set_cli_view_mode', {
      targetSessionId: 'cli-1',
      cliType: 'hermes-cli',
      mode: 'terminal',
    })
  })

  it('rolls back the optimistic override when the command fails before reaching the runtime', async () => {
    const overrides = createOverrideHarness()
    const sendDaemonCommand = vi.fn().mockRejectedValue(new Error('P2P not connected'))

    await switchCliConversationViewModeOptimistically({
      conversation: createConversation(),
      mode: 'terminal',
      ides: [createEntry({ mode: 'chat' })],
      sendDaemonCommand,
      setCliViewModeOverrides: overrides.set,
    })

    expect(overrides.read()).toEqual({})
  })

  it('keeps the optimistic override when the transport fails after the command may already have landed', async () => {
    const overrides = createOverrideHarness()
    const sendDaemonCommand = vi.fn().mockRejectedValue(new Error('P2P command timeout (30s)'))

    await switchCliConversationViewModeOptimistically({
      conversation: createConversation(),
      mode: 'terminal',
      ides: [createEntry({ mode: 'chat' })],
      sendDaemonCommand,
      setCliViewModeOverrides: overrides.set,
    })

    expect(overrides.read()).toEqual({ 'cli-1': 'terminal' })
  })
})
