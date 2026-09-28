// The live worker feed (design 2026-09-28 message-keyed storage §5.4): a real
// seqscribe producer appends real keyed `session.<safeSessionId>.chat` frames,
// and the browser-side subscription folds them with daemon-core's own
// `KeyedTranscriptFolder` into verified per-commit changes.
//
// Deliberately end-to-end over the REAL stack — real sqlite-wasm storage, real
// seqscribe SUB, the real daemon-core codec and folder. A fake that handed
// pre-built views to the adapter would prove nothing about the part that
// matters: whether a browser node can define the same topic the daemon
// defined, subscribe through a peer, and pass the folder's digest/owner
// verification against rows a real producer emitted.
import type { KeyedTranscriptFrameDelta } from '@adhdev/daemon-core/seqscribe/transcript-keyed-folder'
import { describe, expect, it } from 'vitest'
import { sessionChatTopic } from '../../src/transcript-transport/topic-addressing.js'
import {
    BASE_REQUEST_AFTER,
    subscribeSessionChat,
} from '../../src/transcript-transport/transcript-session-subscription.js'
import { PRODUCER_DAEMON, rig, waitFor } from './keyed-chat-rig.js'

const SESSION_ID = 'sess-Live-Feed-01'

describe('subscribeSessionChat (live worker feed)', () => {
    it('folds a published frame into a verified reset frame and a committed view', async () => {
        const r = await rig(SESSION_ID)
        try {
            const frames: KeyedTranscriptFrameDelta[] = []
            const sub = subscribeSessionChat(r.consumer, {
                sessionId: SESSION_ID,
                peer: r.consumerPeer,
                ownerDaemonId: PRODUCER_DAEMON,
                onFrame: (delta) => frames.push(delta),
            })

            // The browser derives the SAME topic name the daemon defined.
            expect(sub.topic).toBe(sessionChatTopic(SESSION_ID))

            await r.chat.publish({ upserts: [{ id: 'n.a.1.0', ord: 'a1', text: 'hello from the daemon' }] })
            await waitFor(() => frames.length > 0)

            expect(frames[0].reset).toBe(true)
            expect(frames[0].upserts.map((m) => m.content)).toEqual(['hello from the daemon'])
            expect(sub.view()?.messages.map((m) => m.messageId)).toEqual(['n.a.1.0'])
            expect(sub.view()?.frame).toBe(1)
            sub.close()
        } finally {
            await r.close()
        }
    })

    it('a DELTA frame carries ONLY the bubbles it changed, and tombstones as deletes', async () => {
        const r = await rig(SESSION_ID)
        try {
            const frames: KeyedTranscriptFrameDelta[] = []
            const sub = subscribeSessionChat(r.consumer, {
                sessionId: SESSION_ID,
                peer: r.consumerPeer,
                onFrame: (delta) => frames.push(delta),
            })

            await r.chat.publish({
                upserts: [
                    { id: 'm1', ord: 'a1', text: 'one' },
                    { id: 'm2', ord: 'a2', text: 'two' },
                    { id: 'm3', ord: 'a3', text: 'three' },
                ],
            })
            await waitFor(() => frames.length >= 1)

            // Streaming growth of ONE bubble: one upsert, nothing else.
            await r.chat.publish({ upserts: [{ id: 'm2', ord: 'a2', text: 'two, grown' }] })
            await waitFor(() => frames.length >= 2)
            expect(frames[1].reset).toBe(false)
            expect(frames[1].upserts.map((m) => [m.messageId, m.rev, m.content])).toEqual([['m2', 2, 'two, grown']])
            expect(frames[1].deletes).toEqual([])
            expect(frames[1].meta).toBeNull()

            await r.chat.publish({ deletes: ['m1'] })
            await waitFor(() => frames.length >= 3)
            expect(frames[2].upserts).toEqual([])
            expect(frames[2].deletes).toEqual(['m1'])
            expect(sub.view()?.messages.map((m) => m.messageId)).toEqual(['m2', 'm3'])
            sub.close()
        } finally {
            await r.close()
        }
    })

    it('a late subscriber gets the committed live set in ONE reset frame (tombstones folded away)', async () => {
        const r = await rig(SESSION_ID)
        try {
            await r.chat.publish({ upserts: [{ id: 'm1', ord: 'a1', text: 'one' }, { id: 'm2', ord: 'a2', text: 'two' }] })
            await r.chat.publish({ upserts: [{ id: 'm2', ord: 'a2', text: 'two v2' }] })
            await r.chat.publish({ deletes: ['m1'], status: 'generating' })

            const frames: KeyedTranscriptFrameDelta[] = []
            const sub = subscribeSessionChat(r.consumer, {
                sessionId: SESSION_ID,
                peer: r.consumerPeer,
                onFrame: (delta) => frames.push(delta),
            })
            await waitFor(() => frames.length >= 1)

            expect(frames).toHaveLength(1)
            expect(frames[0].reset).toBe(true)
            expect(frames[0].upserts.map((m) => [m.messageId, m.content])).toEqual([['m2', 'two v2']])
            expect(frames[0].meta?.status).toBe('generating')
            expect(frames[0].frame).toBe(3)
            sub.close()
        } finally {
            await r.close()
        }
    })

    it('refuses a commit produced by a daemon that is not the declared owner', async () => {
        const r = await rig(SESSION_ID)
        try {
            const frames: KeyedTranscriptFrameDelta[] = []
            const rejected: string[] = []
            const sub = subscribeSessionChat(r.consumer, {
                sessionId: SESSION_ID,
                peer: r.consumerPeer,
                ownerDaemonId: 'daemon_someone_else',
                onFrame: (delta) => frames.push(delta),
                onRejected: (reason) => rejected.push(reason),
                schedule: () => undefined,
            })

            await r.chat.publish({ upserts: [{ id: 'm1', ord: 'a1', text: 'not yours' }] })
            await waitFor(() => rejected.length > 0)

            expect(rejected).toContain('owner_mismatch')
            expect(frames).toEqual([])
            expect(sub.view()).toBeNull()
            sub.close()
        } finally {
            await r.close()
        }
    })

    it('a frame whose digest does not verify is rolled back, resubscribes, and keeps the last verified view', async () => {
        const r = await rig(SESSION_ID)
        try {
            const frames: KeyedTranscriptFrameDelta[] = []
            const rejected: string[] = []
            const pending: (() => void)[] = []
            const sub = subscribeSessionChat(r.consumer, {
                sessionId: SESSION_ID,
                peer: r.consumerPeer,
                onFrame: (delta) => frames.push(delta),
                onRejected: (reason) => rejected.push(reason),
                schedule: (cb) => pending.push(cb),
            })

            await r.chat.publish({ upserts: [{ id: 'm1', ord: 'a1', text: 'good' }] })
            await waitFor(() => frames.length >= 1)

            await r.chat.publish({ upserts: [{ id: 'm1', ord: 'a1', text: 'lying commit' }], corruptDigest: true })
            await waitFor(() => rejected.includes('digest_mismatch'))

            // Rolled back: the verified view is untouched, no frame was emitted.
            expect(frames).toHaveLength(1)
            expect(sub.view()?.messages[0].content).toBe('good')

            // The resync restarts the SUB — a fresh reset SNAP.
            expect(pending).toHaveLength(1)
            pending.shift()!()
            expect(sub.resubscribes()).toBe(1)
            sub.close()
        } finally {
            await r.close()
        }
    })

    it(`asks the owner for a base frame after ${BASE_REQUEST_AFTER} consecutive resyncs for the same reason`, async () => {
        const r = await rig(SESSION_ID)
        try {
            const pending: (() => void)[] = []
            let baseRequests = 0
            let rejectedCount = 0
            const sub = subscribeSessionChat(r.consumer, {
                sessionId: SESSION_ID,
                peer: r.consumerPeer,
                onFrame: () => undefined,
                onRejected: () => { rejectedCount += 1 },
                onBaseRequest: () => { baseRequests += 1 },
                schedule: (cb) => pending.push(cb),
            })

            // Every SNAP the lying producer serves fails its digest, so each
            // resubscribe fails again — the streak the base request exists for.
            await r.chat.publish({ upserts: [{ id: 'm1', ord: 'a1', text: 'x' }], corruptDigest: true })
            for (let i = 1; i <= BASE_REQUEST_AFTER; i += 1) {
                await waitFor(() => pending.length > 0)
                if (i < BASE_REQUEST_AFTER) expect(baseRequests).toBe(0)
                const before = rejectedCount
                pending.shift()!()
                if (i < BASE_REQUEST_AFTER) await waitFor(() => rejectedCount > before)
            }
            expect(baseRequests).toBe(1)
            sub.close()
        } finally {
            await r.close()
        }
    })

    it('close() unsubscribes and stops delivering', async () => {
        const r = await rig(SESSION_ID)
        try {
            const frames: KeyedTranscriptFrameDelta[] = []
            const sub = subscribeSessionChat(r.consumer, {
                sessionId: SESSION_ID,
                peer: r.consumerPeer,
                onFrame: (delta) => frames.push(delta),
            })
            await r.chat.publish({ upserts: [{ id: 'm1', ord: 'a1', text: 'first' }] })
            await waitFor(() => frames.length >= 1)

            sub.close()
            sub.close() // idempotent
            await r.chat.publish({ upserts: [{ id: 'm1', ord: 'a1', text: 'after close' }] })
            await new Promise((resolve) => setTimeout(resolve, 50))
            expect(frames).toHaveLength(1)
            expect(r.consumer.stats().activeSubscriptions).toBe(0)
        } finally {
            await r.close()
        }
    })
})
