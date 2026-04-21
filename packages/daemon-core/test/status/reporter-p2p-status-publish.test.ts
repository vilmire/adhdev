import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { buildSessionEntriesMock, buildStatusSnapshotMock } = vi.hoisted(() => ({
  buildSessionEntriesMock: vi.fn(() => [
    {
      id: 'cli-1',
      parentId: null,
      providerType: 'hermes-cli',
      providerName: 'Hermes Agent',
      kind: 'agent',
      transport: 'pty',
      status: 'idle',
      workspace: '/repo',
      title: 'Hermes task',
      cdpConnected: false,
      summaryMetadata: undefined,
    },
  ]),
  buildStatusSnapshotMock: vi.fn(() => ({
    instanceId: 'daemon-1',
    machine: { platform: 'darwin', hostname: 'test-host' },
    timestamp: 123,
    p2p: { available: true, state: 'connected', peers: 1, screenshotActive: false },
    sessions: [
      {
        id: 'cli-1',
        parentId: null,
        providerType: 'hermes-cli',
        providerName: 'Hermes Agent',
        kind: 'agent',
        transport: 'pty',
        status: 'idle',
        workspace: '/repo',
        title: 'Hermes task',
        unread: true,
        inboxBucket: 'task_complete',
        completionMarker: 'id:msg_1',
        seenCompletionMarker: '',
        lastUpdated: 123,
      },
    ],
  })),
}))

vi.mock('../../src/status/builders.js', () => ({
  buildSessionEntries: buildSessionEntriesMock,
}))

vi.mock('../../src/status/snapshot.js', () => ({
  buildStatusSnapshot: buildStatusSnapshotMock,
}))

import { DaemonStatusReporter } from '../../src/status/reporter.js'

function createReporter(overrides: {
  serverConnected?: boolean
  p2pConnected?: boolean
} = {}) {
  const sendStatus = vi.fn()
  const sendMessage = vi.fn()

  const reporter = new DaemonStatusReporter({
    serverConn: {
      isConnected: () => overrides.serverConnected ?? true,
      sendMessage,
      getUserPlan: () => 'pro',
    },
    cdpManagers: new Map(),
    p2p: {
      isConnected: overrides.p2pConnected ?? true,
      isAvailable: true,
      connectionState: 'connected',
      connectedPeerCount: 1,
      screenshotActive: false,
      sendStatus,
      sendStatusEvent: vi.fn(),
    },
    providerLoader: {
      resolve: () => null,
      getAll: () => [],
    },
    detectedIdes: [],
    instanceId: 'daemon-1',
    daemonVersion: '0.0.0-test',
    instanceManager: {
      collectAllStates: () => [],
      collectStatesByCategory: () => [],
    },
    getScreenshotUsage: () => null,
  })

  return { reporter, sendStatus, sendMessage }
}

describe('DaemonStatusReporter P2P publish behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-21T12:10:00Z'))
    buildSessionEntriesMock.mockClear()
    buildStatusSnapshotMock.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('still sends p2pOnly rich status when server connection is down', async () => {
    const { reporter, sendStatus, sendMessage } = createReporter({
      serverConnected: false,
      p2pConnected: true,
    })

    await reporter.sendUnifiedStatusReport({ p2pOnly: true, reason: 'test' })

    expect(sendStatus).toHaveBeenCalledTimes(1)
    expect(sendStatus.mock.calls[0]?.[0]?.sessions?.[0]).toMatchObject({
      id: 'cli-1',
      unread: true,
      inboxBucket: 'task_complete',
      completionMarker: 'id:msg_1',
      seenCompletionMarker: '',
    })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('publishes an immediate p2p rich status on status change even inside the throttle window', async () => {
    const { reporter, sendStatus, sendMessage } = createReporter({
      serverConnected: true,
      p2pConnected: true,
    })

    ;(reporter as any).lastStatusSentAt = Date.now()
    reporter.onStatusChange()
    await vi.runAllTicks()

    expect(sendStatus).toHaveBeenCalledTimes(1)
    expect(sendStatus.mock.calls[0]?.[0]?.sessions?.[0]).toMatchObject({
      completionMarker: 'id:msg_1',
      inboxBucket: 'task_complete',
      unread: true,
    })
    expect(sendMessage).not.toHaveBeenCalled()
  })
})
