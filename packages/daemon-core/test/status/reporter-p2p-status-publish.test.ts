import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js'
import { createStatusEventEmitter } from '../../src/status/status-event.js'

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
  })

  return { reporter, sendMessage }
}

/**
 * The reporter is SERVER-only since data-path audit 2026-09-29 P0-3: the
 * dashboard's state lane is the keyed daemon.metadata topic, and the old P2P
 * `status_report` full-snapshot push (and its 5s tick) is gone.
 */
describe('DaemonStatusReporter — server status_report only', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-21T12:10:00Z'))
    buildSessionEntriesMock.mockClear()
    buildStatusSnapshotMock.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends nothing at all when the server connection is down (no P2P lane)', async () => {
    const { reporter, sendMessage } = createReporter({ serverConnected: false, p2pConnected: true })
    await reporter.sendUnifiedStatusReport({ reason: 'test' })
    expect(buildStatusSnapshotMock).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('projects the live status snapshot sessions into the server routing frame', async () => {
    const { reporter, sendMessage } = createReporter()
    await reporter.sendUnifiedStatusReport({ reason: 'combined' })
    expect(buildSessionEntriesMock).not.toHaveBeenCalled()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0]?.[0]).toBe('status_report')
    expect(sendMessage.mock.calls[0]?.[1]?.sessions?.[0]).toMatchObject({
      id: 'cli-1',
      providerType: 'hermes-cli',
      status: 'idle',
    })
    expect(sendMessage.mock.calls[0]?.[1]?.p2p).toEqual({ available: true, state: 'connected', peers: 1, screenshotActive: false })
  })

  it('exposes no P2P send surface and no fleet.status producer', () => {
    const { reporter } = createReporter()
    expect((reporter as any).sendP2PPayload).toBeUndefined()
    expect((reporter as any).resetP2PHash).toBeUndefined()
    expect((reporter as any).p2pTimer).toBeUndefined()
  })
})

/**
 * The status_event projection itself — dashboard (P2P) + server delivery from
 * a single provider_event — moved out of DaemonStatusReporter onto the shared
 * bus subscriber status/status-event.ts's createStatusEventEmitter
 * (wiring-unification B5). These two cases (transcript metadata passthrough,
 * waiting_choice allow-listing) used to be pinned via
 * `reporter.emitStatusEvent(...)`; they now go through the bus, exactly as
 * both hosts wire it in production.
 */
describe('status_event projection — bus delivery', () => {
  function createEmitter() {
    const bus = createSessionLifecycleBus()
    const dashboard: any[] = []
    const server: any[] = []
    createStatusEventEmitter(bus, {
      sendDashboard: (p) => dashboard.push(p),
      sendServer: (p) => server.push(p),
    })
    return { bus, dashboard, server }
  }

  it('agent:generating_completed is now turn-sourced only: a provider_event carrying it (legacy producer, still consumed elsewhere on the bus) is dropped, not relayed with its rich metadata', () => {
    // Wiring-unification C-W5 follow-up: `agent:generating_completed` /
    // `agent:stopped` are content-free wire names projected SOLELY from a
    // committed `turn` bus event now (status/status-event.ts's
    // TURN_SOURCED_WIRE_NAMES guard on projectServerStatusEvent). A
    // provider_event still carrying this name — some producers push it for
    // OTHER consumers (mesh-event-forwarding.ts, quota refresh) that have not
    // migrated off provider_event — must never reach status_event with its
    // old rich metadata (providerType/providerSessionId/workspaceName/duration):
    // that shape only ever existed on the legacy provider_event leg, and the
    // turn leg (below) is deliberately minimal/content-free.
    const { bus, dashboard, server } = createEmitter()

    bus.emit({
      kind: 'provider_event',
      sessionId: 'runtime-session-1',
      at: 0,
      event: {
        event: 'agent:generating_completed',
        timestamp: 456,
        providerType: 'hermes-cli',
        targetSessionId: 'runtime-session-1',
        providerSessionId: 'provider-session-1',
        workspaceName: '/repo',
        duration: 9,
      } as any,
    })

    expect(dashboard).toHaveLength(0)
    expect(server).toHaveLength(0)
  })

  it('the canonical (turn-sourced) agent:generating_completed status event is content-free — no provider transcript metadata', () => {
    const { bus, dashboard, server } = createEmitter()

    bus.emit({
      kind: 'turn',
      at: 456,
      phase: 'committed',
      sessionId: 'runtime-session-1',
      attemptId: 'a1',
      generation: 0,
      outcome: 'completed',
      strength: 'genuine',
    } as any)

    const expectedPayload = { event: 'agent:generating_completed', timestamp: 456, targetSessionId: 'runtime-session-1' }
    expect(dashboard[0]).toEqual(expectedPayload)
    expect(server[0]).toEqual(expectedPayload)
  })

  it('relays agent:waiting_choice to server and P2P (allowlisted) with its modal projection', () => {
    // Regression: waiting_choice was previously absent from the status-event
    // allowlist (toDaemonStatusEventName), so projectServerStatusEvent returned
    // null and the emitter early-returned — the coordinator never got a
    // status_event and no push fired. It must now flow through like
    // waiting_approval.
    const { bus, dashboard, server } = createEmitter()

    bus.emit({
      kind: 'provider_event',
      sessionId: 'runtime-session-2',
      at: 0,
      event: {
        event: 'agent:waiting_choice',
        timestamp: 789,
        providerType: 'claude-cli',
        targetSessionId: 'runtime-session-2',
        modalMessage: 'Pick a branch strategy',
        modalButtons: ['Rebase', 'Merge'],
      } as any,
    })

    const expectedPayload = expect.objectContaining({
      event: 'agent:waiting_choice',
      timestamp: 789,
      providerType: 'claude-cli',
      targetSessionId: 'runtime-session-2',
      modalMessage: 'Pick a branch strategy',
      modalButtons: ['Rebase', 'Merge'],
    })
    expect(dashboard[0]).toEqual(expectedPayload)
    expect(server[0]).toEqual(expectedPayload)
  })
})
