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
 * ── Scope: foundation only ────────────────────────────────────────────────
 * This starts and stops the transport plumbing. It deliberately does NOT
 * define topics, request session activation, subscribe, or surface snapshots
 * to React — that is consumer cutover (§8 unit 5), which builds on this. The
 * only thing crossing back to the caller here is lifecycle status.
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
import type { WebSocketLike } from 'seqscribe';

/** The `Worker` surface this host needs — narrowed so it is testable without a real Worker. */
export interface TranscriptWorkerLike {
    postMessage(data: unknown, transfer?: readonly unknown[]): void;
    terminate(): void;
}

/** The `MessageChannel` surface this host needs. */
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
}

export interface TranscriptWorkerHostHandle {
    /** Frames buffered on the main→transport hop, awaiting transport open. */
    pendingCount(): number;
    /** True until `stop()`. */
    running(): boolean;
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
    const channel = (options.createChannel ?? (() => new MessageChannel() as unknown as TranscriptMessageChannelLike))();
    const worker = options.createWorker();

    // The worker receives port2 and owns it for its lifetime; the main thread
    // keeps port1 and never looks inside the frames crossing it.
    worker.postMessage({ sessionKey: options.sessionKey, writerId: options.writerId }, [channel.port2]);
    channel.port1.start?.();

    let bridge: MainThreadBridgeHandle | null = bridgeTranscriptTransport(transport, channel.port1, {
        ...(options.preOpenQueueCap !== undefined ? { preOpenQueueCap: options.preOpenQueueCap } : {}),
        onOverflow: () => options.onOverflow?.(),
    });

    let stopped = false;

    return {
        pendingCount: () => bridge?.pendingCount() ?? 0,
        running: () => !stopped,
        stop(): void {
            if (stopped) return;
            stopped = true;
            bridge?.close();
            bridge = null;
            // Closing the port before terminating keeps the worker's own
            // `onClose` path observable rather than yanking the thread
            // mid-frame; `terminate()` then releases the OPFS access handles
            // the SAH pool VFS holds.
            try {
                channel.port1.close?.();
            } catch {
                // already gone
            }
            worker.terminate();
        },
    };
}
