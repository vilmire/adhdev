// ---------------------------------------------------------------------------
// mesh-warmup-deadline — cold-open-aware deadline for mesh P2P dispatches
// ---------------------------------------------------------------------------
// A dependency-free leaf so the warmup deadline + its connection-probe resolution
// can be shared by BOTH the dashboard git_status probe path (commands/router.ts)
// and the general task-dispatch path (mesh/mesh-events-coordinator.ts) without an
// import cycle (router ⇄ mesh-events). Pure except for timers + the injected
// `isConnected` probe, so it is unit-testable under fake timers with no real WebRTC.
// ---------------------------------------------------------------------------

/**
 * Await `work` under a warmup-aware deadline so a cold-open DataChannel handshake
 * is NOT charged against the command response budget — the root cause of the
 * "first mesh dispatch to a cold peer false-times-out, the warm retry succeeds"
 * signature. Two budgets, switched by the live peer connection state:
 *
 *  - While `isConnected()` returns false the peer's channel is still opening; the
 *    cold-open `connectTimeoutMs` budget applies. This phase is deliberately
 *    generous because a TURN-relayed cross-machine handshake legitimately needs
 *    many seconds — but a genuine connect *failure* is surfaced by `work`
 *    rejecting on its own (the mesh manager fails the peer the instant its
 *    PeerConnection state goes terminal), so a real failure is never masked for
 *    the whole window.
 *  - The first time `isConnected()` returns true the channel is warm; from that
 *    instant the tight `responseTimeoutMs` governs how long the handler may take.
 *    Warm-channel callers therefore see behavior identical to the old single
 *    `Promise.race(work, responseTimeoutMs)`.
 *
 * Rejects with `Error('timeout')` when either budget is exhausted, mirroring the
 * previous single-race contract. When no connection getter is wired callers must
 * NOT pass `() => true` ("always warm") — that re-introduces the cold-open
 * false-timeout. Use {@link resolveWarmupDeadlineOpts} which degrades conservatively.
 */
export function awaitWithWarmupDeadline<T>(
    work: Promise<T>,
    opts: {
        isConnected: () => boolean;
        connectTimeoutMs: number;
        responseTimeoutMs: number;
        pollIntervalMs?: number;
    },
): Promise<T> {
    const pollMs = Math.max(1, Math.min(opts.pollIntervalMs ?? 200, opts.connectTimeoutMs));
    return new Promise<T>((resolve, reject) => {
        let done = false;
        let poll: ReturnType<typeof setInterval> | undefined;
        let responseTimer: ReturnType<typeof setTimeout> | undefined;
        const startedAt = Date.now();
        const cleanup = () => {
            if (poll) { clearInterval(poll); poll = undefined; }
            if (responseTimer) { clearTimeout(responseTimer); responseTimer = undefined; }
        };
        const settle = (fn: () => void) => {
            if (done) return;
            done = true;
            cleanup();
            fn();
        };
        // Arm the response deadline exactly once, the moment the channel is warm.
        const armResponse = () => {
            if (responseTimer || done) return;
            responseTimer = setTimeout(
                () => settle(() => reject(new Error('timeout'))),
                opts.responseTimeoutMs,
            );
            if (typeof responseTimer.unref === 'function') responseTimer.unref();
        };
        const onPoll = () => {
            if (done) return;
            if (opts.isConnected()) {
                if (poll) { clearInterval(poll); poll = undefined; }
                armResponse();
                return;
            }
            if (Date.now() - startedAt >= opts.connectTimeoutMs) {
                settle(() => reject(new Error('timeout')));
            }
        };
        if (opts.isConnected()) {
            // Already warm (e.g. a retry over an open channel) — skip the warmup
            // phase entirely and let the response deadline govern from t0.
            armResponse();
        } else {
            poll = setInterval(onPoll, pollMs);
            if (typeof poll.unref === 'function') poll.unref();
        }
        work.then(
            (val) => settle(() => resolve(val)),
            (err) => settle(() => reject(err)),
        );
    });
}

/** Minimal connection-state reader: a mesh peer snapshot stamps its live state on `.state`. */
export function readWarmupConnectionState(connection: Record<string, unknown> | null | undefined): string | undefined {
    const state = (connection as { state?: unknown } | null | undefined)?.state;
    return typeof state === 'string' && state.length > 0 ? state : undefined;
}

export interface ResolvedWarmupDeadlineOpts {
    isConnected: () => boolean;
    connectTimeoutMs: number;
    responseTimeoutMs: number;
}

/**
 * Build {@link awaitWithWarmupDeadline} opts from an OPTIONAL live peer-connection
 * probe, handling the missing-getter case fail-loud instead of silently degrading.
 *
 * When `getConnection` is wired the normal cold-open/warm split applies: the probe
 * is consulted live and the channel is "warm" only once it reports `connected`.
 *
 * When `getConnection` is ABSENT the old call sites fell back to `() => true`
 * ("always warm"), which charges a still-opening cold channel against the response
 * budget and silently re-introduces the exact cold-open false-timeout the warmup
 * deadline exists to prevent. Instead we degrade CONSERVATIVELY and FAIL LOUD:
 *   - `onMissingGetter` is invoked so the caller can warn (the degrade is visible,
 *     never silent) — keyed/throttled by the caller as it sees fit.
 *   - the channel is treated as NOT observably warm (`isConnected: () => false`),
 *     so the response deadline never arms early on an unobservable channel.
 *   - the cold peer is granted the COMBINED connect+response window as one deadline,
 *     so a slow-but-live cold open is never false-timed at the shorter response
 *     budget. A genuinely hung dispatch still rejects when the combined window
 *     lapses, and `work` rejecting on its own (a real transport failure) still
 *     settles immediately.
 *
 * Note: a present getter that returns a non-`connected` snapshot (or `null` for an
 * unknown peer) correctly yields `isConnected() === false` — i.e. the generous
 * connect budget, never "always warm". Only a wholly absent getter degrades.
 */
export function resolveWarmupDeadlineOpts(opts: {
    getConnection?: ((daemonId: string) => Record<string, unknown> | null) | undefined;
    daemonId: string;
    connectTimeoutMs: number;
    responseTimeoutMs: number;
    onMissingGetter?: (daemonId: string) => void;
}): ResolvedWarmupDeadlineOpts {
    const { getConnection, daemonId, connectTimeoutMs, responseTimeoutMs } = opts;
    if (getConnection) {
        return {
            isConnected: () => readWarmupConnectionState(getConnection(daemonId)) === 'connected',
            connectTimeoutMs,
            responseTimeoutMs,
        };
    }
    opts.onMissingGetter?.(daemonId);
    return {
        isConnected: () => false,
        connectTimeoutMs: connectTimeoutMs + responseTimeoutMs,
        responseTimeoutMs,
    };
}
