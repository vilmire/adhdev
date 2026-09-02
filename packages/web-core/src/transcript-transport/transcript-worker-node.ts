/**
 * Worker-side seqscribe node lifecycle (design §3.6: "worker owns node/SUB/
 * state; main owns opaque bounded forwarding only").
 *
 * Storage is injected: production wires a sqlite-wasm/OPFS-backed handle
 * (`transcript-worker-entry.ts`, the real browser Worker global-scope entry
 * point — untestable outside a browser); tests inject the same
 * `sqliteWasmHandle` adapter over an in-memory `oo1.DB` running under Node's
 * wasm runtime (`test/transcript-transport/transcript-worker-node.test.ts`),
 * so the lifecycle hygiene this class is responsible for — peers detached,
 * subscriptions closed, storage disposed, repeatable open/close with no
 * leaked bookkeeping — is checked against the real seqscribe + sqlite-wasm
 * stack, not a fake.
 *
 * This class does not decide WHICH topics to define, grant, or subscribe to
 * — that is session-activation/consumer-cutover territory (§8 units 5+),
 * deliberately out of scope here. It only owns the mechanics of opening,
 * attaching, subscribing, and tearing down cleanly.
 */
import { createSeqscribe, type AuthorityHooks, type Channel, type JsonValue, type PeerHandle, type SeqscribeNodeExt, type SqliteHandle, type Subscription, type Timers } from 'seqscribe';
import { guardRingOnlyDefineTopic } from './browser-reject-authority.js';

export interface TranscriptWorkerStorage {
    readonly handle: SqliteHandle;
    /** Closes the underlying db connection / releases OPFS access handles. */
    dispose(): void | Promise<void>;
}

export interface TranscriptWorkerNodeEnv {
    readonly writerId: string;
    openStorage(): TranscriptWorkerStorage | Promise<TranscriptWorkerStorage>;
    readonly timers?: Timers;
    readonly clock?: () => number;
    readonly rng?: () => number;
    /**
     * seqscribe authority hooks. Required to define any topic whose policy
     * names a `finalityAuthority` — which `sessionTranscriptPolicy()` does,
     * because that id is part of `topicSchemaHash` and must match the daemon's
     * byte-for-byte (see `topic-addressing.ts` / `browser-reject-authority.ts`).
     *
     * ★ Supplying `browserRejectAuthority` here also arms the ring-only
     * interlock: `defineTopic` is wrapped so this node can only ever define
     * ring-retention topics, since reject-all verification is inert on a ring
     * and silently destructive on a full-retention content topic.
     */
    readonly authority?: AuthorityHooks;
}

export interface TranscriptWorkerAttachOptions {
    readonly peerId: string;
    readonly peerClass: 'content' | 'metadata';
    readonly grants: Record<string, 'full' | 'serve' | 'none'>;
}

export interface TranscriptWorkerSubscribeOptions {
    readonly view: string;
    readonly params: JsonValue;
    readonly fromCursor?: string;
}

export interface TranscriptWorkerNodeStats {
    readonly open: boolean;
    readonly attachedPeers: number;
    readonly activeSubscriptions: number;
}

export class TranscriptWorkerNode {
    readonly #env: TranscriptWorkerNodeEnv;
    #node: SeqscribeNodeExt | null = null;
    #storage: TranscriptWorkerStorage | null = null;
    readonly #peers = new Set<PeerHandle>();
    readonly #subscriptions = new Set<Subscription>();

    constructor(env: TranscriptWorkerNodeEnv) {
        this.#env = env;
    }

    async open(): Promise<void> {
        if (this.#node) throw new Error('TranscriptWorkerNode already open');
        const storage = await this.#env.openStorage();
        try {
            const created = createSeqscribe({
                writerId: this.#env.writerId,
                storage: storage.handle,
                ...(this.#env.timers ? { timers: this.#env.timers } : {}),
                ...(this.#env.clock ? { clock: this.#env.clock } : {}),
                ...(this.#env.rng ? { rng: this.#env.rng } : {}),
                ...(this.#env.authority ? { authority: this.#env.authority } : {}),
            });
            // ★ Ring-only interlock. Arming it with the authority hooks (rather
            // than unconditionally) keeps the constraint attached to its cause:
            // the hooks are what make a non-ring topic unsafe here.
            this.#node = this.#env.authority ? guardRingOnlyDefineTopic(created) : created;
        } catch (err) {
            await storage.dispose();
            throw err;
        }
        this.#storage = storage;
    }

    get node(): SeqscribeNodeExt {
        if (!this.#node) throw new Error('TranscriptWorkerNode not open');
        return this.#node;
    }

    attach(channel: Channel, opts: TranscriptWorkerAttachOptions): PeerHandle {
        const peer = this.node.attach(channel, opts);
        this.#peers.add(peer);
        const stopWatching = peer.onStateChange((state) => {
            if (state === 'closed') {
                this.#peers.delete(peer);
                stopWatching();
            }
        });
        return peer;
    }

    subscribe(peer: PeerHandle, opts: TranscriptWorkerSubscribeOptions): Subscription {
        const sub = this.node.subscribe(peer, opts);
        this.#subscriptions.add(sub);
        return sub;
    }

    unsubscribe(sub: Subscription): void {
        if (!this.#subscriptions.delete(sub)) return;
        sub.close();
    }

    stats(): TranscriptWorkerNodeStats {
        return {
            open: this.#node !== null,
            attachedPeers: this.#peers.size,
            activeSubscriptions: this.#subscriptions.size,
        };
    }

    async close(): Promise<void> {
        const node = this.#node;
        if (!node) return;
        for (const sub of this.#subscriptions) {
            try {
                sub.close();
            } catch {
                // already closed
            }
        }
        this.#subscriptions.clear();
        for (const peer of this.#peers) {
            try {
                peer.detach();
            } catch {
                // already detached
            }
        }
        this.#peers.clear();
        this.#node = null;
        await node.close();
        const storage = this.#storage;
        this.#storage = null;
        if (storage) await storage.dispose();
    }
}
