// Assembly seam between a live transport and the transcript Worker
// (design §3.6, §8 unit 4). Uses REAL `MessageChannel` ports (Node has them
// globally) with a fake Worker/transport, so the port transfer, the opaque
// forwarding, and the teardown ordering are all exercised for real — only the
// worker body and the WebRTC/WS transport are stood in for.
import { describe, expect, it, vi } from 'vitest'
import {
    startTranscriptWorkerHost,
    type TranscriptWorkerLike,
} from '../../src/transcript-transport/transcript-worker-host.js'
import type { WebSocketLike } from 'seqscribe'

class FakeTransport implements WebSocketLike {
    readyState: number | string = 0
    readonly sent: string[] = []
    private readonly listeners = new Map<string, ((ev: { data?: unknown }) => void)[]>()

    isOpen(): boolean {
        return this.readyState === 1 || this.readyState === 'open'
    }
    send(data: string): void {
        this.sent.push(data)
    }
    close(): void {
        this.readyState = 3
        this.emit('close', {})
    }
    addEventListener(type: string, cb: (ev: { data?: unknown }) => void): void {
        const list = this.listeners.get(type) ?? []
        list.push(cb)
        this.listeners.set(type, list)
    }
    emit(type: string, ev: { data?: unknown }): void {
        for (const cb of this.listeners.get(type) ?? []) cb(ev)
    }
    open(): void {
        this.readyState = 1
        this.emit('open', {})
    }
}

function fakeWorker(): TranscriptWorkerLike & {
    readonly messages: unknown[]
    readonly transfers: readonly unknown[][]
    terminated: number
    port: MessagePort | null
} {
    const messages: unknown[] = []
    const transfers: readonly unknown[][] = []
    return {
        messages,
        transfers: transfers as readonly unknown[][],
        terminated: 0,
        port: null,
        postMessage(data: unknown, transfer?: readonly unknown[]) {
            messages.push(data)
            ;(transfers as unknown[][]).push([...(transfer ?? [])])
            const port = transfer?.[0]
            if (port) this.port = port as MessagePort
        },
        terminate() {
            this.terminated += 1
        },
    }
}

/** Lets a test act as the worker: read what the host forwards, and send back. */
function attachWorkerSide(port: MessagePort): { received: string[]; send(msg: string): void } {
    const received: string[] = []
    port.onmessage = (ev) => {
        if (typeof ev.data === 'string') received.push(ev.data)
    }
    port.start()
    return { received, send: (msg) => port.postMessage(msg) }
}

const OPTS = { writerId: 'writer_abc', sessionKey: 'sess_1' }

describe('startTranscriptWorkerHost', () => {
    it('hands the worker its init payload and transfers exactly two ports (wire + snapshot)', () => {
        const worker = fakeWorker()
        const host = startTranscriptWorkerHost(new FakeTransport(), {
            ...OPTS,
            createWorker: () => worker,
        })

        expect(worker.messages).toEqual([{ sessionKey: 'sess_1', writerId: 'writer_abc' }])
        // Two ports, in a fixed order: [wire, snapshot]. The worker entry reads
        // them positionally (`ev.ports[0]`/`[1]`), so the count AND the order
        // are part of the contract — see the two-ports note in the host header.
        expect(worker.transfers[0]).toHaveLength(2)
        expect(host.running()).toBe(true)
        host.stop()
    })

    it('forwards inbound transport frames to the worker port byte-identically', async () => {
        const transport = new FakeTransport()
        const worker = fakeWorker()
        const host = startTranscriptWorkerHost(transport, { ...OPTS, createWorker: () => worker })
        const workerSide = attachWorkerSide(worker.port!)

        const frames = Array.from({ length: 50 }, (_, i) => `{"seq":${i},"payload":"x${i}"}`)
        for (const f of frames) transport.emit('message', { data: f })
        await new Promise((r) => setTimeout(r, 20))

        expect(workerSide.received).toEqual(frames)
        host.stop()
    })

    it('forwards outbound worker frames to the transport once it is open', async () => {
        const transport = new FakeTransport()
        const worker = fakeWorker()
        const host = startTranscriptWorkerHost(transport, { ...OPTS, createWorker: () => worker })
        const workerSide = attachWorkerSide(worker.port!)
        transport.open()

        workerSide.send('HELLO')
        workerSide.send('SUB')
        await new Promise((r) => setTimeout(r, 20))

        expect(transport.sent).toEqual(['HELLO', 'SUB'])
        host.stop()
    })

    it('buffers worker frames while the transport is closed and reports them via pendingCount', async () => {
        const transport = new FakeTransport()
        const worker = fakeWorker()
        const host = startTranscriptWorkerHost(transport, { ...OPTS, createWorker: () => worker })
        const workerSide = attachWorkerSide(worker.port!)

        workerSide.send('A')
        workerSide.send('B')
        await new Promise((r) => setTimeout(r, 20))

        expect(host.pendingCount()).toBe(2)
        expect(transport.sent).toEqual([])

        transport.open()
        await new Promise((r) => setTimeout(r, 20))
        expect(transport.sent).toEqual(['A', 'B'])
        expect(host.pendingCount()).toBe(0)
        host.stop()
    })

    it('surfaces a bounded pre-open queue overflow as a typed callback, not a silent drop', async () => {
        const transport = new FakeTransport()
        const worker = fakeWorker()
        const onOverflow = vi.fn()
        const host = startTranscriptWorkerHost(transport, {
            ...OPTS,
            createWorker: () => worker,
            preOpenQueueCap: 2,
            onOverflow,
        })
        const workerSide = attachWorkerSide(worker.port!)

        workerSide.send('A')
        workerSide.send('B')
        workerSide.send('C') // exceeds the cap
        await new Promise((r) => setTimeout(r, 20))

        expect(onOverflow).toHaveBeenCalledTimes(1)
        // The whole queue is shed rather than partially flushed — a truncated
        // chunk sequence must never reach the worker.
        expect(host.pendingCount()).toBe(0)
        expect(transport.sent).toEqual([])
        host.stop()
    })

    it('stop() terminates the worker exactly once and is idempotent', () => {
        const worker = fakeWorker()
        const host = startTranscriptWorkerHost(new FakeTransport(), {
            ...OPTS,
            createWorker: () => worker,
        })

        host.stop()
        host.stop()
        host.stop()

        expect(worker.terminated).toBe(1)
        expect(host.running()).toBe(false)
    })

    it('stops forwarding after stop(), so a late transport frame cannot reach a terminated worker', async () => {
        const transport = new FakeTransport()
        const worker = fakeWorker()
        const host = startTranscriptWorkerHost(transport, { ...OPTS, createWorker: () => worker })
        const workerSide = attachWorkerSide(worker.port!)
        transport.open()

        host.stop()
        transport.emit('message', { data: 'AFTER_STOP' })
        await new Promise((r) => setTimeout(r, 20))

        expect(workerSide.received).not.toContain('AFTER_STOP')
    })

    // ★ The case above passes even if `stop()` forgets to close the bridge,
    // because closing the real MessagePort masks it. This one isolates the
    // bridge's own teardown by injecting a port that STAYS live after
    // `close()` — so the only thing that can stop the relay is the bridge
    // having been closed. Found by mutation-testing `stop()`.
    it('stop() closes the bridge itself, not merely the port', () => {
        const transport = new FakeTransport()
        const worker = fakeWorker()

        // A port whose close() is a no-op and whose onmessage handler the
        // bridge installs; we invoke that handler directly afterwards.
        const livePort: any = { postMessage: vi.fn(), onmessage: null, start: vi.fn(), close: vi.fn() }
        const host = startTranscriptWorkerHost(transport, {
            ...OPTS,
            createWorker: () => worker,
            createChannel: () => ({ port1: livePort, port2: {} }),
        })
        transport.open()

        const handlerBeforeStop = livePort.onmessage
        expect(handlerBeforeStop).toBeTypeOf('function')

        host.stop()

        // Whether the bridge detached its handler or merely flagged itself
        // closed, a post-stop worker frame must not reach the transport.
        livePort.onmessage?.({ data: 'AFTER_STOP' })
        expect(transport.sent).not.toContain('AFTER_STOP')

        // And a post-stop inbound frame must not be pushed to the worker port.
        livePort.postMessage.mockClear()
        transport.emit('message', { data: 'INBOUND_AFTER_STOP' })
        expect(livePort.postMessage).not.toHaveBeenCalled()
    })
})
