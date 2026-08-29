// Worker-transport-foundation criteria 2 and 4 (design §3.6): the main-thread
// bridge must forward 1,000+ envelopes in order in both directions, and its
// pre-open/reconnect queue must be bounded with a TYPED overflow (never a
// silent drop) that resets the channel rather than risking a partial
// committed view.
import { describe, expect, it } from 'vitest'
import { isTranscriptBridgeControlEvent } from '../../src/transcript-transport/bridge-protocol.js'
import { bridgeTranscriptTransport, type MainThreadBridgePortLike } from '../../src/transcript-transport/main-thread-bridge.js'

type Listener = (ev: { data?: unknown }) => void

/** Minimal `WebSocketLike` fake — a real transport (RTCDataChannel/WebSocket) shape. */
class FakeTransport {
    isOpenState = false
    sent: string[] = []
    private listeners: Record<'message' | 'close' | 'open', Listener[]> = { message: [], close: [], open: [] }

    isOpen(): boolean {
        return this.isOpenState
    }

    send(data: string): void {
        this.sent.push(data)
    }

    close(): void {
        this.emit('close', {})
    }

    addEventListener(type: 'message' | 'close' | 'open', cb: Listener): void {
        this.listeners[type].push(cb)
    }

    emit(type: 'message' | 'close' | 'open', ev: { data?: unknown }): void {
        for (const cb of this.listeners[type]) cb(ev)
    }

    open(): void {
        this.isOpenState = true
        this.emit('open', {})
    }
}

function fakeWorkerPort(): { port: MainThreadBridgePortLike; sentToWorker: unknown[]; deliverFromWorker(data: unknown): void } {
    const sentToWorker: unknown[] = []
    let onmessage: ((ev: { data: unknown }) => void) | null = null
    const port: MainThreadBridgePortLike = {
        postMessage(data) {
            sentToWorker.push(data)
        },
        get onmessage() {
            return onmessage
        },
        set onmessage(cb) {
            onmessage = cb
        },
    }
    return {
        port,
        sentToWorker,
        deliverFromWorker(data: unknown) {
            onmessage?.({ data })
        },
    }
}

describe('bridgeTranscriptTransport', () => {
    it('forwards 1,000+ inbound transport messages to the worker port in order, byte-identical', () => {
        const transport = new FakeTransport()
        const { port, sentToWorker } = fakeWorkerPort()
        bridgeTranscriptTransport(transport, port)
        transport.open()

        const COUNT = 1500
        const frames: string[] = []
        for (let i = 0; i < COUNT; i++) {
            const f = JSON.stringify({ i })
            frames.push(f)
            transport.emit('message', { data: f })
        }

        expect(sentToWorker.filter((m): m is string => typeof m === 'string')).toEqual(frames)
    })

    it('forwards 1,000+ outbound worker messages to the transport in order once open', () => {
        const transport = new FakeTransport()
        const { port, deliverFromWorker } = fakeWorkerPort()
        bridgeTranscriptTransport(transport, port)
        transport.open()

        const COUNT = 1500
        const frames: string[] = []
        for (let i = 0; i < COUNT; i++) {
            const f = JSON.stringify({ i })
            frames.push(f)
            deliverFromWorker(f)
        }

        expect(transport.sent).toEqual(frames)
    })

    it('buffers outbound frames while the transport is not open, then flushes in order once it opens (bounded pre-open queue)', () => {
        const transport = new FakeTransport()
        const { port, deliverFromWorker } = fakeWorkerPort()
        const handle = bridgeTranscriptTransport(transport, port)

        const frames = Array.from({ length: 10 }, (_, i) => `frame-${i}`)
        for (const f of frames) deliverFromWorker(f)

        expect(transport.sent).toEqual([])
        expect(handle.pendingCount()).toBe(10)

        transport.open()

        expect(transport.sent).toEqual(frames)
        expect(handle.pendingCount()).toBe(0)
    })

    it('overflowing the pre-open cap is a typed reset, never a silent drop: queue is cleared and a queue_overflow control event reaches the worker', () => {
        const transport = new FakeTransport()
        const { port, deliverFromWorker, sentToWorker } = fakeWorkerPort()
        let overflowReason: string | null = null
        const handle = bridgeTranscriptTransport(transport, port, {
            preOpenQueueCap: 5,
            onOverflow: (reason) => {
                overflowReason = reason
            },
        })

        for (let i = 0; i < 5; i++) deliverFromWorker(`frame-${i}`)
        expect(handle.pendingCount()).toBe(5)

        deliverFromWorker('frame-overflow')

        expect(overflowReason).toBe('pre_open_queue_full')
        expect(handle.pendingCount()).toBe(0) // whole queue discarded, not just the overflowing frame
        const controlEvents = sentToWorker.filter(isTranscriptBridgeControlEvent)
        expect(controlEvents).toEqual([{ kind: 'transcript-bridge-control', event: 'queue_overflow' }])

        // post-overflow, the bridge is closed: further worker sends do nothing
        transport.open()
        deliverFromWorker('frame-after-reset')
        expect(transport.sent).toEqual([])
    })

    it('a real transport close notifies the worker with a typed transport_closed control event', () => {
        const transport = new FakeTransport()
        const { port, sentToWorker } = fakeWorkerPort()
        bridgeTranscriptTransport(transport, port)
        transport.open()

        transport.close()

        expect(sentToWorker.filter(isTranscriptBridgeControlEvent)).toEqual([
            { kind: 'transcript-bridge-control', event: 'transport_open' },
            { kind: 'transcript-bridge-control', event: 'transport_closed' },
        ])
    })
})
