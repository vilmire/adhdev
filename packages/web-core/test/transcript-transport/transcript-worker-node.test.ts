// Worker-transport-foundation criterion 1 (design §3.6): a module worker must
// be able to open/close its sqlite-wasm-backed seqscribe node repeatedly with
// zero leaked handles/timers/subscriptions. This exercises the REAL
// `@sqlite.org/sqlite-wasm` engine (the same one the browser Worker runs)
// against an in-memory `oo1.DB` — the identical pattern seqscribe's own
// `adapters-cloud.test.ts` uses to validate `sqliteWasmHandle` without a
// browser. OPFS persistence itself is browser-only and untestable here; see
// `transcript-worker-entry.ts`'s header for why that gap is deliberate.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import type { Channel, SqliteWasmDbLike, TopicPolicy } from 'seqscribe'
import { sqliteWasmHandle } from 'seqscribe'
import { describe, expect, it } from 'vitest'
import { TranscriptWorkerNode, type TranscriptWorkerStorage } from '../../src/transcript-transport/transcript-worker-node.js'

async function memoryStorage(): Promise<TranscriptWorkerStorage> {
    const sqlite3 = await sqlite3InitModule()
    const db = new sqlite3.oo1.DB(':memory:')
    return {
        handle: sqliteWasmHandle(db as unknown as SqliteWasmDbLike),
        dispose(): void {
            db.close()
        },
    }
}

/** In-process duplex `Channel` pair — test-only loopback, not a MessagePort. */
function channelPair(): [Channel, Channel] {
    let aMessageCb: ((m: string) => void) | null = null
    let bMessageCb: ((m: string) => void) | null = null
    let aCloseCb: (() => void) | null = null
    let bCloseCb: (() => void) | null = null
    const a: Channel = {
        send(msg) {
            queueMicrotask(() => bMessageCb?.(msg))
        },
        onMessage(cb) {
            aMessageCb = cb
        },
        onClose(cb) {
            aCloseCb = cb
        },
        close() {
            queueMicrotask(() => bCloseCb?.())
        },
    }
    const b: Channel = {
        send(msg) {
            queueMicrotask(() => aMessageCb?.(msg))
        },
        onMessage(cb) {
            bMessageCb = cb
        },
        onClose(cb) {
            bCloseCb = cb
        },
        close() {
            queueMicrotask(() => aCloseCb?.())
        },
    }
    return [a, b]
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now()
    while (!cond()) {
        if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
}

describe('TranscriptWorkerNode lifecycle', () => {
    it('repeated open/close leaves zero attached peers/subscriptions each cycle', async () => {
        for (let i = 0; i < 5; i++) {
            const node = new TranscriptWorkerNode({ writerId: `adhdev_test_${i}`, openStorage: memoryStorage })
            expect(node.stats()).toEqual({ open: false, attachedPeers: 0, activeSubscriptions: 0 })
            await node.open()
            expect(node.stats()).toEqual({ open: true, attachedPeers: 0, activeSubscriptions: 0 })
            await node.close()
            expect(node.stats()).toEqual({ open: false, attachedPeers: 0, activeSubscriptions: 0 })
        }
    })

    it('disposes storage exactly once per open/close cycle, and close() is idempotent', async () => {
        let disposeCount = 0
        const openStorage = async (): Promise<TranscriptWorkerStorage> => {
            const real = await memoryStorage()
            return {
                handle: real.handle,
                dispose() {
                    disposeCount++
                    return real.dispose()
                },
            }
        }
        const node = new TranscriptWorkerNode({ writerId: 'adhdev_test_dispose', openStorage })
        await node.open()
        expect(disposeCount).toBe(0)
        await node.close()
        expect(disposeCount).toBe(1)
        await node.close()
        expect(disposeCount).toBe(1)
    })

    it('rejects reading .node before open() and rejects a second open()', async () => {
        const node = new TranscriptWorkerNode({ writerId: 'adhdev_test_guard', openStorage: memoryStorage })
        expect(() => node.node).toThrow()
        await node.open()
        await expect(node.open()).rejects.toThrow()
        await node.close()
    })

    it('attach + subscribe delivers a real revision row, and close() detaches/unsubscribes cleanly', async () => {
        const TOPIC = 'session.worker-foundation-test.transcript'
        const policy: TopicPolicy = {
            kind: 'append',
            retention: { mode: 'ring', size: 8 },
            replication: 'subscribe-only',
            access: 'content',
        }

        const producer = new TranscriptWorkerNode({ writerId: 'adhdev_producer', openStorage: memoryStorage })
        const consumer = new TranscriptWorkerNode({ writerId: 'adhdev_consumer', openStorage: memoryStorage })
        await producer.open()
        await consumer.open()

        producer.node.defineTopic(TOPIC, policy)
        consumer.node.defineTopic(TOPIC, policy)

        const [producerChannel, consumerChannel] = channelPair()
        producer.attach(producerChannel, { peerId: 'consumer', peerClass: 'content', grants: { [TOPIC]: 'serve' } })
        const consumerPeer = consumer.attach(consumerChannel, {
            peerId: 'producer',
            peerClass: 'content',
            grants: { [TOPIC]: 'none' },
        })

        await producer.node.log(TOPIC).append('transcript.revision.commit.v1', { i: 1 })

        const snapshots: unknown[][] = []
        const sub = consumer.subscribe(consumerPeer, { view: 'tail', params: { topic: TOPIC } })
        sub.onSnapshot((rows) => snapshots.push(rows))

        await waitFor(() => snapshots.length > 0)
        expect(consumer.stats()).toEqual({ open: true, attachedPeers: 1, activeSubscriptions: 1 })
        expect(producer.stats()).toEqual({ open: true, attachedPeers: 1, activeSubscriptions: 0 })

        await producer.close()
        await consumer.close()

        expect(producer.stats()).toEqual({ open: false, attachedPeers: 0, activeSubscriptions: 0 })
        expect(consumer.stats()).toEqual({ open: false, attachedPeers: 0, activeSubscriptions: 0 })
    })
})
