/**
 * The standalone keyed chat lane wired to the REAL web-core session chat
 * controller registry (not fakes): a verified keyed view arriving on the lane
 * must become the pane's live window, a lane close must keep the last committed
 * view (there is no second lane to fall back to), and the controller's
 * `request_transcript_base` must pass standalone's `/ws` data filter.
 */
import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import {
    applyTranscriptViewToControllers,
    collectRetainedTranscriptSessionInterest,
    getOrCreateSessionChatController,
    requestTranscriptBaseForSession,
    resetSessionChatControllersForTest,
    subscribeTranscriptSessionInterest,
} from '../../web-core/src/components/dashboard/session-chat-controller.ts'
import {
    StandaloneTranscriptLaneClient,
    isStandaloneWsDataFrame,
    type LaneSocket,
} from '../src/standalone-transcript-lane.ts'

const DAEMON = 'standalone_mach_1'
const SESSION = 'sess-1'

afterEach(() => resetSessionChatControllersForTest())

function healthyView(frame: number) {
    return {
        schemaVersion: 2,
        sessionId: SESSION,
        historySessionId: null,
        providerType: 'claude-cli',
        providerSessionId: null,
        producerDaemonId: DAEMON,
        producerWriterId: 'writer-1',
        epoch: 'epoch-1',
        frame,
        observedAt: '2026-09-24T00:00:00.000Z',
        status: 'idle',
        providerObservedStatus: null,
        title: null,
        activeModal: null,
        activeInteractivePrompt: null,
        turn: null,
        provenance: { messageSource: null, transcriptProvenance: null },
        messages: [
            { messageId: 'n.0000beef.1.0', ord: 'a1', rev: 1, role: 'user', kind: 'standard', content: 'hi', receivedAt: 10, timestamp: 10, turnKey: 'u-10', bubbleState: 'final', senderName: null, toolName: null, streaming: null, expandable: false, srcId: null },
            { messageId: 'n.0000beef.2.0', ord: 'a2', rev: 1, role: 'assistant', kind: 'standard', content: 'replica answer', receivedAt: 11, timestamp: 11, turnKey: 'a-11', bubbleState: 'final', senderName: null, toolName: null, streaming: null, expandable: false, srcId: null },
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
    const controller = getOrCreateSessionChatController({
        sendData,
        daemonId: DAEMON,
        sessionId: SESSION,
    })
    controller.retain()

    const sockets: FakeSocket[] = []
    let onView: ((m: any) => void) | null = null
    let onBaseRequest: ((sessionId: string) => void) | null = null
    const activations: string[][] = []
    const client = new StandaloneTranscriptLaneClient({
        createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
        startHost: (_t, viewCb, baseCb) => {
            onView = viewCb
            onBaseRequest = baseCb
            return { pendingCount: () => 0, running: () => true, activateSessions: (ids) => { activations.push([...ids]) }, view: () => null, stop: () => {} }
        },
        collectInterest: collectRetainedTranscriptSessionInterest,
        subscribeInterest: subscribeTranscriptSessionInterest,
        applyView: (daemonId, sessionId, view) => applyTranscriptViewToControllers(daemonId, sessionId, view),
        requestBase: requestTranscriptBaseForSession,
        setTimer: () => null,
        clearTimer: () => {},
        now: () => 0,
    })
    return {
        wire, controller, client, sockets, activations,
        deliver: (m: any) => onView!(m),
        requestBase: (sessionId: string) => onBaseRequest!(sessionId),
    }
}

describe('standalone keyed chat lane → real session chat controller', () => {
    it('derives interest from the retained controller and activates it on the worker host', () => {
        const h = setup()
        h.client.start()
        h.sockets[0]!.fire('open')
        assert.deepEqual(h.activations, [[SESSION]])
        h.client.stop()
    })

    it('a verified view on the lane becomes the live window, with no transport report on /ws', () => {
        const h = setup()
        h.client.start()
        h.sockets[0]!.fire('open')
        h.deliver({ sessionId: SESSION, view: healthyView(2), reset: true })
        const messages = h.controller.getSnapshot().liveMessages as Array<{ content?: unknown }>
        assert.ok(messages.some((m) => m.content === 'replica answer'))
        assert.equal(h.wire.filter((f) => f.commandType === 'report_transcript_transport').length, 0)
        h.client.stop()
    })

    it('a lane close keeps the last committed view (no fallback lane)', () => {
        const h = setup()
        h.client.start()
        h.sockets[0]!.fire('open')
        h.deliver({ sessionId: SESSION, view: healthyView(2), reset: true })
        h.sockets[0]!.fire('close')
        const messages = h.controller.getSnapshot().liveMessages as Array<{ content?: unknown }>
        assert.ok(messages.some((m) => m.content === 'replica answer'))
        h.client.stop()
    })

    it('a worker base-frame request reaches /ws as request_transcript_base (session id only)', () => {
        const h = setup()
        h.client.start()
        h.sockets[0]!.fire('open')
        h.requestBase(SESSION)
        const requests = h.wire.filter((f) => f.type === 'command' && f.commandType === 'request_transcript_base')
        assert.deepEqual(requests, [{ type: 'command', commandType: 'request_transcript_base', data: { rawSessionId: SESSION } }])
        h.client.stop()
    })
})
