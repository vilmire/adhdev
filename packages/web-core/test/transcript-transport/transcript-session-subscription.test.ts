// The live worker feed (unit 4b): a real seqscribe producer appends real
// begin/chunk/commit rows for `session.<safeSessionId>.transcript`, and the
// browser-side subscription reassembles them into a verified snapshot.
//
// Deliberately end-to-end over the REAL stack — real sqlite-wasm storage, real
// seqscribe SUB, the real daemon-core encoder, the real assembler. A fake that
// handed pre-built snapshots to the adapter would prove nothing about the part
// that was actually missing: whether a browser node can define the same topic
// the daemon defined, subscribe through a peer, and pass the codec's
// hash/chunk/owner verification against bytes a real producer emitted.
import { encodeTranscriptRevision } from '@adhdev/daemon-core/seqscribe/transcript-revision-codec'
import type { ReplicatedTranscriptSnapshotV1 } from '@adhdev/daemon-core/seqscribe/transcript-projection'
import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import type { Channel, SqliteWasmDbLike } from 'seqscribe'
import { sqliteWasmHandle } from 'seqscribe'
import { describe, expect, it } from 'vitest'
import { sessionTranscriptPolicy, sessionTranscriptTopic } from '../../src/transcript-transport/topic-addressing.js'
import { subscribeSessionTranscript } from '../../src/transcript-transport/transcript-session-subscription.js'
import {
    TranscriptWorkerNode,
    type TranscriptWorkerStorage,
} from '../../src/transcript-transport/transcript-worker-node.js'
import { browserRejectAuthority } from '../../src/transcript-transport/browser-reject-authority.js'

const SESSION_ID = 'sess-Live-Feed-01'
const TOPIC = sessionTranscriptTopic(SESSION_ID)
const PRODUCER_WRITER = 'adhdev_daemon_writer'

async function memoryStorage(): Promise<TranscriptWorkerStorage> {
    const sqlite3 = await sqlite3InitModule()
    const db = new sqlite3.oo1.DB(':memory:')
    return {
        handle: sqliteWasmHandle(db as unknown as SqliteWasmDbLike),
        dispose: () => db.close(),
    }
}

function channelPair(): [Channel, Channel] {
    let aMsg: ((m: string) => void) | null = null
    let bMsg: ((m: string) => void) | null = null
    let aClose: (() => void) | null = null
    let bClose: (() => void) | null = null
    const a: Channel = {
        send: (m) => queueMicrotask(() => bMsg?.(m)),
        onMessage: (cb) => void (aMsg = cb),
        onClose: (cb) => void (aClose = cb),
        close: () => queueMicrotask(() => bClose?.()),
    }
    const b: Channel = {
        send: (m) => queueMicrotask(() => aMsg?.(m)),
        onMessage: (cb) => void (bMsg = cb),
        onClose: (cb) => void (bClose = cb),
        close: () => queueMicrotask(() => aClose?.()),
    }
    return [a, b]
}

async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
    const start = Date.now()
    while (!cond()) {
        if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
        await new Promise((r) => setTimeout(r, 5))
    }
}

function snapshotFixture(revision: number, content: string): ReplicatedTranscriptSnapshotV1 {
    return {
        schemaVersion: 1,
        sessionId: SESSION_ID,
        historySessionId: null,
        providerType: 'claude',
        providerSessionId: null,
        producerDaemonId: 'daemon_owner',
        producerWriterId: PRODUCER_WRITER,
        producerEpoch: 'epoch-1',
        revision,
        observedAt: '2026-09-04T00:00:00.000Z',
        status: 'idle',
        providerObservedStatus: null,
        title: null,
        activeModal: null,
        activeInteractivePrompt: null,
        turn: null,
        provenance: { messageSource: 'native', transcriptProvenance: null },
        messages: [
            {
                role: 'assistant',
                kind: 'text',
                content,
                receivedAt: 1_700_000_000_000,
                timestamp: null,
                turnKey: `turn-${revision}`,
                bubbleState: null,
                senderName: null,
                toolName: null,
                streaming: null,
            },
        ],
        terminalMarkers: [],
        coverage: { mode: 'tail', totalMessageCount: 1, returnedMessageCount: 1, omittedBefore: false },
    } as unknown as ReplicatedTranscriptSnapshotV1
}

/** Append one full begin/chunk/commit envelope, as the daemon's publisher does. */
async function publishRevision(
    producer: TranscriptWorkerNode,
    snapshot: ReplicatedTranscriptSnapshotV1,
): Promise<void> {
    const encoded = encodeTranscriptRevision(snapshot, {
        sessionId: snapshot.sessionId,
        producerDaemonId: snapshot.producerDaemonId,
        producerWriterId: snapshot.producerWriterId,
        producerEpoch: snapshot.producerEpoch,
        revision: snapshot.revision,
    })
    if (!encoded.ok) throw new Error(`fixture should not be oversize: ${encoded.reason}`)
    const log = producer.node.log(TOPIC)
    await log.append('transcript.revision.begin.v1', encoded.begin as never)
    for (const chunk of encoded.chunks) await log.append('transcript.revision.chunk.v1', chunk as never)
    await log.append('transcript.revision.commit.v1', encoded.commit as never)
}

interface Rig {
    producer: TranscriptWorkerNode
    consumer: TranscriptWorkerNode
    consumerPeer: ReturnType<TranscriptWorkerNode['attach']>
    close(): Promise<void>
}

async function rig(): Promise<Rig> {
    const producer = new TranscriptWorkerNode({
        writerId: PRODUCER_WRITER,
        openStorage: memoryStorage,
        authority: browserRejectAuthority,
    })
    // The browser consumer: no fleet secret, only the non-signing hooks.
    const consumer = new TranscriptWorkerNode({
        writerId: 'dashboard_writer',
        openStorage: memoryStorage,
        authority: browserRejectAuthority,
    })
    await producer.open()
    await consumer.open()
    producer.node.defineTopic(TOPIC, sessionTranscriptPolicy())

    const [pChan, cChan] = channelPair()
    producer.attach(pChan, { peerId: 'dashboard', peerClass: 'content', grants: { [TOPIC]: 'serve' } })
    const consumerPeer = consumer.attach(cChan, { peerId: 'daemon', peerClass: 'content', grants: {} })

    return {
        producer,
        consumer,
        consumerPeer,
        async close() {
            await producer.close()
            await consumer.close()
        },
    }
}

describe('subscribeSessionTranscript (live worker feed)', () => {
    it('reassembles a real published revision into a verified snapshot', async () => {
        const r = await rig()
        try {
            const seen: { content: string; omittedBefore: boolean }[] = []
            const sub = subscribeSessionTranscript(r.consumer, {
                sessionId: SESSION_ID,
                peer: r.consumerPeer,
                ownerWriterId: PRODUCER_WRITER,
                onSnapshot: ({ snapshot, omittedBefore }) =>
                    seen.push({ content: snapshot.messages[0].content, omittedBefore }),
            })

            // The browser derives the SAME topic name the daemon defined.
            expect(sub.topic).toBe(TOPIC)

            await publishRevision(r.producer, snapshotFixture(1, 'hello from the daemon'))
            await waitFor(() => seen.length > 0)

            expect(seen[0].content).toBe('hello from the daemon')
            expect(sub.latest()?.snapshot.revision).toBe(1)
            sub.close()
        } finally {
            await r.close()
        }
    })

    it('delivers successive revisions in order', async () => {
        const r = await rig()
        try {
            const revisions: number[] = []
            const sub = subscribeSessionTranscript(r.consumer, {
                sessionId: SESSION_ID,
                peer: r.consumerPeer,
                ownerWriterId: PRODUCER_WRITER,
                onSnapshot: ({ snapshot }) => revisions.push(snapshot.revision),
            })

            await publishRevision(r.producer, snapshotFixture(1, 'first'))
            await waitFor(() => revisions.length >= 1)
            await publishRevision(r.producer, snapshotFixture(2, 'second'))
            await waitFor(() => revisions.length >= 2)

            expect(revisions).toEqual([1, 2])
            expect(sub.latest()?.snapshot.messages[0].content).toBe('second')
            sub.close()
        } finally {
            await r.close()
        }
    })

    it('rejects a revision written by a writer that is not the declared owner', async () => {
        const r = await rig()
        try {
            const seen: unknown[] = []
            const rejected: string[] = []
            subscribeSessionTranscript(r.consumer, {
                sessionId: SESSION_ID,
                peer: r.consumerPeer,
                // Gate on a DIFFERENT writer than the one that will publish.
                ownerWriterId: 'some_other_writer',
                onSnapshot: (u) => seen.push(u),
                onRejected: (reason) => rejected.push(reason),
            })

            await publishRevision(r.producer, snapshotFixture(1, 'should not be displayed'))
            await waitFor(() => rejected.length > 0)

            expect(rejected).toContain('wrong_writer')
            expect(seen).toEqual([])
        } finally {
            await r.close()
        }
    })

    it('an incomplete revision (commit never arrives) produces no snapshot', async () => {
        const r = await rig()
        try {
            const seen: unknown[] = []
            const sub = subscribeSessionTranscript(r.consumer, {
                sessionId: SESSION_ID,
                peer: r.consumerPeer,
                ownerWriterId: PRODUCER_WRITER,
                onSnapshot: (u) => seen.push(u),
            })

            const snapshot = snapshotFixture(1, 'half-written')
            const encoded = encodeTranscriptRevision(snapshot, {
                sessionId: snapshot.sessionId,
                producerDaemonId: snapshot.producerDaemonId,
                producerWriterId: snapshot.producerWriterId,
                producerEpoch: snapshot.producerEpoch,
                revision: snapshot.revision,
            })
            if (!encoded.ok) throw new Error('fixture oversize')
            const log = r.producer.node.log(TOPIC)
            // begin + chunks, but deliberately NO commit — a producer crash
            // mid-revision must never surface as a displayable snapshot.
            await log.append('transcript.revision.begin.v1', encoded.begin as never)
            for (const chunk of encoded.chunks) await log.append('transcript.revision.chunk.v1', chunk as never)

            // Publish a complete SECOND revision so we can wait on a real
            // signal rather than an arbitrary sleep: if the partial one were
            // going to land, it would land before this.
            await publishRevision(r.producer, snapshotFixture(2, 'complete'))
            await waitFor(() => seen.length > 0)

            expect(seen).toHaveLength(1)
            expect(sub.latest()?.snapshot.revision).toBe(2)
        } finally {
            await r.close()
        }
    })

    it('close() unsubscribes and stops delivering', async () => {
        const r = await rig()
        try {
            const seen: number[] = []
            const sub = subscribeSessionTranscript(r.consumer, {
                sessionId: SESSION_ID,
                peer: r.consumerPeer,
                ownerWriterId: PRODUCER_WRITER,
                onSnapshot: ({ snapshot }) => seen.push(snapshot.revision),
            })
            await publishRevision(r.producer, snapshotFixture(1, 'before close'))
            await waitFor(() => seen.length === 1)

            sub.close()
            expect(r.consumer.stats().activeSubscriptions).toBe(0)

            await publishRevision(r.producer, snapshotFixture(2, 'after close'))
            await new Promise((res) => setTimeout(res, 120))
            expect(seen).toEqual([1])

            sub.close() // idempotent
        } finally {
            await r.close()
        }
    })
})
