/**
 * The standalone replica lane wired to the REAL web-core chat-tail controller
 * registry (not fakes): a verified snapshot arriving on the lane must flip the
 * controller to `replica`, and the resulting `report_transcript_transport`
 * frame must pass standalone's `/ws` data filter — that frame is what the
 * daemon's `transcriptTransportSelection.replicaSelected` counts, i.e. the
 * acceptance signal for the live check.
 *
 * Before this unit both halves were broken on standalone: nothing fed the
 * controller, and `sendDataViaWs` dropped every non-subscribe frame, so even a
 * fed controller could not have reported.
 */
import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import {
    applyTranscriptReplicaSnapshotToControllers,
    collectRetainedTranscriptSessionInterest,
    getOrCreateSessionChatTailController,
    reportTranscriptReplicaFallbackForSession,
    resetSessionChatTailControllersForTest,
    subscribeTranscriptSessionInterest,
} from '../../web-core/src/components/dashboard/session-chat-tail-controller.ts'
import { SubscriptionManager } from '../../web-core/src/managers/SubscriptionManager.ts'
import {
    StandaloneTranscriptLaneClient,
    isStandaloneWsDataFrame,
    type LaneSocket,
} from '../src/standalone-transcript-lane.ts'

const DAEMON = 'standalone_mach_1'
const SESSION = 'sess-1'

afterEach(() => resetSessionChatTailControllersForTest())

function healthySnapshot(revision: number) {
    return {
        schemaVersion: 1,
        sessionId: SESSION,
        historySessionId: null,
        providerType: 'claude-cli',
        providerSessionId: null,
        producerDaemonId: DAEMON,
        producerWriterId: 'writer-1',
        producerEpoch: 'epoch-1',
        revision,
        observedAt: '2026-09-24T00:00:00.000Z',
        status: 'idle',
        providerObservedStatus: null,
        title: null,
        activeModal: null,
        activeInteractivePrompt: null,
        turn: null,
        provenance: { messageSource: null, transcriptProvenance: null },
        messages: [
            { role: 'user', kind: 'standard', content: 'hi', receivedAt: 10, timestamp: 10, turnKey: 'u-10', bubbleState: 'final', senderName: null, toolName: null, streaming: null },
            { role: 'assistant', kind: 'standard', content: 'replica answer', receivedAt: 11, timestamp: 11, turnKey: 'a-11', bubbleState: 'final', senderName: null, toolName: null, streaming: null },
        ],
        terminalMarkers: [],
        coverage: { mode: 'tail', totalMessageCount: 2, returnedMessageCount: 2, omittedBefore: false },
    } as any
}

class FakeSocket implements LaneSocket {
    readyState = 0
    private l: Record<string, Array<() => void>> = { open: [], close: [], message: [] }
    send(): void {}
    close(): void { this.fire('close') }
    addEventListener(type: string, cb: () => void): void { this.l[type]!.push(cb) }
    fire(type: 'open' | 'close'): void {
        this.readyState = type === 'open' ? 1 : 3
        for (const cb of this.l[type]!) cb()
    }
}

function setup() {
    // What actually reaches the /ws socket: sendDataViaWs's filter applied.
    const wire: any[] = []
    const sendData = (_daemonId: string, data: any): boolean => {
        if (!isStandaloneWsDataFrame(data)) return false
        wire.push(data)
        return true
    }
    const controller = getOrCreateSessionChatTailController({
        manager: new SubscriptionManager(),
        sendData,
        daemonId: DAEMON,
        sessionId: SESSION,
        subscriptionKey: `daemon:${DAEMON}:session:${SESSION}`,
        tailLimit: 60,
    })
    controller.retain()

    const sockets: FakeSocket[] = []
    let onSnapshot: ((m: any) => void) | null = null
    const activations: string[][] = []
    const client = new StandaloneTranscriptLaneClient({
        createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
        startHost: (_t, cb) => {
            onSnapshot = cb
            return { pendingCount: () => 0, running: () => true, activateSessions: (ids) => { activations.push([...ids]) }, stop: () => {} }
        },
        collectInterest: collectRetainedTranscriptSessionInterest,
        subscribeInterest: subscribeTranscriptSessionInterest,
        applySnapshot: applyTranscriptReplicaSnapshotToControllers as any,
        reportFallback: reportTranscriptReplicaFallbackForSession,
        setTimer: () => null,
        clearTimer: () => {},
        now: () => 0,
    })
    return { wire, controller, client, sockets, activations, deliver: (m: any) => onSnapshot!(m) }
}

const reports = (wire: any[]) =>
    wire.filter((f) => f.type === 'command' && f.commandType === 'report_transcript_transport').map((f) => f.data.selection)

describe('standalone replica lane → real chat-tail controller → /ws report', () => {
    it('derives interest from the retained controller and activates it on the worker host', () => {
        const h = setup()
        h.client.start()
        h.sockets[0]!.fire('open')
        assert.deepEqual(h.activations, [[SESSION]])
        h.client.stop()
    })

    it('a verified snapshot on the lane flips the controller to replica and the report reaches /ws', () => {
        const h = setup()
        h.client.start()
        h.sockets[0]!.fire('open')
        assert.deepEqual(reports(h.wire), ['legacy'])

        h.deliver({ kind: 'transcript-bridge-snapshot', sessionId: SESSION, snapshot: healthySnapshot(2), omittedBefore: false })

        assert.deepEqual(reports(h.wire), ['legacy', 'replica'])
        const messages = h.controller.getSnapshot().liveMessages as Array<{ content?: unknown }>
        assert.ok(messages.some((m) => m.content === 'replica answer'))
        h.client.stop()
    })

    it('a lane close falls the controller back to legacy (and reports it)', () => {
        const h = setup()
        h.client.start()
        h.sockets[0]!.fire('open')
        h.deliver({ kind: 'transcript-bridge-snapshot', sessionId: SESSION, snapshot: healthySnapshot(2), omittedBefore: false })
        h.sockets[0]!.fire('close')
        assert.deepEqual(reports(h.wire), ['legacy', 'replica', 'legacy'])
        h.client.stop()
    })
})
