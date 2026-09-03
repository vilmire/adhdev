// The worker's activation loop (unit 4b): which sessions are subscribed, what
// survives a transport reset, and what reaches the snapshot port.
//
// Uses the REAL seqscribe stack (same rig as the subscription suite) so
// "resubscribe after reset" is proven against actual peer/subscription
// lifecycle rather than a mock that cannot fail the way the real one does.
import { encodeTranscriptRevision } from '@adhdev/daemon-core/seqscribe/transcript-revision-codec'
import type { ReplicatedTranscriptSnapshotV1 } from '@adhdev/daemon-core/seqscribe/transcript-projection'
import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import type { Channel, PeerHandle, SqliteWasmDbLike } from 'seqscribe'
import { sqliteWasmHandle } from 'seqscribe'
import { describe, expect, it } from 'vitest'
import { browserRejectAuthority } from '../../src/transcript-transport/browser-reject-authority.js'
import {
    isTranscriptBridgeSnapshotMessage,
    transcriptSessionActivation,
} from '../../src/transcript-transport/bridge-protocol.js'
import { sessionTranscriptPolicy, sessionTranscriptTopic } from '../../src/transcript-transport/topic-addressing.js'
import {
    runTranscriptWorkerSession,
    type TranscriptWorkerSessionPort,
} from '../../src/transcript-transport/transcript-worker-session.js'
import {
    TranscriptWorkerNode,
    type TranscriptWorkerStorage,
} from '../../src/transcript-transport/transcript-worker-node.js'

const SESSION_A = 'sess-A'
const SESSION_B = 'sess-B'
const PRODUCER_WRITER = 'adhdev_daemon_writer'

async function memoryStorage(): Promise<TranscriptWorkerStorage> {
    const sqlite3 = await sqlite3InitModule()
    const db = new sqlite3.oo1.DB(':memory:')
    return { handle: sqliteWasmHandle(db as unknown as SqliteWasmDbLike), dispose: () => db.close() }
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

/** A test double for the worker half of the snapshot MessagePort. */
function fakePort(): TranscriptWorkerSessionPort & { readonly posted: unknown[] } {
    const posted: unknown[] = []
    return {
        posted,
        onmessage: null,
        postMessage(data: unknown) {
            posted.push(data)
        },
    }
}

function snapshotFixture(sessionId: string, revision: number, content: string): ReplicatedTranscriptSnapshotV1 {
    return {
        schemaVersion: 1,
        sessionId,
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

async function publish(
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
    if (!encoded.ok) throw new Error('fixture oversize')
    const log = producer.node.log(sessionTranscriptTopic(snapshot.sessionId))
    await log.append('transcript.revision.begin.v1', encoded.begin as never)
    for (const c of encoded.chunks) await log.append('transcript.revision.chunk.v1', c as never)
    await log.append('transcript.revision.commit.v1', encoded.commit as never)
}

interface Rig {
    producer: TranscriptWorkerNode
    consumer: TranscriptWorkerNode
    /** Re-dials a fresh channel pair, as a transport reconnect would. */
    reattach(): PeerHandle
    peer: PeerHandle
    close(): Promise<void>
}

async function rig(sessionIds: readonly string[]): Promise<Rig> {
    const producer = new TranscriptWorkerNode({
        writerId: PRODUCER_WRITER,
        openStorage: memoryStorage,
        authority: browserRejectAuthority,
    })
    const consumer = new TranscriptWorkerNode({
        writerId: 'dashboard_writer',
        openStorage: memoryStorage,
        authority: browserRejectAuthority,
    })
    await producer.open()
    await consumer.open()

    const grants: Record<string, 'serve'> = {}
    for (const id of sessionIds) {
        producer.node.defineTopic(sessionTranscriptTopic(id), sessionTranscriptPolicy())
        grants[sessionTranscriptTopic(id)] = 'serve'
    }

    let producerPeer: PeerHandle | null = null
    let consumerPeer: PeerHandle | null = null

    // Mirrors production teardown ordering: a reconnect DETACHES the dead peer
    // before attaching the new one. seqscribe routes `subscribe` by `peerId`
    // (`vendor/seqscribe/src/node.ts`), so leaving a stale session under the
    // same id would make the routing ambiguous — the daemon-side router does
    // the same thing in `acceptPeerChannel`, which calls `detachPeer` first.
    const dial = (): PeerHandle => {
        producerPeer?.detach()
        consumerPeer?.detach()
        const [p, c] = channelPair()
        producerPeer = producer.attach(p, { peerId: 'dashboard', peerClass: 'content', grants })
        consumerPeer = consumer.attach(c, { peerId: 'daemon', peerClass: 'content', grants: {} })
        return consumerPeer
    }

    let peer = dial()
    return {
        producer,
        consumer,
        get peer() {
            return peer
        },
        reattach() {
            peer = dial()
            return peer
        },
        async close() {
            await producer.close()
            await consumer.close()
        },
    }
}

describe('runTranscriptWorkerSession', () => {
    it('subscribes only to activated sessions and posts their snapshots', async () => {
        const r = await rig([SESSION_A, SESSION_B])
        const port = fakePort()
        try {
            const session = runTranscriptWorkerSession({
                node: r.consumer,
                port,
                currentPeer: () => r.peer,
            })

            // Activate A only — B is granted and defined, but not wanted.
            port.onmessage?.({ data: transcriptSessionActivation([SESSION_A], PRODUCER_WRITER) })
            expect(session.activeSessionIds()).toEqual([SESSION_A])

            await publish(r.producer, snapshotFixture(SESSION_A, 1, 'for A'))
            await waitFor(() => port.posted.length > 0)

            const message = port.posted[0]
            expect(isTranscriptBridgeSnapshotMessage(message)).toBe(true)
            if (!isTranscriptBridgeSnapshotMessage(message)) throw new Error('unreachable')
            expect(message.sessionId).toBe(SESSION_A)
            expect(message.snapshot.messages[0].content).toBe('for A')

            // A revision on the NON-activated session must not be delivered.
            await publish(r.producer, snapshotFixture(SESSION_B, 1, 'for B'))
            await new Promise((res) => setTimeout(res, 150))
            expect(port.posted).toHaveLength(1)

            session.close()
        } finally {
            await r.close()
        }
    })

    it('activation is absolute: re-activating a narrower set closes the dropped subscription', async () => {
        const r = await rig([SESSION_A, SESSION_B])
        const port = fakePort()
        try {
            const session = runTranscriptWorkerSession({
                node: r.consumer,
                port,
                currentPeer: () => r.peer,
            })

            port.onmessage?.({ data: transcriptSessionActivation([SESSION_A, SESSION_B], PRODUCER_WRITER) })
            expect(session.activeSessionIds().sort()).toEqual([SESSION_A, SESSION_B])
            expect(r.consumer.stats().activeSubscriptions).toBe(2)

            port.onmessage?.({ data: transcriptSessionActivation([SESSION_B], PRODUCER_WRITER) })
            expect(session.activeSessionIds()).toEqual([SESSION_B])
            expect(r.consumer.stats().activeSubscriptions).toBe(1)

            session.close()
            expect(r.consumer.stats().activeSubscriptions).toBe(0)
        } finally {
            await r.close()
        }
    })

    it('★ resubscribes from the RETAINED activation after a transport reset', async () => {
        const r = await rig([SESSION_A])
        const port = fakePort()
        try {
            const session = runTranscriptWorkerSession({
                node: r.consumer,
                port,
                currentPeer: () => r.peer,
            })
            port.onmessage?.({ data: transcriptSessionActivation([SESSION_A], PRODUCER_WRITER) })

            await publish(r.producer, snapshotFixture(SESSION_A, 1, 'before reset'))
            await waitFor(() => port.posted.length === 1)

            // Transport died: the peer and every subscription on it are dead.
            session.detach()
            expect(session.activeSessionIds()).toEqual([])

            // A new transport produces a NEW peer handle. The activation set is
            // retained, so the main thread does NOT have to re-send it — this is
            // what keeps the pane live across a reconnect.
            r.reattach()
            session.resubscribe()
            expect(session.activeSessionIds()).toEqual([SESSION_A])

            await publish(r.producer, snapshotFixture(SESSION_A, 2, 'after reset'))

            const revisions = (): number[] =>
                port.posted
                    .filter(isTranscriptBridgeSnapshotMessage)
                    .map((m) => m.snapshot.revision)
            await waitFor(() => revisions().includes(2))

            // The fresh subscription SNAPs the whole ring first, so revision 1
            // is legitimately re-delivered before 2 — the ring is the replica's
            // source, not a delta feed, and re-emitting a revision the pane has
            // already applied is idempotent (`handleUpdate` dedups by signature).
            // What matters is that the post-reset revision arrives at all, and
            // that it is the newest one.
            expect(revisions()).toContain(2)
            expect(revisions().at(-1)).toBe(2)

            const latest = port.posted.filter(isTranscriptBridgeSnapshotMessage).at(-1)
            expect(latest?.snapshot.messages[0].content).toBe('after reset')

            session.close()
        } finally {
            await r.close()
        }
    })

    it('holds the activation while detached and subscribes on the next attach', async () => {
        const r = await rig([SESSION_A])
        const port = fakePort()
        let peer: PeerHandle | null = null
        try {
            const session = runTranscriptWorkerSession({
                node: r.consumer,
                port,
                currentPeer: () => peer,
            })

            // Activation arrives BEFORE any peer exists (the realistic ordering:
            // the user picks a session while the channel is still dialing).
            port.onmessage?.({ data: transcriptSessionActivation([SESSION_A], PRODUCER_WRITER) })
            expect(session.activeSessionIds()).toEqual([])

            peer = r.peer
            session.resubscribe()
            expect(session.activeSessionIds()).toEqual([SESSION_A])

            await publish(r.producer, snapshotFixture(SESSION_A, 1, 'late attach'))
            await waitFor(() => port.posted.length === 1)

            session.close()
        } finally {
            await r.close()
        }
    })

    it('close() is idempotent and detaches the port listener', async () => {
        const r = await rig([SESSION_A])
        const port = fakePort()
        try {
            const session = runTranscriptWorkerSession({
                node: r.consumer,
                port,
                currentPeer: () => r.peer,
            })
            port.onmessage?.({ data: transcriptSessionActivation([SESSION_A], PRODUCER_WRITER) })
            expect(r.consumer.stats().activeSubscriptions).toBe(1)

            session.close()
            session.close()
            expect(r.consumer.stats().activeSubscriptions).toBe(0)
            expect(port.onmessage).toBeNull()
        } finally {
            await r.close()
        }
    })
})
