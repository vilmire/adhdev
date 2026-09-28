// Test rig for the keyed chat lane (design 2026-09-28 message-keyed storage):
// a REAL producer node appends real `session.<id>.chat` rows — heads,
// tombstones, meta and a digest-carrying commit per frame — encoded with the
// daemon's own portable codec, and a browser consumer node subscribes to it
// through a real seqscribe peer. Nothing is faked between the two, so a test
// over this rig exercises exactly the bytes the daemon's publisher writes.
import {
    CHAT_COMMIT_KEY,
    CHAT_COMMIT_KIND,
    CHAT_DEL_KIND,
    CHAT_META_KEY,
    CHAT_META_KIND,
    CHAT_MSG_KIND,
    chatMessageKey,
    computeChatCommitDigest,
    encodeChatDel,
    encodeChatMessageHead,
    encodeChatMeta,
} from '@adhdev/daemon-core/seqscribe/transcript-keyed-codec'
import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import type { Channel, SqliteWasmDbLike } from 'seqscribe'
import { sqliteWasmHandle } from 'seqscribe'
import { browserRejectAuthority } from '../../src/transcript-transport/browser-reject-authority.js'
import { sessionChatPolicy, sessionChatTopic } from '../../src/transcript-transport/topic-addressing.js'
import { TranscriptWorkerNode, type TranscriptWorkerStorage } from '../../src/transcript-transport/transcript-worker-node.js'

export const PRODUCER_WRITER = 'adhdev_daemon_writer'
export const PRODUCER_DAEMON = 'daemon_owner'

export async function memoryStorage(): Promise<TranscriptWorkerStorage> {
    const sqlite3 = await sqlite3InitModule()
    const db = new sqlite3.oo1.DB(':memory:')
    return {
        handle: sqliteWasmHandle(db as unknown as SqliteWasmDbLike),
        dispose: () => db.close(),
    }
}

export function channelPair(): [Channel, Channel] {
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

export async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
    const start = Date.now()
    while (!cond()) {
        if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
        await new Promise((r) => setTimeout(r, 5))
    }
}

export interface BubbleSpec {
    readonly id: string
    readonly ord: string
    readonly text: string
    readonly role?: string
    readonly turnKey?: string
}

export interface FrameSpec {
    readonly upserts?: readonly BubbleSpec[]
    readonly deletes?: readonly string[]
    readonly status?: string
    /** Corrupt the commit digest (a torn/lying producer) — the reader must reject the frame. */
    readonly corruptDigest?: boolean
}

/**
 * The producer half: tracks the live `(id, rev)` set and meta revision exactly
 * as the daemon's `KeyedChatSessionState` does, and appends one frame per
 * `publish` — changed heads, tombstones, meta when it changed, then the commit.
 */
export class KeyedChatProducer {
    private readonly live = new Map<string, number>()
    private metaRev = 0
    private status: string | null = null
    private frame = 0

    constructor(
        private readonly node: TranscriptWorkerNode,
        readonly sessionId: string,
        private readonly epoch = 'epoch-1',
        private readonly writer = PRODUCER_WRITER,
        private readonly daemonId = PRODUCER_DAEMON,
    ) {}

    get topic(): string {
        return sessionChatTopic(this.sessionId)
    }

    async publish(spec: FrameSpec): Promise<void> {
        this.frame += 1
        const frame = this.frame
        const log = this.node.node.log(this.topic)
        for (const bubble of spec.upserts ?? []) {
            const rev = (this.live.get(bubble.id) ?? 0) + 1
            this.live.set(bubble.id, rev)
            const head = encodeChatMessageHead(
                { role: bubble.role ?? 'assistant', kind: 'standard', content: bubble.text, turnKey: bubble.turnKey ?? 't1', bubbleState: 'final' },
                { id: bubble.id, ord: bubble.ord, rev, epoch: this.epoch, frame, srcId: null, body: { text: bubble.text } },
            )
            await log.append(CHAT_MSG_KIND, head as never, { key: chatMessageKey(bubble.id) })
        }
        for (const id of spec.deletes ?? []) {
            const rev = (this.live.get(id) ?? 0) + 1
            this.live.delete(id)
            await log.append(CHAT_DEL_KIND, encodeChatDel(id, null, rev, this.epoch, frame) as never, { key: chatMessageKey(id) })
        }
        const status = spec.status ?? this.status ?? 'idle'
        if (this.metaRev === 0 || status !== this.status) {
            this.metaRev += 1
            this.status = status
            const meta = encodeChatMeta(
                { sessionId: this.sessionId, providerType: 'claude-cli', status, provenance: { messageSource: 'native-history' } },
                {
                    rev: this.metaRev,
                    epoch: this.epoch,
                    frame,
                    producerDaemonId: this.daemonId,
                    ledgerEpoch: 'ledger-1',
                    coverage: { mode: 'full', omittedBefore: false },
                },
            )
            await log.append(CHAT_META_KIND, meta as never, { key: CHAT_META_KEY })
        }
        const digest = computeChatCommitDigest(this.live.entries(), this.metaRev)
        await log.append(
            CHAT_COMMIT_KIND,
            {
                v: 2,
                sessionId: this.sessionId,
                writer: this.writer,
                producerDaemonId: this.daemonId,
                epoch: this.epoch,
                frame,
                observedAt: '2026-09-28T00:00:00.000Z',
                liveCount: this.live.size,
                metaRev: this.metaRev,
                digest: spec.corruptDigest ? '0'.repeat(64) : digest,
                basis: 'delta',
                baseReason: null,
            } as never,
            { key: CHAT_COMMIT_KEY },
        )
    }
}

export interface Rig {
    producer: TranscriptWorkerNode
    consumer: TranscriptWorkerNode
    consumerPeer: ReturnType<TranscriptWorkerNode['attach']>
    chat: KeyedChatProducer
    close(): Promise<void>
}

/** A producer node serving the session's chat topic to a browser consumer node. */
export async function rig(sessionId: string): Promise<Rig> {
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
    const topic = sessionChatTopic(sessionId)
    producer.node.defineTopic(topic, sessionChatPolicy())

    const [pChan, cChan] = channelPair()
    producer.attach(pChan, { peerId: 'dashboard', peerClass: 'content', grants: { [topic]: 'serve' } })
    const consumerPeer = consumer.attach(cChan, { peerId: 'daemon', peerClass: 'content', grants: {} })

    return {
        producer,
        consumer,
        consumerPeer,
        chat: new KeyedChatProducer(producer, sessionId),
        async close() {
            await producer.close()
            await consumer.close()
        },
    }
}
