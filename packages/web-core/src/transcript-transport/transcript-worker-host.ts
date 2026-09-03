/**
 * Worker host: the assembly seam between a live authenticated transport and
 * the transcript Worker (design §3.6, §8 unit 4).
 *
 * Until this module existed, unit 4's parts were all present but nothing
 * joined them — `transcript-worker-entry.ts` was never instantiated, and
 * web-cloud's `onSeqscribeTransport` callback had no consumer. This is the
 * piece that owns that lifecycle:
 *
 *     transport (RTCDataChannel-backed / WS-backed, `WebSocketLike`)
 *       ↕  bridgeTranscriptTransport   ← main thread, opaque bytes only
 *     MessagePort
 *       ↕  transcript-worker-entry.ts  ← worker: node + OPFS + SUB
 *
 * ── Two ports, on purpose ─────────────────────────────────────────────────
 * The host transfers TWO MessagePorts to the worker:
 *
 *   port2 (wire)     ── opaque seqscribe frames, bridged to the transport.
 *                       `main-thread-bridge.ts` owns `onmessage` on the main
 *                       half and forwards strings byte-for-byte.
 *   snapshot port    ── verified `ReplicatedTranscriptSnapshotV1` objects,
 *                       worker → main only.
 *
 * They are separate because the wire port's main-thread half must stay
 * provably content-blind: `main-thread-bridge-canary.test.ts` scans that
 * module's source and fails on `JSON.parse`/`JSON.stringify` OR on the words
 * `topic`/`snapshot`/`revision`/`sessionId`/`messages` appearing in executable
 * code. Routing snapshots through the same port would force exactly that
 * vocabulary into the bridge and dissolve a load-bearing invariant. A second
 * port keeps "relay bytes" and "deliver verified content" as two channels with
 * two different rules, rather than one channel with a conditional.
 *
 * Nothing is ever SENT on the snapshot port from the main thread, so transcript
 * content has no path back onto the wire (or, on the cloud lane, toward the
 * server — design §2.3).
 *
 * ── Scope ─────────────────────────────────────────────────────────────────
 * This starts and stops the transport plumbing and delivers verified snapshots
 * to its caller. Which SESSION is activated is the caller's decision, sent via
 * `activateSession()`.
 *
 * ── Why worker construction is injected ───────────────────────────────────
 * `new Worker(new URL('./transcript-worker-entry.js', import.meta.url))` is a
 * bundler-visible construct: Vite/tsup must see that literal to emit the
 * worker chunk. Keeping it in the CALLER (web-cloud) rather than here means
 * this module stays bundler-agnostic and unit-testable with a fake worker,
 * while each assembly declares its own worker URL in the form its bundler
 * understands. `createTranscriptWorker()` in web-cloud is that one-liner.
 */
import { bridgeTranscriptTransport, type MainThreadBridgeHandle, type MainThreadBridgePortLike } from './main-thread-bridge.js';
import {
    isTranscriptBridgeSnapshotMessage,
    transcriptSessionActivation,
    type TranscriptBridgeSnapshotMessage,
} from './bridge-protocol.js';
import type { WebSocketLike } from 'seqscribe';

/** The `Worker` surface this host needs — narrowed so it is testable without a real Worker. */
export interface TranscriptWorkerLike {
    postMessage(data: unknown, transfer?: readonly unknown[]): void;
    terminate(): void;
}

/**
 * The `MessageChannel` surface this host needs. Called TWICE per host — once
 * for the wire port, once for the snapshot port (see the header).
 */
export interface TranscriptMessageChannelLike {
    readonly port1: MainThreadBridgePortLike & { start?(): void; close?(): void };
    readonly port2: unknown;
}

export interface TranscriptWorkerHostOptions {
    /**
     * Identifies the OPFS storage directory for this replica
     * (`transcript-worker-entry.ts` uses `.adhdev-transcript/<writerId>`).
     * Must be stable per browser profile + daemon so a reconnect reuses the
     * same database rather than accumulating orphaned ones.
     */
    readonly writerId: string;
    /** Names the per-session database file inside that directory. */
    readonly sessionKey: string;
    /** Constructs the real Worker. See "Why worker construction is injected". */
    createWorker(): TranscriptWorkerLike;
    /** Constructs a MessageChannel. Defaults to the global. */
    createChannel?(): TranscriptMessageChannelLike;
    /** Bounded pre-open queue for the main→transport hop. */
    readonly preOpenQueueCap?: number;
    /** Fires when the bridge sheds its pre-open queue (typed reset, never a silent drop). */
    readonly onOverflow?: () => void;
    /**
     * A verified-complete revision arrived for one of the activated sessions.
     *
     * Delivered exactly as the worker verified it — the main thread neither
     * parses nor re-validates. See the two-ports note in this file's header.
     */
    readonly onSnapshot?: (message: TranscriptBridgeSnapshotMessage) => void;
}

export interface TranscriptWorkerHostHandle {
    /** Frames buffered on the main→transport hop, awaiting transport open. */
    pendingCount(): number;
    /** True until `stop()`. */
    running(): boolean;
    /**
     * Set the absolute list of sessions the worker should subscribe to.
     *
     * Idempotent and absolute (not incremental) — see
     * `TranscriptSessionActivation`. Safe to call before the transport opens;
     * the worker applies it once its node is ready.
     */
    activateSessions(sessionIds: readonly string[], ownerWriterId?: string): void;
    /** Tears down the bridge and terminates the worker. Idempotent. */
    stop(): void;
}

/**
 * Attach one transport to one freshly-spawned transcript worker.
 *
 * The pairing is 1:1 and lasts exactly as long as the transport does. A
 * reconnect does not reuse this handle: the caller calls `stop()` and starts a
 * new host for the new transport, so the worker's seqscribe session always
 * begins from a clean attach rather than resuming across a gap it cannot
 * verify (§3.6 criterion 4 — no partial committed view).
 */
export function startTranscriptWorkerHost(
    transport: WebSocketLike,
    options: TranscriptWorkerHostOptions,
): TranscriptWorkerHostHandle {
    const createChannel = options.createChannel ?? (() => new MessageChannel() as unknown as TranscriptMessageChannelLike);
    const channel = createChannel();
    const snapshotChannel = createChannel();
    const worker = options.createWorker();

    // The worker receives both port2s and owns them for its lifetime; the main
    // thread keeps the port1s. It never looks inside the WIRE frames, and it
    // never sends on the snapshot port.
    worker.postMessage({ sessionKey: options.sessionKey, writerId: options.writerId }, [
        channel.port2,
        snapshotChannel.port2,
    ]);
    channel.port1.start?.();
    snapshotChannel.port1.start?.();

    snapshotChannel.port1.onmessage = (ev: { data: unknown }): void => {
        if (isTranscriptBridgeSnapshotMessage(ev.data)) options.onSnapshot?.(ev.data);
    };

    let bridge: MainThreadBridgeHandle | null = bridgeTranscriptTransport(transport, channel.port1, {
        ...(options.preOpenQueueCap !== undefined ? { preOpenQueueCap: options.preOpenQueueCap } : {}),
        onOverflow: () => options.onOverflow?.(),
    });

    let stopped = false;

    return {
        pendingCount: () => bridge?.pendingCount() ?? 0,
        running: () => !stopped,
        activateSessions(sessionIds: readonly string[], ownerWriterId?: string): void {
            if (stopped) return;
            snapshotChannel.port1.postMessage(transcriptSessionActivation(sessionIds, ownerWriterId));
        },
        stop(): void {
            if (stopped) return;
            stopped = true;
            bridge?.close();
            bridge = null;
            snapshotChannel.port1.onmessage = null;
            // Closing the ports before terminating keeps the worker's own
            // `onClose` path observable rather than yanking the thread
            // mid-frame; `terminate()` then releases the OPFS access handles
            // the SAH pool VFS holds.
            for (const port of [channel.port1, snapshotChannel.port1]) {
                try {
                    port.close?.();
                } catch {
                    // already gone
                }
            }
            worker.terminate();
        },
    };
}
