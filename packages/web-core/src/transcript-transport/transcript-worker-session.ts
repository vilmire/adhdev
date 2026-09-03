/**
 * The worker's session-activation loop: owns which sessions are subscribed and
 * pushes verified snapshots back to the main thread.
 *
 * Extracted from `transcript-worker-entry.ts` deliberately. That file is the
 * real dedicated-worker global-scope script and is NOT unit-testable (it needs
 * OPFS and a worker global); everything it does beyond wiring those two real
 * globals lives here instead, so the activation/teardown logic runs under
 * `npm run test:web-core` against the same seqscribe + sqlite-wasm stack the
 * browser uses. The entry file keeps only the parts that genuinely require a
 * browser.
 *
 * ── Reset re-subscribes, it does not resume ────────────────────────────────
 * When the wire channel closes (transport gone, or a `queue_overflow` typed
 * reset), every subscription built on it is dead: seqscribe's peer handle
 * transitions to `closed` and its SUB cursor cannot be trusted across a gap
 * that may have dropped bytes (§3.6 criterion 4). This module therefore drops
 * its subscriptions on reset and rebuilds them from the LAST ACTIVATION on the
 * next attach — which is why activation is absolute state kept here, rather
 * than a one-shot command. The main thread does not have to re-send it.
 */
import type { PeerHandle } from 'seqscribe';
import {
    isTranscriptSessionActivation,
    transcriptBridgeSnapshotMessage,
    type TranscriptSessionActivation,
} from './bridge-protocol.js';
import {
    subscribeSessionTranscript,
    type TranscriptSessionSubscriptionHandle,
} from './transcript-session-subscription.js';
import type { TranscriptWorkerNode } from './transcript-worker-node.js';

/** The worker half of the snapshot port. */
export interface TranscriptWorkerSessionPort {
    postMessage(data: unknown): void;
    onmessage: ((ev: { data: unknown }) => void) | null;
}

export interface TranscriptWorkerSessionOptions {
    readonly node: TranscriptWorkerNode;
    readonly port: TranscriptWorkerSessionPort;
    /**
     * The currently attached daemon peer, or null while detached. Read on every
     * (re)subscribe rather than captured once, so a reset that produces a NEW
     * peer handle is picked up without the caller re-plumbing this module.
     */
    currentPeer(): PeerHandle | null;
    /** Surfaces a rejected row's reason for fallback telemetry. */
    onRejected?(sessionId: string, reason: string): void;
}

export interface TranscriptWorkerSessionHandle {
    /** Re-subscribe everything currently activated — call after a fresh attach. */
    resubscribe(): void;
    /** Drop all live subscriptions, keeping the activation set for the next attach. */
    detach(): void;
    /** Sessions currently subscribed — diagnostics/tests. */
    activeSessionIds(): readonly string[];
    /** Idempotent; clears activation too. */
    close(): void;
}

/**
 * Wire a snapshot port to a node: apply activations, subscribe, and forward
 * each verified revision.
 */
export function runTranscriptWorkerSession(
    options: TranscriptWorkerSessionOptions,
): TranscriptWorkerSessionHandle {
    const subscriptions = new Map<string, TranscriptSessionSubscriptionHandle>();
    let activation: TranscriptSessionActivation | null = null;
    let closed = false;

    const closeSubscription = (sessionId: string): void => {
        const existing = subscriptions.get(sessionId);
        if (!existing) return;
        subscriptions.delete(sessionId);
        try {
            existing.close();
        } catch {
            // subscription already torn down with its peer
        }
    };

    const openSubscription = (sessionId: string, peer: PeerHandle): void => {
        if (subscriptions.has(sessionId)) return;
        const handle = subscribeSessionTranscript(options.node, {
            sessionId,
            peer,
            ...(activation?.ownerWriterId ? { ownerWriterId: activation.ownerWriterId } : {}),
            onSnapshot: ({ snapshot, omittedBefore }) => {
                if (closed) return;
                options.port.postMessage(transcriptBridgeSnapshotMessage(sessionId, snapshot, omittedBefore));
            },
            onRejected: (reason) => options.onRejected?.(sessionId, reason),
        });
        subscriptions.set(sessionId, handle);
    };

    /** Reconcile live subscriptions against the activation set. */
    const apply = (): void => {
        if (closed) return;
        const wanted = new Set(activation?.sessionIds ?? []);
        for (const sessionId of [...subscriptions.keys()]) {
            if (!wanted.has(sessionId)) closeSubscription(sessionId);
        }
        const peer = options.currentPeer();
        if (!peer) return; // detached: keep the activation, subscribe on next attach
        for (const sessionId of wanted) openSubscription(sessionId, peer);
    };

    options.port.onmessage = (ev): void => {
        if (closed) return;
        if (!isTranscriptSessionActivation(ev.data)) return;
        activation = ev.data;
        apply();
    };

    return {
        resubscribe(): void {
            if (closed) return;
            // The old handles belong to a dead peer; drop them so `apply`
            // rebuilds against the current one.
            for (const sessionId of [...subscriptions.keys()]) closeSubscription(sessionId);
            apply();
        },
        detach(): void {
            for (const sessionId of [...subscriptions.keys()]) closeSubscription(sessionId);
        },
        activeSessionIds: () => [...subscriptions.keys()],
        close(): void {
            if (closed) return;
            closed = true;
            options.port.onmessage = null;
            for (const sessionId of [...subscriptions.keys()]) closeSubscription(sessionId);
            activation = null;
        },
    };
}
