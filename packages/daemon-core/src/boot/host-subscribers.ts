/**
 * Host bus subscribers — the per-concern logic `createDaemonHostRuntime`
 * composes (wiring-unification B5, plan §3.1). Each one replaces glue that
 * both hosts used to hand-write around the old `onStatusChange` lambdas:
 *
 *   host.status-facts  status / daemon_facts / registered / terminated / launch_updated
 *                      → transport.onStatusFacts (cloud reporter push, standalone WS status)
 *   host.chat-tail     status → hot chat flush; working|blocked → ready → forced completion tail
 *                      (C17: standalone's completion flush lived in lambdas that never fired
 *                      on a turn transition, so only the 2 s timer delivered it)
 *   host.modal         modal / prompt → session.modal flush (was standalone-only, per poke)
 *   host.topics        command_executed → topic invalidation (covers every router caller,
 *                      incl. the 6 that skipped it before — C11)
 *   host.mesh-state    mesh_state → transport hook + daemon.metadata flush (standalone gains it)
 *   host.turn-snapshots status working|blocked → ready|dead → post-turn git snapshot (D4, both hosts)
 *
 * Each returns its unsubscribe. None throws into the bus: the bus isolates
 * handlers, but async work is caught here so a rejected flush never surfaces
 * as an unhandled rejection.
 */

import { classifySessionStatus } from '@adhdev/mesh-shared';
import { LOG } from '../logging/logger.js';
import type { SessionLifecycleBus, Unsubscribe } from '../sessions/lifecycle-bus.js';
import type { EventOf } from '../sessions/lifecycle-events.js';
import type { SessionRegistry } from '../sessions/registry.js';
import type { TopicSubscriptionRegistry } from '../subscriptions/topic-registry.js';
import type { TransportTopic } from '../shared-types.js';
import type { GitCommandServices } from '../git/git-commands.js';
import type { GitWorkspaceMonitor } from '../git/git-monitor.js';

type Bus = Pick<SessionLifecycleBus, 'on'>;
type Topics = Pick<TopicSubscriptionRegistry, 'hasSubscriptions' | 'flushNow' | 'invalidate'> & Partial<Pick<TopicSubscriptionRegistry, 'purgeChatOutputActivity'>>;
type ReconcileTopics = Pick<TopicSubscriptionRegistry, 'hasSubscriptions' | 'oldestLastSentAt'>;

export type StatusFactsEvent =
    | EventOf<'status'>
    | EventOf<'daemon_facts'>
    | EventOf<'registered'>
    | EventOf<'terminated'>
    | EventOf<'launch_updated'>;

function swallow(label: string): (error: unknown) => void {
    return (error) => LOG.debug('HostRuntime', `${label} failed: ${(error as Error)?.message ?? error}`);
}

function flushTopic(topics: Topics, topic: 'session.modal' | 'daemon.metadata'): void {
    if (!topics.hasSubscriptions(topic)) return;
    void topics.flushNow(topic).catch(swallow(`${topic} flush`));
}

/** A turn ended: the agent owned the turn (or was blocked on a human) and is now ready for input. */
export function isTurnCompletionEdge(prev: unknown, next: unknown): boolean {
    const from = classifySessionStatus(prev);
    return (from === 'working' || from === 'blocked') && classifySessionStatus(next) === 'ready';
}

export function subscribeHostStatusFacts(bus: Bus, onFacts: (e: StatusFactsEvent) => void): Unsubscribe {
    return bus.on(['status', 'daemon_facts', 'registered', 'terminated', 'launch_updated'], (e) => onFacts(e), {
        name: 'host.status-facts',
    });
}

export interface ChatTailHooks {
    /** Hot (onlyActive) chat-tail flush — every status edge. */
    flushActive(): void;
    /** Forced flush of the sessions whose turn just completed (guaranteed completion tail). */
    flushCompleted?(sessionIds: ReadonlySet<string>): void;
}

export function subscribeHostChatTail(bus: Bus, hooks: ChatTailHooks): Unsubscribe {
    return bus.on('status', (e) => {
        hooks.flushActive();
        if (hooks.flushCompleted && isTurnCompletionEdge(e.prev, e.next)) {
            hooks.flushCompleted(new Set([e.sessionId]));
        }
    }, { name: 'host.chat-tail' });
}

export function subscribeHostModal(bus: Bus, topics: Topics): Unsubscribe {
    return bus.on(['modal', 'prompt'], () => flushTopic(topics, 'session.modal'), { name: 'host.modal' });
}

/**
 * `terminated` → drop the session's chat-output activity stamp eagerly (design B2
 * registry #12: `chatOutputActiveAt` is a subscriber cache). The 8 s hot-window
 * expiry already makes this safe to miss; this keeps the map from carrying dead ids.
 */
export function subscribeHostSessionPurge(bus: Bus, topics: Topics): Unsubscribe {
    return bus.on('terminated', (e) => {
        try { topics.purgeChatOutputActivity?.(e.sessionId); } catch (err) { swallow('purge chat output activity')(err); }
    }, { name: 'host.session-purge' });
}

export function subscribeHostCommandTopics(
    bus: Bus,
    topics: Topics,
    onCommandExecuted?: (e: EventOf<'command_executed'>) => void,
): Unsubscribe {
    return bus.on('command_executed', (e) => {
        // A fast-flush command (launch) already pushed daemon.metadata through
        // the host's immediate path — do not flush it twice.
        const fastFlushed = e.fastFlush && e.success;
        void topics.invalidate(e.invalidates, fastFlushed ? { skip: ['daemon.metadata'] } : {})
            .catch(swallow(`invalidate after ${e.command}`));
        onCommandExecuted?.(e);
    }, { name: 'host.topics' });
}

export function subscribeHostMeshState(bus: Bus, topics: Topics, onMeshState?: (meshId: string) => void): Unsubscribe {
    return bus.on('mesh_state', (e) => {
        onMeshState?.(e.meshId);
        flushTopic(topics, 'daemon.metadata');
    }, { name: 'host.mesh-state' });
}

export interface TurnSnapshotDeps {
    sessionRegistry: Pick<SessionRegistry, 'get'>;
    gitServices?: Pick<GitCommandServices, 'createSnapshot'> | null;
    gitMonitor?: Pick<GitWorkspaceMonitor, 'refresh'> | null;
}

/**
 * D4: the post-turn workspace snapshot, ported from cloud's IDE-stream-only
 * TurnSnapshotTracker to a bus `status` subscriber that runs for every session
 * transport in both hosts. The pre-turn half is the command plane's
 * `onBeforeSendChat` (boot/stages/command-plane.ts).
 */
export function subscribeHostTurnSnapshots(bus: Bus, deps: TurnSnapshotDeps): Unsubscribe {
    return bus.on('status', (e) => {
        const from = classifySessionStatus(e.prev);
        const to = classifySessionStatus(e.next);
        if (!(from === 'working' || from === 'blocked')) return;
        if (!(to === 'ready' || to === 'dead')) return;
        const workspace = deps.sessionRegistry.get(e.sessionId)?.workspace;
        if (!workspace) return;
        if (deps.gitServices?.createSnapshot) {
            void Promise.resolve(deps.gitServices.createSnapshot({ workspace, reason: 'after_agent_work', sessionId: e.sessionId }))
                .catch(swallow('after_agent_work snapshot'));
        }
        // Refresh the workspace git pill.
        if (deps.gitMonitor) {
            void Promise.resolve(deps.gitMonitor.refresh({ workspace, includeDiffSummary: false }))
                .catch(swallow('git monitor refresh'));
        }
    }, { name: 'host.turn-snapshots' });
}

// ─── P-II item 1: topic-flush reconciliation (WARN-only safety net) ───
//
// Both hosts used to re-flush every push topic on a 2-2.5s `setInterval`,
// self-labelled "safety net" in both code comments, even though every edge
// that can invalidate a topic already flushes it through the bus subscribers
// above (host.chat-tail / host.modal / host.topics / host.mesh-state) or
// `command_executed.invalidates`. That timer is gone; this is what replaces
// it — a single slow (default 60s) tick that does NOT flush anything itself.
// It only checks whether a topic that has live subscribers has gone stale
// (nothing sent since well before the newest edge that should have produced
// a send) and WARNs with the topic name and the age, so a silently-broken
// bus subscriber is still observable. Precedent for "shrink the safety net
// once the event path is trusted": `UserSession.ts`'s removed 30s DO timer
// (packages/server, ~line 1029).

/** Topics this reconciliation pass watches — every push topic the removed 2-2.5s timers flushed. */
const RECONCILE_TOPICS: ReadonlyArray<TransportTopic> = [
    'machine.runtime',
    'session_host.diagnostics',
    'session.modal',
    'workspace.git',
    'daemon.metadata',
];

/** Bus edges that should have produced a flush of at least one watched topic. */
const RECONCILE_EDGE_KINDS = [
    'status',
    'modal',
    'prompt',
    'registered',
    'terminated',
    'daemon_facts',
    'command_executed',
    'mesh_state',
] as const satisfies readonly EventOf<'status' | 'modal' | 'prompt' | 'registered' | 'terminated' | 'daemon_facts' | 'command_executed' | 'mesh_state'>['kind'][];

export const DEFAULT_HOST_RECONCILE_INTERVAL_MS = 60_000;
/** A topic must be at least this much older than the newest edge before it is reported stale — absorbs the topic's own internal throttle (the slowest is machine.runtime's default 15s) plus scheduling jitter. */
const RECONCILE_STALE_GRACE_MS = 20_000;

export interface HostReconcileOptions {
    intervalMs?: number;
    /** Test seam / explicit override of the default `Date.now`. */
    now?: () => number;
    /** Test seam for `setInterval`/`clearInterval` (defaults to the globals). */
    setIntervalFn?: typeof setInterval;
    clearIntervalFn?: typeof clearInterval;
}

/**
 * Arms the WARN-only reconciliation tick. Never calls `flushNow`/`invalidate`
 * — flushing here would silently reinstate a second delivery path, which the
 * design explicitly rules out. Returns the unsubscribe (clears the timer and
 * detaches the bus listener that tracks the newest edge timestamp).
 */
export function subscribeHostTopicReconciliation(bus: Bus, topics: ReconcileTopics, opts: HostReconcileOptions = {}): Unsubscribe {
    const now = opts.now ?? Date.now;
    const setIntervalFn = opts.setIntervalFn ?? setInterval;
    const clearIntervalFn = opts.clearIntervalFn ?? clearInterval;
    const intervalMs = opts.intervalMs ?? DEFAULT_HOST_RECONCILE_INTERVAL_MS;

    let newestEdgeAt = now();
    const offEdges = bus.on(RECONCILE_EDGE_KINDS, (e) => {
        const at = (e as { at?: number }).at;
        if (typeof at === 'number' && at > newestEdgeAt) newestEdgeAt = at;
    }, { name: 'host.reconcile-edge-tracker' });

    const tick = (): void => {
        const edgeAt = newestEdgeAt;
        // Give the event path a grace window after the edge before judging a
        // topic stale (absorbs the topic's own internal throttle — the
        // slowest is machine.runtime's default 15s — plus scheduling jitter).
        // Below that, "not flushed yet" is expected, not evidence of a break.
        if (now() < edgeAt + RECONCILE_STALE_GRACE_MS) return;
        for (const topic of RECONCILE_TOPICS) {
            if (!topics.hasSubscriptions(topic)) continue;
            const oldest = topics.oldestLastSentAt(topic);
            if (oldest === null) continue;
            // Healthy: this topic was flushed at or after the newest edge that
            // should have produced a send (the event path caught up).
            if (oldest >= edgeAt) continue;
            const ageMs = now() - oldest;
            LOG.warn('HostRuntime', `topic reconciliation: ${topic} has subscribers but no flush since ${ageMs}ms ago (newest bus edge was ${now() - edgeAt}ms ago) — a bus subscriber may be silently broken`);
        }
    };
    const timer = setIntervalFn(tick, intervalMs);
    if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
        (timer as unknown as { unref: () => void }).unref();
    }
    return () => {
        clearIntervalFn(timer);
        offEdges();
    };
}
