// The worker's activation loop (unit 4b): which sessions are subscribed, what
// survives a transport reset, and what reaches the view port (keyed frames,
// design 2026-09-28 message-keyed storage §5.4).
//
// Uses the REAL seqscribe stack (same rig as the subscription suite) so
// "resubscribe after reset" is proven against actual peer/subscription
// lifecycle rather than a mock that cannot fail the way the real one does.
import type { PeerHandle } from 'seqscribe'
import { describe, expect, it } from 'vitest'
import { browserRejectAuthority } from '../../src/transcript-transport/browser-reject-authority.js'
import {
    isTranscriptBridgeBaseRequestMessage,
    isTranscriptBridgeFrameMessage,
    transcriptSessionActivation,
} from '../../src/transcript-transport/bridge-protocol.js'
import { sessionChatPolicy, sessionChatTopic } from '../../src/transcript-transport/topic-addressing.js'
import {
    runTranscriptWorkerSession,
    type TranscriptWorkerSessionPort,
} from '../../src/transcript-transport/transcript-worker-session.js'
import { TranscriptWorkerNode } from '../../src/transcript-transport/transcript-worker-node.js'
import { KeyedChatProducer, PRODUCER_DAEMON, PRODUCER_WRITER, channelPair, memoryStorage, waitFor } from './keyed-chat-rig.js'

const SESSION_A = 'sess-A'
const SESSION_B = 'sess-B'

/** A test double for the worker half of the view MessagePort. */
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

interface Rig {
    producer: TranscriptWorkerNode
    consumer: TranscriptWorkerNode
    /** Re-dials a fresh channel pair, as a transport reconnect would. */
    reattach(): PeerHandle
    peer: PeerHandle
    chat(sessionId: string): KeyedChatProducer
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
    const producers = new Map<string, KeyedChatProducer>()
    for (const id of sessionIds) {
        producer.node.defineTopic(sessionChatTopic(id), sessionChatPolicy())
        grants[sessionChatTopic(id)] = 'serve'
        producers.set(id, new KeyedChatProducer(producer, id))
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
        chat: (sessionId) => producers.get(sessionId)!,
        async close() {
            await producer.close()
            await consumer.close()
        },
    }
}

describe('runTranscriptWorkerSession', () => {
    it('subscribes only to activated sessions and posts their frames', async () => {
        const r = await rig([SESSION_A, SESSION_B])
        const port = fakePort()
        try {
            const session = runTranscriptWorkerSession({
                node: r.consumer,
                port,
                currentPeer: () => r.peer,
            })

            // Activate A only — B is granted and defined, but not wanted.
            port.onmessage?.({ data: transcriptSessionActivation([SESSION_A], PRODUCER_DAEMON) })
            expect(session.activeSessionIds()).toEqual([SESSION_A])

            await r.chat(SESSION_A).publish({ upserts: [{ id: 'a1', ord: 'a1', text: 'for A' }] })
            await waitFor(() => port.posted.length > 0)

            const message = port.posted[0]
            expect(isTranscriptBridgeFrameMessage(message)).toBe(true)
            if (!isTranscriptBridgeFrameMessage(message)) throw new Error('unreachable')
            expect(message.sessionId).toBe(SESSION_A)
            expect(message.reset).toBe(true)
            expect(message.upserts[0].content).toBe('for A')
            expect(message.meta?.status).toBe('idle')

            // A frame on the NON-activated session must not be delivered.
            await r.chat(SESSION_B).publish({ upserts: [{ id: 'b1', ord: 'a1', text: 'for B' }] })
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

            port.onmessage?.({ data: transcriptSessionActivation([SESSION_A, SESSION_B], PRODUCER_DAEMON) })
            expect(session.activeSessionIds().sort()).toEqual([SESSION_A, SESSION_B])
            expect(r.consumer.stats().activeSubscriptions).toBe(2)

            port.onmessage?.({ data: transcriptSessionActivation([SESSION_B], PRODUCER_DAEMON) })
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
            port.onmessage?.({ data: transcriptSessionActivation([SESSION_A], PRODUCER_DAEMON) })

            await r.chat(SESSION_A).publish({ upserts: [{ id: 'a1', ord: 'a1', text: 'before reset' }] })
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

            await r.chat(SESSION_A).publish({ upserts: [{ id: 'a1', ord: 'a1', text: 'after reset' }] })

            const frames = () => port.posted.filter(isTranscriptBridgeFrameMessage)
            await waitFor(() => frames().some((m) => m.frame === 2))

            // The fresh subscription SNAPs the committed live set first (a reset
            // frame), then the new commit arrives — possibly folded into that
            // same reset when the SNAP was served after it. Either way the last
            // frame carries the post-reset content.
            const latest = frames().at(-1)
            expect(latest?.frame).toBe(2)
            expect(latest?.upserts.at(-1)?.content).toBe('after reset')

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
            port.onmessage?.({ data: transcriptSessionActivation([SESSION_A], PRODUCER_DAEMON) })
            expect(session.activeSessionIds()).toEqual([])

            peer = r.peer
            session.resubscribe()
            expect(session.activeSessionIds()).toEqual([SESSION_A])

            await r.chat(SESSION_A).publish({ upserts: [{ id: 'a1', ord: 'a1', text: 'late attach' }] })
            await waitFor(() => port.posted.length === 1)

            session.close()
        } finally {
            await r.close()
        }
    })

    it('forwards the folder\'s base-frame request to the main thread as a bridge message', async () => {
        const r = await rig([SESSION_A])
        const port = fakePort()
        const pending: (() => void)[] = []
        try {
            const session = runTranscriptWorkerSession({
                node: r.consumer,
                port,
                currentPeer: () => r.peer,
                schedule: (cb) => pending.push(cb),
            })
            port.onmessage?.({ data: transcriptSessionActivation([SESSION_A]) })

            // A producer whose every commit lies about its digest: each resync's
            // SNAP fails again, until the streak asks for a base frame.
            await r.chat(SESSION_A).publish({ upserts: [{ id: 'a1', ord: 'a1', text: 'x' }], corruptDigest: true })
            for (let i = 0; i < 3; i += 1) {
                await waitFor(() => pending.length > 0)
                pending.shift()!()
            }
            await waitFor(() => port.posted.some(isTranscriptBridgeBaseRequestMessage))
            const request = port.posted.find(isTranscriptBridgeBaseRequestMessage)
            expect(request).toEqual({ kind: 'transcript-bridge-base-request', sessionId: SESSION_A })
            // Content-free: the request names the session and nothing else.
            expect(port.posted.filter(isTranscriptBridgeFrameMessage)).toEqual([])

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
            port.onmessage?.({ data: transcriptSessionActivation([SESSION_A], PRODUCER_DAEMON) })
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
