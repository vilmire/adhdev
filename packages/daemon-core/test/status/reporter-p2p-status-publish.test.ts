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
  fleetStatusPeerView?: Record<string, unknown>
} = {}) {
  const sendStatus = vi.fn()
  const sendStatusEvent = vi.fn()
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
      sendStatusEvent,
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
    getFleetStatusPeerView: () => overrides.fleetStatusPeerView as any ?? null,
  })

  return { reporter, sendStatus, sendStatusEvent, sendMessage }
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

    expect(buildSessionEntriesMock).not.toHaveBeenCalled()
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

  it('reuses the live status snapshot sessions for p2p plus server reports instead of building server sessions up front', async () => {
    const { reporter, sendStatus, sendMessage } = createReporter({
      serverConnected: true,
      p2pConnected: true,
    })

    await reporter.sendUnifiedStatusReport({ reason: 'combined' })

    expect(buildSessionEntriesMock).not.toHaveBeenCalled()
    expect(sendStatus).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0]?.[1]?.sessions?.[0]).toMatchObject({
      id: 'cli-1',
      providerType: 'hermes-cli',
      status: 'idle',
    })
  })

  it('exposes the SUB peer view on rich P2P status but never on the server status_report', async () => {
    const fleetStatusPeerView = {
      peers: [{
        daemonId: 'daemon_mach_peer',
        at: '2026-04-21T12:09:59.000Z',
        onlineState: 'online',
        p2pActive: true,
        sessionCounts: {
          ideCount: 1, cliCount: 0, acpCount: 0, idleCount: 1,
          generatingCount: 0, waitingApprovalCount: 0, erroredCount: 0,
        },
      }],
      diagnostics: {
        subscribedPeers: 1, receivedEntries: 1, comparedEntries: 1,
        matchedEntries: 1, mismatchedEntries: 0, invalidEntries: 0,
        viewReplacements: 1,
      },
      serverBoundaryCanary: 'FLEET_STATUS_PEER_VIEW_MUST_STAY_P2P_ONLY',
    }
    const { reporter, sendStatus, sendMessage } = createReporter({ fleetStatusPeerView })

    await reporter.sendUnifiedStatusReport({ reason: 'fleet-status-boundary' })

    expect(sendStatus.mock.calls[0]?.[0]?.fleetStatusPeerView).toBe(fleetStatusPeerView)
    const serverPayload = sendMessage.mock.calls.find(([type]) => type === 'status_report')?.[1]
    expect(serverPayload).not.toHaveProperty('fleetStatusPeerView')
    expect(JSON.stringify(serverPayload)).not.toContain('FLEET_STATUS_PEER_VIEW_MUST_STAY_P2P_ONLY')
  })

  it('debounces rapid p2p status changes while preserving full status payloads', async () => {
    const { reporter, sendStatus } = createReporter({
      serverConnected: false,
      p2pConnected: true,
    })

    await reporter.sendUnifiedStatusReport({ p2pOnly: true, reason: 'initial' })
    expect(sendStatus).toHaveBeenCalledTimes(1)
    expect(sendStatus.mock.calls[0]?.[0]?._delta).toBeUndefined()
    expect(sendStatus.mock.calls[0]?.[0]?.sessions).toHaveLength(1)

    buildStatusSnapshotMock.mockReturnValue({
      instanceId: 'daemon-1',
      machine: { platform: 'darwin', hostname: 'test-host' },
      timestamp: 456,
      p2p: { available: true, state: 'connected', peers: 1, screenshotActive: false },
      sessions: [
        {
          id: 'cli-1',
          parentId: null,
          providerType: 'hermes-cli',
          providerName: 'Hermes Agent',
          kind: 'agent',
          transport: 'pty',
          status: 'generating',
          workspace: '/repo',
          title: 'Hermes task',
          unread: true,
          inboxBucket: 'task_complete',
          completionMarker: 'id:msg_2',
          seenCompletionMarker: '',
          lastUpdated: 456,
        },
      ],
    })

    await reporter.sendUnifiedStatusReport({ p2pOnly: true, reason: 'rapid' })
    expect(sendStatus).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(500)
    expect(sendStatus).toHaveBeenCalledTimes(2)
    expect(sendStatus.mock.calls[1]?.[0]?._delta).toBeUndefined()
    expect(sendStatus.mock.calls[1]?.[0]?.sessions?.[0]).toMatchObject({
      id: 'cli-1',
      status: 'generating',
    })
  })

  it('preserves provider transcript metadata on canonical status events for completion refreshes', () => {
    const { reporter, sendStatusEvent, sendMessage } = createReporter({
      serverConnected: true,
      p2pConnected: true,
    })

    reporter.emitStatusEvent({
      event: 'agent:generating_completed',
      timestamp: 456,
      providerType: 'hermes-cli',
      targetSessionId: 'runtime-session-1',
      providerSessionId: 'provider-session-1',
      workspaceName: '/repo',
      duration: 9,
    })

    const expectedPayload = expect.objectContaining({
      event: 'agent:generating_completed',
      timestamp: 456,
      providerType: 'hermes-cli',
      targetSessionId: 'runtime-session-1',
      providerSessionId: 'provider-session-1',
      workspaceName: '/repo',
      duration: 9,
    })
    expect(sendStatusEvent).toHaveBeenCalledWith(expectedPayload)
    expect(sendMessage).toHaveBeenCalledWith('status_event', expectedPayload)
  })

  it('relays agent:waiting_choice to server and P2P (allowlisted) with its modal projection', () => {
    // Regression: waiting_choice was previously absent from the status-event
    // allowlist (toDaemonStatusEventName), so buildServerStatusEvent returned
    // null and emitStatusEvent early-returned — the coordinator never got a
    // status_event and no push fired. It must now flow through like
    // waiting_approval.
    const { reporter, sendStatusEvent, sendMessage } = createReporter({
      serverConnected: true,
      p2pConnected: true,
    })

    reporter.emitStatusEvent({
      event: 'agent:waiting_choice',
      timestamp: 789,
      providerType: 'claude-cli',
      targetSessionId: 'runtime-session-2',
      modalMessage: 'Pick a branch strategy',
      modalButtons: ['Rebase', 'Merge'],
    })

    const expectedPayload = expect.objectContaining({
      event: 'agent:waiting_choice',
      timestamp: 789,
      providerType: 'claude-cli',
      targetSessionId: 'runtime-session-2',
      modalMessage: 'Pick a branch strategy',
      modalButtons: ['Rebase', 'Merge'],
    })
    expect(sendStatusEvent).toHaveBeenCalledWith(expectedPayload)
    expect(sendMessage).toHaveBeenCalledWith('status_event', expectedPayload)
  })
})
