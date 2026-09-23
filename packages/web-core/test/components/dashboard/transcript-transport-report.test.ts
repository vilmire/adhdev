/**
 * G2 transcript-transport selection reporting
 * (`SessionChatTailController#reportTransportSelection`, private, driven
 * through `syncLegacySubscription()`).
 *
 * The daemon-side `transcriptTransportSelection` counters
 * (`replicaSelected`/`legacySelected`, design §7e G2) can only be fed by the
 * browser, because `replicaHealthy`/`shouldRunLegacySubscription()` are
 * pure browser state the daemon never otherwise observes (see
 * `oss/packages/daemon-core/src/seqscribe/transcript-transport-selection.ts`'s
 * header). This file pins the wire contract: what frame goes out, when, and
 * how often — reusing `legacy-chat-tail-retirement.test.ts`'s setup/health-
 * transition helpers so the assertions describe the same real transitions
 * that file already proves retire/re-arm legacy correctly.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ReplicatedTranscriptSnapshotV1 } from '@adhdev/daemon-core'
import { SubscriptionManager } from '../../../src/managers/SubscriptionManager'
import {
  getOrCreateSessionChatTailController,
  resetSessionChatTailControllersForTest,
} from '../../../src/components/dashboard/session-chat-tail-controller'

const DAEMON = 'daemon-1'
const SESSION = 'session-1'
const SUBSCRIPTION_KEY = `daemon:${DAEMON}:session:${SESSION}`

function snapshot(overrides: Partial<ReplicatedTranscriptSnapshotV1> = {}): ReplicatedTranscriptSnapshotV1 {
  return {
    schemaVersion: 1,
    sessionId: SESSION,
    historySessionId: null,
    providerType: 'claude-cli',
    providerSessionId: null,
    producerDaemonId: DAEMON,
    producerWriterId: 'writer-1',
    producerEpoch: 'epoch-1',
    revision: 1,
    observedAt: '2026-09-05T00:00:00.000Z',
    status: 'idle',
    providerObservedStatus: null,
    title: null,
    activeModal: null,
    activeInteractivePrompt: null,
    turn: null,
    provenance: { messageSource: null, transcriptProvenance: null },
    messages: [],
    terminalMarkers: [],
    coverage: { mode: 'tail', totalMessageCount: 0, returnedMessageCount: 0, omittedBefore: false },
    ...overrides,
  }
}

function message(
  role: 'user' | 'assistant',
  content: string,
  receivedAt: number,
): ReplicatedTranscriptSnapshotV1['messages'][number] {
  return {
    role,
    kind: 'standard',
    content,
    receivedAt,
    timestamp: receivedAt,
    turnKey: `${role}-${receivedAt}`,
    bubbleState: 'final',
    senderName: null,
    toolName: null,
    streaming: null,
  } as ReplicatedTranscriptSnapshotV1['messages'][number]
}

function healthySnapshot(revision: number, ...contents: string[]) {
  return snapshot({
    revision,
    messages: contents.map((c, i) => message(i % 2 === 0 ? 'user' : 'assistant', c, 10 + i)),
  })
}

function setup() {
  resetSessionChatTailControllersForTest()
  const manager = new SubscriptionManager()
  const sendData = vi.fn().mockReturnValue(true)
  const controller = getOrCreateSessionChatTailController({
    manager,
    sendData,
    daemonId: DAEMON,
    sessionId: SESSION,
    subscriptionKey: SUBSCRIPTION_KEY,
    tailLimit: 60,
  })
  return { manager, sendData, controller }
}

/** The report_transcript_transport command frames actually sent, in order. */
function transportReportFrames(sendData: ReturnType<typeof vi.fn>): Array<{ selection: string }> {
  return sendData.mock.calls
    .map((call) => call[1] as { type: string; commandType?: string; data?: { selection: string } })
    .filter((f) => f.type === 'command' && f.commandType === 'report_transcript_transport')
    .map((f) => f.data as { selection: string })
}

describe('transcript transport selection reporting', () => {
  it('reports "legacy" on first retain (no replica has ever arrived)', () => {
    const { sendData, controller } = setup()
    controller.retain()

    const reports = transportReportFrames(sendData)
    expect(reports).toEqual([{ selection: 'legacy' }])
  })

  it('reports "replica" once a verified snapshot lands, without re-reporting on every subsequent snapshot', () => {
    const { sendData, controller } = setup()
    controller.retain()
    controller.applyTranscriptReplicaSnapshot(healthySnapshot(2, 'replica answer'), { omittedBefore: false })
    controller.applyTranscriptReplicaSnapshot(healthySnapshot(3, 'replica answer', 'two'), {
      omittedBefore: false,
    })
    controller.applyTranscriptReplicaSnapshot(healthySnapshot(4, 'replica answer', 'two', 'three'), {
      omittedBefore: false,
    })

    // legacy (retain) -> replica (first healthy snapshot); the two further
    // snapshots do not churn the subscription (legacy-chat-tail-retirement's
    // own "further replica snapshots do not churn" test) and must not
    // re-report an unchanged selection either.
    expect(transportReportFrames(sendData)).toEqual([{ selection: 'legacy' }, { selection: 'replica' }])
  })

  it('reports "legacy" again after a fallback re-arms it', () => {
    const { sendData, controller } = setup()
    controller.retain()
    controller.applyTranscriptReplicaSnapshot(healthySnapshot(2, 'replica answer'), { omittedBefore: false })
    controller.reportTranscriptReplicaFallback('no_node')

    expect(transportReportFrames(sendData)).toEqual([
      { selection: 'legacy' },
      { selection: 'replica' },
      { selection: 'legacy' },
    ])
  })

  it('recovery is not one-way: replica -> legacy -> replica reports each transition once', () => {
    const { sendData, controller } = setup()
    controller.retain()
    controller.applyTranscriptReplicaSnapshot(healthySnapshot(2, 'replica one'), { omittedBefore: false })
    controller.reportTranscriptReplicaFallback('no_node')
    controller.applyTranscriptReplicaSnapshot(healthySnapshot(3, 'r1', 'replica two'), { omittedBefore: false })

    expect(transportReportFrames(sendData)).toEqual([
      { selection: 'legacy' },
      { selection: 'replica' },
      { selection: 'legacy' },
      { selection: 'replica' },
    ])
  })

  it('★ a repeated fallback with the SAME reason does not re-report legacy twice (dedup)', () => {
    const { sendData, controller } = setup()
    controller.retain()
    controller.applyTranscriptReplicaSnapshot(healthySnapshot(2, 'replica answer'), { omittedBefore: false })
    controller.reportTranscriptReplicaFallback('no_node')
    // `reportTranscriptReplicaFallback`'s own dedup guard still re-syncs the
    // legacy subscription state on a repeat identical fallback (its header:
    // "the second identical report is exactly the case where a resubscribe
    // was previously dropped"), but the transport selection itself has not
    // CHANGED — it was already 'legacy' — so this must not add a duplicate.
    controller.reportTranscriptReplicaFallback('no_node')

    expect(transportReportFrames(sendData)).toEqual([{ selection: 'legacy' }, { selection: 'replica' }, { selection: 'legacy' }])
  })

  it('reports fresh (legacy) after dispose + re-retain, matching health being re-earned', () => {
    const { sendData, controller } = setup()
    controller.retain()
    controller.applyTranscriptReplicaSnapshot(healthySnapshot(2, 'replica answer'), { omittedBefore: false })
    controller.release()
    controller.dispose()

    sendData.mockClear()
    controller.retain()

    expect(transportReportFrames(sendData)).toEqual([{ selection: 'legacy' }])
  })

  it('never sends the report frame when sendData is absent (no P2P connection)', () => {
    resetSessionChatTailControllersForTest()
    const manager = new SubscriptionManager()
    const controller = getOrCreateSessionChatTailController({
      manager,
      daemonId: DAEMON,
      sessionId: SESSION,
      subscriptionKey: SUBSCRIPTION_KEY,
      tailLimit: 60,
    })
    // No sendData wired — must not throw.
    expect(() => controller.retain()).not.toThrow()
  })

  it('★ content boundary: the reported value is always the closed enum, never richer session data', () => {
    const { sendData, controller } = setup()
    controller.retain()
    controller.applyTranscriptReplicaSnapshot(healthySnapshot(2, 'super secret prompt content'), {
      omittedBefore: false,
    })

    const reports = transportReportFrames(sendData)
    for (const report of reports) {
      expect(Object.keys(report)).toEqual(['selection'])
      expect(['replica', 'legacy']).toContain(report.selection)
    }
    const wire = JSON.stringify(sendData.mock.calls)
    expect(wire).not.toContain('super secret prompt content')
  })
})
