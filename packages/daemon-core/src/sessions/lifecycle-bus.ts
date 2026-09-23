/**
 * SessionLifecycleBus — the one in-process fan-out for session lifecycle facts.
 *
 * Wiring-unification Phase B1 (docs/design/2026-09-23-wiring-unification.md §4 B1).
 *
 * Semantics (each is pinned by test/sessions/lifecycle-bus.test.ts):
 *  1. Sync lane, registration order. `emit` runs every matching sync handler in
 *     the order it subscribed, each inside its own try/catch. A throw is logged
 *     (throttled per subscriber+kind) and counted; the remaining handlers still run.
 *  2. Re-entrancy is queued, not nested. An `emit` issued from inside a handler is
 *     appended to a FIFO and delivered after the current fan-out finishes, so every
 *     subscriber observes events in the same global order.
 *  3. Async lane. `onAsync` handlers get a per-subscriber serial queue; beyond
 *     `maxPending` the OLDEST pending event is dropped and counted. Rejections are
 *     caught and counted like sync throws.
 *  4. No module global: the bus is constructed at boot and passed explicitly.
 *  5. `close()` rejects further emits (counted no-ops), discards anything queued,
 *     and makes further subscription attempts throw.
 */

import { LOG } from '../logging/logger.js';
import { BUS_EVENT_KINDS, type BusEvent, type BusEventKind, type EventOf } from './lifecycle-events.js';

export type Unsubscribe = () => void;

export interface SubscribeOptions {
    /** Log / metric key. Defaults to `anonymous#<n>`. */
    name?: string;
}

export interface AsyncSubscribeOptions extends SubscribeOptions {
    /** Pending-queue bound; the oldest pending event is dropped beyond it. Default 256. */
    maxPending?: number;
}

export interface BusStats {
    /** Total events accepted by `emit` (queued re-entrant ones included). */
    emitted: number;
    emittedByKind: Record<BusEventKind, number>;
    /** Sync throws + async rejections, total and per subscriber name. */
    handlerErrors: number;
    handlerErrorsBySubscriber: Record<string, number>;
    /** Async events dropped by `maxPending`, total and per subscriber name. */
    dropped: number;
    droppedBySubscriber: Record<string, number>;
    /** Async events currently waiting, per subscriber name. */
    asyncPending: Record<string, number>;
    /** Emits refused because the bus was closed. */
    rejectedAfterClose: number;
    closed: boolean;
}

type KindSelector<K extends BusEventKind> = K | readonly K[] | '*';

export interface SessionLifecycleBus {
    emit(event: BusEvent): void;
    on(kinds: '*', handler: (event: BusEvent) => void, opts?: SubscribeOptions): Unsubscribe;
    on<K extends BusEventKind>(kinds: K | readonly K[], handler: (event: EventOf<K>) => void, opts?: SubscribeOptions): Unsubscribe;
    onAsync(kinds: '*', handler: (event: BusEvent) => Promise<void> | void, opts?: AsyncSubscribeOptions): Unsubscribe;
    onAsync<K extends BusEventKind>(
        kinds: K | readonly K[],
        handler: (event: EventOf<K>) => Promise<void> | void,
        opts?: AsyncSubscribeOptions,
    ): Unsubscribe;
    stats(): BusStats;
    close(): void;
}

export interface CreateSessionLifecycleBusOptions {
    /** Sink for handler-error / close diagnostics. Defaults to LOG.warn('LifecycleBus', …). */
    log?: (message: string) => void;
    /** Clock used for error-log throttling. */
    now?: () => number;
    /** Minimum gap between two error logs of the same subscriber+kind. Default 60 s. */
    errorLogIntervalMs?: number;
}

const DEFAULT_MAX_PENDING = 256;
const DEFAULT_ERROR_LOG_INTERVAL_MS = 60_000;

interface Subscriber {
    readonly name: string;
    readonly kinds: ReadonlySet<BusEventKind> | null; // null = every kind
    active: boolean;
    readonly sync: ((event: BusEvent) => void) | null;
    readonly async: ((event: BusEvent) => Promise<void> | void) | null;
    readonly maxPending: number;
    readonly pending: BusEvent[];
    pumping: boolean;
}

function zeroByKind(): Record<BusEventKind, number> {
    const out = {} as Record<BusEventKind, number>;
    for (const kind of BUS_EVENT_KINDS) out[kind] = 0;
    return out;
}

function describeError(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

export function createSessionLifecycleBus(options: CreateSessionLifecycleBusOptions = {}): SessionLifecycleBus {
    const log = options.log ?? ((message: string) => LOG.warn('LifecycleBus', message));
    const now = options.now ?? Date.now;
    const errorLogIntervalMs = options.errorLogIntervalMs ?? DEFAULT_ERROR_LOG_INTERVAL_MS;

    const subscribers: Subscriber[] = [];
    const queue: BusEvent[] = [];
    let draining = false;
    let closed = false;
    let anonymousCount = 0;

    let emitted = 0;
    const emittedByKind = zeroByKind();
    let handlerErrors = 0;
    const handlerErrorsBySubscriber: Record<string, number> = {};
    let dropped = 0;
    const droppedBySubscriber: Record<string, number> = {};
    let rejectedAfterClose = 0;
    const lastErrorLogAt = new Map<string, number>();

    function recordHandlerError(sub: Subscriber, kind: BusEventKind, error: unknown): void {
        handlerErrors += 1;
        handlerErrorsBySubscriber[sub.name] = (handlerErrorsBySubscriber[sub.name] ?? 0) + 1;
        const key = `${sub.name}\u0000${kind}`;
        const t = now();
        const last = lastErrorLogAt.get(key);
        if (last !== undefined && t - last < errorLogIntervalMs) return;
        lastErrorLogAt.set(key, t);
        log(`subscriber "${sub.name}" failed on ${kind}: ${describeError(error)}`);
    }

    function matches(sub: Subscriber, kind: BusEventKind): boolean {
        return sub.active && (sub.kinds === null || sub.kinds.has(kind));
    }

    function pump(sub: Subscriber): void {
        if (sub.pumping || !sub.async) return;
        sub.pumping = true;
        const handler = sub.async;
        void (async () => {
            try {
                while (sub.active && sub.pending.length > 0) {
                    const event = sub.pending.shift() as BusEvent;
                    try {
                        await handler(event);
                    } catch (error) {
                        recordHandlerError(sub, event.kind, error);
                    }
                }
            } finally {
                sub.pumping = false;
            }
        })();
    }

    function enqueueAsync(sub: Subscriber, event: BusEvent): void {
        if (sub.pending.length >= sub.maxPending) {
            sub.pending.shift();
            dropped += 1;
            droppedBySubscriber[sub.name] = (droppedBySubscriber[sub.name] ?? 0) + 1;
        }
        sub.pending.push(event);
        pump(sub);
    }

    function fanOut(event: BusEvent): void {
        // Snapshot: a subscriber added mid-fan-out starts with the next event;
        // one removed mid-fan-out stops immediately (the `active` check).
        for (const sub of [...subscribers]) {
            if (!matches(sub, event.kind)) continue;
            if (sub.sync) {
                try {
                    sub.sync(event);
                } catch (error) {
                    recordHandlerError(sub, event.kind, error);
                }
            } else {
                enqueueAsync(sub, event);
            }
        }
    }

    function emit(event: BusEvent): void {
        if (closed) {
            rejectedAfterClose += 1;
            return;
        }
        emitted += 1;
        emittedByKind[event.kind] += 1;
        queue.push(event);
        if (draining) return; // re-entrant: delivered after the current fan-out
        draining = true;
        try {
            while (queue.length > 0 && !closed) {
                fanOut(queue.shift() as BusEvent);
            }
        } finally {
            draining = false;
            if (closed) queue.length = 0;
        }
    }

    function addSubscriber(
        kinds: KindSelector<BusEventKind>,
        sync: ((event: BusEvent) => void) | null,
        async: ((event: BusEvent) => Promise<void> | void) | null,
        opts: AsyncSubscribeOptions | undefined,
    ): Unsubscribe {
        if (closed) throw new Error('SessionLifecycleBus is closed');
        const maxPending = Math.max(1, Math.floor(opts?.maxPending ?? DEFAULT_MAX_PENDING));
        const sub: Subscriber = {
            name: opts?.name?.trim() || `anonymous#${++anonymousCount}`,
            kinds: kinds === '*' ? null : new Set(typeof kinds === 'string' ? [kinds] : kinds),
            active: true,
            sync,
            async,
            maxPending,
            pending: [],
            pumping: false,
        };
        subscribers.push(sub);
        return () => {
            if (!sub.active) return;
            sub.active = false;
            sub.pending.length = 0;
            const index = subscribers.indexOf(sub);
            if (index >= 0) subscribers.splice(index, 1);
        };
    }

    const bus: SessionLifecycleBus = {
        emit,
        on(kinds: KindSelector<BusEventKind>, handler: (event: never) => void, opts?: SubscribeOptions): Unsubscribe {
            return addSubscriber(kinds, handler as (event: BusEvent) => void, null, opts);
        },
        onAsync(
            kinds: KindSelector<BusEventKind>,
            handler: (event: never) => Promise<void> | void,
            opts?: AsyncSubscribeOptions,
        ): Unsubscribe {
            return addSubscriber(kinds, null, handler as (event: BusEvent) => Promise<void> | void, opts);
        },
        stats(): BusStats {
            const asyncPending: Record<string, number> = {};
            for (const sub of subscribers) {
                if (sub.async) asyncPending[sub.name] = (asyncPending[sub.name] ?? 0) + sub.pending.length;
            }
            return {
                emitted,
                emittedByKind: { ...emittedByKind },
                handlerErrors,
                handlerErrorsBySubscriber: { ...handlerErrorsBySubscriber },
                dropped,
                droppedBySubscriber: { ...droppedBySubscriber },
                asyncPending,
                rejectedAfterClose,
                closed,
            };
        },
        close(): void {
            if (closed) return;
            closed = true;
            queue.length = 0;
            for (const sub of subscribers) {
                sub.active = false;
                sub.pending.length = 0;
            }
            subscribers.length = 0;
        },
    };
    return bus;
}
