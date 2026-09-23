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
import type { CommandInvalidationTopic } from '../commands/command-registry.js';
import type { GitCommandServices } from '../git/git-commands.js';
import type { GitWorkspaceMonitor } from '../git/git-monitor.js';

type Bus = Pick<SessionLifecycleBus, 'on'>;
type Topics = Pick<TopicSubscriptionRegistry, 'hasSubscriptions' | 'flushNow' | 'invalidate'> & Partial<Pick<TopicSubscriptionRegistry, 'purgeChatOutputActivity'>>;
type ReconcileTopics = Pick<TopicSubscriptionRegistry, 'hasSubscriptions' | 'oldestLastFlushedAt'>;

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
// (nothing sent since well before the newest edge THAT SHOULD HAVE FLUSHED
// THAT SPECIFIC TOPIC) and WARNs with the topic name and the age, so a
// silently-broken bus subscriber is still observable. Precedent for "shrink
// the safety net once the event path is trusted": `UserSession.ts`'s removed
// 30s DO timer (packages/server, ~line 1029).
//
// ── Per-topic edge map (P-II-1 follow-up, 2026-09-25) ──────────────────
//
// The first cut tracked ONE global "newest edge of any watched kind" and
// judged every topic against it. That over-counts: an edge of a kind that
// does not invalidate a given topic (e.g. a `command_executed` for
// `read_chat` with an empty `invalidates` set, or one that only invalidates
// `session.modal`) still moved the global clock forward and made every OTHER
// topic look stale by comparison. Live symptom: `daemon.metadata` and
// `session.modal` WARNing every ~60s tick even though both were flushed
// normally — the "newest edge" was an unrelated `command_executed` a few ms
// after a dashboard subscribe.
//
// Below, each watched topic gets its own subscriber-proven edge-kind set:
//
//   session.modal        ← modal, prompt                     (subscribeHostModal: bus.on(['modal','prompt'], () => flushTopic(topics,'session.modal')))
//                         ← command_executed when invalidates has 'session.modal'
//                                                              (subscribeHostCommandTopics: topics.invalidate(e.invalidates, …))
//   daemon.metadata       ← mesh_state                        (subscribeHostMeshState: bus.on('mesh_state', () => { …; flushTopic(topics,'daemon.metadata'); }))
//                         ← command_executed when invalidates has 'daemon.metadata'
//                                                              (subscribeHostCommandTopics, same call — fastFlush just means the flush
//                                                               already happened through a different immediate path, so the edge is
//                                                               still real evidence a flush was due; it is not excluded here)
//   session_host.diagnostics ← command_executed when invalidates has 'session_host.diagnostics'
//                                                              (subscribeHostCommandTopics)
//   workspace.git         ← command_executed when invalidates has 'workspace.git'
//                                                              (subscribeHostCommandTopics)
//   machine.runtime        ← (none) — no subscriber in this file invalidates it; it is not a
//                            member of `CommandInvalidationTopic` (command-registry.ts) either.
//                            It is purely interval-driven inside topic-registry.ts (its own
//                            throttle), so this pass never has a bus edge to judge it against
//                            and therefore never WARNs for it.
//
// `status`, `registered`, `terminated`, and `daemon_facts` are NOT in the
// edge map: `subscribeHostStatusFacts` only forwards them to
// `transport.onStatusFacts`, a host-specific hook outside this file (cloud's
// status reporter never touches the topic registry at all; standalone's
// `broadcastStatus` conditionally flushes `daemon.metadata`, but only behind
// a 500ms debounce AND a dedup signature check — it is not a flush this file
// can prove happens on every edge). Counting them here reproduces the same
// false-positive class this follow-up fixes, so they are left out per the
// task's explicit fallback ("if status edges do not flush any of the five
// watched topics directly, drop status from the edge map rather than
// guessing").

/** Topics this reconciliation pass watches — every push topic the removed 2-2.5s timers flushed. */
const RECONCILE_TOPICS: ReadonlyArray<TransportTopic> = [
    'machine.runtime',
    'session_host.diagnostics',
    'session.modal',
    'workspace.git',
    'daemon.metadata',
];

/** Bus edge kinds that can, for at least one watched topic, be counted as "this topic should now flush". */
const RECONCILE_EDGE_KINDS = [
    'modal',
    'prompt',
    'command_executed',
    'mesh_state',
] as const satisfies readonly EventOf<'modal' | 'prompt' | 'command_executed' | 'mesh_state'>['kind'][];
type ReconcileEdgeEvent = EventOf<typeof RECONCILE_EDGE_KINDS[number]>;

/** Non-command edge kinds that unconditionally invalidate one fixed topic (see map above). */
const FIXED_EDGE_TOPIC: Partial<Record<ReconcileEdgeEvent['kind'], TransportTopic>> = {
    modal: 'session.modal',
    prompt: 'session.modal',
    mesh_state: 'daemon.metadata',
};

/** Human-readable "what proved this edge counts" label for the WARN message. */
function edgeLabel(e: ReconcileEdgeEvent): string {
    return e.kind === 'command_executed' ? `command_executed:${e.command}` : e.kind;
}

function isCommandInvalidationTopic(topic: TransportTopic): topic is CommandInvalidationTopic {
    return topic === 'daemon.metadata' || topic === 'session_host.diagnostics' || topic === 'session.modal' || topic === 'workspace.git';
}

/** Does this edge invalidate `topic`, per the map documented above? */
function edgeInvalidatesTopic(e: ReconcileEdgeEvent, topic: TransportTopic): boolean {
    if (e.kind === 'command_executed') return isCommandInvalidationTopic(topic) && e.invalidates.has(topic);
    return FIXED_EDGE_TOPIC[e.kind] === topic;
}

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

    // Per-topic "newest edge that should have flushed it" — {at, label}. A
    // topic absent from this map has seen no qualifying edge yet and is
    // never judged (matches the old behavior of "nothing to compare against").
    const newestEdgeByTopic = new Map<TransportTopic, { at: number; label: string }>();
    const startedAt = now();

    const offEdges = bus.on(RECONCILE_EDGE_KINDS, (e) => {
        const at = (e as { at?: number }).at ?? startedAt;
        for (const topic of RECONCILE_TOPICS) {
            if (!edgeInvalidatesTopic(e, topic)) continue;
            const current = newestEdgeByTopic.get(topic);
            if (current && current.at >= at) continue;
            newestEdgeByTopic.set(topic, { at, label: edgeLabel(e) });
        }
    }, { name: 'host.reconcile-edge-tracker' });

    const tick = (): void => {
        for (const topic of RECONCILE_TOPICS) {
            if (!topics.hasSubscriptions(topic)) continue;
            const edge = newestEdgeByTopic.get(topic);
            if (!edge) continue; // no qualifying edge yet for this topic — nothing to judge.
            // Give the event path a grace window after the edge before judging
            // this topic stale (absorbs the topic's own internal throttle —
            // the slowest is machine.runtime's default 15s — plus scheduling
            // jitter). Below that, "not flushed yet" is expected, not
            // evidence of a break.
            if (now() < edge.at + RECONCILE_STALE_GRACE_MS) continue;
            const oldest = topics.oldestLastFlushedAt(topic);
            if (oldest === null) continue;
            // Healthy: this topic was flushed at or after the edge that
            // should have produced a send (the event path caught up).
            if (oldest >= edge.at) continue;
            const ageMs = now() - oldest;
            LOG.warn('HostRuntime', `topic reconciliation: ${topic} has subscribers but no flush since ${ageMs}ms ago (newest ${topic} edge (${edge.label}) was ${now() - edge.at}ms ago) — a bus subscriber may be silently broken`);
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
