// Worker-transport-foundation criterion 2 (design §3.6): the MessagePort
// bridge must deliver 1,000+ test envelopes in order and byte-identical.
// Uses Node's real global `MessageChannel`/`MessagePort` (available since
// Node 15, structurally identical to the browser API this code targets) —
// not a mock — so delivery order/identity is verified against the actual
// message-passing primitive, not an assumption about it.
import { describe, expect, it } from 'vitest'
import { transcriptBridgeControlEvent } from '../../src/transcript-transport/bridge-protocol.js'
import { workerPortChannel, type MessagePortLike } from '../../src/transcript-transport/message-port-channel.js'

function frame(i: number): string {
    return JSON.stringify({ i, pad: 'x'.repeat(i % 37) })
}

function asPortLike(port: MessagePort): MessagePortLike {
    return port as unknown as MessagePortLike
}

describe('workerPortChannel', () => {
    it('delivers 1,000+ envelopes in order and byte-identical over a real MessagePort', async () => {
        const { port1, port2 } = new MessageChannel()
        const { channel } = workerPortChannel(asPortLike(port2))

        const received: string[] = []
        channel.onMessage((m) => received.push(m))

        const COUNT = 1200
        const sent: string[] = []
        for (let i = 0; i < COUNT; i++) {
            const f = frame(i)
            sent.push(f)
            port1.postMessage(f)
        }

        await new Promise((resolve) => setTimeout(resolve, 50))

        expect(received).toHaveLength(COUNT)
        expect(received).toEqual(sent)
        port1.close()
        port2.close()
    })

    it('forwards outbound sends through to the raw port in order', async () => {
        const { port1, port2 } = new MessageChannel()
        const { channel } = workerPortChannel(asPortLike(port2))

        const received: unknown[] = []
        port1.onmessage = (ev) => received.push(ev.data)

        const COUNT = 1200
        const sent: string[] = []
        for (let i = 0; i < COUNT; i++) {
            const f = frame(i)
            sent.push(f)
            channel.send(f)
        }

        await new Promise((resolve) => setTimeout(resolve, 50))

        expect(received).toEqual(sent)
        port1.close()
        port2.close()
    })

    it('routes bridge control events to onControl, never to onMessage (content demux)', async () => {
        const { port1, port2 } = new MessageChannel()
        const { channel, onControl } = workerPortChannel(asPortLike(port2))

        const messages: string[] = []
        const controlEvents: string[] = []
        channel.onMessage((m) => messages.push(m))
        onControl((e) => controlEvents.push(e.event))

        port1.postMessage(transcriptBridgeControlEvent('transport_open'))
        port1.postMessage('a real wire frame')

        await new Promise((resolve) => setTimeout(resolve, 20))

        expect(controlEvents).toEqual(['transport_open'])
        expect(messages).toEqual(['a real wire frame'])
        port1.close()
        port2.close()
    })

    it('a reset control event (transport_closed / queue_overflow) closes the channel', async () => {
        for (const resetEvent of ['transport_closed', 'queue_overflow'] as const) {
            const { port1, port2 } = new MessageChannel()
            const { channel } = workerPortChannel(asPortLike(port2))

            let closed = false
            channel.onClose(() => {
                closed = true
            })

            port1.postMessage(transcriptBridgeControlEvent(resetEvent))
            await new Promise((resolve) => setTimeout(resolve, 20))

            expect(closed).toBe(true)
            port1.close()
            port2.close()
        }
    })
})
